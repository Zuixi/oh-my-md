#!/usr/bin/env node

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const secret = process.env.UPDATER_PRIVATE_KEY?.trim()
if (!secret) throw new Error("missing UPDATER_PRIVATE_KEY")
if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret) || secret.length % 4 !== 0) {
  throw new Error("UPDATER_PRIVATE_KEY must be valid base64 without internal whitespace")
}

const decoded = Buffer.from(secret, "base64")
if (decoded.toString("base64") !== secret || !decoded.toString("utf8").includes("secret key")) {
  throw new Error("UPDATER_PRIVATE_KEY must decode to a Tauri updater secret key")
}

const directory = resolve(process.argv[2] ?? process.env.RUNNER_TEMP ?? ".")
mkdirSync(directory, { recursive: true })
const path = join(directory, "omd-updater.key")
writeFileSync(path, secret, { mode: 0o600 })
chmodSync(path, 0o600)

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `TAURI_SIGNING_PRIVATE_KEY=${path}\n`)
}
process.stdout.write(`${path}\n`)
