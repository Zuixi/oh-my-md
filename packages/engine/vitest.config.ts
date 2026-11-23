import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
    // Unit suite only: `bench/perfGate.test.ts` runs through vitest.perf.config.ts
    // (single worker) so timed wall-clock budgets are never measured under load.
    include: ["test/**/*.test.ts"],
  },
})
