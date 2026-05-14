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
    const [orEntry] = loadFixture("openrouter/simple-completion");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      // First call: OpenRouter completion
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
          messages: [{ role: "user", content: "hello" }],
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
        "https://openrouter.ai/api/v1/chat/completions",
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
          messages: [{ role: "user", content: "hello" }],
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
      // First call: OpenRouter — network failure
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      // Second call: callback delivery
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const encryptedApiKey = await encryptApiKey("sk-or-test-key");
    const introspector = await introspectWorkflow(env.LLM_RELAY);

    try {
      const body = JSON.stringify({
        requestId: crypto.randomUUID(),
        openrouter: {
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        },
        encryptedApiKey,
      });
      const req = await makeSignedRequest(body);
      const ctx = createExecutionContext();
      await worker.fetch(req, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      const [instance] = introspector.get();
      await instance.waitForStatus("complete");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const callbackBody = JSON.parse(
        fetchSpy.mock.calls[1][1]?.body as string,
      ) as { error: { type: string } };
      expect(callbackBody.error.type).toBe("transport_error");
    } finally {
      await introspector.dispose();
    }
  });
});
