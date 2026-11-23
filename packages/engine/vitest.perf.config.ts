import { defineConfig } from "vitest/config"

// Blocking performance gate (PERF-01/PERF-03) — separate from the unit suite so
// `pnpm test` stays fast and 1 000+ tests never share the CPU with the timed
// scenarios. One worker, no file parallelism: wall-clock budgets are only
// meaningful when nothing else runs concurrently.
export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
    include: ["bench/perfGate.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
})
