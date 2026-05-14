import { signOutbound } from "../src/auth";
import { b64encode } from "../src/crypto";
import type { EncryptedApiKey } from "../src/crypto";

/** Shared secret injected by vitest.config.mts miniflare.bindings. */
export const TEST_SECRET = "test-secret";

export interface RequestOverrides {
  signature?: string;
  timestamp?: number | string;
  contentType?: string;
}

/**
 * Builds a valid signed `POST /relay` Request.
 * Override individual headers to exercise rejection branches.
 */
export async function makeSignedRequest(
  body: string,
  overrides: RequestOverrides = {},
): Promise<Request> {
  const { signature, timestamp, contentType = "application/json" } = overrides;

  const { signature: sig, timestamp: ts } = await signOutbound(
    body,
    TEST_SECRET,
  );

  const headers = new Headers({ "content-type": contentType });
  headers.set("x-signature", signature ?? sig);
  headers.set("x-timestamp", String(timestamp ?? ts));

  return new Request("http://localhost/relay", {
    method: "POST",
    headers,
    body,
  });
}

/**
 * Encrypts a plaintext API key using AES-256-GCM with a key derived from
 * `secret` via HKDF-SHA-256 (same derivation as the production `setKeys`).
 * Use this in tests to create valid `EncryptedApiKey` payloads.
 */
export async function encryptApiKey(
  plaintext: string,
  secret: string = TEST_SECRET,
): Promise<EncryptedApiKey> {
  const secretBytes = new TextEncoder().encode(secret);
  const hkdfBase = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );
  const aes = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("openrouter-key-v1"),
    },
    hkdfBase,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aes,
    new TextEncoder().encode(plaintext),
  );
  return {
    iv: b64encode(iv),
    ct: b64encode(new Uint8Array(ct)),
  };
}
