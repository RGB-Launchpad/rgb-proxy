/**
 * Conformance run: send the same cases to the official rgb-proxy-server and to this Worker,
 * then compare the responses field by field, error paths included.
 *
 * Usage:
 *   # official server on 3000 (docker start rgb-proxy)
 *   # Worker on 8787         (npx wrangler dev --port 8787)
 *   node test/conformance.mjs
 */

const OFFICIAL = process.env.OFFICIAL_URL || "http://localhost:3000/json-rpc";
const WORKER = process.env.WORKER_URL || "http://localhost:8787/json-rpc";

let pass = 0, fail = 0;
const failures = [];

const rnd = () => Math.random().toString(36).slice(2, 10);

async function rpc(url, method, params, { file = null, id = "1" } = {}) {
    let res;
    if (file) {
        const form = new FormData();
        form.set("jsonrpc", "2.0");
        form.set("id", id);
        form.set("method", method);
        form.set("params", JSON.stringify(params));
        form.set("file", new Blob([file]), "consignment");
        res = await fetch(url, { method: "POST", body: form });
    } else {
        const body = { jsonrpc: "2.0", method, params };
        if (id !== undefined) body.id = id;
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 204 and friends */ }
    return { status: res.status, json };
}

/** Compare only what the protocol fixes: result, error.code, error.message, HTTP status. */
function shape(r) {
    if (!r.json) return { status: r.status, body: null };
    const { result, error } = r.json;
    return {
        status: r.status,
        result: result === undefined ? "<undefined>" : result,
        error: error ? { code: error.code, message: error.message } : undefined,
    };
}

async function compare(name, run) {
    const a = shape(await run(OFFICIAL));
    const b = shape(await run(WORKER));
    // server.info's version and uptime always differ; compare the protocol version only.
    if (name.startsWith("server.info")) {
        const pa = a.result && a.result.protocol_version;
        const pb = b.result && b.result.protocol_version;
        if (pa === pb && pa === "0.2") { pass++; console.log(`  ok   ${name}  protocol_version=${pa}`); return; }
        fail++; failures.push({ name, official: pa, worker: pb });
        console.log(`  FAIL ${name}  official=${pa} worker=${pb}`);
        return;
    }
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa === sb) { pass++; console.log(`  ok   ${name}`); }
    else {
        fail++; failures.push({ name, official: a, worker: b });
        console.log(`  FAIL ${name}\n       official: ${sa}\n       ours:     ${sb}`);
    }
}

async function main() {
    console.log(`official: ${OFFICIAL}\nWorker:   ${WORKER}\n`);

    await compare("server.info", (u) => rpc(u, "server.info", {}));

    // ---- Error paths; no fixtures needed ----
    await compare("consignment.get without recipient_id", (u) => rpc(u, "consignment.get", {}));
    await compare("consignment.get with an empty recipient_id", (u) => rpc(u, "consignment.get", { recipient_id: "" }));
    await compare("consignment.get with a non-string recipient_id", (u) => rpc(u, "consignment.get", { recipient_id: 123 }));
    await compare("consignment.get for an unknown id", (u) => rpc(u, "consignment.get", { recipient_id: `nope-${rnd()}` }));
    await compare("ack.get without recipient_id", (u) => rpc(u, "ack.get", {}));
    await compare("ack.get for an unknown id", (u) => rpc(u, "ack.get", { recipient_id: `nope-${rnd()}` }));
    await compare("ack.post for an unknown id", (u) => rpc(u, "ack.post", { recipient_id: `nope-${rnd()}`, ack: true }));
    await compare("media.get without attachment_id", (u) => rpc(u, "media.get", {}));
    await compare("media.get for an unknown id", (u) => rpc(u, "media.get", { attachment_id: `nope-${rnd()}` }));
    await compare("unknown method", (u) => rpc(u, "no.such.method", {}));
    await compare("consignment.post with no file", (u) => rpc(u, "consignment.post", { recipient_id: rnd(), txid: "aa" }));

    // ---- Full flow. Each side uses its own id so both start from the same state. ----
    const payload = new TextEncoder().encode(`consignment-body-${rnd()}`);
    const ids = new Map();
    const idFor = (u) => { if (!ids.has(u)) ids.set(u, `rid-${rnd()}`); return ids.get(u); };

    await compare("post, first time -> true", (u) =>
        rpc(u, "consignment.post", { recipient_id: idFor(u), txid: "d34db33f", vout: 1 }, { file: payload }));
    await compare("post, identical content -> false (idempotent)", (u) =>
        rpc(u, "consignment.post", { recipient_id: idFor(u), txid: "d34db33f", vout: 1 }, { file: payload }));
    await compare("post, different content -> -101", (u) =>
        rpc(u, "consignment.post", { recipient_id: idFor(u), txid: "d34db33f", vout: 1 },
            { file: new TextEncoder().encode("different") }));
    await compare("get returns the file", (u) => rpc(u, "consignment.get", { recipient_id: idFor(u) }));
    await compare("ack.get before an ACK", (u) => rpc(u, "ack.get", { recipient_id: idFor(u) }));
    await compare("ack.post, first time -> true", (u) => rpc(u, "ack.post", { recipient_id: idFor(u), ack: true }));
    await compare("ack.post, same value -> false (idempotent)", (u) => rpc(u, "ack.post", { recipient_id: idFor(u), ack: true }));
    await compare("ack.post, flipped -> -100", (u) => rpc(u, "ack.post", { recipient_id: idFor(u), ack: false }));
    await compare("ack.get after an ACK", (u) => rpc(u, "ack.get", { recipient_id: idFor(u) }));
    await compare("ack.post without ack", (u) => rpc(u, "ack.post", { recipient_id: idFor(u) }));
    await compare("ack.post with a non-boolean ack", (u) => rpc(u, "ack.post", { recipient_id: idFor(u), ack: "yes" }));

    // vout edges
    const v = new Map();
    const vid = (u) => { if (!v.has(u)) v.set(u, `vid-${rnd()}`); return v.get(u); };
    await compare("post, vout as a numeric string -> accepted", (u) =>
        rpc(u, "consignment.post", { recipient_id: vid(u), txid: "beef", vout: "2" }, { file: payload }));
    await compare("post, non-integer vout -> -204", (u) =>
        rpc(u, "consignment.post", { recipient_id: `bad-${rnd()}`, txid: "beef", vout: "x" }, { file: payload }));
    await compare("post without txid -> -303", (u) =>
        rpc(u, "consignment.post", { recipient_id: `bad-${rnd()}` }, { file: payload }));

    console.log(`\npassed ${pass}  failed ${fail}`);
    if (fail) {
        console.log("\nMismatches:");
        for (const f of failures) console.log(JSON.stringify(f, null, 1));
        process.exit(1);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
