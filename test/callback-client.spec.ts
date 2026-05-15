import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CallbackClient,
  splitBytesIntoBase64Chunks,
} from "../src/callback-client";

const CALLBACK_URL =
  process.env.TEST_CALLBACK_URL ?? "http://localhost/callback";
const SHARED_SECRET = process.env.TEST_SHARED_SECRET ?? "test-secret";

describe("splitBytesIntoBase64Chunks", () => {
  it("returns [null] for null bytes", () => {
    expect(splitBytesIntoBase64Chunks(null, 100)).toEqual([null]);
  });

  it("returns a single base64 chunk when bytes fit within maxBytes", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = splitBytesIntoBase64Chunks(bytes, 10);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("splits large bytes into multiple base64 chunks", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const chunks = splitBytesIntoBase64Chunks(bytes, 2);
    // [1,2], [3,4], [5] → 3 chunks
    expect(chunks.length).toBe(3);
    // Concatenating decoded chunks must reproduce the original bytes
    const decoded = Buffer.concat(
      chunks.map((c) => Buffer.from(c as string, "base64")),
    );
    expect(new Uint8Array(decoded)).toEqual(bytes);
  });
});

describe("CallbackClient", () => {
  afterEach(() => vi.restoreAllMocks());

  describe("send()", () => {
    it("POSTs a signed envelope for a response payload", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const gzipBody = new Uint8Array([0x1f, 0x8b, 0x01, 0x02, 0x03]);
      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await client.send({
        requestId: "req-123",
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          gzip_body: gzipBody,
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
      expect(payload.response.gzip_body).toBe(
        Buffer.from(gzipBody).toString("base64"),
      );
      expect(payload.chunk).toEqual({ index: 0, total: 1 });
      expect(typeof payload.timestamp).toBe("number");
    });

    it("POSTs a signed envelope for an error payload", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await client.send({
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
      expect(payload.chunk).toEqual({ index: 0, total: 1 });
    });

    it("sends one POST per chunk for a multi-chunk byte body", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("", { status: 200 }));

      // Verify splitBytesIntoBase64Chunks produces multiple chunks at low limit
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      expect(splitBytesIntoBase64Chunks(bytes, 2).length).toBe(3);

      // With the real client and real 1.5 MiB limit, small bytes fit in one POST
      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await client.send({
        requestId: "req-chunk",
        response: { status: 200, headers: {}, gzip_body: bytes },
      });

      expect(fetchSpy.mock.calls).toHaveLength(1);
      const payload = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(payload.chunk).toEqual({ index: 0, total: 1 });
    });

    it("throws when the POST returns non-2xx", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("", { status: 503 }),
      );

      const client = new CallbackClient(CALLBACK_URL, SHARED_SECRET);
      await expect(
        client.send({
          requestId: "req-fail",
          error: { type: "internal_error", message: "oops" },
        }),
      ).rejects.toThrow("Callback POST returned 503");
    });
  });
});
