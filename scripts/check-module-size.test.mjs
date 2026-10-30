import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const SCRIPT = fileURLToPath(new URL("./check-module-size.mjs", import.meta.url))
const BASELINE = "scripts/module-size-baseline.json"

function fixture(t, files = {}, baseline = {}) {
  const root = mkdtempSync(join(tmpdir(), "omd-module-size-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const budgets = (value) => write(BASELINE, JSON.stringify(value))
  const commit = () => {
    git("add", ".")
    git("-c", "user.name=Module Size Test", "-c", "user.email=test@example.invalid",
      "commit", "--quiet", "--no-verify", "-m", "fixture")
  }
  git("init", "--quiet")
  write(".gitignore", "ignored/\n")
  for (const [path, text] of Object.entries(files)) write(path, text)
  if (baseline !== null) budgets(baseline)
  commit()
  const check = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
  })
  return { root, git, write, budgets, commit, check }
}

function lines(count) {
  return "// source\n".repeat(count)
}

function passes(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function fails(result, pattern) {
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.match(result.stderr, pattern)
}

test("counts physical lines, including comments and blanks, at the exact limit", (t) => {
  const repo = fixture(t, {
    "src/with spaces.ts": lines(800),
    "src/no-newline.rs": lines(800).trimEnd(),
    "test/crlf.test.tsx": lines(800).replaceAll("\n", "\r\n"),
    "src/empty.py": "",
  })
  passes(repo.check())
  repo.write("src/with spaces.ts", `${lines(800)}\n`)
  fails(repo.check(), /src\/with spaces\.ts.*801.*800/)
})

test("rejects a new oversized module even when Git has not staged it", (t) => {
  const repo = fixture(t)
  repo.write("scripts/new.mjs", lines(801))
  fails(repo.check(), /scripts\/new\.mjs.*801.*800/)
})

test("permits legacy size but rejects growth beyond its explicit cap", (t) => {
  const repo = fixture(t, { "src/legacy.ts": lines(850) }, { "src/legacy.ts": 850 })
  passes(repo.check())
  repo.write("src/legacy.ts", lines(851))
  fails(repo.check(), /src\/legacy\.ts.*851.*850/)
})

test("cannot reclaim a legacy reduction after it is committed", (t) => {
  const repo = fixture(t, { "src/legacy.ts": lines(850) }, { "src/legacy.ts": 850 })
  repo.write("src/legacy.ts", lines(840))
  passes(repo.check())
  repo.commit()
  repo.write("src/legacy.ts", lines(841))
  fails(repo.check(), /src\/legacy\.ts.*841.*840/)
})

test("rejects adding or increasing legacy allowances", (t) => {
  const repo = fixture(t, { "src/legacy.ts": lines(850) }, { "src/legacy.ts": 850 })
  repo.budgets({ "src/legacy.ts": 851 })
  fails(repo.check(), /allowance.*src\/legacy\.ts/i)
  repo.budgets({ "src/legacy.ts": 850, "src/new.ts": 900 })
  repo.write("src/new.ts", lines(900))
  fails(repo.check(), /allowance.*src\/new\.ts/i)
})

test("bootstraps only existing oversized files at or below their base size", (t) => {
  const repo = fixture(t, { "src/legacy.ts": lines(850) }, null)
  repo.budgets({ "src/legacy.ts": 850 })
  passes(repo.check())
  repo.budgets({ "src/legacy.ts": 851 })
  fails(repo.check(), /allowance.*src\/legacy\.ts/i)
  repo.budgets({ "src/legacy.ts": 850, "src/new.ts": 900 })
  repo.write("src/new.ts", lines(900))
  fails(repo.check(), /allowance.*src\/new\.ts/i)
})

test("requires removing obsolete allowances after deletion or reaching the limit", (t) => {
  const repo = fixture(t, { "src/legacy.ts": lines(850) }, { "src/legacy.ts": 850 })
  repo.write("src/legacy.ts", lines(800))
  fails(repo.check(), /remove.*src\/legacy\.ts/i)
  repo.budgets({})
  passes(repo.check())
  rmSync(join(repo.root, "src/legacy.ts"))
  passes(repo.check())
})

test("checks staged content rather than hiding violations behind worktree edits", (t) => {
  const repo = fixture(t, { "src/main.ts": lines(800) })
  repo.write("src/main.ts", lines(801))
  repo.git("add", "src/main.ts")
  repo.write("src/main.ts", lines(800))
  fails(repo.check("--staged"), /src\/main\.ts.*801.*800/)
  repo.git("add", "src/main.ts")
  repo.write("src/main.ts", lines(801))
  passes(repo.check("--staged"))
})

test("checks the staged baseline and accepts staged deletion with allowance cleanup", (t) => {
  const repo = fixture(t, { "src/legacy.ts": lines(850) }, { "src/legacy.ts": 850 })
  repo.budgets({ "src/legacy.ts": 900 })
  repo.git("add", BASELINE)
  repo.budgets({ "src/legacy.ts": 850 })
  fails(repo.check("--staged"), /allowance.*src\/legacy\.ts/i)
  repo.git("rm", "src/legacy.ts")
  repo.budgets({})
  repo.git("add", BASELINE)
  passes(repo.check("--staged"))
})

test("respects Git ignores without excluding tracked files in ignored directories", (t) => {
  const repo = fixture(t)
  repo.write("ignored/generated.ts", lines(801))
  passes(repo.check())
  repo.git("add", "--force", "ignored/generated.ts")
  fails(repo.check(), /ignored\/generated\.ts.*801.*800/)
})

test("uses the requested base revision, falls back to HEAD on empty/zero SHA, and fails on an invalid revision", (t) => {
  const repo = fixture(t, { "src/legacy.ts": lines(850) }, { "src/legacy.ts": 850 })
  const base = repo.git("rev-parse", "HEAD")
  repo.write("src/legacy.ts", lines(840))
  repo.commit()
  repo.write("src/legacy.ts", lines(845))
  fails(repo.check(), /src\/legacy\.ts.*845.*840/)
  passes(repo.check("--base", base))
  fails(repo.check("--base", "0000000000000000000000000000000000000000"), /src\/legacy\.ts.*845.*840/)
  fails(repo.check("--base", ""), /src\/legacy\.ts.*845.*840/)
  fails(repo.check("--base", "missing-ref"), /missing-ref/)
})

test("fails explicitly for missing, malformed, or invalid baseline configuration", (t) => {
  const repo = fixture(t)
  rmSync(join(repo.root, BASELINE))
  fails(repo.check(), /module-size-baseline\.json/)
  repo.write(BASELINE, "{")
  fails(repo.check(), /JSON|baseline/i)
  for (const invalid of [[], { "../escape.ts": 900 }, { "src/a.ts": "900" }, { "src/a.ts": 800 }]) {
    repo.budgets(invalid)
    fails(repo.check(), /baseline|allowance/i)
  }
})
