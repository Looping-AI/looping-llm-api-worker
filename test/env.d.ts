export {};

declare module "cloudflare:test" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ProvidedEnv extends Env {}
}

declare module "vitest" {
  interface ProvidedContext {
    fixturePort: number;
    fixtures: Record<string, string>;
    isRecording: boolean;
  }
}
