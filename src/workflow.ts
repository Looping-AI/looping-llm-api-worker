import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
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

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/**
 * LlmRelayWorkflow
 *
 * Step structure
 * ──────────────
 * 1. "decrypt-key"   (no retries)
 *    Decrypts the caller-supplied OpenRouter API key. On failure, emits a
 *    `decrypt_failed` callback (inline retry loop) and ends the workflow
 *    successfully so no further action is taken.
 *
 * 2. "call-and-respond"   (no step-level retries)
 *    Calls OpenRouter, truncates reasoning fields, then sends the callback
 *    envelope in ≤1.5 MiB chunks via an inline retry loop (5×, exponential).
 *    Combining the OpenRouter call and the callback delivery in a single step
 *    avoids passing potentially large response bodies through Workflow state
 *    (which is capped at 1 MiB per step return value).
 *
 * Outer try/catch
 * ───────────────
 * Any unexpected throw that escapes the steps is caught here; a best-effort
 * `internal_error` callback is attempted before re-throwing so the Workflow
 * ends in the `errored` state.
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
      const apiKey = await step.do("decrypt-key", async () => {
        try {
          const { aes } = getKeys() ?? (await setKeys(this.env.SHARED_SECRET));
          return await decryptApiKey(aes, encryptedApiKey);
        } catch (e) {
          // Emit decrypt_failed callback with inline retries, then signal
          // the outer run() to exit cleanly by returning null.
          await callback.sendWithRetry({
            requestId,
            error: { type: "decrypt_failed", message: String(e) },
          });
          return null;
        }
      });

      if (apiKey === null) return;

      // ------------------------------------------------------------------
      // Step 2: call OpenRouter, truncate reasoning, send chunked callback
      // ------------------------------------------------------------------
      await step.do("call-and-respond", async () => {
        const client = new OpenRouterClient(apiKey);
        const result = await client.complete(openrouterPayload);

        if ("transportError" in result) {
          await callback.sendWithRetry({
            requestId,
            error: { type: "transport_error", message: result.transportError },
          });
        } else {
          const body = truncateReasoning(
            result.body,
            truncateThinkingMaxChars ?? DEFAULT_THINKING_TRUNCATE,
          ).text;
          await callback.sendWithRetry({
            requestId,
            response: {
              status: result.status,
              headers: result.headers,
              body,
            },
          });
        }
      });
    } catch (e) {
      // Best-effort: attempt to notify the caller before the workflow errors.
      await callback.sendBestEffort({
        requestId,
        error: { type: "internal_error", message: String(e) },
      });
      throw e;
    }
  }
}
