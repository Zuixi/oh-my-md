#!/usr/bin/env node
/**
 * Cross-platform task runner: `dev`, `build`, `test`, `verify`, `package`.
 *
 * One Node file owns every sequence instead of a bash/PowerShell pair per
 * command. The old scripts/*.sh + scripts/*.ps1 copies had already drifted
 * (package.ps1 collected more artifacts than package.sh) and CI only ever ran
 * the bash side. Node runs identically on macOS, Windows, and Linux, so the
 * shell scripts are now thin delegating shims.
 *
 * Invariants:
 * - Steps only compose package scripts. `tsc --noEmit && vitest run` stays in
 *   packages/engine/package.json; restating it here would recreate the drift.
 * - Steps are sequential with inherited stdio and fail fast, so the last
 *   printed step is always the one that failed.
 * - Nothing here reads or writes document state; it spawns processes and
 *   copies build artifacts.
 */
import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const IS_WINDOWS = process.platform === "win32"
const SIGNAL_EXIT_CODE = 130
/** How long a signalled child gets before the runner leaves without it. */
const INTERRUPT_GRACE_MS = 5000

const DESKTOP_PKG = "@omd/desktop"
const ENGINE_PKG = "@omd/engine"
const CARGO_MANIFEST = join("apps", "desktop", "src-tauri", "Cargo.toml")
const RELEASE_DIR = join("apps", "desktop", "src-tauri", "target", "release")
const BUNDLE_DIR = join(RELEASE_DIR, "bundle")
const OUTPUT_DIR = "output"

/** Bundle artifacts worth collecting, matched by filename suffix on every OS. */
const BUNDLE_ARTIFACT_SUFFIXES = [
  ".dmg",
  ".app.tar.gz",
  ".app.tar.gz.sig",
  ".deb",
  ".AppImage",
  ".AppImage.sig",
  "-setup.exe",
  "-setup.exe.sig",
  ".msi",
  ".msi.sig",
]
const APP_BINARY_NAMES = ["omd", "omd.exe"]

const pnpm = (...args) => ["pnpm", args]
const cargo = (...args) => ["cargo", args]

/**
 * Leaf steps. `commands` are spawned in order; `run` is an in-process step for
 * work with no shell equivalent (artifact collection).
 */
const STEPS = {
  quality: {
    label: "quality (module-size gate + behavior tests)",
    commands: [pnpm("check:quality")],
  },
  engine: {
    label: "engine (tsc --noEmit + vitest)",
    commands: [pnpm("-F", ENGINE_PKG, "test")],
  },
  desktop: {
    label: "desktop (tsc + vitest)",
    commands: [pnpm("-F", DESKTOP_PKG, "test")],
  },
  e2e: {
    label: "desktop e2e (Playwright, real browser)",
    commands: [pnpm("-F", DESKTOP_PKG, "test:e2e")],
  },
  rust: {
    label: "rust (fmt + clippy + test)",
    commands: [
      cargo("fmt", "--all", "--manifest-path", CARGO_MANIFEST, "--", "--check"),
      cargo("clippy", "--manifest-path", CARGO_MANIFEST, "--all-targets", "--", "-D", "warnings"),
      cargo("test", "--manifest-path", CARGO_MANIFEST),
    ],
  },
  "web-build": {
    label: "desktop (tsc + vite build)",
    commands: [pnpm("-F", DESKTOP_PKG, "build")],
  },
  "rust-link": {
    label: "rust app binary link (matches tauri dev)",
    commands: [cargo("build", "--manifest-path", CARGO_MANIFEST, "--no-default-features")],
  },
  "dev-app": {
    label: "tauri dev (native window + hot reload)",
    commands: [pnpm("-F", DESKTOP_PKG, "tauri", "dev")],
  },
  "dev-web": {
    label: "vite dev server (browser only, no native window)",
    commands: [pnpm("-F", DESKTOP_PKG, "dev")],
  },
  "tauri-build": {
    label: "desktop package (tauri build)",
    commands: [pnpm("-F", DESKTOP_PKG, "tauri", "build")],
  },
  "package-artifacts": {
    label: "collect artifacts into output/",
    run: collectArtifacts,
  },
}

export const MODES = {
  dev: {
    description: "run the app (or the Vite server) with hot reload",
    defaultTarget: "app",
    targets: { app: ["dev-app"], web: ["dev-web"] },
  },
  build: {
    description: "production frontend build, optionally with the Rust link gate",
    defaultTarget: "app",
    targets: { app: ["web-build", "rust-link"], web: ["web-build"] },
  },
  test: {
    description: "run test suites, fail fast",
    defaultTarget: "all",
    targets: {
      all: ["quality", "engine", "desktop", "rust"],
      quality: ["quality"],
      engine: ["engine"],
      desktop: ["desktop"],
      rust: ["rust"],
      e2e: ["e2e"],
    },
  },
  verify: {
    description: "full gate: every suite plus the Rust app binary link",
    defaultTarget: "all",
    targets: { all: ["quality", "engine", "desktop", "rust", "web-build", "rust-link"] },
  },
  package: {
    description: "release bundle for the host platform, collected into output/",
    defaultTarget: "app",
    targets: { app: ["tauri-build", "package-artifacts"] },
  },
}

/** Quotes one argument for `cmd.exe` (Windows paths contain spaces). */
export function quoteWindowsArg(arg) {
  if (arg === "") return '""'
  if (!/[\s"&|<>^()]/.test(arg)) return arg
  // Doubling inner quotes is the cmd.exe rule; no step argument contains one.
  return `"${arg.replace(/"/g, '""')}"`
}

/** Resolves a mode + target into ordered steps, or throws a usage error. */
export function plan(mode, target) {
  const entry = Object.hasOwn(MODES, mode) ? MODES[mode] : undefined
  if (entry === undefined) {
    throw new UsageError(`unknown mode "${mode}" (expected ${Object.keys(MODES).join(" | ")})`)
  }
  const name = target ?? entry.defaultTarget
  const keys = Object.hasOwn(entry.targets, name) ? entry.targets[name] : undefined
  if (keys === undefined) {
    throw new UsageError(
      `unknown target "${name}" for mode "${mode}" (expected ${Object.keys(entry.targets).join(" | ")})`,
    )
  }
  return keys.map((key) => {
    const step = Object.hasOwn(STEPS, key) ? STEPS[key] : undefined
    if (step === undefined) {
      throw new Error(`internal: mode "${mode}" references unknown step "${key}"`)
    }
    return { key, ...step }
  })
}

class UsageError extends Error {}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    })
  } catch (error) {
    return usage(error.message, 2)
  }
  if (parsed.values.help) return usage(null, 0)

  const [mode, target, ...rest] = parsed.positionals
  if (mode === undefined) return usage("missing mode", 2)
  if (rest.length > 0) return usage(`unexpected argument "${rest[0]}"`, 2)

  const dryRun = parsed.values["dry-run"] === true
  let steps
  try {
    steps = plan(mode, target)
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message, 2)
    throw error
  }
  return runSteps(steps, { dryRun })
}

async function runSteps(steps, { dryRun }) {
  for (const step of steps) {
    console.log(`==> ${step.label}`)
    const code = await runStep(step, { dryRun })
    if (code !== 0) return code
    if (interrupted) return SIGNAL_EXIT_CODE
  }
  console.log(dryRun ? "==> dry run complete; nothing was executed" : "==> OK")
  return 0
}

async function runStep(step, { dryRun }) {
  if (step.run !== undefined) {
    if (dryRun) {
      console.log("    (in-process step)")
      return 0
    }
    await step.run()
    return 0
  }
  for (const [bin, args] of step.commands) {
    const line = [bin, ...args].join(" ")
    if (dryRun) {
      console.log(`    ${line}`)
      continue
    }
    const code = await runCommand(bin, args)
    if (code !== 0) {
      // An interrupt is not a defect: report the signal exit code, not "FAILED".
      if (interrupted) return SIGNAL_EXIT_CODE
      console.error(`==> FAILED: ${line}`)
      return code
    }
  }
  return 0
}

function runCommand(bin, args) {
  return new Promise((resolve, reject) => {
    const child = startChild(bin, args)
    activeChild = child
    child.on("error", (error) => {
      activeChild = null
      reject(error)
    })
    child.on("exit", (code, signal) => {
      activeChild = null
      resolve(signal === null ? (code ?? 1) : SIGNAL_EXIT_CODE)
    })
  })
}

function startChild(bin, args) {
  const options = { cwd: ROOT, stdio: "inherit", shell: false, windowsHide: true }
  if (!IS_WINDOWS) return spawn(bin, args, options)
  // Node refuses to spawn .cmd/.bat shims (`pnpm`) without a shell, so Windows
  // goes through cmd.exe with every argument quoted explicitly.
  const line = [bin, ...args].map(quoteWindowsArg).join(" ")
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], options)
}

let activeChild = null
let interrupted = false

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true
    if (activeChild === null) {
      process.exit(SIGNAL_EXIT_CODE)
      return
    }
    stopChild(activeChild)
    // A wedged child must never wedge the runner: the dev server chain
    // (pnpm -> tauri -> cargo/vite) can ignore the signal, so the exit does not
    // depend on the child's exit event.
    setTimeout(() => process.exit(SIGNAL_EXIT_CODE), INTERRUPT_GRACE_MS).unref()
  })
}

function stopChild(child) {
  if (child.pid === undefined) return
  if (IS_WINDOWS) {
    // Windows has no process groups, so a plain kill leaves cargo.exe holding
    // the target-directory lock and the next build fails with "file is in use".
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" })
    return
  }
  // The child shares our process group (that is what lets terminal Ctrl-C reach
  // it), so negative-PID signalling would hit this runner and its siblings.
  // Walk the descendant list deepest-first, then signal the direct child too so
  // non-TTY SIGTERM (e.g. CI timeout or IDE stop) never leaves a leaf child alive.
  for (const pid of [...descendantsOf(child.pid), child.pid]) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // Already gone: a signal race is not an error.
    }
  }
}

export function descendantsOf(rootPid) {
  const output = spawnSync("ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" }).stdout ?? ""
  const childrenOf = new Map()
  for (const line of output.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const siblings = childrenOf.get(ppid) ?? []
    siblings.push(pid)
    childrenOf.set(ppid, siblings)
  }
  const found = []
  const pending = [...(childrenOf.get(rootPid) ?? [])]
  while (pending.length > 0) {
    const pid = pending.pop()
    found.push(pid)
    pending.push(...(childrenOf.get(pid) ?? []))
  }
  return found.reverse()
}

function collectArtifacts() {
  const output = join(ROOT, OUTPUT_DIR)
  mkdirSync(output, { recursive: true })
  const collected = []

  const bundleDir = join(ROOT, BUNDLE_DIR)
  if (existsSync(bundleDir)) {
    for (const file of walk(bundleDir)) {
      const name = basename(file)
      if (!BUNDLE_ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue
      copyFileSync(file, join(output, name))
      collected.push(name)
    }
  }
  for (const name of APP_BINARY_NAMES) {
    const source = join(ROOT, RELEASE_DIR, name)
    if (!existsSync(source)) continue
    copyFileSync(source, join(output, name))
    collected.push(name)
  }

  if (collected.length === 0) {
    throw new Error(`no artifacts found under ${BUNDLE_DIR}; did the bundle step run?`)
  }
  console.log(`    ${collected.length} artifact(s) in ${OUTPUT_DIR}/`)
  for (const name of collected) console.log(`    ${name}`)
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

function usage(error, code) {
  const lines = [
    "Usage: node scripts/task.mjs <mode> [target] [--dry-run]",
    "",
    "Modes (default target in brackets):",
    ...Object.entries(MODES).map(
      ([name, mode]) =>
        `  ${name.padEnd(8)} ${mode.description}  [${Object.keys(mode.targets).join("|")}]`,
    ),
    "",
    "Examples:",
    "  pnpm dev                      # native window, hot reload",
    "  pnpm build web                # frontend bundle only (fast loop)",
    "  pnpm test engine              # one suite: quality|engine|desktop|rust|e2e",
    "  node scripts/task.mjs verify --dry-run",
  ]
  const text = lines.join("\n")
  if (error !== null) console.error(`task: ${error}\n\n${text}`)
  else console.log(text)
  return code
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`task: ${error.stack ?? error}`)
      process.exitCode = 1
    },
  )
}
