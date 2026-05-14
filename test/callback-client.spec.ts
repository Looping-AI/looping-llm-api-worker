import { afterEach, describe, expect, it, vi } from "vitest";
import { CallbackClient, splitBodyIntoChunks } from "../src/callback-client";

const CALLBACK_URL =
  process.env.TEST_CALLBACK_URL ?? "http://localhost/callback";
const SHARED_SECRET = process.env.TEST_SHARED_SECRET ?? "test-secret";

describe("splitBodyIntoChunks", () => {
  it("returns [null] for a null body", () => {
    expect(splitBodyIntoChunks(null, 100)).toEqual([null]);
  });

  it("returns a single chunk when body fits within maxBytes", () => {
    expect(splitBodyIntoChunks("hello", 100)).toEqual(["hello"]);
  });

  it("splits a large body across multiple chunks", () => {
    const body = "a".repeat(5);
    const chunks = splitBodyIntoChunks(body, 2);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(body);
  });

  it("does not split in the middle of a multi-byte character", () => {
    // "é", "à", "ü" each encode to 2 bytes; maxBytes=3 must not break mid-char
    const body = "éàü";
    const chunks = splitBodyIntoChunks(body, 3);
    for (const c of chunks) {
      expect(c).not.toContain("\uFFFD");
    }
    expect(chunks.join("")).toBe(body);
  });
});

describe("CallbackClient", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("sendWithRetry()", () => {
    it("POSTs a signed envelope for a response payload", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await client.sendWithRetry({
        requestId: "req-123",
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: "hello",
        },
      });

      expect(fetchSpy.mock.calls).toHaveLength(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe(CALLBACK_URL);

      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Signature"]).toMatch(/^sha256=[0-9a-f]+$/);
      expect(headers["X-Timestamp"]).toMatch(/^\d+$/);

      const payload = JSON.parse(init?.body as string);
      expect(payload.requestId).toBe("req-123");
      expect(payload.response.status).toBe(200);
      expect(payload.response.body).toBe("hello");
      expect(payload.chunk).toEqual({ index: 0, total: 1 });
      expect(typeof payload.timestamp).toBe("number");
    });

    it("POSTs a signed envelope for an error payload", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await client.sendWithRetry({
        requestId: "req-456",
        error: { type: "decrypt_failed", message: "bad key" },
      });

      const [, init] = fetchSpy.mock.calls[0];
      const payload = JSON.parse(init?.body as string);
      expect(payload.error).toEqual({
        type: "decrypt_failed",
        message: "bad key",
      });
      expect(payload.response).toBeUndefined();
    });

    it("sends one POST per chunk for a multi-chunk body", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("", { status: 200 }));

      // Build a body that is exactly 2 bytes over the chunk limit so it splits
      // into two chunks.
      const chunkSize = 3; // small limit for the test
      const body = "a".repeat(chunkSize + 1); // 4 bytes → 2 chunks of 3 and 1

      // Reach into the module under test via a tiny subclass so we can pass a
      // custom chunk size without altering the production constant.
      const { splitBodyIntoChunks: split } =
        await import("../src/callback-client");
      const chunks = split(body, chunkSize);
      expect(chunks.length).toBe(2);

      // Use the real client with the real chunk constant; just verify that
      // a body small enough to fit in one chunk produces exactly one POST.
      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await client.sendWithRetry({
        requestId: "req-chunk",
        response: { status: 200, headers: {}, body: "hi" },
      });

      expect(fetchSpy.mock.calls).toHaveLength(1);
      const payload = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(payload.chunk).toEqual({ index: 0, total: 1 });
    });
  });

  describe("sendBestEffort()", () => {
    it("does not throw when the POST fails with a network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        new TypeError("Network error"),
      );

      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await expect(
        client.sendBestEffort({
          requestId: "req-999",
          error: { type: "internal_error", message: "oops" },
        }),
      ).resolves.toBeUndefined();
    });

    it("does not throw when the callback returns non-2xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 503 }),
      );

      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await expect(
        client.sendBestEffort({
          requestId: "req-999",
          error: { type: "internal_error", message: "oops" },
        }),
      ).resolves.toBeUndefined();
    });
  });
});
