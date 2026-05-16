import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  introspectWorkflow,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { encryptApiKey, makeSignedRequest } from "./helpers";
import { loadFixture } from "./helpers/fixture";

describe("LlmRelayWorkflow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("calls OpenRouter, truncates reasoning, and delivers the callback", async () => {
    const [orEntry] = loadFixture("openrouter/simple-response");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      // First call: OpenRouter response
      .mockImplementationOnce(
        async () =>
          new Response(orEntry.body, {
            status: orEntry.status,
            headers: orEntry.headers,
          }),
      )
      // Second call: callback delivery
      .mockImplementationOnce(async () => new Response("", { status: 200 }));

    const encryptedApiKey = await encryptApiKey("sk-or-test-key");
    const introspector = await introspectWorkflow(env.LLM_RELAY);

    try {
      const body = JSON.stringify({
        requestId: crypto.randomUUID(),
        openrouter: {
          model: "openai/gpt-4o-mini",
          input: [{ role: "user", content: "hello" }],
        },
        encryptedApiKey,
      });
      const req = await makeSignedRequest(body);
      const ctx = createExecutionContext();
      const resp = await worker.fetch(req, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(resp.status).toBe(202);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[0][0]).toBe(
        "https://openrouter.ai/api/v1/responses",
      );
      expect(fetchSpy.mock.calls[1][0]).toBe(env.CALLBACK_URL);

      const callbackBody = JSON.parse(
        fetchSpy.mock.calls[1][1]?.body as string,
      ) as {
        requestId: string;
        response: { status: number; gzip_body: string };
      };
      expect(callbackBody.response.status).toBe(200);
      expect(typeof callbackBody.response.gzip_body).toBe("string");
    } finally {
      await introspector.dispose();
    }
  });

  it("sends decrypt_failed callback when the API key cannot be decrypted", async () => {
    const callbackSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const introspector = await introspectWorkflow(env.LLM_RELAY);

    try {
      // iv = 12 zero bytes (valid base64), ct = 16 zero bytes (valid base64, wrong tag)
      const body = JSON.stringify({
        requestId: crypto.randomUUID(),
        openrouter: {
          model: "openai/gpt-4o-mini",
          input: [{ role: "user", content: "hello" }],
        },
        encryptedApiKey: {
          iv: "AAAAAAAAAAAAAAAA",
          ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      });
      const req = await makeSignedRequest(body);
      const ctx = createExecutionContext();
      await worker.fetch(req, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(callbackSpy).toHaveBeenCalledTimes(1);
      const callbackBody = JSON.parse(
        callbackSpy.mock.calls[0][1]?.body as string,
      ) as { error: { type: string } };
      expect(callbackBody.error.type).toBe("decrypt_failed");
    } finally {
      await introspector.dispose();
    }
  });

  it("sends transport_error callback when OpenRouter is unreachable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      // 4 OpenRouter failures: 1 initial attempt + 3 retries
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      // callback delivery
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const encryptedApiKey = await encryptApiKey("sk-or-test-key");
    const introspector = await introspectWorkflow(env.LLM_RELAY);

    try {
      const body = JSON.stringify({
        requestId: crypto.randomUUID(),
        openrouter: {
          model: "openai/gpt-4o-mini",
          input: [{ role: "user", content: "hello" }],
        },
        encryptedApiKey,
      });
      const req = await makeSignedRequest(body);
      const ctx = createExecutionContext();
      await worker.fetch(req, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(fetchSpy).toHaveBeenCalledTimes(5);
      const callbackBody = JSON.parse(
        fetchSpy.mock.calls[4][1]?.body as string,
      ) as { error: { type: string } };
      expect(callbackBody.error.type).toBe("transport_error");
    } finally {
      await introspector.dispose();
    }
  });

  it("retries on retryable status and delivers response after exhaustion", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const errorBody = JSON.stringify({
      error: { message: "Service Unavailable" },
    });
    fetchSpy
      // 4 OpenRouter 503 responses: 1 initial attempt + 3 retries.
      // Use mockImplementationOnce so each Response is created lazily inside
      // the step's request context — pre-created Response bodies cannot be
      // read across Miniflare's per-retry context boundaries.
      .mockImplementationOnce(
        async () =>
          new Response(errorBody, {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(errorBody, {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(errorBody, {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(errorBody, {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      )
      // callback delivery
      .mockImplementationOnce(async () => new Response("", { status: 200 }));

    const encryptedApiKey = await encryptApiKey("sk-or-test-key");
    const introspector = await introspectWorkflow(env.LLM_RELAY);

    try {
      const body = JSON.stringify({
        requestId: crypto.randomUUID(),
        openrouter: {
          model: "openai/gpt-4o-mini",
          input: [{ role: "user", content: "hello" }],
        },
        encryptedApiKey,
      });
      const req = await makeSignedRequest(body);
      const ctx = createExecutionContext();
      await worker.fetch(req, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(fetchSpy).toHaveBeenCalledTimes(5);
      const callbackBody = JSON.parse(
        fetchSpy.mock.calls[4][1]?.body as string,
      ) as { response: { status: number } };
      expect(callbackBody.response.status).toBe(503);
    } finally {
      await introspector.dispose();
    }
  });

  it("does not retry on non-retryable status and delivers response immediately", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      // 1 OpenRouter 400 — no retries
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ error: "Bad Request" }), {
            status: 400,
          }),
      )
      // callback delivery
      .mockImplementationOnce(async () => new Response("", { status: 200 }));

    const encryptedApiKey = await encryptApiKey("sk-or-test-key");
    const introspector = await introspectWorkflow(env.LLM_RELAY);

    try {
      const body = JSON.stringify({
        requestId: crypto.randomUUID(),
        openrouter: {
          model: "openai/gpt-4o-mini",
          input: [{ role: "user", content: "hello" }],
        },
        encryptedApiKey,
      });
      const req = await makeSignedRequest(body);
      const ctx = createExecutionContext();
      await worker.fetch(req, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      // 1 OpenRouter call (no retries) + 1 callback = 2 total
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const callbackBody = JSON.parse(
        fetchSpy.mock.calls[1][1]?.body as string,
      ) as { response: { status: number } };
      expect(callbackBody.response.status).toBe(400);
    } finally {
      await introspector.dispose();
    }
  });
});
