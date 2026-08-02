import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

import { expect, it } from "vitest";

import {
  ATTUNEGRAPH_PROJECTION_ENCODING,
  MAX_ENCODED_PROJECTION_BYTES,
  MAX_UNCOMPRESSED_PROJECTION_BYTES,
  decodeAttuneGraphProjectionJson,
  encodeAttuneGraphProjectionJson
} from "./attunegraph-projection-codec.mjs";

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

it("roundtrips exact canonical JSON bytes with explicit physical metadata", () => {
  const json = JSON.stringify({ canon: "자료/é/😀", exact: true });
  const encoded = encodeAttuneGraphProjectionJson(json);

  expect(encoded).toMatchObject({
    encoding: "deflate-raw@1",
    payloadFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    uncompressedBytes: Buffer.byteLength(json, "utf8")
  });
  expect(encoded.payloadFingerprint).toHaveLength(71);
  expect(decodeAttuneGraphProjectionJson(encoded)).toBe(json);
});

it("retains the full v1 uncompressed capacity under the conservative deflate bound", () => {
  expect(MAX_ENCODED_PROJECTION_BYTES).toBe(1_048_909);
  let state = 0x9e3779b9;
  const chunks: string[] = [];
  for (let index = 0; index < MAX_UNCOMPRESSED_PROJECTION_BYTES / 64; index += 1) {
    let chunk = "";
    for (let offset = 0; offset < 64; offset += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      chunk += String.fromCharCode(0x21 + ((state >>> 0) % 94));
    }
    chunks.push(chunk);
  }
  const nearMaximum = chunks.join("");
  const encoded = encodeAttuneGraphProjectionJson(nearMaximum);
  expect(Buffer.byteLength(nearMaximum, "utf8")).toBe(MAX_UNCOMPRESSED_PROJECTION_BYTES);
  expect(encoded.payload.byteLength).toBeLessThanOrEqual(MAX_ENCODED_PROJECTION_BYTES);
  expect(decodeAttuneGraphProjectionJson(encoded)).toBe(nearMaximum);
});

it("rejects unknown encodings, corruption, bombs, invalid UTF-8, and trailing bytes", () => {
  const source = Buffer.from('{"exact":true}', "utf8");
  const valid = encodeAttuneGraphProjectionJson(source.toString("utf8"));
  expect(() => decodeAttuneGraphProjectionJson({ ...valid, encoding: "future@9" }))
    .toThrow("unsupported");

  const corrupt = Buffer.from(valid.payload);
  corrupt[0] = corrupt[0]! ^ 0xff;
  expect(() => decodeAttuneGraphProjectionJson({ ...valid, payload: corrupt }))
    .toThrow("fingerprint does not match");

  const trailing = Buffer.concat([valid.payload, Buffer.from([0xde, 0xad])]);
  expect(() => decodeAttuneGraphProjectionJson({
    ...valid,
    payload: trailing,
    payloadFingerprint: sha256(trailing)
  })).toThrow("trailing or incoherent bytes");

  const bomb = deflateRawSync(Buffer.alloc(1_024, 0x61), { level: 1 });
  expect(() => decodeAttuneGraphProjectionJson({
    encoding: ATTUNEGRAPH_PROJECTION_ENCODING,
    payload: bomb,
    payloadFingerprint: sha256(bomb),
    uncompressedBytes: 8
  })).toThrow("decompression failed");

  const invalidUtf8 = deflateRawSync(Buffer.from([0xff]), { level: 1 });
  expect(() => decodeAttuneGraphProjectionJson({
    encoding: ATTUNEGRAPH_PROJECTION_ENCODING,
    payload: invalidUtf8,
    payloadFingerprint: sha256(invalidUtf8),
    uncompressedBytes: 1
  })).toThrow("exact UTF-8");
});
