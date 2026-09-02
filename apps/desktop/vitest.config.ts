import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./test/setup.ts"],
    // e2e/ is Playwright territory (real Chromium via e2e/harness.html); the
    // default glob would collect its *.spec.ts into happy-dom and fail.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
})
