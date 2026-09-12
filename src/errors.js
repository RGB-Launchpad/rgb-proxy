/**
 * Error codes, one for one with the reference implementation, RGB-Tools/rgb-proxy-server.
 *
 * NOTE: clients may branch on the code, so both the code and the message have to match the
 * official server exactly.
 */

export class RpcError extends Error {
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data ?? {};
    }
    toJSON() {
        return { code: this.code, message: this.message, data: this.data };
    }
}

const mk = (code, message) => (data) => new RpcError(code, message, data);

export const CannotChangeAck = mk(-100, "Cannot change ACK");
export const CannotChangeUploadedFile = mk(-101, "Cannot change uploaded file");
export const InvalidAck = mk(-200, "Invalid ACK");
export const InvalidAttachmentID = mk(-201, "Invalid attachment ID");
export const InvalidRecipientID = mk(-202, "Invalid recipient ID");
export const InvalidTxid = mk(-203, "Invalid TXID");
export const InvalidVout = mk(-204, "Invalid vout");
export const MissingAck = mk(-300, "Missing ACK");
export const MissingAttachmentID = mk(-301, "Missing attachment ID");
export const MissingRecipientID = mk(-302, "Missing recipient ID");

// NOTE: upstream reuses -303 for both MissingFile and MissingTxid. Copied as is, because
// clients may branch on the code; only the message tells the two apart.
export const MissingFile = mk(-303, "Missing file");
export const MissingTxid = mk(-303, "Missing TXID");

export const NotFoundConsignment = mk(-400, "Consignment file not found");
export const NotFoundMedia = mk(-401, "Media file not found");

export const MethodNotFound = mk(-32601, "Method not found");
export const InvalidRequest = mk(-32600, "Invalid Request");
export const InternalError = mk(-32603, "Internal error");
