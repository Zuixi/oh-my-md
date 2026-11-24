import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const SCRIPT = fileURLToPath(new URL("./extract-release-notes.mjs", import.meta.url))
const DELIMITER = "__OMD_CHANGELOG_EOF__"
const FALLBACK = "See the commit log for changes in this release."

const CHANGELOG = `# Changelog

All notable changes to this project are documented here.

## v0.1.5 - 2026-11-11

### Bug Fixes

- Keep empty GFM table cells (332fcf6)
- Compile Linux smoke tests (cb3cb09)

## v0.1.4 - 2026-11-11

### Features

- Add cross-platform high-DPI PNG capture (a9f8bb9)
`

function fixture(t, changelog = CHANGELOG) {
  const root = mkdtempSync(join(tmpdir(), "omd-release-notes-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, "CHANGELOG.md"), changelog)
  return {
    root,
    run: (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" }),
  }
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

function readOutput(path) {
  const text = readFileSync(path, "utf8")
  const header = `changelog<<${DELIMITER}\n`
  const trailer = `\n${DELIMITER}\n`
  assert.ok(text.startsWith(header), `missing output header: ${JSON.stringify(text)}`)
  assert.ok(text.endsWith(trailer), `missing output trailer: ${JSON.stringify(text)}`)
  return text.slice(header.length, text.length - trailer.length)
}

test("extracts the matching dated section for both tag spellings", (t) => {
  const repo = fixture(t)
  const expected = [
    "### Bug Fixes",
    "",
    "- Keep empty GFM table cells (332fcf6)",
    "- Compile Linux smoke tests (cb3cb09)",
  ].join("\n")

  assert.equal(succeeds(repo.run("--tag", "v0.1.5")), `${expected}\n`)
  assert.equal(succeeds(repo.run("--tag", "0.1.5")), `${expected}\n`)
})

test("extracts the last section in the file up to EOF", (t) => {
  const repo = fixture(t)
  const stdout = succeeds(repo.run("--tag", "v0.1.4"))

  assert.equal(stdout, "### Features\n\n- Add cross-platform high-DPI PNG capture (a9f8bb9)\n")
  assert.ok(!stdout.includes("## v0.1.5"))
})

test("falls back to a version-agnostic line when the tag or section is missing", (t) => {
  const repo = fixture(t)
  const missing = repo.run("--tag", "v9.9.9")

  assert.equal(succeeds(missing), `${FALLBACK}\n`)
  assert.ok(!missing.stdout.includes("v9.9.9"))

  // An empty section is as unusable as a missing one.
  writeFileSync(join(repo.root, "CHANGELOG.md"), "## v1.0.0 - 2026-01-01\n\n## v0.9.0 - 2025-12-01\n\n- old\n")
  assert.equal(succeeds(repo.run("--tag", "v1.0.0")), `${FALLBACK}\n`)
})

test("rejects tags that are not exact release semver", (t) => {
  const repo = fixture(t)

  for (const tag of ["0.1.5-rc.1", "", "release"]) {
    const result = repo.run("--tag", tag)
    assert.equal(result.status, 1, result.stdout)
    assert.match(result.stderr, /--tag/)
  }
})

test("writes a delimited $GITHUB_OUTPUT entry that survives ordinary format tokens", (t) => {
  // Format tokens that appear in real notes must not be mistaken for the delimiter.
  const notes = [
    "### Bug Fixes",
    "",
    "- Keep `changelog<<EOF` and `GITHUB_OUTPUT` fixtures intact (332fcf6)",
    "- Keep a lone EOF marker on its own line (cb3cb09)",
  ].join("\n")
  const repo = fixture(t, `## v0.1.5 - 2026-11-11\n\n${notes}\n\n## v0.1.4 - 2026-11-11\n\n- old\n`)
  const output = join(repo.root, "github-output")
  succeeds(repo.run("--tag", "v0.1.5", "--changelog", "CHANGELOG.md", "--github-output", output))

  assert.equal(readOutput(output), notes)
})

test("refuses to write a body that would collide with the output delimiter", (t) => {
  const repo = fixture(t, `## v0.1.5 - 2026-11-11

- Sneak in a fake terminator

${DELIMITER}

## v0.1.4 - 2026-11-11

- old
`)
  const output = join(repo.root, "github-output")
  const result = repo.run("--tag", "v0.1.5", "--github-output", output)

  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /output delimiter/i)
  assert.equal(existsSync(output), false)
})
