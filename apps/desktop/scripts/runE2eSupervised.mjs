// Supervised `playwright test` entry point (`pnpm test:e2e`).
//
// Playwright owns browser + web-server teardown, but only while its own event loop is
// alive. `playwright test | head` (SIGPIPE/EPIPE), Ctrl-C, or an IDE kill ends the driver
// first, and the Chromium process group - plus `chrome_crashpad_handler` under the run's
// temp profile - survives. Running the CLI as a child in its own process group lets this
// process reap the whole group deterministically on every exit path, including the
// synchronous `process.on("exit")` one.
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRunSandbox, installBrokenPipeGuard, reapRunProcessesSync } from "../e2e/processReaper.mjs"

const desktopDir = fileURLToPath(new URL("..", import.meta.url))
const PLAYWRIGHT_CLI = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url))
/** SIGTERM grace for a Chromium teardown before SIGKILL. */
const REAP_GRACE_MS = 1500
/** The `exit` handler runs after an explicit reap; it only needs to catch stragglers. */
const EXIT_REAP_GRACE_MS = 500
const EXIT_CODE_BROKEN_PIPE = 141
const EXIT_CODE_SIGINT = 130
const EXIT_CODE_SIGTERM = 143
const EXIT_CODE_SIGHUP = 129
const EXIT_CODE_FAILURE = 1
/** A broken pipe can never be flushed, and a signal must reap now. */
const FORCE_EXIT = { force: true }

const customTarget = process.env.OMD_E2E_TARGET_SCRIPT ?? ""
const targetScript = customTarget === "" ? PLAYWRIGHT_CLI : customTarget
const targetArgs = customTarget === "" ? ["test", ...process.argv.slice(2)] : process.argv.slice(2)

const sandbox = createRunSandbox("omd-pw")
const childEnv = sandbox.childEnv(process.env)
// The child writes into a pipe, so Playwright's own `isTTY` check would drop ANSI colors
// that the previous in-process `playwright test` kept. Forward the terminal intent.
if (process.stdout.isTTY && childEnv.FORCE_COLOR === undefined) childEnv.FORCE_COLOR = "1"

const child = spawn(process.execPath, [targetScript, ...targetArgs], {
  cwd: desktopDir,
  env: childEnv,
  // A dedicated process group on POSIX: terminal Ctrl-C reaches this supervisor only, so
  // the reap order is ours, and `kill(-pid)` can address the whole Playwright tree.
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
})

let shuttingDown = false

function shutdown(exitCode, { force = false } = {}) {
  if (shuttingDown) return
  shuttingDown = true
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue
    stream.removeAllListeners("data")
    stream.destroy()
  }
  reapRunProcessesSync({
    rootPid: child.pid ?? null,
    runTag: sandbox.runTag,
    runTmpDir: sandbox.runTmpDir,
    graceMs: REAP_GRACE_MS,
  })
  sandbox.cleanupTmpDir()
  // A forced exit drops buffered writes, which is fine when the destination just broke but
  // would truncate Playwright's final report. The child's own exit therefore only sets the
  // code and lets the event loop drain its pending stdout writes before Node exits.
  process.exitCode = exitCode
  if (force) process.exit(exitCode)
}

function forward(source, sink) {
  if (source === null) return
  source.on("data", chunk => {
    if (shuttingDown) return
    try {
      sink.write(chunk)
    } catch {
      // A synchronous EPIPE from a closed pipe would otherwise escape the data handler
      // before the stream error event is emitted.
      shutdown(EXIT_CODE_BROKEN_PIPE, FORCE_EXIT)
    }
  })
}

forward(child.stdout, process.stdout)
forward(child.stderr, process.stderr)

installBrokenPipeGuard(() => shutdown(EXIT_CODE_BROKEN_PIPE, FORCE_EXIT))
process.on("SIGINT", () => shutdown(EXIT_CODE_SIGINT, FORCE_EXIT))
process.on("SIGTERM", () => shutdown(EXIT_CODE_SIGTERM, FORCE_EXIT))
process.on("SIGHUP", () => shutdown(EXIT_CODE_SIGHUP, FORCE_EXIT))
process.on("uncaughtException", error => {
  reportCrash("uncaughtException", error)
  shutdown(EXIT_CODE_FAILURE, FORCE_EXIT)
})
process.on("unhandledRejection", reason => {
  reportCrash("unhandledRejection", reason)
  shutdown(EXIT_CODE_FAILURE, FORCE_EXIT)
})

// Last line of defence: runs even when a handler above already called process.exit, and
// covers exits this script did not initiate.
process.on("exit", () => {
  reapRunProcessesSync({
    rootPid: child.pid ?? null,
    runTag: sandbox.runTag,
    runTmpDir: sandbox.runTmpDir,
    graceMs: EXIT_REAP_GRACE_MS,
  })
  sandbox.cleanupTmpDir()
})

child.on("error", error => {
  reportCrash("spawn", error)
  shutdown(EXIT_CODE_FAILURE, FORCE_EXIT)
})
child.on("close", (code, signal) => {
  shutdown(code ?? (signal === null ? 0 : EXIT_CODE_FAILURE))
})

function reportCrash(label, value) {
  if (!process.stderr.writable) return
  const detail = value instanceof Error ? (value.stack ?? value.message) : String(value)
  try {
    process.stderr.write(`[omd-e2e] ${label}: ${detail}\n`)
  } catch {
    // stderr may be the closed pipe that triggered this path; the exit code still carries
    // the outcome.
  }
}
