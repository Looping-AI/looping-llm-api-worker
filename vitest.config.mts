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
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    globalSetup: ["./test/setup/global-setup.ts"],
  },
});
