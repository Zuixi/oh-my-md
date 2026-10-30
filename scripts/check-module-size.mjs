#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { parseArgs } from "node:util"

const MAX_MODULE_LINES = 800
const BASELINE_PATH = "scripts/module-size-baseline.json"
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".py",
])

function main() {
  const { values } = parseArgs({
    options: { staged: { type: "boolean" }, base: { type: "string", default: "HEAD" } },
  })
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim()
  const baseRef = values.base && !/^0+$/.test(values.base) ? values.base : "HEAD"
  const base = git(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]).trim()
  const basePaths = paths(git(root, ["ls-tree", "-r", "--name-only", "-z", base]))
  const currentPaths = paths(git(root, [
    "ls-files", "-z", "--cached", ...(values.staged ? [] : ["--others", "--exclude-standard"]),
  ]))
  const unstagedPaths = values.staged ? paths(git(root, ["diff", "--name-only", "-z"])) : null
  const readCurrent = (path) => {
    const full = join(root, path)
    if (values.staged && (!currentPaths.has(path) || unstagedPaths.has(path) || !existsSync(full))) {
      return git(root, ["show", `:${path}`])
    }
    if (lstatSync(full).isSymbolicLink()) {
      throw new Error(`source/config symlinks are not supported: ${path}`)
    }
    return readFileSync(full, "utf8")
  }
  const baseline = parseBaseline(readCurrent(BASELINE_PATH))
  const previous = basePaths.has(BASELINE_PATH)
    ? parseBaseline(git(root, ["show", `${base}:${BASELINE_PATH}`]))
    : null
  const baseLines = new Map()
  for (const path of Object.keys(baseline)) {
    baseLines.set(path, basePaths.has(path) ? countLines(git(root, ["show", `${base}:${path}`])) : 0)
  }
  const errors = []
  for (const [path, allowance] of Object.entries(baseline)) {
    const previousAllowance = previous?.[path]
    const canKeep = previous !== null
      ? Object.hasOwn(previous, path) && allowance <= previousAllowance
      : allowance <= baseLines.get(path)
    if (!canKeep) errors.push(`legacy allowance cannot be added or increased: ${path}`)
  }
  let checked = 0
  for (const path of [...currentPaths].sort()) {
    if (!isSource(path) || (!values.staged && !existsSync(join(root, path)))) continue
    const lines = countLines(readCurrent(path))
    const allowance = baseline[path]
    const limit = allowance === undefined
      ? MAX_MODULE_LINES
      : Math.min(allowance, Math.max(MAX_MODULE_LINES, baseLines.get(path)))
    if (lines > limit) errors.push(`${path}: ${lines} lines exceeds ${limit}; split by responsibility`)
    if (allowance !== undefined && lines <= MAX_MODULE_LINES) {
      errors.push(`remove obsolete legacy allowance: ${path}`)
    }
    checked++
  }
  for (const path of Object.keys(baseline)) {
    if (!currentPaths.has(path) || (!values.staged && !existsSync(join(root, path)))) {
      errors.push(`remove deleted module's legacy allowance: ${path}`)
    }
  }
  if (errors.length > 0) {
    console.error(`[module-size]\n${errors.join("\n")}`)
    process.exitCode = 1
    return
  }
  console.log(`[module-size] ${checked} files checked; limit ${MAX_MODULE_LINES}; legacy modules may not grow`)
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function paths(output) {
  return new Set(output.split("\0").filter(Boolean))
}

function isSource(path) {
  return SOURCE_EXTENSIONS.has(extname(path))
}

function countLines(text) {
  return text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"))
}

function parseBaseline(text) {
  const baseline = JSON.parse(text)
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error(`${BASELINE_PATH}: baseline must be a path-to-line-count object`)
  }
  for (const [path, allowance] of Object.entries(baseline)) {
    if (!isSource(path) || path.startsWith("/") || path.includes("\\")
      || path.split("/").some(part => part === ".." || part === "." || part === "")
      || !Number.isSafeInteger(allowance) || allowance <= MAX_MODULE_LINES) {
      throw new Error(`${BASELINE_PATH}: invalid legacy allowance: ${path}`)
    }
  }
  return baseline
}

try {
  main()
} catch (error) {
  console.error(`[module-size] ${error.message}`)
  process.exitCode = 1
}
