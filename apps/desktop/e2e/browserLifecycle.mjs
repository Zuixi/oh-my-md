// Shared lifecycle for the standalone browser audits (`apps/desktop/e2e/*-audit.mjs`,
// `calibrate-heights.mjs`). A bare `try { ... } finally { browser.close() }` cannot run
// when Node is killed, when the script is piped into `head` (SIGPIPE/EPIPE), or when the
// event loop dies with the browser still open - system Chrome then keeps its process
// group and `chrome_crashpad_handler` alive as orphans.
//
// `withManagedChromium` launches Chromium with a per-run tag and temp directory, and
// installs signal / exit / broken-pipe reapers that remove exactly those processes.
// The user's own Chrome never carries this run's tag, so it is never a target.
import { chromium } from "@playwright/test"
import { createRunSandbox, installBrokenPipeGuard, reapRunProcessesSync } from "./processReaper.mjs"

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"]
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
const EXIT_CODE_BROKEN_PIPE = 141
const REAP_GRACE_MS = 1500

/**
 * Launch Chromium for `fn` and guarantee the run's processes and temp profile are gone
 * before the promise settles - whether the audit succeeds, throws, or is interrupted.
 */
export async function withManagedChromium(launchOptions, fn) {
  const sandbox = createRunSandbox("omd-audit")
  let reaped = false
  let uninstall = () => {}

  const reapOnce = () => {
    if (reaped) return
    reaped = true
    // rootPid stays null: an audit's own PID is the script's, so the tag and the temp
    // directory are the only evidence - and they are unique to this run.
    reapRunProcessesSync({
      rootPid: null,
      runTag: sandbox.runTag,
      runTmpDir: sandbox.runTmpDir,
      graceMs: REAP_GRACE_MS,
    })
    sandbox.cleanupTmpDir()
  }

  const shutdown = exitCode => {
    reapOnce()
    uninstall()
    process.exit(exitCode)
  }

  const signalHandlers = new Map(
    SIGNALS.map(signal => [signal, () => shutdown(SIGNAL_EXIT_CODE[signal] ?? 1)]),
  )
  for (const [signal, handler] of signalHandlers) process.once(signal, handler)
  process.once("exit", reapOnce)
  const removeBrokenPipeGuard = installBrokenPipeGuard(() => shutdown(EXIT_CODE_BROKEN_PIPE))
  uninstall = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    process.removeListener("exit", reapOnce)
    removeBrokenPipeGuard()
  }

  const mergedOptions = {
    ...launchOptions,
    args: [...(launchOptions?.args ?? []), sandbox.runTag],
    env: sandbox.childEnv(launchOptions?.env ?? process.env),
  }

  let browser = null
  try {
    browser = await chromium.launch(mergedOptions)
    return await fn(browser)
  } finally {
    if (browser !== null) await browser.close().catch(() => {})
    reapOnce()
    uninstall()
  }
}
