import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

// The CLI is spawned with real Node so the tests exercise the actual command
// line (parse errors, exit codes, stderr) rather than an imported helper.
const SCRIPT = resolve(process.cwd(), "..", "..", "scripts", "update-manifest.mjs")

const BASE = "https://github.com/Zuixi/oh-my-md/releases/download/v0.1.1"

// Deterministic zero-content updater fixtures created by each test.
const STANDARD_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ["oh-my-md.app.tar.gz", ""],
  ["oh-my-md.app.tar.gz.sig", "sig-mac\n"],
  ["oh-my-md-setup.exe", ""],
  ["oh-my-md-setup.exe.sig", "sig-win\n"],
  ["oh-my-md.AppImage.tar.gz", ""],
  ["oh-my-md.AppImage.tar.gz.sig", "sig-linux\n"],
]

const tempDirs: string[] = []

function tempFixture(...entries: ReadonlyArray<readonly [string, string]>): string {
  const dir = mkdtempSync(join(tmpdir(), "omd-update-manifest-"))
  tempDirs.push(dir)
  for (const [name, content] of entries) {
    writeFileSync(join(dir, name), content)
  }
  return dir
}

afterEach(() => {
  let dir: string | undefined
  while ((dir = tempDirs.pop()) !== undefined) {
    rmSync(dir, { recursive: true, force: true })
  }
})

type Manifest = {
  version: string
  pub_date: string
  platforms: Record<string, { url: string; signature: string }>
}

function runCli(
  args: string[],
  options: { env?: Record<string, string> } = {},
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...options.env },
      encoding: "utf8",
    })
    return { status: 0, stdout, stderr: "" }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" }
  }
}

function readManifest(output: string): Manifest {
  return JSON.parse(readFileSync(output, "utf8")) as Manifest
}

function expectFailure(result: { status: number; stderr: string }, needle: string): void {
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain(needle)
}

const GENERATE_ARGS = [
  "candidate",
  "--version", "0.1.1",
  "--tag", "v0.1.1",
  "--pub-date", "2026-09-10T10:00:00Z",
]

const VALIDATE_ARGS = ["validate", "--version", "0.1.1", "--tag", "v0.1.1"]

describe("update-manifest candidate generation", () => {
  it("writes a valid candidate manifest for the standard asset set", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")

    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])

    expect(result.status).toBe(0)
    expect(readManifest(output)).toEqual({
      version: "0.1.1",
      pub_date: "2026-09-10T10:00:00Z",
      platforms: {
        "darwin-x86_64": { url: `${BASE}/oh-my-md.app.tar.gz`, signature: "sig-mac\n" },
        "darwin-aarch64": { url: `${BASE}/oh-my-md.app.tar.gz`, signature: "sig-mac\n" },
        "windows-x86_64": { url: `${BASE}/oh-my-md-setup.exe`, signature: "sig-win\n" },
        "linux-x86_64": { url: `${BASE}/oh-my-md.AppImage.tar.gz`, signature: "sig-linux\n" },
      },
    })
  })

  it("maps actual discovered filenames into URLs instead of guessing Tauri naming", () => {
    const assets = tempFixture(
      ["Custom-Editor.app.tar.gz", ""],
      ["Custom-Editor.app.tar.gz.sig", "sig-a\n"],
      ["omd-x86-setup.exe", ""],
      ["omd-x86-setup.exe.sig", "sig-b\n"],
      ["desktop.AppImage.tar.gz", ""],
      ["desktop.AppImage.tar.gz.sig", "sig-c\n"],
    )
    const output = join(assets, "latest.json")

    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])

    expect(result.status).toBe(0)
    const platforms = readManifest(output).platforms
    expect(platforms["darwin-x86_64"]!.url).toBe(`${BASE}/Custom-Editor.app.tar.gz`)
    expect(platforms["windows-x86_64"]!.url).toBe(`${BASE}/omd-x86-setup.exe`)
    expect(platforms["linux-x86_64"]!.url).toBe(`${BASE}/desktop.AppImage.tar.gz`)
  })

  it("embeds signature file text verbatim, trailing newline included", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")

    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])

    expect(result.status).toBe(0)
    const platforms = readManifest(output).platforms
    expect(platforms["darwin-aarch64"]!.signature).toBe("sig-mac\n")
    expect(platforms["windows-x86_64"]!.signature).toBe("sig-win\n")
    expect(platforms["linux-x86_64"]!.signature).toBe("sig-linux\n")
    expect(platforms["linux-x86_64"]!.signature.endsWith("\n")).toBe(true)
  })

  it("writes both Darwin architecture keys to the same Universal tarball artifact", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")

    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])

    expect(result.status).toBe(0)
    const platforms = readManifest(output).platforms
    expect(Object.keys(platforms)).toEqual([
      "darwin-x86_64",
      "darwin-aarch64",
      "windows-x86_64",
      "linux-x86_64",
    ])
    expect(platforms["darwin-x86_64"]).toEqual(platforms["darwin-aarch64"])
  })

  it("uses exact immutable tag URLs with no mutable path segments", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")

    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])

    expect(result.status).toBe(0)
    for (const entry of Object.values(readManifest(output).platforms)) {
      expect(entry.url).toMatch(
        /^https:\/\/github\.com\/Zuixi\/oh-my-md\/releases\/download\/v0\.1\.1\/[^/]+$/,
      )
      expect(entry.url).not.toContain("latest")
    }
  })

  it("derives a deterministic RFC3339 pub_date from SOURCE_DATE_EPOCH", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")

    const result = runCli(
      ["candidate", "--version", "0.1.1", "--tag", "v0.1.1", "--assets", assets, "--output", output],
      { env: { SOURCE_DATE_EPOCH: "1767225600" } },
    )

    expect(result.status).toBe(0)
    expect(readManifest(output).pub_date).toBe("2026-01-01T00:00:00.000Z")
  })

  it("rejects a version that does not strictly match the tag", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")

    const cases: ReadonlyArray<[string, string]> = [
      ["0.1.1", "v0.1.2"],
      ["0.1.1", "0.1.1"],
      ["v0.1.1", "v0.1.1"],
    ]
    for (const [version, tag] of cases) {
      const result = runCli([
        "candidate",
        "--version", version,
        "--tag", tag,
        "--assets", assets,
        "--output", output,
        "--pub-date", "2026-09-10T10:00:00Z",
      ])
      expectFailure(result, "version/tag")
      expect(existsSync(output)).toBe(false)
    }
  })

  it("fails when any required updater asset class is missing", () => {
    const assets = tempFixture(
      ...STANDARD_FIXTURES.filter(([name]) => name !== "oh-my-md.app.tar.gz"),
    )
    const output = join(assets, "latest.json")
    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])
    expectFailure(result, "macOS updater tarball")

    const noWindowsSig = tempFixture(
      ...STANDARD_FIXTURES.filter(([name]) => name !== "oh-my-md-setup.exe.sig"),
    )
    const resultAlt = runCli([
      ...GENERATE_ARGS,
      "--assets", noWindowsSig,
      "--output", join(noWindowsSig, "latest.json"),
    ])
    expectFailure(resultAlt, "Windows NSIS updater signature")
  })

  it("fails when an updater asset class is duplicated", () => {
    const assets = tempFixture(...STANDARD_FIXTURES, ["second.app.tar.gz", ""])
    const output = join(assets, "latest.json")
    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])
    expectFailure(result, "exactly one")
  })

  it("fails when the signature file name does not match its artifact", () => {
    const assets = tempFixture(
      ["oh-my-md.app.tar.gz", ""],
      ["mismatched.app.tar.gz.sig", "sig\n"],
      ["oh-my-md-setup.exe", ""],
      ["oh-my-md-setup.exe.sig", "sig\n"],
      ["oh-my-md.AppImage.tar.gz", ""],
      ["oh-my-md.AppImage.tar.gz.sig", "sig\n"],
    )
    const output = join(assets, "latest.json")
    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])
    expectFailure(result, "must be named oh-my-md.app.tar.gz.sig")
  })

  it("rejects an empty updater signature", () => {
    const assets = tempFixture(
      ...STANDARD_FIXTURES.map(([name, content]) =>
        name.endsWith(".sig") ? ([name, ""] as const) : ([name, content] as const),
      ),
    )
    const output = join(assets, "latest.json")
    const result = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])
    expectFailure(result, "empty updater signature")
  })
})

describe("update-manifest candidate validation", () => {
  it("accepts a manifest produced by the candidate command", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")
    const generated = runCli([...GENERATE_ARGS, "--assets", assets, "--output", output])
    expect(generated.status).toBe(0)

    const result = runCli([...VALIDATE_ARGS, "--manifest", output, "--assets", assets])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("OK")
  })

  it("rejects a manifest whose version does not match the requested version and tag", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")
    expect(runCli([...GENERATE_ARGS, "--assets", assets, "--output", output]).status).toBe(0)

    const result = runCli([
      "validate",
      "--version", "0.1.2",
      "--tag", "v0.1.2",
      "--manifest", output,
      "--assets", assets,
    ])

    expectFailure(result, "does not match requested version")
  })

  it("rejects a manifest that rewrites any URL to a mutable path", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")
    expect(runCli([...GENERATE_ARGS, "--assets", assets, "--output", output]).status).toBe(0)

    const manifest = readManifest(output)
    manifest.platforms["darwin-x86_64"]!.url = manifest.platforms["darwin-x86_64"]!.url.replace(
      "/download/v0.1.1/",
      "/download/latest/",
    )
    writeFileSync(output, JSON.stringify(manifest, null, 2))

    const result = runCli([...VALIDATE_ARGS, "--manifest", output, "--assets", assets])
    expectFailure(result, "immutable tag asset")
  })

  it("rejects a manifest that points at a different immutable tag", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")
    expect(runCli([...GENERATE_ARGS, "--assets", assets, "--output", output]).status).toBe(0)

    const manifest = readManifest(output)
    manifest.platforms["windows-x86_64"]!.url = manifest.platforms["windows-x86_64"]!.url.replace(
      "/download/v0.1.1/",
      "/download/v0.1.2/",
    )
    writeFileSync(output, JSON.stringify(manifest, null, 2))

    const result = runCli([...VALIDATE_ARGS, "--manifest", output, "--assets", assets])
    expectFailure(result, "immutable tag asset")
  })

  it("rejects a tampered signature that no longer matches the .sig file verbatim", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const output = join(assets, "latest.json")
    expect(runCli([...GENERATE_ARGS, "--assets", assets, "--output", output]).status).toBe(0)

    const manifest = readManifest(output)
    manifest.platforms["linux-x86_64"]!.signature = "tampered\n"
    writeFileSync(output, JSON.stringify(manifest, null, 2))

    const result = runCli([...VALIDATE_ARGS, "--manifest", output, "--assets", assets])
    expectFailure(result, "verbatim")
  })

  it("rejects empty signatures even when manifest and .sig file agree", () => {
    const assets = tempFixture(
      ...STANDARD_FIXTURES.map(([name, content]) =>
        name.endsWith(".sig") ? ([name, ""] as const) : ([name, content] as const),
      ),
    )
    const manifestPath = join(assets, "latest.json")
    const manifest = {
      version: "0.1.1",
      pub_date: "2026-09-10T10:00:00Z",
      platforms: {
        "darwin-x86_64": { url: `${BASE}/oh-my-md.app.tar.gz`, signature: "" },
        "darwin-aarch64": { url: `${BASE}/oh-my-md.app.tar.gz`, signature: "" },
        "windows-x86_64": { url: `${BASE}/oh-my-md-setup.exe`, signature: "" },
        "linux-x86_64": { url: `${BASE}/oh-my-md.AppImage.tar.gz`, signature: "" },
      },
    }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const result = runCli([...VALIDATE_ARGS, "--manifest", manifestPath, "--assets", assets])
    expectFailure(result, "signature is empty")
  })

  it("rejects a manifest that is missing a required platform key", () => {
    const assets = tempFixture(...STANDARD_FIXTURES)
    const manifestPath = join(assets, "latest.json")
    expect(runCli([...GENERATE_ARGS, "--assets", assets, "--output", manifestPath]).status).toBe(0)

    const manifest = readManifest(manifestPath)
    delete manifest.platforms["windows-x86_64"]
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const result = runCli([...VALIDATE_ARGS, "--manifest", manifestPath, "--assets", assets])
    expectFailure(result, "missing platform entry windows-x86_64")
  })
})