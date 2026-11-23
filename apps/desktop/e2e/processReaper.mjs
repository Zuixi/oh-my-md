// Process supervision for Playwright and the standalone browser audits.
//
// A piped run (`pnpm test:e2e | head`), Ctrl-C, or an IDE kill can end the Node driver
// before Playwright's async teardown or a script's `finally { browser.close() }` runs.
// Chromium then survives as an orphan: the browser keeps its own process group,
// `chrome_crashpad_handler` reparents to PID 1 inside a *different* group, and GPU /
// network helpers plus the `vite` dev server keep running. Targets are found only from
// evidence this run owns - root PID/PGID, a unique `--omd-e2e-run=<uuid>` flag, and the
// unique temp dir in `--database=<tmp>/playwright_chromiumdev_profile-*/Crashpad` - never
// by executable name, so a developer's own Chrome is never at risk.
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024 // Chromium command lines are long
const REAP_POLL_MS = 50 // re-snapshot cadence while SIGTERM lands
const SIGKILL_SETTLE_MS = 50 // one pause so the kernel retires the last targets
const DEFAULT_REAP_GRACE_MS = 1500 // one Chromium teardown, not one test timeout

/** Per-run identity: a UUID tag on every Chromium command line plus a private temp dir. */
export function createRunSandbox(prefix = "omd-e2e") {
  const runId = randomUUID()
  const runTag = `--omd-e2e-run=${runId}`
  // realpath matters: macOS `ps` reports /private/var/... while tmpdir() hands back the
  // /var/folders/... symlink, and crashpad's `--database=` must match this string verbatim.
  const runTmpDir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-${runId.slice(0, 8)}-`)))
  return {
    runId,
    runTag,
    runTmpDir,
    // Chromium resolves temp paths from the environment, so every profile, socket and
    // crashpad database this run creates stays inside runTmpDir.
    childEnv: (baseEnv = process.env) => {
      const temp = { TMPDIR: runTmpDir, TMP: runTmpDir, TEMP: runTmpDir }
      return { ...baseEnv, ...temp, OMD_PW_RUN_ID: runId, OMD_PW_TMPDIR: runTmpDir }
    },
    cleanupTmpDir: () => removeTmpDir(runTmpDir),
  }
}

/** Parse `ps -axo pid=,ppid=,pgid=,command=` into rows; unparsable lines are skipped. */
export function parsePosixPs(stdout) {
  const rows = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] })
  }
  return rows
}

/**
 * Pure selection step. `selfPid`, `parentPid` and their groups stay protected, so a reaper
 * running inside Vitest can never signal its own runner.
 */
export function selectReapTargets(rows, { rootPid, runTag, runTmpDir, selfPid, parentPid }) {
  const selfPgid = rows.find(row => row.pid === selfPid)?.pgid ?? -1
  const parentPgid = rows.find(row => row.pid === parentPid)?.pgid ?? -1
  const protectedPids = new Set([0, 1, selfPid, parentPid])
  const protectedPgids = new Set([0, 1, selfPgid])
  if (parentPgid > 0) protectedPgids.add(parentPgid)
  const hasRoot = typeof rootPid === "number" && rootPid > 1

  const matchedPids = new Set()
  for (const row of rows) {
    if (protectedPids.has(row.pid)) continue
    const rootMatch = hasRoot && (row.pid === rootPid || (!protectedPgids.has(rootPid) && row.pgid === rootPid))
    const tagMatch = Boolean(runTag) && row.command.includes(runTag)
    const tmpMatch = Boolean(runTmpDir) && row.command.includes(runTmpDir)
    if (rootMatch || tagMatch || tmpMatch) matchedPids.add(row.pid)
  }

  // Transitive closure: children of a matched process, plus members of a group whose leader
  // is itself part of this run - a `vite` child of a matched shell, a GPU helper one hop
  // below a tagged browser.
  let grew = true
  while (grew) {
    grew = false
    for (const row of rows) {
      if (matchedPids.has(row.pid) || protectedPids.has(row.pid)) continue
      const parentMatched = matchedPids.has(row.ppid)
      const groupMatched = !protectedPgids.has(row.pgid) && matchedPids.has(row.pgid)
      if (!parentMatched && !groupMatched) continue
      matchedPids.add(row.pid)
      grew = true
    }
  }

  const targetPgids = new Set()
  for (const { pid, pgid } of rows) {
    if (!matchedPids.has(pid) || protectedPgids.has(pgid)) continue
    if ((hasRoot && pgid === rootPid) || matchedPids.has(pgid)) targetPgids.add(pgid)
  }
  return { targetPids: [...matchedPids], targetPgids: [...targetPgids] }
}

/**
 * Synchronous, so it also works inside `process.on("exit")`: SIGTERM the run's groups and
 * PIDs, poll until they are gone (catching children that reparent to PID 1 mid-teardown),
 * then SIGKILL the rest. The temp directory is removed on every path.
 */
export function reapRunProcessesSync({
  rootPid = null,
  runTag = "",
  runTmpDir = "",
  graceMs = DEFAULT_REAP_GRACE_MS,
} = {}) {
  if (process.platform === "win32") {
    // `taskkill /T` walks the Windows process tree; there are no POSIX groups to signal.
    const hasRoot = typeof rootPid === "number" && rootPid > 1
    if (hasRoot) spawnSync("taskkill", ["/T", "/F", "/PID", String(rootPid)], { stdio: "ignore" })
    removeTmpDir(runTmpDir)
    return
  }

  let targets = snapshotTargets({ rootPid, runTag, runTmpDir })
  if (!hasTargets(targets)) {
    removeTmpDir(runTmpDir)
    return
  }
  signalTargets(targets, "SIGTERM")
  const deadline = Date.now() + Math.max(0, graceMs)
  while (Date.now() < deadline) {
    sleepSync(REAP_POLL_MS)
    targets = snapshotTargets({ rootPid, runTag, runTmpDir })
    if (!hasTargets(targets)) break
  }
  if (hasTargets(targets)) {
    signalTargets(targets, "SIGKILL")
    sleepSync(SIGKILL_SETTLE_MS)
  }
  removeTmpDir(runTmpDir)
}

/**
 * Route a closed stdout/stderr pipe (SIGPIPE surfaces as EPIPE in Node) to the caller's
 * shutdown instead of an uncaught stream error. Returns a disposer for long-lived hosts.
 */
export function installBrokenPipeGuard(onBrokenPipe) {
  const onError = error => {
    if (error?.code !== "EPIPE") throw error
    onBrokenPipe()
  }
  const streams = [process.stdout, process.stderr]
  for (const stream of streams) stream.on("error", onError)
  const usePosixSignal = process.platform !== "win32"
  if (usePosixSignal) process.on("SIGPIPE", onBrokenPipe)
  return () => {
    for (const stream of streams) stream.removeListener("error", onError)
    if (usePosixSignal) process.removeListener("SIGPIPE", onBrokenPipe)
  }
}

const hasTargets = ({ targetPids, targetPgids }) => targetPids.length > 0 || targetPgids.length > 0
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function snapshotTargets({ rootPid, runTag, runTmpDir }) {
  try {
    // A synchronous reap blocks the event loop, so a child that already died is still listed
    // as `<defunct>` until this process collects it. Dropping zombie rows keeps a clean
    // teardown at two `ps` calls instead of a full grace period.
    const table = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], {
      encoding: "utf8",
      maxBuffer: PS_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const rows = parsePosixPs(table).filter(row => !row.command.includes("<defunct>"))
    return selectReapTargets(rows, { rootPid, runTag, runTmpDir, selfPid: process.pid, parentPid: process.ppid })
  } catch {
    // `ps` can fail under resource pressure; a reaper never throws from an exit handler.
    return { targetPids: [], targetPgids: [] }
  }
}

function signalTargets({ targetPids, targetPgids }, signal) {
  for (const target of [...targetPgids.map(pgid => -pgid), ...targetPids]) {
    try {
      process.kill(target, signal)
    } catch {
      // ESRCH (already exited) and EPERM are expected races between snapshot and signal;
      // nothing here may abort a teardown or exit handler.
    }
  }
}

function removeTmpDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A file can still be held by a process the kernel is retiring; the dir is unique per
    // run, so a late failure leaks one OS-temp folder and nothing else.
  }
}
