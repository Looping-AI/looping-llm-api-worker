import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SHARED_SECRET: "test-secret",
          CALLBACK_URL: "https://test-callback.invalid/cb",
          // 100 ms between retries so retry tests complete in ~700 ms instead of 35 s.
          STEP_RETRY_DELAY: "100",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    globalSetup: ["./test/setup/global-setup.ts"],
  },
});
