# Plan: Looping LLM API Worker — consolidation (v2)

## TL;DR

Replace the demo workflow in `src/index.ts` with `POST /relay`: HMAC-authenticated
endpoint that dispatches a `LlmRelayWorkflow`. Workflow decrypts the OpenRouter API
key (AES-256-GCM, key derived from the shared secret via HKDF, cached per-isolate),
calls OpenRouter non-streaming, truncates `reasoning` fields per request param,
and POSTs a signed envelope to a fixed `CALLBACK_URL`. Every post-trust failure
branch also emits a callback. No timeouts on our side — we wait on OpenRouter.

## Wire formats

### Inbound `POST /relay`

Headers: `X-Signature: sha256=<hex>`, `X-Timestamp: <unix s>`, `Content-Type: application/json`.

HMAC = HMAC-SHA256 of `${X-Timestamp}.${rawBody}` using `SHARED_SECRET`. Replay window 300s (hardcoded const).

Body:

```
{
  "requestId": "uuid",
  "openrouter": { "model": "...", "messages": [...], ... },
  "encryptedApiKey": { "v": 1, "iv": "<b64 12B>", "ct": "<b64 ciphertext+tag>" },
  "truncate_thinking_to_max_chars": 4096 | null   // null -> default 4096
}
```

Response: `202 { ok:true, instanceId, requestId }` or sync error (see below).

### Outbound callback `POST $CALLBACK_URL`

Headers: `X-Signature`, `X-Timestamp`, `Content-Type: application/json`.
Body:

```
{
  "requestId",
  "instanceId",
  "ok": true|false,
  "phase": "openrouter_response" | "decrypt_failed" | "openrouter_transport_error" | "internal_error",
  "status": <int|null>,            // OpenRouter HTTP status if reached, else null
  "headers": { ... } | null,       // whitelisted upstream headers
  "body": "<string>" | null,       // body slice for this chunk (with reasoning truncation applied)
  "error": "string|null",
  "truncated": bool,               // true if any reasoning field was shortened
  "timestamp": <unix s>,
  "chunkIndex": 0,                 // 0-based; always 0 when chunkTotal is 1
  "chunkTotal": 1                  // 1 = no chunking; >1 = caller must reassemble body
}
```

`ok` is `true` only when `phase==="openrouter_response"` AND HTTP status is 2xx.
A non-2xx OpenRouter response → `ok:false, phase:"openrouter_response"` with body forwarded verbatim.

#### Chunking rules

- `CALLBACK_BODY_CHUNK_MAX_BYTES = 1_572_864` (1.5 MiB, hardcoded const).
- Body byte size measured with `new TextEncoder().encode(slice).length` (UTF-8 bytes, not JS string length).
- If the full `body` string fits within the limit: send one POST with `chunkIndex:0, chunkTotal:1`.
- If not: split `body` into N slices of ≤1 MB each, send N sequential POSTs. All metadata fields (`ok`, `phase`, `status`, `headers`, `error`, `truncated`, `timestamp`) are repeated verbatim in every chunk.
- Non-body phases (`decrypt_failed`, `openrouter_transport_error`, `internal_error`) always have `body:null` → always `chunkIndex:0, chunkTotal:1`.
- Each chunk POST is independently signed (`X-Signature` over `${X-Timestamp}.${rawChunkBody}`).
- Step-level retries resend all chunks from `chunkIndex:0`. Receiver deduplicates by `(instanceId, chunkIndex)` — at-least-once delivery.
- Caller reassembles: collect all chunks, sort by `chunkIndex`, concatenate `body` slices.

## Sync vs callback error matrix

| Failure                                          | Sync HTTP            | Callback fires?                                    |
| ------------------------------------------------ | -------------------- | -------------------------------------------------- |
| Missing/bad `X-Signature` / `X-Timestamp` / skew | 401                  | No (pre-trust)                                     |
| Non-JSON or schema-invalid body                  | 400                  | No (pre-trust, no trustworthy `requestId`)         |
| Wrong content-type                               | 415                  | No                                                 |
| Workflow create itself fails                     | 500                  | No (couldn't enqueue)                              |
| `encryptedApiKey` decrypt fails                  | 202 ack already sent | Yes — `phase:"decrypt_failed"`                     |
| OpenRouter fetch throws / network error          | 202 already          | Yes — `phase:"openrouter_transport_error"`         |
| OpenRouter responds (any status, incl. 4xx/5xx)  | 202 already          | Yes — `phase:"openrouter_response"`                |
| Anything else inside workflow                    | 202 already          | Yes — `phase:"internal_error"` via outer try/catch |
| Callback POST fails all 5 retries                | n/a                  | n/a — workflow ends `errored`, logged only         |

## Crypto

- **HMAC**: WebCrypto HMAC-SHA256, hex lower-case, constant-time verify.
- **AES**: AES-256-GCM, 96-bit random IV, 128-bit auth tag (WebCrypto default appends to ciphertext). Base64 (standard, not URL-safe).
- **Key derivation**: HKDF-SHA256 over UTF-8 bytes of `SHARED_SECRET`, `salt=""`, `info="openrouter-key-v1"`, 32 B → AES key. HMAC key imported directly from the raw secret bytes.
- **Per-isolate cache**: `let cached: { hmac: CryptoKey, aes: CryptoKey } | null = null;` lazily initialized on first request. Rotation = `wrangler secret put SHARED_SECRET` + redeploy/let isolates recycle.

## Reasoning truncation (`truncate_thinking_to_max_chars`)

- Default `4096` when field missing or `null`.
- After getting the raw response body string, attempt `JSON.parse`. If parse succeeds and shape matches OpenAI-style chat completion, walk `choices[].message.reasoning` and `choices[].message.reasoning_details[].text` (and `.summary` if present). For each string longer than `max`, replace with `${head}...${tail}` where head/tail split the budget roughly evenly (`floor((max-3)/2)` each).
- If parse fails OR shape doesn't match, leave the body untouched. Always set `truncated:true` only if at least one field was actually shortened.
- Re-serialize with `JSON.stringify` (no pretty-print) and use that as the callback `body`.

## Steps

### Phase 1 — Skeleton + bindings

1. Edit [wrangler.jsonc](wrangler.jsonc):
   - `name`: `looping-llm-api-worker`.
   - Workflow binding: `LLM_RELAY` / `LlmRelayWorkflow`.
   - `vars`: only `CALLBACK_URL`.
   - Secret (set via `wrangler secret put SHARED_SECRET`): `SHARED_SECRET`.
2. `npx wrangler types` → refresh [worker-configuration.d.ts](worker-configuration.d.ts).

### Phase 2 — Crypto + auth utilities

3. New `src/crypto.ts`:
   - `getKeys(env): Promise<{ hmac: CryptoKey, aes: CryptoKey }>` with module-scope cache.
   - `signHmac(key, msg) → hex`, `verifyHmac(key, msg, hex) → bool` (constant-time).
   - `decryptApiKey(aesKey, { v, iv, ct }) → string`; throws on bad version/tag.
   - `b64decode`, `b64encode`, `bytesEqualConstantTime`.
4. New `src/auth.ts`:
   - `MAX_TIMESTAMP_SKEW_SECONDS = 300` (const).
   - `verifyInboundSignature(req, rawBody, env)` → `{ ok, reason }`.
   - `signOutbound(rawBody, env)` → `{ signature, timestamp }`.

### Phase 3 — Workflow

5. New `src/workflow.ts` exporting `LlmRelayWorkflow`:
   - `Params = { requestId, openrouterPayload, encryptedApiKey, truncateThinkingMaxChars }`.
   - `OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"` (const).
   - `DEFAULT_THINKING_TRUNCATE = 4096` (const).
   - Outer structure: `try { … } catch (e) { await emitCallback({ ok:false, phase:"internal_error", error:String(e) }); throw; }` so any unexpected throw still fires a callback before the workflow errors.
   - Step `decrypt-key` (no retries): decrypt; on failure → `emitCallback({phase:"decrypt_failed"})` and return early (workflow ends `complete`).
   - Step `call-openrouter` (no retries, no abort/timeout): single `fetch`, force `stream:false` in payload, capture `{status, headers, bodyText}` even on non-2xx. On thrown error → `emitCallback({phase:"openrouter_transport_error", error})` and return.
   - Step `truncate-and-send-callback` (retries 5, exponential, initial 5s): run truncation, split `body` into ≤1 MB chunks, send all chunks sequentially (each independently signed), throw on any non-2xx so the whole step (and all chunks) are retried from the start.
6. New `src/truncate.ts`: `truncateReasoning(bodyText, max) → { text, truncated }`.

### Phase 4 — Handler

7. Rewrite [src/index.ts](src/index.ts):
   - Export `LlmRelayWorkflow` (re-export so the binding can find it).
   - `fetch`: route `POST /relay`; everything else → 404.
   - Read raw body once, verify HMAC, validate body shape (inline checks: `typeof requestId === "string"`, `openrouter` is object with `messages` array, `encryptedApiKey` has `v/iv/ct` strings, `truncate_thinking_to_max_chars` is `null|undefined|positive int`).
   - `env.LLM_RELAY.create({ params })` → return 202.

### Phase 5 — Rotation script (small)

8. New `scripts/rotate-secret.mjs`:
   - Accepts a shared secret on stdin or `--from-file`.
   - Runs `wrangler secret put SHARED_SECRET` with that value (no offline AES derivation needed — runtime derives + caches).
   - Also provides a `--print-derived` mode: prints the base64 derived AES key so you can verify the same secret produces the same key across environments.

## Relevant files

- [src/index.ts](src/index.ts) — full rewrite (handler + workflow re-export).
- [wrangler.jsonc](wrangler.jsonc) — binding + `CALLBACK_URL` var.
- [worker-configuration.d.ts](worker-configuration.d.ts) — regenerated.
- New: `src/crypto.ts`, `src/auth.ts`, `src/workflow.ts`, `src/truncate.ts`, `scripts/rotate-secret.mjs`.

## Verification

1. `npx tsc --noEmit` clean.
2. `wrangler deploy --dry-run` clean.
3. `wrangler dev` sanity:
   - valid sig + valid encrypted key + webhook.site `CALLBACK_URL` → 202, then callback with `ok:true, phase:"openrouter_response"`.
   - valid sig + corrupted `encryptedApiKey.ct` → 202, then callback `phase:"decrypt_failed"`.
   - bad sig → 401, no callback.
   - large reasoning string → callback body shows `...` in the middle, `truncated:true`.

## Decisions

- Endpoint `POST /relay`.
- ENV holds raw `SHARED_SECRET`; derived AES + HMAC keys cached per-isolate.
- No timeouts, no abort signals — we wait on OpenRouter.
- Truncation parses JSON and rewrites `reasoning` / `reasoning_details[].text` per choice. Default 4096. Truncated form: `head + "..." + tail`.
- Pre-trust failures (signature, schema, content-type) return sync 4xx, **no** callback.
- Post-trust failures (decrypt, transport, internal) → 202 ack + callback envelope with typed `phase`.
- Callback step retries 5× exponential. Terminal failure = log + workflow `errored`.
- No GET status endpoint.
- Hardcoded constants (not vars): `OPENROUTER_URL`, `MAX_TIMESTAMP_SKEW_SECONDS=300`, `DEFAULT_THINKING_TRUNCATE=4096`, `CALLBACK_BODY_CHUNK_MAX_BYTES=1_572_864`.
- Demo workers under sibling folders left untouched.

## Risks / call-outs

1. **Truncation correctness depends on response shape.** If OpenRouter changes field names or a provider returns reasoning in `content` only, truncation silently does nothing. Mitigation: leave body verbatim when shape doesn't match; surface `truncated:false` honestly. Future work: configurable JSON paths.
2. **Callback URL can become unreachable.** Worst case: 5 retries fail, envelope is lost. Acceptable per your call; logs are the only trail.
3. **Workflow state stores the encrypted blob** (and the user prompt!). The prompt content is plaintext in CF workflow storage. Worth being aware of — not encryption-of-prompt's responsibility but worth noting.
4. **Per-isolate cache means cold-start does the HKDF once per isolate.** Microseconds, but technically observable on the very first request after deploy.
5. **Header whitelist for callback envelope**: `content-type`, `x-request-id`, and headers matching `^openrouter-` / `^x-openrouter-`. Everything else dropped to avoid leaking CF-internal headers.
6. **Chunk byte measurement**: `TextEncoder().encode()` is called per slice during chunking — negligible CPU cost but worth noting for very large responses where many chunks are produced.
