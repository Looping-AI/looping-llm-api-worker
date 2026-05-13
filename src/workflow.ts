import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";
import { getKeys, decryptApiKey } from "./crypto";
import { signOutbound } from "./auth";
import { truncateReasoning, DEFAULT_THINKING_TRUNCATE } from "./truncate";
import type { EncryptedApiKey } from "./crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** 1.5 MiB — maximum UTF-8 byte size of the `body` slice in each callback POST. */
const CALLBACK_BODY_CHUNK_MAX_BYTES = 1_572_864;

const CALLBACK_MAX_RETRIES = 5;
const CALLBACK_INITIAL_DELAY_MS = 5_000;

/**
 * Response headers forwarded verbatim in the callback envelope.
 * Anything not matching these prefixes/names is dropped to avoid leaking
 * Cloudflare-internal headers.
 */
const ALLOWED_HEADER_PREFIXES = [
  "content-type",
  "x-request-id",
  "openrouter-",
  "x-openrouter-",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Params {
  requestId: string;
  openrouterPayload: Record<string, unknown>;
  encryptedApiKey: EncryptedApiKey;
  truncateThinkingMaxChars: number;
}

type CallbackPhase =
  | "openrouter_response"
  | "decrypt_failed"
  | "openrouter_transport_error"
  | "internal_error";

interface CallbackEnvelopeData {
  requestId: string;
  instanceId: string;
  ok: boolean;
  phase: CallbackPhase;
  status: number | null;
  headers: Record<string, string> | null;
  body: string | null;
  error: string | null;
  truncated: boolean;
}

interface CallbackEnvelope extends CallbackEnvelopeData {
  timestamp: number;
  chunkIndex: number;
  chunkTotal: number;
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
    const {
      requestId,
      openrouterPayload,
      encryptedApiKey,
      truncateThinkingMaxChars,
    } = event.payload;
    const instanceId = event.instanceId;

    try {
      // ------------------------------------------------------------------
      // Step 1: decrypt the OpenRouter API key
      // ------------------------------------------------------------------
      const apiKey = await step.do("decrypt-key", async () => {
        try {
          const { aes } = await getKeys(this.env.SHARED_SECRET);
          return await decryptApiKey(aes, encryptedApiKey);
        } catch (e) {
          // Emit decrypt_failed callback with inline retries, then signal
          // the outer run() to exit cleanly by returning null.
          await this.sendWithRetry({
            requestId,
            instanceId,
            ok: false,
            phase: "decrypt_failed",
            status: null,
            headers: null,
            body: null,
            error: String(e),
            truncated: false,
          });
          return null;
        }
      });

      if (apiKey === null) return;

      // ------------------------------------------------------------------
      // Step 2: call OpenRouter, truncate reasoning, send chunked callback
      // ------------------------------------------------------------------
      await step.do("call-and-respond", async () => {
        let status: number | null = null;
        let responseHeaders: Record<string, string> | null = null;
        let bodyText: string | null = null;
        let transportError: string | null = null;

        try {
          const resp = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...openrouterPayload, stream: false }),
          });
          status = resp.status;
          responseHeaders = extractAllowedHeaders(resp.headers);
          bodyText = await resp.text();
        } catch (e) {
          transportError = String(e);
        }

        // Truncate reasoning fields before sending.
        let truncated = false;
        if (bodyText !== null) {
          const result = truncateReasoning(
            bodyText,
            truncateThinkingMaxChars ?? DEFAULT_THINKING_TRUNCATE,
          );
          bodyText = result.text;
          truncated = result.truncated;
        }

        const phase: CallbackPhase =
          transportError !== null
            ? "openrouter_transport_error"
            : "openrouter_response";

        const ok =
          phase === "openrouter_response" &&
          status !== null &&
          status >= 200 &&
          status < 300;

        await this.sendWithRetry({
          requestId,
          instanceId,
          ok,
          phase,
          status,
          headers: responseHeaders,
          body: bodyText,
          error: transportError,
          truncated,
        });
      });
    } catch (e) {
      // Best-effort: attempt to notify the caller before the workflow errors.
      await this.sendBestEffort({
        requestId,
        instanceId,
        ok: false,
        phase: "internal_error",
        status: null,
        headers: null,
        body: null,
        error: String(e),
        truncated: false,
      });
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Callback delivery helpers
  // -------------------------------------------------------------------------

  /**
   * Splits `data.body` into ≤1.5 MiB chunks and sends each chunk with a
   * per-chunk exponential retry loop (5 attempts, starting at 5 s).
   * Throws if any chunk exhausts all retries.
   */
  private async sendWithRetry(data: CallbackEnvelopeData): Promise<void> {
    const chunks = splitBodyIntoChunks(
      data.body,
      CALLBACK_BODY_CHUNK_MAX_BYTES,
    );
    for (let i = 0; i < chunks.length; i++) {
      const envelope: CallbackEnvelope = {
        ...data,
        body: chunks[i],
        timestamp: Math.floor(Date.now() / 1000),
        chunkIndex: i,
        chunkTotal: chunks.length,
      };
      await retryWithBackoff(
        () => this.postCallback(envelope),
        CALLBACK_MAX_RETRIES,
        CALLBACK_INITIAL_DELAY_MS,
      );
    }
  }

  /**
   * Attempts to send each chunk exactly once. Logs failures but does not
   * throw. Used for error-phase callbacks where we can't add retries without
   * risking cascading complexity.
   */
  private async sendBestEffort(data: CallbackEnvelopeData): Promise<void> {
    const chunks = splitBodyIntoChunks(
      data.body,
      CALLBACK_BODY_CHUNK_MAX_BYTES,
    );
    for (let i = 0; i < chunks.length; i++) {
      const envelope: CallbackEnvelope = {
        ...data,
        body: chunks[i],
        timestamp: Math.floor(Date.now() / 1000),
        chunkIndex: i,
        chunkTotal: chunks.length,
      };
      try {
        await this.postCallback(envelope);
      } catch (err) {
        console.error(
          `[relay] best-effort callback chunk ${i}/${chunks.length} failed: ${err}`,
        );
      }
    }
  }

  /** Signs and POSTs a single callback envelope. Throws on non-2xx. */
  private async postCallback(envelope: CallbackEnvelope): Promise<void> {
    const bodyStr = JSON.stringify(envelope);
    const { signature, timestamp } = await signOutbound(
      bodyStr,
      this.env.SHARED_SECRET,
    );
    const resp = await fetch(this.env.CALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
        "X-Timestamp": String(timestamp),
      },
      body: bodyStr,
    });
    if (!resp.ok) {
      // Drain the body to free the connection before retrying.
      await resp.text().catch(() => {});
      throw new Error(`Callback POST returned ${resp.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level utilities
// ---------------------------------------------------------------------------

function extractAllowedHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      ALLOWED_HEADER_PREFIXES.some((p) => lower === p || lower.startsWith(p))
    ) {
      result[lower] = value;
    }
  });
  return result;
}

/**
 * Splits `body` into slices whose UTF-8 byte length does not exceed `maxBytes`.
 * Multi-byte characters are never split across chunk boundaries.
 * Returns `[null]` when `body` is null.
 */
function splitBodyIntoChunks(
  body: string | null,
  maxBytes: number,
): (string | null)[] {
  if (body === null) return [null];

  const encoder = new TextEncoder();
  const encoded = encoder.encode(body);

  if (encoded.length <= maxBytes) return [body];

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let offset = 0;

  while (offset < encoded.length) {
    let end = Math.min(offset + maxBytes, encoded.length);
    // Walk back to the start of a multi-byte sequence if we landed mid-char.
    while (end > offset && (encoded[end] & 0xc0) === 0x80) {
      end--;
    }
    chunks.push(decoder.decode(encoded.slice(offset, end)));
    offset = end;
  }

  return chunks;
}

async function retryWithBackoff(
  fn: () => Promise<void>,
  maxAttempts: number,
  initialDelayMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await delay(initialDelayMs * Math.pow(2, attempt - 1));
    }
    try {
      await fn();
      return;
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      console.error(
        `[relay] callback attempt ${attempt + 1}/${maxAttempts} failed, retrying: ${err}`,
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
