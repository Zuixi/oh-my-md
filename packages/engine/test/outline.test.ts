import { describe, expect, it } from "vitest"
import { collectOutline, outlineCurrentIndex } from "../src/outline"
import { makeState } from "./helpers"

describe("document outline", () => {
  it("collects ATX and Setext headings with levels and positions", () => {
    const doc = "# Top\n\n## Nested\n\nTitle\n=====\n\n## Also"
    const items = collectOutline(makeState(doc))
    expect(items).toEqual([
      { level: 1, text: "Top", from: 0 },
      { level: 2, text: "Nested", from: doc.indexOf("## Nested") },
      { level: 1, text: "Title", from: doc.indexOf("Title") },
      { level: 2, text: "Also", from: doc.lastIndexOf("## Also") },
    ])
  })

  it("does not invent headings from paragraph text", () => {
    expect(collectOutline(makeState("not a heading\n\n# Real"))).toEqual([
      { level: 1, text: "Real", from: "not a heading\n\n".length },
    ])
  })
})

describe("outlineCurrentIndex", () => {
  const DOC = "# Intro\n\nbody\n\n## A\n\ntext\n\n# Next\n\nend"
  const items = collectOutline(makeState(DOC))
  // from 值取真实收集结果，避免测试文档与手工偏移漂移。
  const [intro, a, next] = items

  it("returns -1 before the first heading and for an empty outline", () => {
    const withPreamble = collectOutline(makeState("preamble\n\n# H\n\nbody"))
    expect(outlineCurrentIndex(withPreamble, 3)).toBe(-1) // 首标题之前
    expect(outlineCurrentIndex(items, 0)).toBe(0) // 标题行自身属于该节
    expect(outlineCurrentIndex([], 5)).toBe(-1)
  })

  it("tracks the deepest section containing the cursor", () => {
    expect(outlineCurrentIndex(items, DOC.indexOf("body"))).toBe(0)
    expect(outlineCurrentIndex(items, DOC.indexOf("text"))).toBe(1)
    expect(outlineCurrentIndex(items, DOC.indexOf("end"))).toBe(2)
  })

  it("clamps positions past the document end to the last section", () => {
    expect(outlineCurrentIndex(items, DOC.length + 100)).toBe(2)
  })

  it("is robust to unordered input by scanning for the latest start", () => {
    // 防御性：collectOutline 产物有序，但纯函数不假设调用方顺序。
    const shuffled = [next, intro, a]
    expect(outlineCurrentIndex(shuffled, DOC.indexOf("text"))).toBe(2)
  })
})

