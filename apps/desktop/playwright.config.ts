import { defineConfig } from "@playwright/test"

// Real-browser layout invariants for the editor surface (see e2e/harness.ts for
// why this exists). Geometry assertions are relative (ratios, gaps) so they hold
// across runner fonts and DPI; no pixel snapshots on purpose.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:9420",
    // CI uses the pinned Playwright Chromium download. Dev machines behind
    // sandboxed/proxied networks may not reach the CDN — fall back to the
    // system Chrome channel (assertions are relative geometry, engine-robust).
    channel: process.env.CI ? undefined : (process.env.PW_CHANNEL ?? "chrome"),
  },
  webServer: {
    command: "pnpm dev",
    port: 9420,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
