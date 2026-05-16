import { inject, vi } from "vitest";

export interface FixtureEntry {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Loads recorded fixture entries by name (e.g. "openrouter/simple-response").
 * Throws if the fixture does not exist — run `RECORD=1 bun test` to create it.
 */
export function loadFixture(name: string): FixtureEntry[] {
  const fixtureMap = inject("fixtures");
  const raw = fixtureMap[name];
  if (!raw) {
    throw new Error(
      `Fixture '${name}' not found. Run with RECORD=1 to create it.`,
    );
  }
  return JSON.parse(raw) as FixtureEntry[];
}

/**
 * Intercepts `globalThis.fetch` for the duration of a test.
 *
 * - **Record mode** (`RECORD=1`): lets real fetch calls through, captures
 *   each response, then writes the fixture file to disk via the globalSetup
 *   HTTP bridge on `stop()`.
 * - **Replay mode** (default): returns recorded entries in order from the
 *   fixture file identified by `name`.
 *
 * Call `await recording.stop()` in a `finally` block (or `afterEach`) to
 * flush recordings and restore the original `fetch`.
 */
export function useFixture(name: string): { stop(): Promise<void> } {
  const fixturePort = inject("fixturePort");
  const isRecord = inject("isRecording");
  const recorded: FixtureEntry[] = [];
  const originalFetch = globalThis.fetch;

  if (isRecord) {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);

        // Pass through calls to the fixture server to avoid recursion
        if (url.startsWith(`http://127.0.0.1:${fixturePort}/`)) {
          return originalFetch(input, init);
        }

        const resp = await originalFetch(input, init);
        const body = await resp.clone().text();
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          headers[k] = v;
        });
        recorded.push({
          url,
          method: (init?.method ?? "GET").toUpperCase(),
          status: resp.status,
          headers,
          body,
        });
        return resp;
      },
    );
  } else {
    const entries = loadFixture(name);
    const queue = [...entries];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const entry = queue.shift();
      if (!entry) {
        throw new Error(`useFixture('${name}'): no more entries to replay`);
      }
      return new Response(entry.body, {
        status: entry.status,
        headers: entry.headers,
      });
    });
  }

  return {
    async stop() {
      if (isRecord && recorded.length > 0) {
        await originalFetch(`http://127.0.0.1:${fixturePort}/fixture/${name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(recorded, null, 2),
        });
      }
      vi.restoreAllMocks();
    },
  };
}
