import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ASSETS_DIR_NAME,
  CONTENT_MAX_WIDTH,
  MARKDOWN_EXTENSIONS,
  MARKDOWN_FILE_EXTENSION,
  MAX_IMAGE_BYTES,
  MAX_RECENTS,
  MAX_SEARCH_HITS,
} from "../src/constants"

/**
 * Drift guard for constants that must agree across the TS and Rust sides of
 * the Tauri IPC boundary. TypeScript cannot see Rust source, and desktop tests
 * mock services at the TS boundary, so the only guard is asserting the two
 * definitions still match. If a value legitimately changes, update both sides
 * and this test.
 */

const LIB_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8")
const WORKSPACE_RS = readFileSync(resolve(process.cwd(), "src-tauri/src/workspace.rs"), "utf8")
const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")

function rustConstNumber(source: string, name: string): number {
  const match = new RegExp(`const ${name}: (?:usize|u64) = ([^;]+);`).exec(source)
  if (!match) throw new Error(`missing Rust const ${name}`)
  return match[1]
    .split("*")
    .map(part => Number(part.trim()))
    .reduce((product, factor) => product * factor, 1)
}

function rustConstString(source: string, name: string): string {
  const match = new RegExp(`const ${name}: &str = "([^"]+)";`).exec(source)
  if (!match) throw new Error(`missing Rust const ${name}`)
  return match[1]
}

function rustConstStringList(source: string, name: string): string[] {
  const match = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]+)\\];`).exec(source)
  if (!match) throw new Error(`missing Rust const ${name}`)
  return [...match[1].matchAll(/"([^"]+)"/g)].map(inner => inner[1])
}

describe("cross-layer constants (TS ↔ Rust)", () => {
  it("image size cap matches lib.rs MAX_IMAGE_BYTES", () => {
    expect(MAX_IMAGE_BYTES).toBe(rustConstNumber(LIB_RS, "MAX_IMAGE_BYTES"))
  })

  it("recent-files cap matches lib.rs MAX_RECENT_FILES", () => {
    expect(MAX_RECENTS).toBe(rustConstNumber(LIB_RS, "MAX_RECENT_FILES"))
  })

  it("search hit cap matches workspace.rs MAX_SEARCH_HITS", () => {
    expect(MAX_SEARCH_HITS).toBe(rustConstNumber(WORKSPACE_RS, "MAX_SEARCH_HITS"))
  })

  it("markdown extensions match workspace.rs MARKDOWN_EXT", () => {
    expect([...MARKDOWN_EXTENSIONS]).toEqual(rustConstStringList(WORKSPACE_RS, "MARKDOWN_EXT"))
  })

  it("markdown file extension matches workspace.rs MARKDOWN_FILE_EXTENSION", () => {
    expect(MARKDOWN_FILE_EXTENSION).toBe(
      rustConstString(WORKSPACE_RS, "MARKDOWN_FILE_EXTENSION"),
    )
  })

  it("assets directory name matches lib.rs ASSETS_DIR_NAME", () => {
    expect(ASSETS_DIR_NAME).toBe(rustConstString(LIB_RS, "ASSETS_DIR_NAME"))
  })

  it("content max width matches styles.css --omd-content-width", () => {
    expect(STYLES_CSS).toContain(`--omd-content-width: ${CONTENT_MAX_WIDTH}px`)
  })
})
