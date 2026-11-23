import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parsePosixPs, selectReapTargets, type PsRow } from "../e2e/processReaper.mjs"

// Selection is unit-tested with synthetic `ps` rows; the teardown contract is proved with
// real OS processes, because the failure this module fixes (orphaned Chromium groups after
// SIGPIPE/SIGTERM) only exists at the process-table level.
const RUN_ID = "11111111-2222-3333-4444-555555555555"
const RUN_TAG = `--omd-e2e-run=${RUN_ID}`
const RUN_TMP = "/private/var/folders/xy/omd-pw-11111111-"
const USER_CRASHPAD = "/Users/u/Library/Application Support/Google/Chrome/Crashpad"

const PS_SAMPLE = [
  "    1     0     1 /sbin/launchd",
  "  900   800   800 node vitest",
  "20324     1 20324 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=browser",
  `20326     1 20325 /Applications/Google Chrome.app/Contents/Helpers/chrome_crashpad_handler --database=${USER_CRASHPAD}`,
  "",
].join("\n")

/** A run's own tree plus an unrelated user Chrome that must never be selected. */
const RUN_ROWS: PsRow[] = [
  { pid: 1, ppid: 0, pgid: 1, command: "/sbin/launchd" },
  { pid: 800, ppid: 1, pgid: 800, command: "node vitest run" },
  { pid: 900, ppid: 800, pgid: 800, command: "node test-worker" },
  { pid: 20324, ppid: 1, pgid: 20324, command: "Google Chrome --type=browser" },
  { pid: 20326, ppid: 1, pgid: 20325, command: `chrome_crashpad_handler --database=${USER_CRASHPAD}` },
  { pid: 55000, ppid: 900, pgid: 55000, command: "node playwright test e2e/topbar-tabs.spec.ts" },
  { pid: 55001, ppid: 55000, pgid: 55000, command: "node ./node_modules/vite/bin/vite.js --port 9437" },
  { pid: 55010, ppid: 1, pgid: 55010, command: `Google Chrome for Testing --type=browser ${RUN_TAG}` },
  { pid: 55011, ppid: 55010, pgid: 55010, command: "Google Chrome for Testing --type=gpu-process" },
  {
    pid: 55099,
    ppid: 1,
    pgid: 55099,
    command: `chrome_crashpad_handler --database=${RUN_TMP}/playwright_chromiumdev_profile-abc/Crashpad`,
  },
]

describe("parsePosixPs", () => {
  it("reads pid/ppid/pgid and keeps the full command line", () => {
    const rows = parsePosixPs(PS_SAMPLE)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ pid: 1, ppid: 0, pgid: 1, command: "/sbin/launchd" })
    expect(rows[1]).toMatchObject({ pid: 900, ppid: 800, pgid: 800 })
    expect(rows[3]).toMatchObject({ pid: 20326, ppid: 1, pgid: 20325 })
    expect(rows[3]?.command).toContain(`--database=${USER_CRASHPAD}`)
  })
})

describe("selectReapTargets", () => {
  const select = (rows: PsRow[], rootPid: number) =>
    selectReapTargets(rows, { rootPid, runTag: RUN_TAG, runTmpDir: RUN_TMP, selfPid: 900, parentPid: 800 })

  it("selects the run's group, its tagged browser and the untagged crashpad handler", () => {
    const { targetPids, targetPgids } = select(RUN_ROWS, 55000)
    expect([...targetPids].sort((a, b) => a - b)).toEqual([55000, 55001, 55010, 55011, 55099])
    // 55099 is a group leader in its own group: crashpad does not inherit the browser's PGID.
    expect([...targetPgids].sort((a, b) => a - b)).toEqual([55000, 55010, 55099])
  })

  it("never selects the runner, its parent, PID 1, or an unrelated Chrome", () => {
    const { targetPids, targetPgids } = select(RUN_ROWS, 55000)
    for (const pid of [1, 800, 900, 20324, 20326]) expect(targetPids).not.toContain(pid)
    for (const pgid of [1, 800, 20324, 20325]) expect(targetPgids).not.toContain(pgid)
  })

  it("protects the runner's group even when that PID is passed as the root", () => {
    const { targetPids, targetPgids } = select(RUN_ROWS, 800)
    for (const pid of [800, 900]) expect(targetPids).not.toContain(pid)
    expect(targetPgids).not.toContain(800)
    // The run's own evidence (tag and temp directory) is still found from the same snapshot.
    expect([...targetPids].sort((a, b) => a - b)).toEqual([55010, 55011, 55099])
  })
})

const FIXTURE_LINES = [
  'import { spawn } from "node:child_process"',
  "",
  'const KEEP_ALIVE = "setInterval(() => {}, 1000)"',
  'const runTag = process.env.OMD_PW_RUN_ID ? `--omd-e2e-run=${process.env.OMD_PW_RUN_ID}` : ""',
  'const tmpDir = process.env.OMD_PW_TMPDIR ?? ""',
  "",
  "// Detached children get their own session and PGID, like a reparented Chromium helper.",
  "function detached(args) {",
  '  const child = spawn(process.execPath, ["-e", KEEP_ALIVE, "--", ...args], { detached: true, stdio: "ignore" })',
  "  child.unref()",
  "  return child.pid",
  "}",
  "",
  'const sameGroup = spawn(process.execPath, ["-e", KEEP_ALIVE], { stdio: "ignore" })',
  "const browserPid = detached([runTag])",
  'const crashpadPid = detached([`--database=${tmpDir}/Crashpad`])',
  "const report = { sameGroupPid: sameGroup.pid, browserPid, crashpadPid, runTmpDir: tmpDir }",
  'process.stdout.write(`${JSON.stringify(report)}\\n`)',
  'setInterval(() => process.stdout.write("tick\\n"), 40)',
]

interface FixtureReport {
  sameGroupPid: number
  browserPid: number
  crashpadPid: number
  runTmpDir: string
}

const desktopDir = join(import.meta.dirname, "..")
const supervisorScript = join(desktopDir, "scripts", "runE2eSupervised.mjs")
const scratchDirs: string[] = []

function writeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "omd-supervisor-fixture-"))
  scratchDirs.push(dir)
  const path = join(dir, "fixture.mjs")
  writeFileSync(path, `${FIXTURE_LINES.join("\n")}\n`)
  return path
}

function startRun(fixture: string): ChildProcess {
  return spawn(process.execPath, [supervisorScript], {
    cwd: desktopDir,
    env: { ...process.env, OMD_E2E_TARGET_SCRIPT: fixture },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function readReport(child: ChildProcess, stderrText: () => string): Promise<FixtureReport> {
  return new Promise((resolve, reject) => {
    let buffered = ""
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString()
      const line = buffered.split("\n").find(candidate => candidate.startsWith("{"))
      if (line === undefined) return
      child.stdout?.off("data", onData)
      resolve(JSON.parse(line) as FixtureReport)
    }
    child.stdout?.on("data", onData)
    child.once("close", code => reject(new Error(`supervisor exited early (${String(code)}): ${stderrText()}`)))
  })
}

function collectStderr(child: ChildProcess): () => string {
  let text = ""
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString()
  })
  return () => text
}

function closed(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })))
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** SIGKILL/exit takes effect before the parent reaps, so poll instead of sampling once. */
async function expectAllDead(pids: number[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let survivors = pids.filter(alive)
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    survivors = pids.filter(alive)
  }
  expect(survivors).toEqual([])
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("supervised run teardown", () => {
  it("reaps the group, tagged browser and crashpad handler on SIGTERM", async () => {
    const supervisor = startRun(writeFixture())
    const stderrText = collectStderr(supervisor)
    const report = await within(readReport(supervisor, stderrText), 20_000, "fixture report")
    const pids = [report.sameGroupPid, report.browserPid, report.crashpadPid]
    expect(pids.filter(pid => !alive(pid))).toEqual([])
    expect(existsSync(report.runTmpDir)).toBe(true)

    const exit = closed(supervisor)
    supervisor.kill("SIGTERM")
    const { code } = await within(exit, 30_000, "supervisor SIGTERM exit")
    expect(code).toBe(143)
    await expectAllDead(pids)
    expect(existsSync(report.runTmpDir)).toBe(false)
    expect(stderrText()).not.toContain("uncaughtException")
  })

  it("reaps everything when its stdout pipe closes, like `playwright test | head`", async () => {
    const supervisor = startRun(writeFixture())
    const stderrText = collectStderr(supervisor)
    const report = await within(readReport(supervisor, stderrText), 20_000, "fixture report")
    const pids = [report.sameGroupPid, report.browserPid, report.crashpadPid]

    const exit = closed(supervisor)
    supervisor.stdout?.destroy()
    const { code } = await within(exit, 30_000, "supervisor EPIPE exit")
    expect(code).toBe(141)
    await expectAllDead(pids)
    expect(existsSync(report.runTmpDir)).toBe(false)
    expect(stderrText()).not.toContain("uncaughtException")
  })
})
