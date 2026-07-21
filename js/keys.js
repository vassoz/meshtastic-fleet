// X25519 key generation for local (per-device) profiles.
//
// Meshtastic's PKI (config.security.private_key/public_key) is a raw
// 32-byte X25519 scalar, matching RFC 7748. WebCrypto's X25519 support
// (confirmed present in Chrome via crypto.subtle.generateKey({name:
// "X25519"}, ...)) does NOT support "raw" export/import for private
// keys -- only "pkcs8". A PKCS8 X25519 private key (RFC 8410) is a fixed
// 16-byte ASN.1 prefix followed by the raw 32-byte scalar, always 48
// bytes total (verified empirically: exportKey("pkcs8", ...) returned
// exactly 48 bytes). Slicing off the last 32 bytes recovers exactly the
// raw scalar the device expects -- a standard technique, not a hack
// specific to this app.
//
// The device always (re)computes its own public key from whatever
// private key it's given (AdminModule.cpp regenerates public_key from
// private_key on write), so this module never needs to derive or verify
// a public key client-side.

import { bytesToBase64, base64ToBytes } from "./util.js";

export async function generatePrivateKeyBase64() {
  const keyPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  if (bytes.length !== 48) {
    throw new Error(`Unexpected PKCS8 X25519 key length ${bytes.length} (expected 48); ` +
      "this browser's WebCrypto X25519 implementation may not match RFC 8410.");
  }
  const scalar = bytes.slice(bytes.length - 32);
  return bytesToBase64(scalar);
}

/** Throws if `b64` doesn't decode to exactly 32 bytes. */
export function validatePrivateKeyBase64(b64) {
  let bytes;
  try {
    bytes = base64ToBytes(b64.trim());
  } catch {
    throw new Error("Not valid base64");
  }
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte key, got ${bytes.length} bytes`);
  }
  return true;
}

export function keyByteLength(b64) {
  try {
    return base64ToBytes(b64.trim()).length;
  } catch {
    return -1;
  }
}
