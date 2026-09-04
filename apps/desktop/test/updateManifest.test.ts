import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
// ---------------------------------------------------------------------------
// Stable promotion and withdrawal (Task 7)
// ---------------------------------------------------------------------------

const DOWNLOAD_BASE = "https://github.com/Zuixi/oh-my-md/releases/download"
const RELEASE_TAG_BASE = "https://github.com/Zuixi/oh-my-md/releases/tag"
const PROMOTION_RUN = "https://github.com/Zuixi/oh-my-md/actions/runs/123"
const PROMOTION_ENV = { SOURCE_DATE_EPOCH: "1767225600" }
const PROMOTED_AT = "2026-01-01T00:00:00.000Z"

type SiteStatus = {
  channel: string
  version: string
  promotedAt: string
  releaseUrl: string
  manifestSha256: string
  versions: string[]
  workflowRun?: string
  previousVersion?: string
}

function candidateManifest(version: string): Manifest {
  const tag = `v${version}`
  return {
    version,
    pub_date: "2026-09-10T10:00:00Z",
    platforms: {
      "darwin-x86_64": { url: `${DOWNLOAD_BASE}/${tag}/oh-my-md.app.tar.gz`, signature: "sig-mac\n" },
      "darwin-aarch64": { url: `${DOWNLOAD_BASE}/${tag}/oh-my-md.app.tar.gz`, signature: "sig-mac\n" },
      "windows-x86_64": { url: `${DOWNLOAD_BASE}/${tag}/oh-my-md-setup.exe`, signature: "sig-win\n" },
      "linux-x86_64": { url: `${DOWNLOAD_BASE}/${tag}/oh-my-md.AppImage.tar.gz`, signature: "sig-linux\n" },
    },
  }
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function makeCandidate(version: string): { manifestPath: string; siteDir: string } {
  const root = tempFixture()
  const candidateDir = join(root, "candidate")
  mkdirSync(candidateDir, { recursive: true })
  const manifestPath = join(candidateDir, "latest.json")
  writeJsonFile(manifestPath, candidateManifest(version))
  return { manifestPath, siteDir: join(root, "site") }
}

function promoteArgs(candidate: string, currentSite: string, outputSite: string, version: string): string[] {
  return [
    "promote",
    "--candidate", candidate,
    "--current-site", currentSite,
    "--release-url", `${RELEASE_TAG_BASE}/v${version}`,
    "--workflow-run", PROMOTION_RUN,
    "--output-site", outputSite,
  ]
}

function readSiteJson(site: string, relative: string): unknown {
  return JSON.parse(readFileSync(join(site, relative), "utf8"))
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function promoteVersion(version: string, currentSite: string, outputSite: string) {
  const candidate = makeCandidate(version)
  const result = runCli(promoteArgs(candidate.manifestPath, currentSite, outputSite, version), {
    env: PROMOTION_ENV,
  })
  return { result, candidate }
}

describe("update-manifest stable promotion", () => {
  it("promotes the first candidate into a complete stable site", () => {
    const { manifestPath } = makeCandidate("0.1.1")
    const currentSite = join(tempFixture(), "current-site")
    const outputSite = join(tempFixture(), "site")

    const result = runCli(promoteArgs(manifestPath, currentSite, outputSite, "0.1.1"), { env: PROMOTION_ENV })

    expect(result.status).toBe(0)
    const latest = readSiteJson(outputSite, "updates/stable/latest.json") as Manifest
    expect(latest).toEqual(candidateManifest("0.1.1"))
    expect(readSiteJson(outputSite, "updates/stable/status.json")).toEqual({
      channel: "stable",
      version: "0.1.1",
      promotedAt: PROMOTED_AT,
      releaseUrl: `${RELEASE_TAG_BASE}/v0.1.1`,
      manifestSha256: sha256OfFile(join(outputSite, "updates/stable/latest.json")),
      workflowRun: PROMOTION_RUN,
      versions: ["0.1.1"],
    })
    const history = readSiteJson(outputSite, "updates/stable/history/0.1.1.json") as Manifest & {
      previousVersion?: string
    }
    expect(history).toMatchObject(candidateManifest("0.1.1"))
    expect(history.previousVersion).toBeUndefined()
    expect(existsSync(join(outputSite, ".nojekyll"))).toBe(true)
  })

  it("produces byte-identical output across repeated promotions of the same candidate", () => {
    const { manifestPath } = makeCandidate("0.1.0")
    const siteA = join(tempFixture(), "site-a")
    const siteB = join(tempFixture(), "site-b")
    const resultA = runCli(promoteArgs(manifestPath, join(tempFixture(), "current"), siteA, "0.1.0"), { env: PROMOTION_ENV })
    const resultB = runCli(promoteArgs(manifestPath, join(tempFixture(), "current"), siteB, "0.1.0"), { env: PROMOTION_ENV })

    expect(resultA.status).toBe(0)
    expect(resultB.status).toBe(0)
    for (const relative of [
      "updates/stable/latest.json",
      "updates/stable/status.json",
      "updates/stable/history/0.1.0.json",
    ]) {
      expect(readFileSync(join(siteA, relative)).equals(readFileSync(join(siteB, relative)))).toBe(true)
    }
  })

  it("rejects an equal or lower candidate version", () => {
    const first = makeCandidate("0.1.1")
    const firstSite = join(tempFixture(), "first")
    expect(runCli(promoteArgs(first.manifestPath, join(tempFixture(), "current"), firstSite, "0.1.1"), { env: PROMOTION_ENV }).status).toBe(0)

    for (const lower of ["0.1.1", "0.1.0"]) {
      const candidate = makeCandidate(lower)
      const out = join(tempFixture(), "out")
      const result = runCli(promoteArgs(candidate.manifestPath, firstSite, out, lower), { env: PROMOTION_ENV })
      expectFailure(result, "strictly greater")
      expect(existsSync(out)).toBe(false)
    }
  })

  it("preserves history and records the previous version on an increasing promotion", () => {
    const empty = join(tempFixture(), "empty")
    const site010 = join(tempFixture(), "site-010")
    expect(promoteVersion("0.1.0", empty, site010).result.status).toBe(0)

    const site011 = join(tempFixture(), "site-011")
    const result = promoteVersion("0.1.1", site010, site011).result
    expect(result.status).toBe(0)

    expect((readSiteJson(site011, "updates/stable/latest.json") as Manifest).version).toBe("0.1.1")
    const status = readSiteJson(site011, "updates/stable/status.json") as SiteStatus
    expect(status.version).toBe("0.1.1")
    expect(status.workflowRun).toBe(PROMOTION_RUN)
    expect(status.previousVersion).toBe("0.1.0")
    expect(status.versions).toEqual(["0.1.0", "0.1.1"])
    const history011 = readSiteJson(site011, "updates/stable/history/0.1.1.json") as { previousVersion?: string; workflowRun?: string }
    expect(history011.previousVersion).toBe("0.1.0")
    expect(history011.workflowRun).toBe(PROMOTION_RUN)

    expect(existsSync(join(site011, "updates/stable/history/0.1.0.json"))).toBe(true)
    const original010 = readFileSync(join(site010, "updates/stable/history/0.1.0.json"))
    const preserved010 = readFileSync(join(site011, "updates/stable/history/0.1.0.json"))
    expect(preserved010.equals(original010)).toBe(true)

    expect((readSiteJson(site010, "updates/stable/latest.json") as Manifest).version).toBe("0.1.0")
  })

  it("does not mutate the candidate manifest input", () => {
    const currentSite = join(tempFixture(), "current")
    const { manifestPath, siteDir } = makeCandidate("0.1.1")
    const before = readFileSync(manifestPath)
    const result = runCli(promoteArgs(manifestPath, currentSite, siteDir, "0.1.1"), { env: PROMOTION_ENV })

    expect(result.status).toBe(0)
    expect(readFileSync(manifestPath).equals(before)).toBe(true)
    expect((readSiteJson(siteDir, "updates/stable/latest.json") as Manifest).version).toBe("0.1.1")
  })

  it("rejects a release URL that does not match the candidate version tag", () => {
    const { manifestPath, siteDir } = makeCandidate("0.1.1")
    const currentSite = join(tempFixture(), "current")
    const result = runCli(
      [
        "promote",
        "--candidate", manifestPath,
        "--current-site", currentSite,
        "--release-url", `${RELEASE_TAG_BASE}/v0.1.2`,
        "--workflow-run", PROMOTION_RUN,
        "--output-site", siteDir,
      ],
      { env: PROMOTION_ENV },
    )

    expectFailure(result, "release tag URL")
    expect(existsSync(siteDir)).toBe(false)
  })

  it("rejects a malformed workflow run URL", () => {
    const { manifestPath, siteDir } = makeCandidate("0.1.1")
    const currentSite = join(tempFixture(), "current")
    const result = runCli(
      [
        "promote",
        "--candidate", manifestPath,
        "--current-site", currentSite,
        "--release-url", `${RELEASE_TAG_BASE}/v0.1.1`,
        "--workflow-run", "not-a-run-url",
        "--output-site", siteDir,
      ],
      { env: PROMOTION_ENV },
    )

    expectFailure(result, "workflow-run")
    expect(existsSync(siteDir)).toBe(false)
  })

  it("rejects a candidate manifest whose platform URL is not an immutable tag asset", () => {
    const root = tempFixture()
    const manifestPath = join(root, "latest.json")
    const bad = candidateManifest("0.1.1")
    bad.platforms["darwin-x86_64"]!.url = `${BASE}/latest/oh-my-md.app.tar.gz`
    writeJsonFile(manifestPath, bad)
    const currentSite = join(tempFixture(), "current")
    const siteDir = join(root, "site")

    const result = runCli(promoteArgs(manifestPath, currentSite, siteDir, "0.1.1"), { env: PROMOTION_ENV })
    expectFailure(result, "immutable tag asset")
    expect(existsSync(siteDir)).toBe(false)
  })

  it("rejects a candidate with an empty platform signature", () => {
    const root = tempFixture()
    const manifestPath = join(root, "latest.json")
    const bad = candidateManifest("0.1.1")
    bad.platforms["linux-x86_64"]!.signature = "   "
    writeJsonFile(manifestPath, bad)

    const result = runCli(promoteArgs(manifestPath, join(tempFixture(), "current"), join(root, "site"), "0.1.1"), { env: PROMOTION_ENV })
    expectFailure(result, "signature must be a non-empty string")
  })

  it("hard-stops when the current stable site is inconsistent or invalid", () => {
    const { manifestPath } = makeCandidate("0.1.1")

    const onlyStatus = join(tempFixture(), "only-status")
    mkdirSync(join(onlyStatus, "updates/stable"), { recursive: true })
    writeJsonFile(join(onlyStatus, "updates/stable/status.json"), { channel: "stable", version: "0.1.0" })
    const out1 = join(tempFixture(), "out1")
    const result1 = runCli(promoteArgs(manifestPath, onlyStatus, out1, "0.1.1"), { env: PROMOTION_ENV })
    expectFailure(result1, "current stable")
    expect(existsSync(out1)).toBe(false)

    const badLatest = join(tempFixture(), "bad-latest")
    mkdirSync(join(badLatest, "updates/stable"), { recursive: true })
    writeFileSync(join(badLatest, "updates/stable/latest.json"), "{not json")
    const out2 = join(tempFixture(), "out2")
    const result2 = runCli(promoteArgs(manifestPath, badLatest, out2, "0.1.1"), { env: PROMOTION_ENV })
    expectFailure(result2, "current stable")
    expect(existsSync(out2)).toBe(false)
  })

  it("tracks a deterministic ordered versions inventory across increasing promotions", () => {
    const empty = join(tempFixture(), "empty")
    const inv010 = join(tempFixture(), "inv-010")
    expect(promoteVersion("0.1.0", empty, inv010).result.status).toBe(0)
    expect((readSiteJson(inv010, "updates/stable/status.json") as SiteStatus).versions).toEqual(["0.1.0"])

    const inv011 = join(tempFixture(), "inv-011")
    expect(promoteVersion("0.1.1", inv010, inv011).result.status).toBe(0)
    expect((readSiteJson(inv011, "updates/stable/status.json") as SiteStatus).versions).toEqual(["0.1.0", "0.1.1"])

    const inv012 = join(tempFixture(), "inv-012")
    expect(promoteVersion("0.1.2", inv011, inv012).result.status).toBe(0)
    expect((readSiteJson(inv012, "updates/stable/status.json") as SiteStatus).versions).toEqual(["0.1.0", "0.1.1", "0.1.2"])
    for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
      expect(existsSync(join(inv012, "updates/stable/history", `${version}.json`))).toBe(true)
    }
  })

  it("hard-stops when the current status.json.versions inventory is missing or invalid", () => {
    const { manifestPath } = makeCandidate("0.1.1")

    const noInventory = join(tempFixture(), "no-inventory")
    mkdirSync(join(noInventory, "updates/stable"), { recursive: true })
    writeFileSync(join(noInventory, "updates/stable/latest.json"), JSON.stringify(candidateManifest("0.1.0"), null, 2))
    writeJsonFile(join(noInventory, "updates/stable/status.json"), { channel: "stable", version: "0.1.0" })
    const out1 = join(tempFixture(), "out1")
    const result1 = runCli(promoteArgs(manifestPath, noInventory, out1, "0.1.1"), { env: PROMOTION_ENV })
    expectFailure(result1, "versions")
    expect(existsSync(out1)).toBe(false)

    const badInventory = join(tempFixture(), "bad-inventory")
    mkdirSync(join(badInventory, "updates/stable"), { recursive: true })
    writeFileSync(join(badInventory, "updates/stable/latest.json"), JSON.stringify(candidateManifest("0.1.0"), null, 2))
    writeJsonFile(join(badInventory, "updates/stable/status.json"), {
      channel: "stable",
      version: "0.1.0",
      versions: ["0.1.0", "junk"],
    })
    const out2 = join(tempFixture(), "out2")
    const result2 = runCli(promoteArgs(manifestPath, badInventory, out2, "0.1.1"), { env: PROMOTION_ENV })
    expectFailure(result2, "versions")
    expect(existsSync(out2)).toBe(false)
  })
})

describe("update-manifest stable withdrawal", () => {
  it("withdraws to the previous known-good manifest and can walk the full chain", () => {
    const empty = join(tempFixture(), "empty")
    const site010 = join(tempFixture(), "s010")
    expect(promoteVersion("0.1.0", empty, site010).result.status).toBe(0)
    const site011 = join(tempFixture(), "s011")
    expect(promoteVersion("0.1.1", site010, site011).result.status).toBe(0)
    const site012 = join(tempFixture(), "s012")
    expect(promoteVersion("0.1.2", site011, site012).result.status).toBe(0)

    const withdrawn1 = join(tempFixture(), "w1")
    const result1 = runCli(["withdraw", "--current-site", site012, "--output-site", withdrawn1], { env: PROMOTION_ENV })
    expect(result1.status).toBe(0)
    expect((readSiteJson(withdrawn1, "updates/stable/latest.json") as Manifest).version).toBe("0.1.1")
    expect(readSiteJson(withdrawn1, "updates/stable/status.json")).toEqual({
      channel: "stable",
      version: "0.1.1",
      promotedAt: PROMOTED_AT,
      releaseUrl: `${RELEASE_TAG_BASE}/v0.1.1`,
      manifestSha256: sha256OfFile(join(withdrawn1, "updates/stable/latest.json")),
      previousVersion: "0.1.0",
      versions: ["0.1.0", "0.1.1", "0.1.2"],
    })
    for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
      expect(existsSync(join(withdrawn1, "updates/stable/history", `${version}.json`))).toBe(true)
    }

    const withdrawn2 = join(tempFixture(), "w2")
    const result2 = runCli(["withdraw", "--current-site", withdrawn1, "--output-site", withdrawn2], { env: PROMOTION_ENV })
    expect(result2.status).toBe(0)
    expect((readSiteJson(withdrawn2, "updates/stable/latest.json") as Manifest).version).toBe("0.1.0")
    const status2 = readSiteJson(withdrawn2, "updates/stable/status.json") as SiteStatus
    expect(status2.version).toBe("0.1.0")
    expect(status2.previousVersion).toBeUndefined()
    expect(status2.versions).toEqual(["0.1.0", "0.1.1", "0.1.2"])

    const withdrawn3 = join(tempFixture(), "w3")
    const result3 = runCli(["withdraw", "--current-site", withdrawn2, "--output-site", withdrawn3], { env: PROMOTION_ENV })
    expectFailure(result3, "previousVersion")
    expect(existsSync(withdrawn3)).toBe(false)
  })

  it("hard-stops when status.json is missing or invalid", () => {
    const emptySite = join(tempFixture(), "empty")
    const result = runCli(["withdraw", "--current-site", emptySite, "--output-site", join(tempFixture(), "out")], { env: PROMOTION_ENV })
    expectFailure(result, "status.json")

    const badStatus = join(tempFixture(), "bad")
    mkdirSync(join(badStatus, "updates/stable"), { recursive: true })
    writeFileSync(join(badStatus, "updates/stable/status.json"), "{oops")
    const resultBad = runCli(["withdraw", "--current-site", badStatus, "--output-site", join(tempFixture(), "out2")], { env: PROMOTION_ENV })
    expectFailure(resultBad, "status.json")
  })

  it("hard-stops when previousVersion is missing from status", () => {
    const site = join(tempFixture(), "site")
    mkdirSync(join(site, "updates/stable"), { recursive: true })
    writeJsonFile(join(site, "updates/stable/status.json"), { channel: "stable", version: "0.1.0", versions: ["0.1.0"] })

    const result = runCli(["withdraw", "--current-site", site, "--output-site", join(tempFixture(), "out")], { env: PROMOTION_ENV })
    expectFailure(result, "previousVersion")
  })

  it("hard-stops when the previous version's history entry is missing", () => {
    const site = join(tempFixture(), "site")
    mkdirSync(join(site, "updates/stable"), { recursive: true })
    writeJsonFile(join(site, "updates/stable/status.json"), {
      channel: "stable",
      version: "0.1.1",
      previousVersion: "0.1.0",
      versions: ["0.1.0", "0.1.1"],
    })

    const result = runCli(["withdraw", "--current-site", site, "--output-site", join(tempFixture(), "out")], { env: PROMOTION_ENV })
    expectFailure(result, "history entry")
  })

  it("hard-stops when the restored history entry is invalid", () => {
    const site = join(tempFixture(), "site")
    mkdirSync(join(site, "updates/stable/history"), { recursive: true })
    writeJsonFile(join(site, "updates/stable/status.json"), {
      channel: "stable",
      version: "0.1.1",
      previousVersion: "0.1.0",
      versions: ["0.1.0", "0.1.1"],
    })
    writeJsonFile(join(site, "updates/stable/history/0.1.0.json"), {
      version: "0.1.0",
      pub_date: "not-a-date",
      platforms: {},
    })

    const result = runCli(["withdraw", "--current-site", site, "--output-site", join(tempFixture(), "out")], { env: PROMOTION_ENV })
    expectFailure(result, "invalid")
  })

  it("retains the full ordered versions inventory and history through two withdrawals", () => {
    const empty = join(tempFixture(), "empty")
    const r010 = join(tempFixture(), "r010")
    expect(promoteVersion("0.1.0", empty, r010).result.status).toBe(0)
    const r011 = join(tempFixture(), "r011")
    expect(promoteVersion("0.1.1", r010, r011).result.status).toBe(0)
    const r012 = join(tempFixture(), "r012")
    expect(promoteVersion("0.1.2", r011, r012).result.status).toBe(0)

    const w1 = join(tempFixture(), "rw1")
    expect(runCli(["withdraw", "--current-site", r012, "--output-site", w1], { env: PROMOTION_ENV }).status).toBe(0)
    const status1 = readSiteJson(w1, "updates/stable/status.json") as SiteStatus
    expect(status1.version).toBe("0.1.1")
    expect(status1.versions).toEqual(["0.1.0", "0.1.1", "0.1.2"])

    const w2 = join(tempFixture(), "rw2")
    expect(runCli(["withdraw", "--current-site", w1, "--output-site", w2], { env: PROMOTION_ENV }).status).toBe(0)
    const status2 = readSiteJson(w2, "updates/stable/status.json") as SiteStatus
    expect(status2.version).toBe("0.1.0")
    expect(status2.versions).toEqual(["0.1.0", "0.1.1", "0.1.2"])
    for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
      expect(existsSync(join(w2, "updates/stable/history", `${version}.json`))).toBe(true)
    }
  })

  it("rejects re-promotion of a version whose immutable history entry already exists", () => {
    const empty = join(tempFixture(), "empty")
    const p010 = join(tempFixture(), "p010")
    expect(promoteVersion("0.1.0", empty, p010).result.status).toBe(0)
    const p011 = join(tempFixture(), "p011")
    expect(promoteVersion("0.1.1", p010, p011).result.status).toBe(0)
    const p012 = join(tempFixture(), "p012")
    expect(promoteVersion("0.1.2", p011, p012).result.status).toBe(0)
    const withdrawn = join(tempFixture(), "withdrawn")
    expect(runCli(["withdraw", "--current-site", p012, "--output-site", withdrawn], { env: PROMOTION_ENV }).status).toBe(0)

    const candidate = makeCandidate("0.1.2")
    const out = join(tempFixture(), "re-promote")
    const result = runCli(promoteArgs(candidate.manifestPath, withdrawn, out, "0.1.2"), { env: PROMOTION_ENV })
    expectFailure(result, "already promoted")
    expect(existsSync(out)).toBe(false)
  })

  it("hard-stops when status.json.versions inventory is missing or invalid", () => {
    const site = join(tempFixture(), "no-inv")
    mkdirSync(join(site, "updates/stable/history"), { recursive: true })
    writeJsonFile(join(site, "updates/stable/status.json"), {
      channel: "stable",
      version: "0.1.1",
      previousVersion: "0.1.0",
    })
    writeJsonFile(join(site, "updates/stable/history/0.1.0.json"), { ...candidateManifest("0.1.0"), previousVersion: undefined })
    const result = runCli(["withdraw", "--current-site", site, "--output-site", join(tempFixture(), "out")], { env: PROMOTION_ENV })
    expectFailure(result, "versions")

    const bad = join(tempFixture(), "bad-inv")
    mkdirSync(join(bad, "updates/stable/history"), { recursive: true })
    writeJsonFile(join(bad, "updates/stable/status.json"), {
      channel: "stable",
      version: "0.1.1",
      previousVersion: "0.1.0",
      versions: ["0.1.0", "not-semver"],
    })
    writeJsonFile(join(bad, "updates/stable/history/0.1.0.json"), { ...candidateManifest("0.1.0"), previousVersion: undefined })
    const resultBad = runCli(["withdraw", "--current-site", bad, "--output-site", join(tempFixture(), "out2")], { env: PROMOTION_ENV })
    expectFailure(resultBad, "versions")
  })
})
