import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { MODES, descendantsOf, plan, quoteWindowsArg } from "./task.mjs"

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url))
const RUNNER = join(SCRIPTS, "task.mjs")

const commandsOf = (steps) => steps.flatMap((step) => step.commands ?? [])

test("test mode defaults to every suite in fail-fast order", () => {
  const keys = plan("test").map((step) => step.key)
  assert.deepEqual(keys, ["quality", "engine", "desktop", "rust"])
})

test("a suite step delegates to the package script instead of restating it", () => {
  // `tsc --noEmit && vitest run` belongs to packages/engine/package.json; if it
  // is ever copied here, CI, the pre-commit hook, and this runner drift apart.
  assert.deepEqual(commandsOf(plan("test", "engine")), [
    ["pnpm", ["-F", "@omd/engine", "test"]],
  ])
  assert.deepEqual(commandsOf(plan("test", "desktop")), [
    ["pnpm", ["-F", "@omd/desktop", "test"]],
  ])
})

test("build app keeps the Rust link gate, build web stays fast", () => {
  assert.deepEqual(
    plan("build").map((step) => step.key),
    ["web-build", "rust-link"],
  )
  assert.deepEqual(
    plan("build", "web").map((step) => step.key),
    ["web-build"],
  )
})

test("verify runs every suite before the link gate", () => {
  assert.deepEqual(
    plan("verify").map((step) => step.key),
    ["quality", "engine", "desktop", "rust", "web-build", "rust-link"],
  )
})

test("package bundles first, then collects artifacts", () => {
  const steps = plan("package")
  assert.deepEqual(
    steps.map((step) => step.key),
    ["tauri-build", "package-artifacts"],
  )
  assert.equal(typeof steps.at(-1).run, "function")
})

test("unknown mode and target name the valid choices", () => {
  assert.throws(() => plan("buid"), /unknown mode "buid".*dev \| build \| test \| verify \| package/)
  assert.throws(
    () => plan("test", "engin"),
    /unknown target "engin" for mode "test".*quality \| engine \| desktop \| rust \| e2e/,
  )
})

test("every mode/target combination resolves to executable steps", () => {
  // Guards against a step-key typo, which would otherwise spread `undefined`
  // into an empty step that silently succeeds.
  for (const [mode, entry] of Object.entries(MODES)) {
    assert.ok(entry.targets[entry.defaultTarget], `${mode}: default target is not declared`)
    for (const target of Object.keys(entry.targets)) {
      const steps = plan(mode, target)
      assert.ok(steps.length > 0, `${mode}/${target} resolved to no steps`)
      for (const step of steps) {
        assert.ok(step.label, `${mode}/${target}: step "${step.key}" has no label`)
        assert.ok(
          (step.commands?.length ?? 0) > 0 || typeof step.run === "function",
          `${mode}/${target}: step "${step.key}" has nothing to run`,
        )
      }
    }
  }
})

test("dry run prints the plan without spawning anything", () => {
  // `--dry-run` is how the Windows command lines get inspected from a
  // non-Windows host, so it must stay side-effect free.
  const result = spawnSync(process.execPath, [RUNNER, "build", "app", "--dry-run"], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /==> desktop \(tsc \+ vite build\)/)
  assert.match(result.stdout, /cargo build --manifest-path .*Cargo\.toml --no-default-features/)
})

test("interrupts reap the whole process tree, not just the direct child", async (t) => {
  // A dev run is pnpm -> tauri -> cargo/vite. Killing only the direct child
  // leaves the dev server holding port 9420 (observed while building this
  // runner), so the descendant walk is the part that must not regress.
  if (process.platform === "win32") return t.skip("covered by taskkill /t on Windows")
  const child = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], {
    detached: true,
    stdio: "ignore",
  })
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {
      // Already reaped.
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 300))

  const found = descendantsOf(child.pid)
  assert.ok(found.length >= 2, `expected the two sleeps, got ${found.join(",")}`)
  assert.ok(!found.includes(child.pid), "the root pid must not be signalled twice")
})

test("quoting handles the Windows argument shapes cmd.exe breaks on", () => {
  assert.equal(quoteWindowsArg("--all-targets"), "--all-targets")
  assert.equal(quoteWindowsArg("-D"), "-D")
  assert.equal(quoteWindowsArg(""), '""')
  assert.equal(quoteWindowsArg("C:\\Program Files\\omd"), '"C:\\Program Files\\omd"')
  assert.equal(quoteWindowsArg("a&b"), '"a&b"')
  assert.equal(quoteWindowsArg('say "hi"'), '"say ""hi"""')
})

test("shell shims delegate instead of keeping a second copy of the sequence", () => {
  // The point of this runner is one implementation. A shim that regrows its own
  // `cargo`/`--filter` sequence silently re-forks the contract.
  for (const file of ["test.sh", "build.sh", "package.sh", "test.ps1", "build.ps1", "package.ps1"]) {
    const text = readFileSync(join(SCRIPTS, file), "utf8")
    assert.match(text, /task\.mjs/, `${file} must delegate to scripts/task.mjs`)
    const executable = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
    assert.doesNotMatch(executable, /cargo |--filter/, `${file} must not restate the sequence`)
  }
})
