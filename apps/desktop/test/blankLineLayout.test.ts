import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const STYLES_CSS = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")

describe("blank-line density (zero decorations)", () => {
  it("leaves blank lines uncompressed without omd-empty class or height overrides", () => {
    // 空行零装饰、原样保留：不使用 line-height 压缩，更绝不用 display:none/visibility:hidden，
    // 彻底消除光标点击/进出空行导致的行高跳变。
    expect(STYLES_CSS).not.toMatch(/\.omd-empty\b/)
    expect(STYLES_CSS).not.toMatch(/--omd-empty-line-height\b/)
  })
})
