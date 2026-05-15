/**
 * Augments the auto-generated Env interface with runtime secrets that are
 * configured via `wrangler secret put` and are therefore not reflected in
 * the generated worker-configuration.d.ts.
 */
interface Env {
  SHARED_SECRET: string;
  CALLBACK_URL: string;
  /** Milliseconds to wait between step retries. Defaults to 5 seconds in production. Inject a small value in tests. */
  STEP_RETRY_DELAY?: string;
}
