import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const SCRIPT = resolve(process.cwd(), "..", "..", "scripts", "prepare-updater-key.mjs")
const VALID_KEY = Buffer.from("untrusted comment: minisign encrypted secret key\nRWTESTKEY\n").toString("base64")

function run(secret: string): { output: string; key: Buffer; mode: number; githubEnv: string } {
  const directory = mkdtempSync(join(tmpdir(), "omd-updater-key-"))
  const githubEnv = join(directory, "github-env")
  const output = execFileSync(process.execPath, [SCRIPT, directory], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ENV: githubEnv, UPDATER_PRIVATE_KEY: secret },
  })
  const path = output.trim()
  return {
    output: path,
    key: readFileSync(path),
    mode: statSync(path).mode & 0o777,
    githubEnv: readFileSync(githubEnv, "utf8"),
  }
}

describe("prepare-updater-key", () => {
  it("trims accidental surrounding whitespace and writes the normalized base64 key", () => {
    const result = run(` \r\n${VALID_KEY}\r\n `)

    expect(result.key.toString("utf8")).toBe(VALID_KEY)
    expect(result.mode & 0o077).toBe(0)
    expect(result.githubEnv).toBe(`TAURI_SIGNING_PRIVATE_KEY=${result.output}\n`)
  })

  it("rejects a key whose base64 payload contains internal whitespace", () => {
    const broken = `${VALID_KEY.slice(0, -2)}  ==`

    expect(() => run(broken)).toThrow(/valid base64/i)
  })

  it("rejects an empty secret", () => {
    expect(() => run(" \r\n ")).toThrow(/missing UPDATER_PRIVATE_KEY/i)
  })
})
