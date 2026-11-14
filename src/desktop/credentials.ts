// Copyright OpenMausBot contributors. Apache-2.0; see third_party/OpenMausBot-LICENSE.
import { Buffer } from "buffer";
import { sha256 as hash } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { equalBytes } from "@noble/ciphers/utils.js";
const B64U = /^[A-Za-z0-9_-]*$/;

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Strict: unpadded URL-safe alphabet only, and canonical (re-encoding gives the same text). Node's own decoder
 * skips characters it does not know, which would let two spellings mean one value. */
export function fromB64u(text: string): Buffer | null {
  if (!B64U.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return b64u(bytes) === text ? bytes : null;
}

export const sha256 = (bytes: Uint8Array | string): Buffer => Buffer.from(hash(typeof bytes === "string" ? Buffer.from(bytes) : bytes));
export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Buffer => Buffer.from(hmac(hash, key, message));

/** Full-length and constant-time; different lengths are simply unequal. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && equalBytes(a, b);
}

export const KEY_ID_BYTES = 16;
export const HOST_ID_BYTES = 16;

const PSK_LABEL = Buffer.from("omb-e2e psk v1", "utf8");
const ADMISSION_LABEL = Buffer.from("omb-relay admission v1", "utf8");

/** `SHA256(cred)`: the raw digest of the token's UTF-8 bytes. The desktop stores its hex as `tokenHash`. */
export const credentialHash = (token: string): Buffer => sha256(Buffer.from(token, "utf8"));

/** Accepts the stored hex form; null for anything that is not 64 hex characters. */
export function credentialHashFromHex(hex: string): Buffer | null {
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

export const keyId = (transportPublicKey: Uint8Array): Buffer => sha256(transportPublicKey).subarray(0, KEY_ID_BYTES);

export const psk = (credHash: Uint8Array, transportKeyId: Uint8Array): Buffer =>
  hmacSha256(credHash, Buffer.concat([PSK_LABEL, transportKeyId]));

export const admission = (credHash: Uint8Array, hostId: Uint8Array): Buffer =>
  hmacSha256(credHash, Buffer.concat([ADMISSION_LABEL, hostId]));

/** What the host puts in its relay admission set, and all the relay ever stores. */
export const admissionHash = (adm: Uint8Array): string => b64u(sha256(adm));

