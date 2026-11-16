import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The e2e harness pages are served by Vite from apps/desktop, so every bare import under
// e2e/ must be a dependency of @omd/desktop itself. A warm Vite optimization cache can
// hide a missing declaration by reusing its pre-bundled module; a cold cache cannot.
const desktop = join(import.meta.dirname, "..")
const manifest = (path: string) => JSON.parse(readFileSync(path, "utf8")) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const declared = (path: string) => {
  const pkg = manifest(path)
  return { ...pkg.dependencies, ...pkg.devDependencies }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:[cm]?[jt]sx?)$/.test(name) ? [path] : []
  })
}

function bareImports(source: string): string[] {
  const specifiers = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ].map(match => match[1]!)
  return specifiers
    .filter(spec => !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("node:"))
    .map(spec => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"))
}

const harnessImports = () =>
  [...new Set(sourceFiles(join(desktop, "e2e")).flatMap(file => bareImports(readFileSync(file, "utf8"))))].sort()

describe("e2e harness dependencies", () => {
  it("declares every package imported under e2e/", () => {
    const deps = declared(join(desktop, "package.json"))
    expect(harnessImports().filter(pkg => !(pkg in deps))).toEqual([])
  })

  it("keeps harness packages shared with @omd/engine on the engine's version range", () => {
    // Keep shared ranges in lockstep to reduce the risk of duplicate package instances.
    const deps = declared(join(desktop, "package.json"))
    const engine = declared(join(desktop, "..", "..", "packages", "engine", "package.json"))
    const drift = harnessImports()
      .filter(pkg => pkg in engine && pkg in deps && !deps[pkg]!.startsWith("workspace:") && deps[pkg] !== engine[pkg])
      .map(pkg => `${pkg}: desktop ${deps[pkg]}, engine ${engine[pkg]}`)
    expect(drift).toEqual([])
  })
})
