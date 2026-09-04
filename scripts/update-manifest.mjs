#!/usr/bin/env node
// Tauri 2 candidate updater manifest generator and validator.
//
//   node scripts/update-manifest.mjs candidate --version X.Y.Z --tag vX.Y.Z \
//     --assets DIR --output DIR/latest.json [--pub-date RFC3339]
//   node scripts/update-manifest.mjs validate --manifest FILE \
//     --version X.Y.Z --tag vX.Y.Z --assets DIR
//   node scripts/update-manifest.mjs promote --candidate latest.json \
//     --current-site DIR --release-url URL --workflow-run URL --output-site DIR
//   node scripts/update-manifest.mjs withdraw --current-site DIR --output-site DIR
//
// The tool discovers the actual Tauri updater artifact filenames instead of
// guessing: exactly one macOS *.app.tar.gz + .sig, one Windows *-setup.exe +
// .sig, and one Linux *.AppImage.tar.gz + .sig. It embeds .sig text verbatim,
// maps both Darwin architectures to the one Universal tarball, and points
// every platform at an immutable release-tag URL. pub_date is RFC3339, taken
// from --pub-date, else SOURCE_DATE_EPOCH, else the current time.
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const RELEASE_OWNER_REPO = "Zuixi/oh-my-md"
const RELEASE_BASE = `https://github.com/${RELEASE_OWNER_REPO}/releases/download`
const PLATFORM_KEYS = ["darwin-x86_64", "darwin-aarch64", "windows-x86_64", "linux-x86_64"]
const SEMVER = /^\d+\.\d+\.\d+$/
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

const PLATFORMS = [
  {
    name: "macOS",
    assetLabel: "macOS updater tarball (*.app.tar.gz)",
    sigLabel: "macOS updater signature (*.app.tar.gz.sig)",
    isAsset: (name) => name.endsWith(".app.tar.gz"),
    isSig: (name) => name.endsWith(".app.tar.gz.sig"),
  },
  {
    name: "Windows",
    assetLabel: "Windows NSIS updater executable (*-setup.exe)",
    sigLabel: "Windows NSIS updater signature (*-setup.exe.sig)",
    isAsset: (name) => name.endsWith("-setup.exe"),
    isSig: (name) => name.endsWith("-setup.exe.sig"),
  },
  {
    name: "Linux",
    assetLabel: "Linux AppImage updater tarball (*.AppImage.tar.gz)",
    sigLabel: "Linux AppImage updater signature (*.AppImage.tar.gz.sig)",
    isAsset: (name) => name.endsWith(".AppImage.tar.gz"),
    isSig: (name) => name.endsWith(".AppImage.tar.gz.sig"),
  },
]

function fileNamesIn(dir) {
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile())
}

function discoverUpdaterAssets(assetsDir, errors) {
  const names = fileNamesIn(assetsDir)
  const found = {}
  for (const platform of PLATFORMS) {
    const assetMatches = names.filter(platform.isAsset)
    const sigMatches = names.filter(platform.isSig)
    if (assetMatches.length !== 1) {
      errors.push(
        `expected exactly one ${platform.assetLabel} in ${assetsDir}, found ${assetMatches.length || "none"}${
          assetMatches.length ? ` (${assetMatches.join(", ")})` : ""
        }`,
      )
    }
    if (sigMatches.length !== 1) {
      errors.push(
        `expected exactly one ${platform.sigLabel} in ${assetsDir}, found ${sigMatches.length || "none"}${
          sigMatches.length ? ` (${sigMatches.join(", ")})` : ""
        }`,
      )
    }
    if (assetMatches.length === 1 && sigMatches.length === 1) {
      const asset = assetMatches[0]
      const expectedSig = `${asset}.sig`
      if (sigMatches[0] !== expectedSig) {
        errors.push(`signature for ${asset} must be named ${expectedSig}, found ${sigMatches[0]}`)
      } else {
        found[platform.name] = { asset, sig: sigMatches[0] }
      }
    }
  }
  return found
}

function readSignature(path) {
  const text = readFileSync(path, "utf8")
  if (!text.trim()) {
    throw new Error(`empty updater signature: ${basename(path)}`)
  }
  return text
}

function immutableUrl(filename, tag) {
  return `${RELEASE_BASE}/${tag}/${filename}`
}

function assertTagMatchesVersion(version, tag, errors) {
  if (!SEMVER.test(version)) {
    errors.push(`version must be strict semver MAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`)
  }
  if (tag !== `v${version}`) {
    errors.push(`tag ${JSON.stringify(tag)} must equal v${version} (strict version/tag match)`)
  }
}

function resolvePubDate(given) {
  if (given !== undefined) {
    if (!RFC3339.test(given) || Number.isNaN(Date.parse(given))) {
      throw new Error(`--pub-date must be RFC3339 UTC, got ${JSON.stringify(given)}`)
    }
    return given
  }
  if (process.env.SOURCE_DATE_EPOCH !== undefined) {
    const epoch = Number(process.env.SOURCE_DATE_EPOCH)
    if (!Number.isFinite(epoch)) {
      throw new Error(
        `SOURCE_DATE_EPOCH must be a Unix epoch, got ${JSON.stringify(process.env.SOURCE_DATE_EPOCH)}`,
      )
    }
    return new Date(epoch * 1000).toISOString()
  }
  return new Date().toISOString()
}

function buildManifest({ version, tag, pubDate, assetsDir, discovered }) {
  const mac = discovered["macOS"]
  const windows = discovered["Windows"]
  const linux = discovered["Linux"]
  const macSig = readSignature(join(assetsDir, mac.sig))
  return {
    version,
    pub_date: pubDate,
    platforms: {
      "darwin-x86_64": { url: immutableUrl(mac.asset, tag), signature: macSig },
      "darwin-aarch64": { url: immutableUrl(mac.asset, tag), signature: macSig },
      "windows-x86_64": {
        url: immutableUrl(windows.asset, tag),
        signature: readSignature(join(assetsDir, windows.sig)),
      },
      "linux-x86_64": {
        url: immutableUrl(linux.asset, tag),
        signature: readSignature(join(assetsDir, linux.sig)),
      },
    },
  }
}

function collectManifestErrors({ version, tag, assetsDir, manifest }) {
  const errors = []
  assertTagMatchesVersion(version, tag, errors)

  if (typeof manifest?.version !== "string") {
    errors.push("manifest version is missing or not a string")
  } else if (manifest.version !== version) {
    errors.push(
      `manifest version ${JSON.stringify(manifest.version)} does not match requested version ${JSON.stringify(version)}`,
    )
  }

  if (
    typeof manifest?.pub_date !== "string" ||
    !RFC3339.test(manifest.pub_date) ||
    Number.isNaN(Date.parse(manifest.pub_date))
  ) {
    errors.push(`manifest pub_date must be RFC3339 UTC, got ${JSON.stringify(manifest?.pub_date)}`)
  }

  const platforms = manifest?.platforms
  if (typeof platforms !== "object" || platforms === null || Array.isArray(platforms)) {
    errors.push("manifest platforms must be an object with exactly the four Tauri platform keys")
    return errors
  }
  for (const key of PLATFORM_KEYS) {
    if (!(key in platforms)) {
      errors.push(`missing platform entry ${key}`)
    }
  }
  for (const key of Object.keys(platforms)) {
    if (!PLATFORM_KEYS.includes(key)) {
      errors.push(`unexpected platform entry ${key}`)
    }
  }

  const discovered = discoverUpdaterAssets(assetsDir, errors)
  const macFound = discovered["macOS"]
  const windowsFound = discovered["Windows"]
  const linuxFound = discovered["Linux"]
  if (macFound && windowsFound && linuxFound && !errors.length) {
    const expected = {
      "darwin-x86_64": { asset: macFound.asset, sig: macFound.sig },
      "darwin-aarch64": { asset: macFound.asset, sig: macFound.sig },
      "windows-x86_64": { asset: windowsFound.asset, sig: windowsFound.sig },
      "linux-x86_64": { asset: linuxFound.asset, sig: linuxFound.sig },
    }
    for (const key of PLATFORM_KEYS) {
      const entry = platforms[key]
      if (typeof entry?.url !== "string" || typeof entry?.signature !== "string") {
        errors.push(`platform ${key} entry must contain string url and signature`)
        continue
      }
      const wantUrl = immutableUrl(expected[key].asset, tag)
      if (entry.url !== wantUrl) {
        errors.push(
          `platform ${key} URL must be the immutable tag asset ${wantUrl}, got ${JSON.stringify(entry.url)}`,
        )
      }
      if (!entry.signature.trim()) {
        errors.push(`platform ${key} signature is empty`)
      } else {
        const wantSig = readFileSync(join(assetsDir, expected[key].sig), "utf8")
        if (entry.signature !== wantSig) {
          errors.push(`platform ${key} signature must equal the contents of ${expected[key].sig} verbatim`)
        }
      }
    }
  }
  return errors
}

function runCandidate(options) {
  const errors = []
  assertTagMatchesVersion(options.version, options.tag, errors)
  const discovered = discoverUpdaterAssets(options.assets, errors)
  if (errors.length > 0) {
    throw new Error(errors.join("\n"))
  }
  const manifest = buildManifest({
    version: options.version,
    tag: options.tag,
    pubDate: resolvePubDate(options["pub-date"]),
    assetsDir: options.assets,
    discovered,
  })
  const generatedErrors = collectManifestErrors({
    version: options.version,
    tag: options.tag,
    assetsDir: options.assets,
    manifest,
  })
  if (generatedErrors.length > 0) {
    throw new Error(generatedErrors.join("\n"))
  }
  writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify(manifest, null, 2))
}

function runValidate(options) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(options.manifest, "utf8"))
  } catch {
    throw new Error(`manifest is not valid JSON: ${options.manifest}`)
  }
  const errors = collectManifestErrors({
    version: options.version,
    tag: options.tag,
    assetsDir: options.assets,
    manifest,
  })
  if (errors.length > 0) {
    throw new Error(errors.join("\n"))
  }
  console.log(`OK: ${basename(options.manifest)} valid for version ${options.version} (tag ${options.tag})`)
}

function readJsonFile(path, label) {
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new Error(`${label} is missing or unreadable: ${path}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON: ${path}`)
  }
}

function parseSemver(version) {
  if (typeof version !== "string" || !SEMVER.test(version)) return null
  return version.split(".").map(Number)
}

function compareVersions(a, b) {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  if (av === null || bv === null) {
    throw new Error(
      `version comparison requires strict semver, got ${JSON.stringify(a)} and ${JSON.stringify(b)}`,
    )
  }
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] !== bv[i]) return av[i] < bv[i] ? -1 : 1
  }
  return 0
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

function tagUrl(version) {
  return `https://github.com/${RELEASE_OWNER_REPO}/releases/tag/v${version}`
}

// The immutable off-chain history index: every version ever promoted, in
// promotion order. Withdrawal preserves it (withdrawn versions stay indexed),
// and re-promotion is refused once a version's history entry exists. Returns
// an error message or null.
function versionInventoryErrors(versions) {
  if (!Array.isArray(versions) || versions.length === 0) {
    return `status.json.versions must be a non-empty array of strict semver strings, got ${JSON.stringify(versions)}`
  }
  for (const version of versions) {
    if (typeof version !== "string" || !SEMVER.test(version)) {
      return `status.json.versions contains an invalid version ${JSON.stringify(version)}`
    }
  }
  return null
}

// Structural validation for a stable manifest without an assets directory.
// The workflow performs full asset/signature validation (validate) before
// promotion; this guards the promoted/restored record itself.
function manifestStructureErrors(manifest, expectedVersion) {
  const errors = []
  const version = manifest?.version
  if (typeof version !== "string" || !SEMVER.test(version)) {
    errors.push(
      `manifest version must be strict semver MAJOR.MINOR.PATCH, got ${JSON.stringify(manifest?.version)}`,
    )
  } else if (expectedVersion !== undefined && version !== expectedVersion) {
    errors.push(
      `manifest version ${JSON.stringify(version)} does not match expected version ${JSON.stringify(expectedVersion)}`,
    )
  }

  if (
    typeof manifest?.pub_date !== "string" ||
    !RFC3339.test(manifest.pub_date) ||
    Number.isNaN(Date.parse(manifest.pub_date))
  ) {
    errors.push(`manifest pub_date must be RFC3339 UTC, got ${JSON.stringify(manifest?.pub_date)}`)
  }

  const platforms = manifest?.platforms
  if (typeof platforms !== "object" || platforms === null || Array.isArray(platforms)) {
    errors.push("manifest platforms must be an object with exactly the four Tauri platform keys")
    return errors
  }
  for (const key of PLATFORM_KEYS) {
    if (!(key in platforms)) {
      errors.push(`missing platform entry ${key}`)
    }
  }
  for (const key of Object.keys(platforms)) {
    if (!PLATFORM_KEYS.includes(key)) {
      errors.push(`unexpected platform entry ${key}`)
    }
  }
  if (typeof version === "string" && SEMVER.test(version)) {
    const wantPrefix = `${RELEASE_BASE}/v${version}/`
    for (const key of PLATFORM_KEYS) {
      const entry = platforms[key]
      if (typeof entry !== "object" || entry === null) {
        errors.push(`platform ${key} entry must be an object with string url and signature`)
        continue
      }
      if (typeof entry.url !== "string") {
        errors.push(`platform ${key} url must be a string`)
      } else if (!entry.url.startsWith(wantPrefix) || entry.url.slice(wantPrefix.length).includes("/")) {
        errors.push(
          `platform ${key} URL must be the immutable tag asset under ${wantPrefix}, got ${JSON.stringify(entry.url)}`,
        )
      }
      if (typeof entry.signature !== "string" || !entry.signature.trim()) {
        errors.push(`platform ${key} signature must be a non-empty string`)
      }
    }
  }
  return errors
}

// Copies the complete existing site tree into the fresh output site before any
// stable file changes, guarding against overlapping input/output directories.
function prepareSite(outputSite, currentSite) {
  const outputResolved = resolve(outputSite)
  const currentResolved = resolve(currentSite)
  if (outputResolved === currentResolved) {
    throw new Error(`output-site must differ from current-site (${currentSite})`)
  }
  if (outputResolved.startsWith(`${currentResolved}/`)) {
    throw new Error(`output-site must not be inside current-site (${currentSite})`)
  }
  if (currentResolved.startsWith(`${outputResolved}/`) && existsSync(outputResolved)) {
    throw new Error(`output-site must not contain current-site (${currentSite})`)
  }
  rmSync(outputResolved, { recursive: true, force: true })
  if (existsSync(currentResolved)) {
    cpSync(currentResolved, outputResolved, { recursive: true })
  }
}

function runPromote(options) {
  const candidate = readJsonFile(options.candidate, "candidate manifest")
  const structureErrors = manifestStructureErrors(candidate)
  if (structureErrors.length > 0) {
    throw new Error(structureErrors.join("\n"))
  }
  const version = candidate.version

  const expectedReleaseUrl = tagUrl(version)
  if (options["release-url"] !== expectedReleaseUrl) {
    throw new Error(
      `--release-url ${JSON.stringify(options["release-url"])} must be the exact release tag URL ${expectedReleaseUrl} for version ${JSON.stringify(version)}`,
    )
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(options["workflow-run"])) {
    throw new Error(
      `--workflow-run must be a GitHub Actions run URL, got ${JSON.stringify(options["workflow-run"])}`,
    )
  }

  const currentSite = options["current-site"]
  const statusPath = join(currentSite, "updates", "stable", "status.json")
  const latestPath = join(currentSite, "updates", "stable", "latest.json")
  let currentVersion
  let versionInventory = []
  if (existsSync(latestPath)) {
    const currentManifest = readJsonFile(latestPath, "current stable manifest")
    const currentErrors = manifestStructureErrors(currentManifest)
    if (currentErrors.length > 0) {
      throw new Error(`current stable state is invalid: ${currentErrors.join("\n")}`)
    }
    currentVersion = currentManifest.version
    if (!existsSync(statusPath)) {
      throw new Error(
        `current stable site has updates/stable/latest.json but no updates/stable/status.json: ${currentSite}`,
      )
    }
    const currentStatus = readJsonFile(statusPath, "current stable status")
    const inventoryError = versionInventoryErrors(currentStatus?.versions)
    if (inventoryError !== null) {
      throw new Error(`current stable state is invalid: ${inventoryError}`)
    }
    versionInventory = [...currentStatus.versions]
  } else if (existsSync(statusPath)) {
    throw new Error(
      `current stable site has updates/stable/status.json but no updates/stable/latest.json: ${currentSite}`,
    )
  }
  if (currentVersion !== undefined && compareVersions(version, currentVersion) <= 0) {
    throw new Error(
      `candidate version ${JSON.stringify(version)} must be strictly greater than current stable version ${JSON.stringify(currentVersion)}`,
    )
  }
  // History is an immutable off-chain record: a version can never be promoted
  // twice, even after a withdrawal has rolled the stable pointer back.
  if (existsSync(join(currentSite, "updates", "stable", "history", `${version}.json`))) {
    throw new Error(
      `version ${JSON.stringify(version)} was already promoted (updates/stable/history/${version}.json already exists): ` +
        `history is immutable and a withdrawn version cannot be re-promoted`,
    )
  }

  const outputSite = options["output-site"]
  prepareSite(outputSite, currentSite)

  const latestText = `${JSON.stringify(candidate, null, 2)}\n`
  const manifestSha256 = sha256Hex(latestText)
  const promotedAt = resolvePubDate(undefined)
  const record = {
    channel: "stable",
    version,
    promotedAt,
    releaseUrl: options["release-url"],
    manifestSha256,
    workflowRun: options["workflow-run"],
    versions: [...versionInventory, version],
  }
  if (currentVersion !== undefined) {
    record.previousVersion = currentVersion
  }

  const stableDir = join(outputSite, "updates", "stable")
  mkdirSync(join(stableDir, "history"), { recursive: true })
  writeFileSync(join(stableDir, "latest.json"), latestText)
  writeFileSync(
    join(stableDir, "history", `${version}.json`),
    `${JSON.stringify({ ...candidate, ...record }, null, 2)}\n`,
  )
  writeFileSync(
    join(outputSite, "updates", "stable", "status.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  writeFileSync(join(outputSite, ".nojekyll"), "")
  console.log(
    `promoted ${version}${currentVersion !== undefined ? ` (previous ${currentVersion})` : " (first stable)"} at ${promotedAt}`,
  )
}

function runWithdraw(options) {
  const currentSite = options["current-site"]
  const status = readJsonFile(join(currentSite, "updates", "stable", "status.json"), "stable status")
  const previousVersion = status?.previousVersion
  if (typeof previousVersion !== "string" || !SEMVER.test(previousVersion)) {
    throw new Error(
      `withdrawal requires status.json.previousVersion to be strict semver, got ${JSON.stringify(previousVersion)}`,
    )
  }
  const inventoryError = versionInventoryErrors(status?.versions)
  if (inventoryError !== null) {
    throw new Error(`stable status is invalid: ${inventoryError}`)
  }

  const historyPath = join(currentSite, "updates", "stable", "history", `${previousVersion}.json`)
  if (!existsSync(historyPath)) {
    throw new Error(
      `history entry for previous version ${JSON.stringify(previousVersion)} is required for withdrawal: updates/stable/history/${previousVersion}.json`,
    )
  }
  const historyRecord = readJsonFile(historyPath, "history entry")
  const historyErrors = manifestStructureErrors(historyRecord, previousVersion)
  if (historyErrors.length > 0) {
    throw new Error(
      `history entry for ${previousVersion} is invalid: ${historyErrors.join("\n")}`,
    )
  }

  const outputSite = options["output-site"]
  prepareSite(outputSite, currentSite)

  const restored = {
    version: historyRecord.version,
    pub_date: historyRecord.pub_date,
    platforms: historyRecord.platforms,
  }
  const latestText = `${JSON.stringify(restored, null, 2)}\n`
  const record = {
    channel: "stable",
    version: previousVersion,
    promotedAt: resolvePubDate(undefined),
    releaseUrl: typeof historyRecord.releaseUrl === "string" ? historyRecord.releaseUrl : tagUrl(previousVersion),
    manifestSha256: sha256Hex(latestText),
    versions: [...status.versions],
  }
  const chainPrevious = historyRecord.previousVersion
  if (typeof chainPrevious === "string" && SEMVER.test(chainPrevious)) {
    record.previousVersion = chainPrevious
  }

  const stableDir = join(outputSite, "updates", "stable")
  mkdirSync(stableDir, { recursive: true })
  writeFileSync(join(stableDir, "latest.json"), latestText)
  writeFileSync(
    join(stableDir, "status.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  // history files are preserved by the complete site copy above
  console.log(`withdrawn stable update to previous version ${previousVersion} at ${record.promotedAt}`)
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!["candidate", "validate", "promote", "withdraw"].includes(command)) {
    throw new Error(
      `expected 'candidate', 'validate', 'promote', or 'withdraw', got ${JSON.stringify(command ?? "")}. ` +
        `Usage: node scripts/update-manifest.mjs <candidate|validate|promote|withdraw> [options]`,
    )
  }
  const options = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument ${JSON.stringify(arg)}`)
    }
    const key = arg.slice(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`)
    }
    options[key] = value
    i += 1
  }
  const required = {
    candidate: ["version", "tag", "assets", "output"],
    validate: ["version", "tag", "assets", "manifest"],
    promote: ["candidate", "current-site", "release-url", "workflow-run", "output-site"],
    withdraw: ["current-site", "output-site"],
  }[command]
  for (const key of required) {
    if (options[key] === undefined) {
      throw new Error(`--${key} is required for '${command}'`)
    }
  }
  return { command, options }
}

function main(argv) {
  try {
    const { command, options } = parseArgs(argv)
    if (command === "candidate") {
      runCandidate(options)
    } else if (command === "validate") {
      runValidate(options)
    } else if (command === "promote") {
      runPromote(options)
    } else {
      runWithdraw(options)
    }
    return 0
  } catch (error) {
    console.error(`update-manifest: ${error.message}`)
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2))
}