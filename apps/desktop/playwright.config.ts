import { defineConfig } from "@playwright/test"

// Real-browser layout invariants for the editor surface (see e2e/harness.ts for
// why this exists). Geometry assertions are relative (ratios, gaps) so they hold
// across runner fonts and DPI; no pixel snapshots on purpose.
//
// PW_PORT: with `reuseExistingServer`, a second concurrent worktree would reuse the
// serving `pnpm dev` of the first one — and since the harness page plus the whole
// `src/` tree are served from that Vite root, the suite would silently assert against
// foreign code. Overriding the port makes each worktree serve its own sources; the
// default stays 9420, so the plain command is unchanged.
const PORT = Number(process.env.PW_PORT ?? 9420)

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // CI uses the pinned Playwright Chromium download. Dev machines behind
    // sandboxed/proxied networks may not reach the CDN — fall back to the
    // system Chrome channel (assertions are relative geometry, engine-robust).
    channel: process.env.CI ? undefined : (process.env.PW_CHANNEL ?? "chrome"),
  },
  webServer: {
    command: PORT === 9420 ? "pnpm dev" : `pnpm dev --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
