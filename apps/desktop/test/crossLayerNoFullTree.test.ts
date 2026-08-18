import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

// Spec 05a §10.5 完整树陷阱：一旦有生产路径把解析推到 doc.length，此后每次编辑的
// fragment 重启随文档规模增长（实测 1MB=23.5ms、10MB=70.6ms 每键）。稳态生产
// 依赖 CM 的 MaxParseAhead（viewport.to + 100k）保持部分树 —— 生产代码永远
// 不得调用 forceParsing / ensureSyntaxTree。test helpers 可以（小文档自有）。
describe("no full-tree parse in production code", () => {
  it("engine and desktop src never call forceParsing/ensureSyntaxTree", () => {
    const roots = [
      join(import.meta.dirname, "../../../packages/engine/src"),
      join(import.meta.dirname, "../src"),
    ]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        const text = readFileSync(file, "utf8")
        if (/forceParsing\s*\(|ensureSyntaxTree\s*\(/.test(text)) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})
