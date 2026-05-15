# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Package Manager

This project uses **Bun**. NEVER use `npm`. All install, run, and exec commands must use `bun` / `bunx`.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command                | Purpose                   |
| ---------------------- | ------------------------- |
| `bunx wrangler dev`    | Local development         |
| `bunx wrangler deploy` | Deploy to Cloudflare      |
| `bunx wrangler types`  | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

## Testing

### Commands

| Command               | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `bun run test`        | Run all tests in replay mode (default, no network) |
| `bun run test:record` | Re-record fixtures against real APIs (`RECORD=1`)  |

### Framework

Tests use **Vitest** with `@cloudflare/vitest-pool-workers` (`cloudflareTest` plugin). The pool runs tests inside a Miniflare environment that matches the Worker runtime. Bindings (`SHARED_SECRET`, `CALLBACK_URL`) are injected via `vitest.config.mts`.

### Fixture / Recording System

Network calls are isolated using a record-and-replay fixture system. Fixtures are JSON files stored under `test/fixtures/<name>.json` (e.g. `test/fixtures/openrouter/simple-completion.json`).

Each fixture is an array of `FixtureEntry` objects:

```ts
interface FixtureEntry {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}
```

**`useFixture(name)`** — `test/helpers/fixture.ts`

The primary helper for tests that make outbound HTTP calls. It intercepts `globalThis.fetch` via `vi.spyOn`.

- **Replay mode** (default): Serves recorded entries in FIFO order. Throws if the queue is exhausted.
- **Record mode** (`RECORD=1`): Passes real fetches through, captures each response, and writes the fixture file to disk via the global-setup HTTP bridge when `stop()` is called.

Always call `await recording.stop()` in a `finally` block:

```ts
it("my test", async () => {
  const recording = useFixture("openrouter/simple-completion");
  try {
    // ... code under test
  } finally {
    await recording.stop(); // flushes recording and restores fetch
  }
});
```

**`loadFixture(name)`** — `test/helpers/fixture.ts`

Loads fixture entries directly without mocking `fetch`. Use this when you need fixture data for hand-crafted `vi.spyOn` mocks (e.g. `mockImplementationOnce`):

```ts
const [entry] = loadFixture("openrouter/simple-completion");
vi.spyOn(globalThis, "fetch").mockImplementationOnce(
  async () =>
    new Response(entry.body, { status: entry.status, headers: entry.headers }),
);
```

**How recording works end-to-end:**

1. `vitest.config.mts` declares `globalSetup: ["./test/setup/global-setup.ts"]`.
2. The global setup reads all fixture JSON files into memory and starts a local HTTP server on a random port.
3. It provides `fixturePort`, `fixtures`, and `isRecording` to tests via Vitest's `provide()` / `inject()` mechanism.
4. In record mode, `useFixture` captures real responses and `POST`s them to `http://127.0.0.1:<fixturePort>/fixture/<name>`, which writes the JSON file to disk.

**When to re-record:** Run `bun run test:record` whenever an upstream API response changes or a new fixture is needed. Commit the resulting JSON files.

### Direct `vi.spyOn` mocking

For tests that need fine-grained control (e.g. simulating network errors, multiple sequential calls with different outcomes), use `vi.spyOn` directly instead of `useFixture`:

```ts
const fetchSpy = vi.spyOn(globalThis, "fetch");
fetchSpy
  .mockImplementationOnce(
    async () => new Response(orEntry.body, { status: 200 }),
  )
  .mockRejectedValueOnce(new TypeError("Failed to fetch"));
```

Always restore mocks — either call `vi.restoreAllMocks()` in `afterEach` or use `vi.spyOn` inside a block guarded by `afterEach(() => vi.restoreAllMocks())`.

### Test Helpers — `test/helpers.ts`

| Helper                                | Purpose                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeSignedRequest(body, overrides?)` | Builds a valid signed `POST /relay` Request. Pass `overrides` to exercise rejection branches (bad signature, stale timestamp, wrong content-type).   |
| `encryptApiKey(plaintext, secret?)`   | Encrypts a plaintext API key with AES-256-GCM using the same HKDF derivation as production. Use to create valid `EncryptedApiKey` payloads in tests. |
| `TEST_SECRET`                         | The `SHARED_SECRET` value injected by Miniflare during tests (`"test-secret"`).                                                                      |

### Workflow testing

Use `introspectWorkflow` / `waitForStatus` from `cloudflare:test` to drive Workflow execution in tests:

```ts
const introspector = await introspectWorkflow(env.LLM_RELAY);
try {
  const ctx = createExecutionContext();
  await worker.fetch(req, env as Env, ctx);
  await waitOnExecutionContext(ctx);

  const [instance] = introspector.get();
  await instance.waitForStatus("complete");
} finally {
  await introspector.dispose(); // always dispose
}
```
