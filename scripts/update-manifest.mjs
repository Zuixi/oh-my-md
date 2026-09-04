#!/usr/bin/env node
// Tauri 2 candidate updater manifest generator and validator.
//
//   node scripts/update-manifest.mjs candidate --version X.Y.Z --tag vX.Y.Z \
//     --assets DIR --output DIR/latest.json [--pub-date RFC3339]
//   node scripts/update-manifest.mjs validate --manifest FILE \
//     --version X.Y.Z --tag vX.Y.Z --assets DIR
//
// The tool discovers the actual Tauri updater artifact filenames instead of
// guessing: exactly one macOS *.app.tar.gz + .sig, one Windows *-setup.exe +
// .sig, and one Linux *.AppImage.tar.gz + .sig. It embeds .sig text verbatim,
// maps both Darwin architectures to the one Universal tarball, and points
// every platform at an immutable release-tag URL. pub_date is RFC3339, taken
// from --pub-date, else SOURCE_DATE_EPOCH, else the current time.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
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

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!["candidate", "validate"].includes(command)) {
    throw new Error(
      `expected 'candidate' or 'validate', got ${JSON.stringify(command ?? "")}. ` +
        `Usage: node scripts/update-manifest.mjs <candidate|validate> [options]`,
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
  const required =
    command === "candidate" ? ["version", "tag", "assets", "output"] : ["version", "tag", "assets", "manifest"]
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
    } else {
      runValidate(options)
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