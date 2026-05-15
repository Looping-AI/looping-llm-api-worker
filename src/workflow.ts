import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { gzipSync } from "node:zlib";
import { getKeys, setKeys, decryptApiKey } from "./crypto";
import { truncateReasoning } from "./truncate";
import { OpenRouterClient } from "./openrouter-client";
import { CallbackClient } from "./callback-client";
import type { EncryptedApiKey } from "./crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Params {
  openrouterPayload: Record<string, unknown>;
  encryptedApiKey: EncryptedApiKey;
  truncateThinkingMaxChars: number;
}

// HTTP status codes from OpenRouter / upstream that are worth retrying.
const RETRYABLE = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compresses a text string to gzip bytes. */
function toGzip(text: string): Uint8Array {
  return gzipSync(new TextEncoder().encode(text));
}

/**
 * Builds the Step 2 → Step 3 wire format:
 *   <JSON header bytes> + 0x0a + <gzip body bytes>
 * and wraps it in a single-chunk ReadableStream<Uint8Array>.
 */
function makeStream(
  header: object,
  gzipBody: Uint8Array = new Uint8Array(0),
): ReadableStream<Uint8Array> {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(headerBytes.length + 1 + gzipBody.length);
  frame.set(headerBytes);
  frame[headerBytes.length] = 0x0a;
  frame.set(gzipBody, headerBytes.length + 1);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/**
 * LlmRelayWorkflow
 *
 * Step structure
 * ──────────────
 * 1. "decrypt-key"   (3 retries, exponential backoff)
 *    Decrypts the caller-supplied OpenRouter API key. On failure, emits a
 *    `decrypt_failed` callback and returns null. Retries serve the callback
 *    delivery — decryption itself fails deterministically on a bad key.
 *
 * 2. "call-openrouter"   (3 retries, exponential backoff)
 *    Calls OpenRouter, truncates reasoning, gzips the response body, and
 *    returns a framed ReadableStream<Uint8Array>:
 *      <JSON header line>\n<gzip bytes>
 *    Using a stream bypasses the 1 MiB step-return-value limit.
 *    Throws for transport errors and RETRYABLE status codes so Cloudflare
 *    manages retries. On exhaustion the throw is caught outside the step;
 *    the error is encoded in the frame and Step 3 delivers it as a callback.
 *
 * 3. "send-callback"   (3 retries, exponential backoff)
 *    Reads the stream, parses the header, then delivers the chunked gzip
 *    callback via CallbackClient.send(). Each chunk is a base64-encoded
 *    slice of the compressed body (≤1.5 MiB raw bytes per chunk).
 */
export class LlmRelayWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { openrouterPayload, encryptedApiKey, truncateThinkingMaxChars } =
      event.payload;
    const requestId = event.instanceId;
    const callback = new CallbackClient(
      this.env.CALLBACK_URL,
      this.env.SHARED_SECRET,
    );

    // Retry delay: number (ms) from env in tests; "5 seconds" string in production.
    const retryDelay = this.env.STEP_RETRY_DELAY
      ? Number(this.env.STEP_RETRY_DELAY)
      : ("5 seconds" as const);
    const CALLBACK_STEP_CONFIG = {
      retries: { limit: 3, delay: retryDelay, backoff: "exponential" as const },
    };

    // ------------------------------------------------------------------
    // Step 1: decrypt the OpenRouter API key
    // ------------------------------------------------------------------
    const apiKey = await step.do(
      "decrypt-key",
      CALLBACK_STEP_CONFIG,
      async () => {
        try {
          const { aes } = getKeys() ?? (await setKeys(this.env.SHARED_SECRET));
          return await decryptApiKey(aes, encryptedApiKey);
        } catch (e) {
          // Decryption is deterministic — retries serve only the send below.
          await callback.send({
            requestId,
            error: { type: "decrypt_failed", message: String(e) },
          });
          return null;
        }
      },
    );

    if (apiKey === null) return;

    // ------------------------------------------------------------------
    // Step 2: call OpenRouter, truncate reasoning, gzip, return stream
    // ------------------------------------------------------------------
    let resultStream: ReadableStream<Uint8Array>;
    try {
      resultStream = await step.do(
        "call-openrouter",
        CALLBACK_STEP_CONFIG,
        async (): Promise<ReadableStream<Uint8Array>> => {
          const client = new OpenRouterClient(apiKey);
          const result = await client.complete(openrouterPayload);

          if (RETRYABLE.has(result.status)) {
            // Encode the full response in the message so it survives
            // Workflow hibernation between retry attempts.
            throw new Error(
              `RETRYABLE_STATUS:${JSON.stringify({
                status: result.status,
                headers: result.headers,
                body: result.body,
              })}`,
            );
          }

          try {
            return makeStream(
              { status: result.status, headers: result.headers },
              toGzip(
                truncateReasoning(result.body, truncateThinkingMaxChars).text,
              ),
            );
          } catch (e) {
            return makeStream({ parseError: String(e) });
          }
        },
      );
    } catch (e) {
      // All retries exhausted — synthesize an error frame so Step 3 can
      // still deliver a structured callback to the caller.
      const msg = e instanceof Error ? e.message : String(e);

      if (msg.startsWith("RETRYABLE_STATUS:")) {
        // Retryable HTTP status: pass the actual response through.
        try {
          const { status, headers, body } = JSON.parse(
            msg.slice("RETRYABLE_STATUS:".length),
          ) as {
            status: number;
            headers: Record<string, string>;
            body: string;
          };
          resultStream = makeStream({ status, headers }, toGzip(body));
        } catch {
          // Parsing failed — fall back to a parse error frame.
          resultStream = makeStream({ parseError: msg });
        }
      } else {
        // Transport error (network failure, etc.).
        resultStream = makeStream({ transportError: msg });
      }
    }

    // ------------------------------------------------------------------
    // Step 3: read stream, chunk gzip body, send callback
    // ------------------------------------------------------------------
    await step.do("send-callback", CALLBACK_STEP_CONFIG, async () => {
      const bytes = new Uint8Array(
        await new Response(resultStream).arrayBuffer(),
      );
      const newlineIdx = bytes.indexOf(0x0a);
      const header = JSON.parse(
        new TextDecoder().decode(bytes.slice(0, newlineIdx)),
      ) as Record<string, unknown>;
      const gzipBytes = bytes.slice(newlineIdx + 1);

      if ("transportError" in header) {
        await callback.send({
          requestId,
          error: {
            type: "transport_error",
            message: String(header.transportError),
          },
        });
      } else if ("parseError" in header) {
        await callback.send({
          requestId,
          error: {
            type: "response_parse_error",
            message: String(header.parseError),
          },
        });
      } else {
        await callback.send({
          requestId,
          response: {
            status: header.status as number,
            headers: header.headers as Record<string, string>,
            gzip_body: gzipBytes,
          },
        });
      }
    });
  }
}
