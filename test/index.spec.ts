import { describe, it, expect } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { makeSignedRequest, TEST_SECRET } from "./helpers";
import { signOutbound } from "../src/auth";
import { MAX_TIMESTAMP_SKEW_SECONDS } from "../src/auth";
import worker from "../src/index";

// ---------------------------------------------------------------------------
// Minimal valid body fixture
// ---------------------------------------------------------------------------

const VALID_BODY = JSON.stringify({
  requestId: "req-001",
  openrouter: {
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  },
  encryptedApiKey: {
    iv: "AAAAAAAAAAAAAAAA",
    ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
});

// ---------------------------------------------------------------------------
// Helper: dispatch a fetch to the worker using Miniflare bindings
// ---------------------------------------------------------------------------

async function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const ctx = createExecutionContext();
  const resp = await worker.fetch(req, env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return resp;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("routing", () => {
  it("returns 404 for GET /relay", async () => {
    const resp = await doFetch("http://localhost/relay", { method: "GET" });
    expect(resp.status).toBe(404);
  });

  it("returns 404 for POST to an unknown path", async () => {
    const resp = await doFetch("http://localhost/unknown", {
      method: "POST",
    });
    expect(resp.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Content-type
// ---------------------------------------------------------------------------

describe("POST /relay - content-type", () => {
  it("returns 415 when content-type is not application/json", async () => {
    const req = await makeSignedRequest(VALID_BODY, {
      contentType: "text/plain",
    });
    const resp = await doFetch(req);
    expect(resp.status).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("POST /relay - authentication", () => {
  it("returns 401 when auth headers are missing", async () => {
    const resp = await doFetch("http://localhost/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VALID_BODY,
    });
    expect(resp.status).toBe(401);
  });

  it("returns 401 for a timestamp outside the acceptable window", async () => {
    const staleTs =
      Math.floor(Date.now() / 1000) - MAX_TIMESTAMP_SKEW_SECONDS - 60;
    const req = await makeSignedRequest(VALID_BODY, { timestamp: staleTs });
    const resp = await doFetch(req);
    expect(resp.status).toBe(401);
  });

  it("returns 401 when the signature does not match", async () => {
    const { timestamp } = await signOutbound(VALID_BODY, TEST_SECRET);
    const req = await makeSignedRequest(VALID_BODY, {
      signature:
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      timestamp,
    });
    const resp = await doFetch(req);
    expect(resp.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe("POST /relay - body validation", () => {
  it("returns 400 for invalid JSON", async () => {
    const bad = "not-json{{";
    const req = await makeSignedRequest(bad);
    const resp = await doFetch(req);
    expect(resp.status).toBe(400);
  });

  it("returns 400 when requestId is missing", async () => {
    const body = JSON.stringify({
      openrouter: { messages: [] },
      encryptedApiKey: { iv: "a", ct: "b" },
    });
    const req = await makeSignedRequest(body);
    const resp = await doFetch(req);
    expect(resp.status).toBe(400);
  });

  it("returns 400 when openrouter.messages is missing", async () => {
    const body = JSON.stringify({
      requestId: "r1",
      openrouter: { model: "x" }, // no messages array
      encryptedApiKey: { iv: "a", ct: "b" },
    });
    const req = await makeSignedRequest(body);
    const resp = await doFetch(req);
    expect(resp.status).toBe(400);
  });

  it("returns 400 when encryptedApiKey is missing", async () => {
    const body = JSON.stringify({
      requestId: "r1",
      openrouter: { messages: [] },
    });
    const req = await makeSignedRequest(body);
    const resp = await doFetch(req);
    expect(resp.status).toBe(400);
  });

  it("returns 400 when truncate_thinking_to_max_chars is not a positive integer", async () => {
    const body = JSON.stringify({
      requestId: "r1",
      openrouter: { messages: [] },
      encryptedApiKey: { iv: "a", ct: "b" },
      truncate_thinking_to_max_chars: -5,
    });
    const req = await makeSignedRequest(body);
    const resp = await doFetch(req);
    expect(resp.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("POST /relay - success", () => {
  it("returns 202 with ok, instanceId, requestId for a valid request", async () => {
    // Use unit style (direct worker.fetch) with a stubbed LLM_RELAY binding so
    // no real Workflow is created and Miniflare isolated storage stays clean.
    const mockEnv = {
      SHARED_SECRET: TEST_SECRET,
      CALLBACK_URL: "https://test-callback.invalid/cb",
      LLM_RELAY: {
        create: async () => ({ id: "test-instance-id" }),
      },
    };

    const req = await makeSignedRequest(VALID_BODY);
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, mockEnv as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);

    expect(resp.status).toBe(202);
    const json = (await resp.json()) as {
      ok: boolean;
      instanceId: string;
      requestId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.instanceId).toBe("test-instance-id");
    expect(json.requestId).toBe("req-001");
  });
});
