import { describe, expect, it } from "vitest"
import type { Text } from "@codemirror/state"
import { buildSearchFixture } from "../bench/searchFixtures"

const NEEDLE = "needle"
const PARAGRAPH_PERIOD = 64 * 1024
const MIB = 1024 * 1024

function countNeedles(text: Text, from: number, to: number): number {
  return text.sliceString(from, to).split(NEEDLE).length - 1
}

function expectNeedleAt(text: Text, offset: number): void {
  expect(text.sliceString(offset, offset + NEEDLE.length)).toBe(NEEDLE)
}

describe("search fixtures", () => {
  it("builds normal-10m from short Markdown paragraphs with one hit per 64 KiB", () => {
    const fixture = buildSearchFixture("normal-10m")
    expect(fixture.name).toBe("normal-10m")
    expect(fixture.text.length).toBe(10485760)
    expect(fixture.expectedLiteralCount).toBe(160)
    expect(fixture.expectedLiteralOffsets.length).toBe(160)
    expect(fixture.expectedLiteralOffsets[0]).toBe(27)
    expect(fixture.expectedLiteralOffsets[80]).toBe(80 * PARAGRAPH_PERIOD + 27)
    expect(fixture.expectedLiteralOffsets[159]).toBe(159 * PARAGRAPH_PERIOD + 27)
    expect(fixture.text.lines).toBe(329067)
    for (const offset of [0, 80, 159]) {
      const hit = fixture.expectedLiteralOffsets[offset]
      expectNeedleAt(fixture.text, hit)
      expect(fixture.text.sliceString(hit - 27, hit + 24)).toBe(
        "A paragraph mentioning the needle and nothing else.",
      )
      expect(fixture.text.lineAt(hit).text).toBe(
        "A paragraph mentioning the needle and nothing else.",
      )
      const periodStart = offset * PARAGRAPH_PERIOD
      expect(countNeedles(fixture.text, periodStart, periodStart + PARAGRAPH_PERIOD)).toBe(1)
    }
  })

  it("builds normal-100m from the same paragraph period at full size", () => {
    const fixture = buildSearchFixture("normal-100m")
    expect(fixture.name).toBe("normal-100m")
    expect(fixture.text.length).toBe(104857600)
    expect(fixture.expectedLiteralCount).toBe(1600)
    expect(fixture.expectedLiteralOffsets.length).toBe(1600)
    expect(fixture.expectedLiteralOffsets[0]).toBe(27)
    expect(fixture.expectedLiteralOffsets[800]).toBe(800 * PARAGRAPH_PERIOD + 27)
    expect(fixture.expectedLiteralOffsets[1599]).toBe(1599 * PARAGRAPH_PERIOD + 27)
    expect(fixture.text.lines).toBe(3270542)
    for (const offset of [0, 800, 1599]) {
      const hit = fixture.expectedLiteralOffsets[offset]
      expectNeedleAt(fixture.text, hit)
      expect(fixture.text.lineAt(hit).text).toBe(
        "A paragraph mentioning the needle and nothing else.",
      )
      const periodStart = offset * PARAGRAPH_PERIOD
      expect(countNeedles(fixture.text, periodStart, periodStart + PARAGRAPH_PERIOD)).toBe(1)
    }
  })

  it("builds dense-100m with one hit per 128 bytes and only 16 recorded offsets", () => {
    const fixture = buildSearchFixture("dense-100m")
    expect(fixture.name).toBe("dense-100m")
    expect(fixture.text.length).toBe(104857600)
    expect(fixture.expectedLiteralCount).toBe(819200)
    expect(fixture.expectedLiteralOffsets.length).toBe(16)
    expect(fixture.expectedLiteralOffsets[0]).toBe(61)
    expect(fixture.expectedLiteralOffsets[15]).toBe(15 * 128 + 61)
    expect(fixture.text.lines).toBe(819201)
    for (const hit of fixture.expectedLiteralOffsets) {
      expectNeedleAt(fixture.text, hit)
      expect(fixture.text.sliceString(hit - 6, hit + 12)).toBe("stuvwxneedleabcdef")
    }
    expect(countNeedles(fixture.text, 0, 128 * 10)).toBe(10)
  })

  it("builds long-line-20m as one line with sparse recorded hits", () => {
    const fixture = buildSearchFixture("long-line-20m")
    expect(fixture.name).toBe("long-line-20m")
    expect(fixture.text.length).toBe(20971520)
    expect(fixture.text.lines).toBe(1)
    expect(fixture.expectedLiteralCount).toBe(6)
    expect(fixture.expectedLiteralOffsets).toEqual([
      1024,
      1 * MIB,
      5 * MIB,
      10 * MIB,
      15 * MIB,
      20971520 - 1024,
    ])
    for (const hit of fixture.expectedLiteralOffsets) {
      expectNeedleAt(fixture.text, hit)
      expect(fixture.text.sliceString(hit - 1, hit + NEEDLE.length + 1)).toBe("xneedlex")
    }
    expect(countNeedles(fixture.text, 0, 64 * 1024)).toBe(1)
    expect(countNeedles(fixture.text, 1 * MIB, 1 * MIB + 64 * 1024)).toBe(1)
  })

  it("builds unicode-100m with sparse hits surrounded by CJK and emoji", () => {
    const fixture = buildSearchFixture("unicode-100m")
    expect(fixture.name).toBe("unicode-100m")
    expect(fixture.text.length).toBe(104857600)
    expect(fixture.expectedLiteralCount).toBe(1600)
    expect(fixture.expectedLiteralOffsets.length).toBe(1600)
    expect(fixture.expectedLiteralOffsets[0]).toBe(8)
    expect(fixture.expectedLiteralOffsets[800]).toBe(800 * PARAGRAPH_PERIOD + 8)
    expect(fixture.expectedLiteralOffsets[1599]).toBe(1599 * PARAGRAPH_PERIOD + 8)
    expect(fixture.text.lines).toBe(3201)
    for (const offset of [0, 800, 1599]) {
      const hit = fixture.expectedLiteralOffsets[offset]
      expectNeedleAt(fixture.text, hit)
      expect(fixture.text.sliceString(hit - 8, hit)).toBe("多语言段落中的 ")
      expect(fixture.text.sliceString(hit + NEEDLE.length, hit + NEEDLE.length + 8)).toBe(
        " 出现在这里🎉",
      )
      expect(fixture.text.lineAt(hit).text).toBe("多语言段落中的 needle 出现在这里🎉")
      const periodStart = offset * PARAGRAPH_PERIOD
      expect(countNeedles(fixture.text, periodStart, periodStart + PARAGRAPH_PERIOD)).toBe(1)
    }
  })
})
