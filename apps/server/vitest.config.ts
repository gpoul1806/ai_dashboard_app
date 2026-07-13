import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sandbox worker threads + esbuild need the node environment and headroom.
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@myday/schema": new URL("../../packages/schema/src/index.ts", import.meta.url)
        .pathname,
    },
  },
});
