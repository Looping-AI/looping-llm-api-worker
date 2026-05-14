/**
 * Inbound HMAC verification and outbound HMAC signing for the /relay endpoint.
 *
 * Inbound signature scheme:
 *   X-Signature: sha256=<lower-case hex>
 *   X-Timestamp:  <unix seconds>
 *   Signed message: `${X-Timestamp}.${rawBody}`
 *
 * Outbound uses the same scheme applied to the serialised callback body.
 */

import { getKeys, setKeys, signHmac, verifyHmac } from "./crypto";

/** Maximum allowed clock skew between caller and worker, in seconds. */
export const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verifies the HMAC signature on an inbound request.
 *
 * @param headers  - The request headers (read-only).
 * @param rawBody  - The raw request body string (must be read before this call).
 * @param secret   - The raw SHARED_SECRET value from env.
 */
export async function verifyInboundSignature(
  headers: Headers,
  rawBody: string,
  secret: string,
): Promise<VerifyResult> {
  const sigHeader = headers.get("x-signature");
  const tsHeader = headers.get("x-timestamp");

  if (!sigHeader || !tsHeader) {
    return { ok: false, reason: "missing X-Signature or X-Timestamp header" };
  }

  // Validate timestamp format and skew
  const ts = Number(tsHeader);
  if (!Number.isInteger(ts) || ts <= 0) {
    return { ok: false, reason: "invalid X-Timestamp" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: "X-Timestamp outside acceptable window" };
  }

  // Strip the "sha256=" prefix
  const prefix = "sha256=";
  if (!sigHeader.startsWith(prefix)) {
    return { ok: false, reason: "X-Signature must begin with 'sha256='" };
  }
  const hexSig = sigHeader.slice(prefix.length);

  const { hmac } = getKeys() ?? await setKeys(secret);
  const message = `${ts}.${rawBody}`;
  const valid = await verifyHmac(hmac, message, hexSig);

  if (!valid) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}

export interface OutboundSignature {
  signature: string; // full header value, e.g. "sha256=abc123..."
  timestamp: number; // unix seconds used for signing
}

/**
 * Signs an outbound callback body.
 * Returns the value to set on `X-Signature` and `X-Timestamp` headers.
 *
 * @param rawBody - The serialised JSON string that will be sent as the POST body.
 * @param secret  - The raw SHARED_SECRET value from env.
 */
export async function signOutbound(
  rawBody: string,
  secret: string,
): Promise<OutboundSignature> {
  const timestamp = Math.floor(Date.now() / 1000);
  const { hmac } = getKeys() ?? await setKeys(secret);
  const hex = await signHmac(hmac, `${timestamp}.${rawBody}`);
  return { signature: `sha256=${hex}`, timestamp };
}
