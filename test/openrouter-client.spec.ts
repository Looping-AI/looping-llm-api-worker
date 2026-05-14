import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenRouterClient,
  extractAllowedHeaders,
} from "../src/openrouter-client";
import { useFixture } from "./helpers/fixture";

describe("extractAllowedHeaders", () => {
  it("keeps content-type, x-request-id, openrouter-*, x-openrouter-*", () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-request-id": "req-123",
      "openrouter-model": "gpt-4o",
      "x-openrouter-credits": "42",
      "cf-ray": "should-be-dropped",
      server: "should-be-dropped",
    });
    const result = extractAllowedHeaders(headers);
    expect(result).toEqual({
      "content-type": "application/json",
      "x-request-id": "req-123",
      "openrouter-model": "gpt-4o",
      "x-openrouter-credits": "42",
    });
  });
});

describe("OpenRouterClient", () => {
  describe("complete()", () => {
    it("returns status, allowed headers, and body on success", async () => {
      const recording = useFixture("openrouter/simple-completion");
      try {
        // In record mode the real API key is required; in replay mode the
        // value doesn't matter because useFixture mocks globalThis.fetch.
        const apiKey = process.env.TEST_OPENROUTER_API_KEY ?? "sk-test-key";
        const client = new OpenRouterClient(apiKey);
        const result = await client.complete({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Say hello in one word." }],
        });

        expect(result.status).toBe(200);
        expect(result.headers).toHaveProperty("content-type");
        expect(typeof result.body).toBe("string");
        expect(result.body.length).toBeGreaterThan(0);

        // Verify only allowed headers are present
        for (const key of Object.keys(result.headers)) {
          expect(
            key === "content-type" ||
              key === "x-request-id" ||
              key.startsWith("openrouter-") ||
              key.startsWith("x-openrouter-"),
          ).toBe(true);
        }
      } finally {
        await recording.stop();
      }
    });

    it("throws when the network call fails", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new TypeError("Network connection refused"),
      );

      const client = new OpenRouterClient("sk-test-key");
      await expect(
        client.complete({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      ).rejects.toThrow("Network connection refused");
    });
  });

  afterEach(() => vi.restoreAllMocks());
});
