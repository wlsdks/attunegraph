import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const ATTUNEGRAPH_PROJECTION_ENCODING = "deflate-raw@1";
export const MAX_UNCOMPRESSED_PROJECTION_BYTES = 1_048_576;
// zlib's documented conservative deflateBound formula. The physical payload
// budget must retain every v1-admissible projection even when compression has
// no density benefit.
export const MAX_ENCODED_PROJECTION_BYTES = MAX_UNCOMPRESSED_PROJECTION_BYTES
  + (MAX_UNCOMPRESSED_PROJECTION_BYTES >>> 12)
  + (MAX_UNCOMPRESSED_PROJECTION_BYTES >>> 14)
  + (MAX_UNCOMPRESSED_PROJECTION_BYTES >>> 25)
  + 13;

/** @param {Uint8Array} bytes */
function fingerprint(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** @param {unknown} value @returns {Buffer} */
function exactBytes(value) {
  if (
    !(value instanceof Uint8Array)
    || nodeTypes.isProxy(value)
    || value.byteLength < 1
    || value.byteLength > MAX_ENCODED_PROJECTION_BYTES
  ) throw new TypeError("encoded projection bytes are invalid");
  return Buffer.from(value);
}

/** @param {string} json */
export function encodeAttuneGraphProjectionJson(json) {
  if (typeof json !== "string") throw new TypeError("projection JSON must be text");
  const source = Buffer.from(json, "utf8");
  if (source.byteLength < 1 || source.byteLength > MAX_UNCOMPRESSED_PROJECTION_BYTES) {
    throw new RangeError("projection JSON exceeds the uncompressed byte bound");
  }
  const payload = deflateRawSync(source, { level: 1 });
  if (payload.byteLength < 1 || payload.byteLength > MAX_ENCODED_PROJECTION_BYTES) {
    throw new RangeError("encoded projection exceeds the physical byte bound");
  }
  return Object.freeze({
    encoding: ATTUNEGRAPH_PROJECTION_ENCODING,
    payload,
    payloadFingerprint: fingerprint(payload),
    uncompressedBytes: source.byteLength
  });
}

/**
 * @param {{ readonly encoding: unknown, readonly payload: unknown,
 *   readonly payloadFingerprint: unknown, readonly uncompressedBytes: unknown }} stored
 */
export function decodeAttuneGraphProjectionJson(stored) {
  if (stored?.encoding !== ATTUNEGRAPH_PROJECTION_ENCODING) {
    throw new TypeError("projection encoding is unsupported");
  }
  if (
    !Number.isSafeInteger(stored.uncompressedBytes)
    || /** @type {number} */ (stored.uncompressedBytes) < 1
    || /** @type {number} */ (stored.uncompressedBytes) > MAX_UNCOMPRESSED_PROJECTION_BYTES
  ) throw new RangeError("projection uncompressed byte length is invalid");
  const uncompressedBytes = /** @type {number} */ (stored.uncompressedBytes);
  if (
    typeof stored.payloadFingerprint !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(stored.payloadFingerprint)
  ) throw new TypeError("projection payload fingerprint is invalid");
  const payload = exactBytes(stored.payload);
  if (fingerprint(payload) !== stored.payloadFingerprint) {
    throw new Error("projection payload fingerprint does not match");
  }
  /** @type {{ readonly buffer: Buffer, readonly engine: { readonly bytesWritten: number } }} */
  let decoded;
  try {
    const inflateWithInfo = /** @type {(input: Uint8Array, options: {
     * info: true, maxOutputLength: number
     * }) => { buffer: Buffer, engine: { bytesWritten: number } }} */ (
      /** @type {unknown} */ (inflateRawSync)
    );
    decoded = inflateWithInfo(payload, {
      info: true,
      maxOutputLength: uncompressedBytes
    });
  } catch (cause) {
    throw new Error("projection payload decompression failed", { cause });
  }
  if (
    decoded.engine.bytesWritten !== payload.byteLength
    || decoded.buffer.byteLength !== uncompressedBytes
  ) throw new Error("projection payload has trailing or incoherent bytes");
  const json = decoded.buffer.toString("utf8");
  if (!Buffer.from(json, "utf8").equals(decoded.buffer)) {
    throw new Error("projection payload is not exact UTF-8 JSON bytes");
  }
  return json;
}
