import { signOutbound } from "./auth";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 1.5 MiB — maximum raw-byte size of each gzip chunk sent per callback POST. */
const CALLBACK_BODY_CHUNK_MAX_BYTES = 1_572_864;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CallbackResponse {
  status: number;
  headers: Record<string, string>;
  /** Pre-compressed (gzipped) response body bytes produced by the workflow. */
  gzip_body: Uint8Array | null;
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

// Wire format — each POST carries exactly one chunk.
interface WireEnvelope {
  requestId: string;
  response?: {
    status: number;
    headers: Record<string, string>;
    /** Base64-encoded slice of the gzip stream. */
    gzip_body: string | null;
  };
  error?: CallbackError;
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
   * For response payloads: splits `data.response.gzip_body` into ≤1.5 MiB
   * raw-byte chunks, base64-encodes each, and POSTs them in order.
   * For error payloads: sends a single POST with no chunking.
   * Throws on any POST failure — the caller's step retry config handles retries.
   */
  async send(data: CallbackEnvelopeData): Promise<void> {
    if (data.response === undefined) {
      await this.postEnvelope({
        requestId: data.requestId,
        error: data.error,
        timestamp: Math.floor(Date.now() / 1000),
        chunk: { index: 0, total: 1 },
      });
      return;
    }

    const chunks = splitBytesIntoBase64Chunks(
      data.response.gzip_body,
      CALLBACK_BODY_CHUNK_MAX_BYTES,
    );
    for (let i = 0; i < chunks.length; i++) {
      await this.postEnvelope({
        requestId: data.requestId,
        response: {
          status: data.response.status,
          headers: data.response.headers,
          gzip_body: chunks[i],
        },
        timestamp: Math.floor(Date.now() / 1000),
        chunk: { index: i, total: chunks.length },
      });
    }
  }

  /** Signs and POSTs a single wire envelope. Throws on non-2xx. */
  private async postEnvelope(envelope: WireEnvelope): Promise<void> {
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
      await resp.text().catch(() => {});
      throw new Error(`Callback POST returned ${resp.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level utilities
// ---------------------------------------------------------------------------

/**
 * Splits `bytes` into chunks whose raw byte length does not exceed `maxBytes`,
 * and returns each chunk as a base64-encoded string.
 * Returns `[null]` when `bytes` is null.
 */
export function splitBytesIntoBase64Chunks(
  bytes: Uint8Array | null,
  maxBytes: number,
): (string | null)[] {
  if (bytes === null) return [null];

  const chunks: string[] = [];
  let offset = 0;
  do {
    const end = Math.min(offset + maxBytes, bytes.length);
    chunks.push(Buffer.from(bytes.slice(offset, end)).toString("base64"));
    offset = end;
  } while (offset < bytes.length);

  return chunks;
}
