import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { gzipSync } from "node:zlib";
import { getKeys, setKeys, decryptApiKey } from "./crypto";
import { truncateReasoning, DEFAULT_THINKING_TRUNCATE } from "./truncate";
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

// Shared retry config for all callback-delivery steps.
const CALLBACK_STEP_CONFIG = {
  retries: {
    limit: 3,
    delay: "5 seconds" as const,
    backoff: "exponential" as const,
  },
};

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
 * 2. "call-openrouter"   (default retries)
 *    Calls OpenRouter, truncates reasoning, gzips the response body, and
 *    returns a framed ReadableStream<Uint8Array>:
 *      <JSON header line>\n<gzip bytes>
 *    Using a stream bypasses the 1 MiB step-return-value limit.
 *
 * 3. "send-callback"   (3 retries, exponential backoff)
 *    Reads the stream, parses the header, then delivers the chunked gzip
 *    callback via CallbackClient.send(). Each chunk is a base64-encoded
 *    slice of the compressed body (≤1.5 MiB raw bytes per chunk).
 *
 * Outer try/catch
 * ───────────────
 * Any unexpected throw that escapes the steps is caught here; a single
 * `internal_error` callback is attempted (send failure swallowed) before
 * re-throwing so the Workflow ends in the `errored` state.
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

    try {
      // ------------------------------------------------------------------
      // Step 1: decrypt the OpenRouter API key
      // ------------------------------------------------------------------
      const apiKey = await step.do(
        "decrypt-key",
        CALLBACK_STEP_CONFIG,
        async () => {
          try {
            const { aes } =
              getKeys() ?? (await setKeys(this.env.SHARED_SECRET));
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
      const resultStream = await step.do(
        "call-openrouter",
        async (): Promise<ReadableStream<Uint8Array>> => {
          const client = new OpenRouterClient(apiKey);
          const result = await client.complete(openrouterPayload);

          let headerBytes: Uint8Array;
          let gzipBytes: Uint8Array;

          if ("transportError" in result) {
            headerBytes = new TextEncoder().encode(
              JSON.stringify({ transportError: result.transportError }),
            );
            gzipBytes = new Uint8Array(0);
          } else {
            const body = truncateReasoning(
              result.body,
              truncateThinkingMaxChars ?? DEFAULT_THINKING_TRUNCATE,
            ).text;
            headerBytes = new TextEncoder().encode(
              JSON.stringify({
                status: result.status,
                headers: result.headers,
              }),
            );
            gzipBytes = gzipSync(new TextEncoder().encode(body));
          }

          // Frame: <JSON header bytes> + 0x0a (newline) + <gzip bytes>
          const frame = new Uint8Array(
            headerBytes.length + 1 + gzipBytes.length,
          );
          frame.set(headerBytes);
          frame[headerBytes.length] = 0x0a;
          frame.set(gzipBytes, headerBytes.length + 1);

          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(frame);
              controller.close();
            },
          });
        },
      );

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
    } catch (e) {
      // Attempt to notify the caller before the workflow errors.
      // Send failure is swallowed so the original error is always re-thrown.
      await callback.send({
        requestId,
        error: { type: "internal_error", message: String(e) },
      });
      throw e;
    }
  }
}
