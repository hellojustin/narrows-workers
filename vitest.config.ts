import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Deliberately hostile timezone, not UTC. These handlers compute the time
// windows narrows buckets revenue and listening by, so running the suite at a
// fractional, date-line-crossing offset makes accidental local-time dependence
// fail here rather than in production. Must be assigned before the workers
// fork, since Node reads TZ at startup; `test.env` is too late to have any effect.
process.env.TZ = "Pacific/Chatham";

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
