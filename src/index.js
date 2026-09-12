/**
 * RGB HTTP JSON-RPC v0.2 proxy, as a Cloudflare Worker. Zero-validation store-and-forward
 * over D1 and R2.
 *
 * The protocol is rgb-http-json-rpc v0.2, as implemented by RGB-Tools/rgb-proxy-server. The
 * behaviour here was taken from that implementation's source rather than its README.
 *
 * NOTE: other people's wallets talk to this, so any deviation shows up as a failed deposit.
 * Check a change against a real rgb-lib client, not only the conformance test.
 */

import { InternalError, InvalidRequest, MethodNotFound, RpcError } from "./errors.js";
import { methods } from "./methods.js";
import { normalizeParams } from "./params.js";

/**
 * NOTE: `Date.now()` returns 0 during module initialisation on Workers, so the start time is
 * taken lazily on the first request. Taking it here would report an uptime of a whole epoch.
 */
let startedAt = null;

/** The official server calls cors() with no arguments: any origin is allowed. */
const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
    "Access-Control-Allow-Headers": "Content-Type, logger-req-id",
};

let reqCounter = 0;

function json(body, { status = 200, extraHeaders = {} } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...CORS, ...extraHeaders },
    });
}

/**
 * Read the request body in either shape:
 *   - application/json          ordinary calls
 *   - multipart/form-data       consignment.post / media.post, where the file field is always
 *                               named "file" and `params` arrives as a JSON string
 */
async function parseBody(request) {
    const ct = request.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
        const form = await request.formData();
        const body = {};
        for (const [k, v] of form.entries()) {
            if (k === "file") continue;
            body[k] = v;
        }
        // Every multipart field is a string, so `params` has to be parsed.
        if (typeof body.params === "string") body.params = normalizeParams(body.params);
        const file = form.get("file");
        return { body, file: file && typeof file.arrayBuffer === "function" ? file : null };
    }
    if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await request.formData();
        const body = {};
        for (const [k, v] of form.entries()) body[k] = v;
        if (typeof body.params === "string") body.params = normalizeParams(body.params);
        return { body, file: null };
    }
    return { body: await request.json(), file: null };
}

async function handleOne(rpc, ctx) {
    const { id } = rpc;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        return { jsonrpc: "2.0", id: id ?? null, error: InvalidRequest().toJSON() };
    }
    const fn = methods[rpc.method];
    if (!fn) {
        return { jsonrpc: "2.0", id: id ?? null, error: MethodNotFound().toJSON() };
    }
    try {
        const result = await fn(normalizeParams(rpc.params), ctx);
        // NOTE: the official server's json-rpc-2.0 library serialises an undefined result as
        // null rather than omitting the field; ack.get before an ACK is the case that hits it.
        // Only the top-level result behaves this way. Undefined fields inside the result (such
        // as consignment.get's vout) are still dropped by JSON.stringify, as upstream does.
        return { jsonrpc: "2.0", id: id ?? null, result: result === undefined ? null : result };
    } catch (e) {
        if (e instanceof RpcError) {
            return { jsonrpc: "2.0", id: id ?? null, error: e.toJSON() };
        }
        console.error("unhandled", rpc.method, e && e.stack ? e.stack : e);
        return { jsonrpc: "2.0", id: id ?? null, error: InternalError().toJSON() };
    }
}

/**
 * Delete consignments past their TTL. The official server keeps them forever; a consignment
 * carries a full transfer history, so this deployment expires them and says so in its privacy
 * notice.
 *
 * R2 objects are content-addressed, so an object is removed only once no other recipient_id
 * still references the same object_key.
 */
async function cleanupExpired(env) {
    const days = Number(env.CONSIGNMENT_TTL_DAYS || 30);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const { results } = await env.DB.prepare(
        "SELECT recipient_id, object_key FROM consignments WHERE created_at < ? LIMIT 500",
    ).bind(cutoff).all();
    if (!results || results.length === 0) return { deleted: 0, objects: 0 };

    let objects = 0;
    for (const row of results) {
        await env.DB.prepare("DELETE FROM consignments WHERE recipient_id = ?")
            .bind(row.recipient_id).run();
        // Content addressing deduplicates: keep the object while another row references it.
        const still = await env.DB.prepare(
            "SELECT 1 FROM consignments WHERE object_key = ? LIMIT 1",
        ).bind(row.object_key).first();
        if (!still) { await env.CONSIGNMENTS.delete(row.object_key); objects += 1; }
    }
    return { deleted: results.length, objects };
}

export default {
    async scheduled(_event, env, _ctx) {
        const r = await cleanupExpired(env);
        console.log(`cleanup: ${r.deleted} rows, ${r.objects} objects deleted`);
    },

    async fetch(request, env, _executionCtx) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS });
        }

        if (startedAt === null) startedAt = Date.now();

        const url = new URL(request.url);
        // The official server routes only `/json-rpc`, and that is what rgb-lib is normally
        // pointed at. A version-prefixed path is accepted as well because clients are
        // configured by hand: a stray `/0.2/` makes rgb-lib's endpoint check 404, and it
        // reports that as "no valid transport endpoints" with no mention of the URL.
        // NOTE: the prefix is only tolerated, never required. Nothing here varies by version.
        if (!/^\/(?:\d+\.\d+\/)?json-rpc$/.test(url.pathname)) {
            return new Response("Not Found", { status: 404, headers: CORS });
        }
        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405, headers: CORS });
        }

        // The official server echoes logger-req-id. Not required by the protocol, but it
        // keeps captured traffic comparable.
        const reqId = request.headers.get("logger-req-id") || String(++reqCounter);
        const extraHeaders = { "logger-req-id": reqId };

        let parsed;
        try {
            parsed = await parseBody(request);
        } catch {
            return json({ jsonrpc: "2.0", id: null, error: InvalidRequest().toJSON() },
                { extraHeaders });
        }

        const { body, file } = parsed;
        const ctx = { env, file, startedAt };

        const response = await handleOne(body, ctx);

        // A notification (no id) gets HTTP 204 with no body.
        if (body && body.id === undefined) {
            return new Response(null, { status: 204, headers: { ...CORS, ...extraHeaders } });
        }
        return json(response, { extraHeaders });
    },
};
