import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/functions/src/__tests__/**/*.test.ts"],
    setupFiles: ["packages/functions/src/__tests__/setup.ts"],
    env: {
      NODE_ENV: "test",
    },
    coverage: {
      provider: "v8",
      include: ["packages/functions/src/**/*.ts"],
      exclude: ["packages/functions/src/__tests__/**"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./packages/functions/src"),
    },
  },
});
