/**
 * Augments the auto-generated Env interface with runtime secrets that are
 * configured via `wrangler secret put` and are therefore not reflected in
 * the generated worker-configuration.d.ts.
 */
interface Env {
	SHARED_SECRET: string;
}
