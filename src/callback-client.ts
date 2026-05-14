import { signOutbound } from "./auth";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 1.5 MiB — maximum UTF-8 byte size of the `body` slice in each callback POST. */
export const CALLBACK_BODY_CHUNK_MAX_BYTES = 1_572_864;

const CALLBACK_MAX_RETRIES = 5;
const CALLBACK_INITIAL_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallbackResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

export interface CallbackError {
  type: string;
  message: string;
}

export interface CallbackEnvelopeData {
  requestId: string;
  response?: CallbackResponse;
  error?: CallbackError;
}

export interface CallbackEnvelope extends CallbackEnvelopeData {
  timestamp: number;
  chunk: { index: number; total: number };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CallbackClient {
  constructor(
    private readonly callbackUrl: string,
    private readonly sharedSecret: string,
  ) {}

  /**
   * Splits `data.body` into ≤1.5 MiB chunks and sends each chunk with a
   * per-chunk exponential retry loop (5 attempts, starting at 5 s).
   * Throws if any chunk exhausts all retries.
   */
  async sendWithRetry(data: CallbackEnvelopeData): Promise<void> {
    const chunks = splitBodyIntoChunks(
      data.response?.body ?? null,
      CALLBACK_BODY_CHUNK_MAX_BYTES,
    );
    for (let i = 0; i < chunks.length; i++) {
      const envelope: CallbackEnvelope = {
        ...data,
        response:
          data.response !== undefined
            ? { ...data.response, body: chunks[i] }
            : undefined,
        timestamp: Math.floor(Date.now() / 1000),
        chunk: { index: i, total: chunks.length },
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
  async sendBestEffort(data: CallbackEnvelopeData): Promise<void> {
    const chunks = splitBodyIntoChunks(
      data.response?.body ?? null,
      CALLBACK_BODY_CHUNK_MAX_BYTES,
    );
    for (let i = 0; i < chunks.length; i++) {
      const envelope: CallbackEnvelope = {
        ...data,
        response:
          data.response !== undefined
            ? { ...data.response, body: chunks[i] }
            : undefined,
        timestamp: Math.floor(Date.now() / 1000),
        chunk: { index: i, total: chunks.length },
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
      this.sharedSecret,
    );
    const resp = await fetch(this.callbackUrl, {
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

/**
 * Splits `body` into slices whose UTF-8 byte length does not exceed `maxBytes`.
 * Multi-byte characters are never split across chunk boundaries.
 * Returns `[null]` when `body` is null.
 */
export function splitBodyIntoChunks(
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
