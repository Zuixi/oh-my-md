import { defineConfig } from "@playwright/test"

// Real-browser layout invariants for the editor surface (see e2e/harness.ts for
// why this exists). Geometry assertions are relative (ratios, gaps) so they hold
// across runner fonts and DPI; no pixel snapshots on purpose.
//
// PW_PORT gives each concurrent worktree its own server. Playwright owns that server
// by default so it also owns cleanup; PW_REUSE_SERVER=1 is an explicit opt-in for a
// human-managed server. A malformed port falls back to 9420.
const PORT = Number.parseInt(process.env.PW_PORT ?? "", 10) || 9420
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    // CI uses the pinned Playwright Chromium download. Dev machines behind
    // sandboxed/proxied networks may not reach the CDN — fall back to the
    // system Chrome channel (assertions are relative geometry, engine-robust).
    channel: process.env.CI ? undefined : (process.env.PW_CHANNEL ?? "chrome"),
    // `runE2eSupervised.mjs` stamps the run id here. A browser that outlives the driver
    // then carries this tag on its command line, so the reaper can find it without ever
    // matching on the executable name (the developer's own Chrome has no tag).
    launchOptions: {
      args: process.env.OMD_PW_RUN_ID ? [`--omd-e2e-run=${process.env.OMD_PW_RUN_ID}`] : [],
    },
  },
  webServer: {
    // Start Vite directly: an intermediate `pnpm dev` wrapper is one more process between
    // Playwright and the server, and a leak target the reaper would have to infer.
    command: `node ./node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: process.env.PW_REUSE_SERVER === "1",
    timeout: 60_000,
  },
})
