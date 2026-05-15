# looping-llm-api-worker

A Cloudflare Workers async LLM relay. It accepts a signed `POST /relay` request, immediately acknowledges it with **202**, and then runs a durable [Cloudflare Workflow](https://developers.cloudflare.com/workflows/) that calls [OpenRouter](https://openrouter.ai/), optionally truncates large reasoning fields, and POSTs the result back to a caller-supplied callback URL — fully signed and with retry logic.

## How it works

```
Caller                          Worker                       Workflow (async)
  │                               │                               │
  │── POST /relay (HMAC-signed) ──▶│                               │
  │◀──────────── 202 + requestId ──│                               │
  │                               │── dispatch LlmRelayWorkflow ──▶│
  │                               │                               │── 1. decrypt API key (AES-256-GCM)
  │                               │                               │── 2. POST to OpenRouter, truncate reasoning, gzip body
  │                               │                               │── 3. POST callback (chunked, gzip, signed, 3× retry)
  │◀══════════ callback POST (HMAC-signed) ════════════════════════│
```

Both inbound and outbound requests are signed with **HMAC-SHA256** using a shared secret. The caller's OpenRouter API key travels encrypted (**AES-256-GCM**); the AES key is derived from `SHARED_SECRET` via HKDF-SHA256 so the raw key never leaves the caller.

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers and Workflows enabled
- [Bun](https://bun.sh/) installed (`curl -fsSL https://bun.sh/install | bash`)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — included as a dev dependency, invoked via `bunx wrangler`

---

## Package manager

This project uses **Bun** exclusively. Do **not** use `npm`, `pnpm`, or `yarn` — their lock files are gitignored and the scripts assume Bun. Replace any `npm run` / `npx` references you see elsewhere with `bun run` / `bunx`.

---

## Setup

```bash
git clone https://github.com/Looping-AI/looping-llm-api-worker.git
cd looping-llm-api-worker
bun install
```

After changing bindings in `wrangler.jsonc`, regenerate the TypeScript types:

```bash
bun run cf-typegen
```

---

## Secrets

The worker requires two secrets at runtime:

| Name            | Purpose                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `SHARED_SECRET` | HMAC signing key for inbound/outbound requests; also used to derive the AES decryption key |
| `CALLBACK_URL`  | The URL the workflow POSTs the LLM response to                                             |

### Local development

Wrangler reads secrets from a `.env` file in the project root (never committed — gitignored). Create it from the provided example:

```bash
cp .env.example .env
```

Then fill in the values:

```dotenv
# Generate a random secret with: openssl rand -hex 32
SHARED_SECRET=your-secret-here
CALLBACK_URL=https://your-server/callback
```

> The test suite injects its own bindings via `vitest.config.mts`; `.env` is not needed for `bun run test`.

### Production

Use the Wrangler CLI to set each secret. You will be prompted to enter the value:

```bash
bunx wrangler secret put SHARED_SECRET
bunx wrangler secret put CALLBACK_URL
```

---

## Local development

```bash
bun run dev
```

This runs `wrangler dev` and exposes the worker at `http://localhost:8787`. Make sure `.env` is populated (see [Secrets](#secrets)).

---

## Testing

```bash
bun run test
```

Tests run with [Vitest](https://vitest.dev/) against `@cloudflare/vitest-pool-workers`, which emulates the Workers runtime locally. No live Cloudflare account or `.env` is needed.

---

## Linting & formatting

```bash
bun run lint          # ESLint (typescript-eslint, strict)
bun run format        # Prettier — write in place
bun run format:check  # Prettier — check only (suitable for CI)
```

---

## Deploy

```bash
bun run deploy
```

Runs `wrangler deploy`. Ensure both production secrets are set before the first deploy (see [Secrets → Production](#production)).

---

## API reference

### `POST /relay`

Accepts a signed JSON payload and enqueues an async LLM request. Returns immediately.

**Required headers**

| Header         | Value                                            |
| -------------- | ------------------------------------------------ |
| `Content-Type` | `application/json`                               |
| `X-Signature`  | `sha256=<lower-case hex HMAC-SHA256>`            |
| `X-Timestamp`  | Unix timestamp in seconds (within ±5 min of now) |

The signed message is `${X-Timestamp}.${rawBody}` (HMAC-SHA256 of the raw request body prefixed with the timestamp and a dot).

**Request body**

```jsonc
{
  "requestId": "caller-assigned-id", // string, required — echoed in every callback
  "openrouter": {
    // object, required — forwarded verbatim to OpenRouter
    // NOTE: any `stream` field is overridden to false (relay is non-streaming)
    "model": "anthropic/claude-3-5-sonnet",
    "messages": [{ "role": "user", "content": "Hello" }],
    // ...any other OpenRouter chat completion fields
  },
  "encryptedApiKey": {
    // object, required — AES-256-GCM encrypted OpenRouter key
    "iv": "<base64-encoded 12-byte IV>",
    "ct": "<base64-encoded ciphertext>",
  },
  "truncate_thinking_to_max_chars": 4096, // integer > 0, optional — default 4096; set null to use default
}
```

**Response — 202 Accepted**

```json
{
  "ok": true,
  "requestId": "<your-requestId>"
}
```

Other responses: `400` (bad request / invalid JSON / schema error), `401` (signature mismatch or expired timestamp), `404` (unknown path), `415` (wrong Content-Type), `500` (workflow dispatch failed).

---

## Callback envelope

Once the workflow completes (or fails), it POSTs JSON to `CALLBACK_URL`. Large responses are split into ≤ 1.5 MiB chunks. Each chunk is independently HMAC-signed with the same scheme as inbound requests (`X-Signature` + `X-Timestamp` headers).

`response` and `error` are mutually exclusive — exactly one is present in every chunk.

**Success / OpenRouter response**

```jsonc
{
  "requestId": "caller-assigned-id",
  "timestamp": 1715000000,                 // unix seconds at send time
  "chunk": { "index": 0, "total": 1 },     // chunk position (total > 1 for large bodies)
  "response": {
    "status": 200,                         // HTTP status from OpenRouter
    "headers": { "content-type": "application/json", ... }, // filtered response headers
    "gzip_body": "..."                     // base64-encoded gzip slice of the response body; null when body is absent
  }
}
```

Check `response.status` to distinguish a successful reply (2xx) from an OpenRouter-level error (4xx / 5xx).

**Error**

```jsonc
{
  "requestId": "caller-assigned-id",
  "timestamp": 1715000000,
  "chunk": { "index": 0, "total": 1 },
  "error": {
    "type": "transport_error", // see error types below
    "message": "fetch failed: ...",
  },
}
```

**`error.type` values**

| Type              | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `decrypt_failed`  | Could not decrypt the caller-supplied API key |
| `transport_error` | Network-level failure reaching OpenRouter     |
| `internal_error`  | Unexpected error inside the workflow          |

Delivery is retried up to **3 times** with exponential backoff starting at **5 seconds**. If all retries are exhausted for any chunk, the workflow enters the `errored` state.

---

## Security model

| Mechanism          | Details                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Inbound auth       | HMAC-SHA256 over `${timestamp}.${body}`; clock skew limit 5 minutes                        |
| Outbound auth      | Same scheme applied to each callback chunk                                                 |
| API key encryption | AES-256-GCM; AES key = HKDF-SHA256(`SHARED_SECRET`, salt=`""`, info=`"openrouter-key-v1"`) |
| Replay protection  | `X-Timestamp` must be within ±300 s of server time                                         |
