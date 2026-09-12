/**
 * The seven JSON-RPC methods, matching the behaviour of the reference implementation,
 * RGB-Tools/rgb-proxy-server, one for one.
 */

import {
    CannotChangeAck, CannotChangeUploadedFile,
    MissingFile, NotFoundConsignment, NotFoundMedia,
} from "./errors.js";
import { getAck, getAttachmentID, getRecipientID, getTxid, getVout } from "./params.js";

export const PROTOCOL_VERSION = "0.2";
export const APP_VERSION = "0.1.0-worker";

/** Upstream's filename is the hex sha256 of the content: identical files deduplicate. */
async function sha256Hex(arrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let bin = "";
    const CHUNK = 0x8000;              // 32KB at a time, to keep apply's argument count sane
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

async function getConsignmentRow(env, recipientId) {
    return env.DB.prepare(
        "SELECT recipient_id, object_key, txid, vout, ack FROM consignments WHERE recipient_id = ?",
    ).bind(recipientId).first();
}

async function getConsignmentOrFail(env, params) {
    const row = await getConsignmentRow(env, getRecipientID(params));
    if (!row) throw NotFoundConsignment(params);
    return row;
}

export const methods = {
    async "server.info"(_params, { startedAt }) {
        return {
            protocol_version: PROTOCOL_VERSION,
            version: APP_VERSION,
            uptime: Math.trunc((Date.now() - startedAt) / 1000),
        };
    },

    async "consignment.get"(params, { env }) {
        const row = await getConsignmentOrFail(env, params);
        const obj = await env.CONSIGNMENTS.get(row.object_key);
        if (!obj) throw NotFoundConsignment(params);   // row present, object gone
        return {
            consignment: toBase64(await obj.arrayBuffer()),
            txid: row.txid,
            vout: row.vout ?? undefined,
        };
    },

    async "consignment.post"(params, { env, file }) {
        if (!file) throw MissingFile(params);
        const recipientId = getRecipientID(params);
        const txid = getTxid(params);
        const vout = getVout(params);

        const bytes = await file.arrayBuffer();
        const objectKey = await sha256Hex(bytes);

        const prev = await getConsignmentRow(env, recipientId);
        if (prev) {
            // Idempotent: re-posting identical content returns false, not an error. Only
            // different content is refused.
            if (prev.object_key === objectKey) return false;
            throw CannotChangeUploadedFile(params);
        }

        await env.CONSIGNMENTS.put(objectKey, bytes);
        try {
            await env.DB.prepare(
                `INSERT INTO consignments (recipient_id, object_key, txid, vout, ack, created_at)
                 VALUES (?, ?, ?, ?, NULL, ?)`,
            ).bind(recipientId, objectKey, txid, vout ?? null, Date.now()).run();
        } catch (e) {
            // Two concurrent posts for the same recipient_id: the later one hits the primary
            // key. Re-read to tell an identical file (idempotent false) from a real conflict.
            const now = await getConsignmentRow(env, recipientId);
            if (now && now.object_key === objectKey) return false;
            if (now) throw CannotChangeUploadedFile(params);
            throw e;
        }
        return true;
    },

    async "media.get"(params, { env }) {
        const attachmentId = getAttachmentID(params);
        const row = await env.DB.prepare(
            "SELECT object_key FROM media WHERE attachment_id = ?",
        ).bind(attachmentId).first();
        if (!row) throw NotFoundMedia(params);
        const obj = await env.CONSIGNMENTS.get(`media/${row.object_key}`);
        if (!obj) throw NotFoundMedia(params);
        return toBase64(await obj.arrayBuffer());     // NOTE: a bare string, not an object
    },

    async "media.post"(params, { env, file }) {
        const attachmentId = getAttachmentID(params);
        if (!file) throw MissingFile(params);

        const bytes = await file.arrayBuffer();
        const objectKey = await sha256Hex(bytes);

        const prev = await env.DB.prepare(
            "SELECT object_key FROM media WHERE attachment_id = ?",
        ).bind(attachmentId).first();
        if (prev) {
            if (prev.object_key === objectKey) return false;
            throw CannotChangeUploadedFile(params);
        }

        await env.CONSIGNMENTS.put(`media/${objectKey}`, bytes);
        await env.DB.prepare(
            "INSERT INTO media (attachment_id, object_key, created_at) VALUES (?, ?, ?)",
        ).bind(attachmentId, objectKey, Date.now()).run();
        return true;
    },

    async "ack.get"(params, { env }) {
        const row = await getConsignmentOrFail(env, params);
        // NOTE: undefined, not false, while unacknowledged. This is the official semantics.
        return row.ack === null || row.ack === undefined ? undefined : Boolean(row.ack);
    },

    async "ack.post"(params, { env }) {
        const row = await getConsignmentOrFail(env, params);
        const ack = getAck(params);
        if (row.ack !== null && row.ack !== undefined) {
            // An ACK is final once written: the payer uses it to decide whether to broadcast.
            if (Boolean(row.ack) === ack) return false;
            throw CannotChangeAck(params);
        }
        const res = await env.DB.prepare(
            "UPDATE consignments SET ack = ? WHERE recipient_id = ? AND ack IS NULL",
        ).bind(ack ? 1 : 0, row.recipient_id).run();
        // Someone wrote first: re-read to tell an identical value from a conflict.
        if (!res.meta || res.meta.changes === 0) {
            const now = await getConsignmentRow(env, row.recipient_id);
            if (now && now.ack !== null && Boolean(now.ack) === ack) return false;
            throw CannotChangeAck(params);
        }
        return true;
    },
};
