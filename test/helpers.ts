import { signOutbound } from "../src/auth";

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
