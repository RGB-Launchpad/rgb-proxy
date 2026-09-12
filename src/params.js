/**
 * Parameter reading and validation, one for one with the official server's
 * src/controllers/api.ts in RGB-Tools/rgb-proxy-server.
 */

import {
    InvalidAck, InvalidAttachmentID, InvalidRecipientID, InvalidTxid, InvalidVout,
    MissingAck, MissingAttachmentID, MissingRecipientID, MissingTxid,
} from "./errors.js";

const isDictionary = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v) => typeof v === "string";
const isBoolean = (v) => Boolean(v) === v;
/** The official server uses Number.isInteger(Number(data)), so numeric strings pass. */
const isNumberLike = (v) => Number.isInteger(Number(v)) && v !== null;

export function getRecipientID(params) {
    if (!isDictionary(params) || !("recipient_id" in params)) throw MissingRecipientID(params);
    const v = params.recipient_id;
    if (!v || !isString(v)) throw InvalidRecipientID(params);
    return v;
}

export function getAttachmentID(params) {
    if (!isDictionary(params) || !("attachment_id" in params)) throw MissingAttachmentID(params);
    const v = params.attachment_id;
    if (!v || !isString(v)) throw InvalidAttachmentID(params);
    return v;
}

export function getTxid(params) {
    if (!isDictionary(params) || !("txid" in params)) throw MissingTxid(params);
    const v = params.txid;
    if (!v || !isString(v)) throw InvalidTxid(params);
    return v;
}

/** vout is optional. When present it must be an integer (numeric strings pass), else -204. */
export function getVout(params) {
    if (!isDictionary(params) || !("vout" in params)) return undefined;
    const v = params.vout;
    if (!isNumberLike(v)) throw InvalidVout(params);
    return Number(v);
}

export function getAck(params) {
    if (!isDictionary(params) || !("ack" in params)) throw MissingAck(params);
    const v = params.ack;
    if (!isBoolean(v)) throw InvalidAck(params);
    return v;
}

/**
 * NOTE: on a multipart upload `params` arrives as a JSON STRING, not an object. The official
 * server parses it once in the router; without this step every consignment.post fails.
 */
export function normalizeParams(params) {
    if (isString(params)) {
        try { return JSON.parse(params); } catch { return params; }
    }
    return params;
}
