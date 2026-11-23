import { describe, expect, it } from "vitest"
import { CHUNK_SIZE_WARNING_LIMIT, vendorChunkFor } from "../viteChunks"

/**
 * The bundle split is shipped behaviour, not a build detail: an eager chunk that
 * swallows the on-demand grammars (Shiki language packs, CodeMirror per-fence
 * grammars, KaTeX's inlined export fonts) makes startup pay for megabytes nobody
 * asked for. These assertions keep the routing honest without a production build.
 */
describe("vite vendor chunks", () => {
  it("keeps the warning limit tight enough to catch an eager-graph regression", () => {
    expect(CHUNK_SIZE_WARNING_LIMIT).toBeLessThanOrEqual(850)
    // Above every eager chunk, below the largest on-demand grammar chunk.
    expect(CHUNK_SIZE_WARNING_LIMIT).toBeGreaterThan(700)
  })

  it("routes the eager vendor packages to their own chunks", () => {
    expect(vendorChunkFor("/repo/node_modules/katex/dist/katex.mjs")).toBe("vendor-katex")
    expect(vendorChunkFor("/repo/node_modules/@codemirror/view/dist/index.js"))
      .toBe("vendor-codemirror")
    expect(vendorChunkFor("/repo/node_modules/@codemirror/lang-markdown/dist/index.js"))
      .toBe("vendor-codemirror")
    expect(vendorChunkFor("/repo/node_modules/@lezer/common/dist/index.js"))
      .toBe("vendor-codemirror")
    expect(vendorChunkFor("/repo/node_modules/react-dom/client.js")).toBe("vendor-react")
    expect(vendorChunkFor("/repo/node_modules/scheduler/index.js")).toBe("vendor-react")
    expect(vendorChunkFor("/repo/node_modules/@tauri-apps/api/core.js")).toBe("vendor-tauri")
    expect(vendorChunkFor("/repo/node_modules/react-toastify/dist/index.mjs"))
      .toBe("vendor-toastify")
    expect(vendorChunkFor("/repo/node_modules/@shikijs/core/dist/index.mjs"))
      .toBe("vendor-shiki-core")
    expect(vendorChunkFor("/repo/node_modules/@shikijs/vscode-textmate/dist/index.js"))
      .toBe("vendor-shiki-core")
    expect(vendorChunkFor("/repo/node_modules/shiki/dist/core.mjs")).toBe("vendor-shiki-core")
  })

  it("leaves app code and on-demand grammar/theme chunks alone", () => {
    expect(vendorChunkFor("/repo/packages/engine/src/index.ts")).toBeUndefined()
    // Per-language grammars and themes stay dynamic: merging them would create
    // a multi-megabyte eager bundle.
    expect(vendorChunkFor("/repo/node_modules/@shikijs/langs/dist/cpp.mjs")).toBeUndefined()
    expect(vendorChunkFor("/repo/node_modules/shiki/dist/langs/cpp.mjs")).toBeUndefined()
    expect(vendorChunkFor("/repo/node_modules/shiki/dist/themes/github-dark.mjs"))
      .toBeUndefined()
    expect(vendorChunkFor("/repo/node_modules/mermaid/dist/mermaid.core.mjs")).toBeUndefined()
    // Fence-only CodeMirror grammars and their Lezer parsers.
    expect(vendorChunkFor("/repo/node_modules/@codemirror/lang-python/dist/index.js"))
      .toBeUndefined()
    expect(vendorChunkFor("/repo/node_modules/@codemirror/legacy-modes/mode/go.js"))
      .toBeUndefined()
    expect(vendorChunkFor("/repo/node_modules/@lezer/cpp/dist/index.js")).toBeUndefined()
    // KaTeX's inlined export assets are string modules, not vendor code.
    expect(vendorChunkFor("/repo/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2?inline"))
      .toBeUndefined()
  })

  it("normalizes Windows separators", () => {
    expect(vendorChunkFor("C:\\repo\\node_modules\\katex\\dist\\katex.mjs")).toBe("vendor-katex")
  })
})
