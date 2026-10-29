import { Text } from "@codemirror/state"
import { createTextAssembler } from "@omd/engine"

export type SearchFixtureName =
  | "normal-10m"
  | "normal-100m"
  | "dense-100m"
  | "long-line-20m"
  | "unicode-100m"

export interface SearchFixture {
  readonly name: SearchFixtureName
  readonly text: Text
  readonly expectedLiteralOffsets: readonly number[]
  readonly expectedLiteralCount: number
}

const NEEDLE = "needle"
const MIB = 1024 * 1024
const PARAGRAPH_PERIOD = 64 * 1024
const DENSE_PERIOD = 128
const DENSE_PRE = 61
const DENSE_POST = 60
const DENSE_RECORDED_OFFSETS = 16
const LONG_LINE_CHUNK = 64 * 1024
const LONG_LINE_TOTAL = 20 * MIB

const NORMAL_HIT_BEFORE = "A paragraph mentioning the "
const NORMAL_HIT_AFTER = " and nothing else.\n"

const UNICODE_HIT_BEFORE = "多语言段落中的 "
const UNICODE_HIT_AFTER = " 出现在这里🎉\n"

const DENSE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 "

const NORMAL_LINES: readonly ((index: number) => string)[] = [
  (index) => `## Section ${index}\n`,
  (index) => `Short paragraph ${index} describing the section in plain Markdown prose.\n`,
  () => `\n`,
  (index) => `- item ${index} in a list\n`,
  (index) => `Another paragraph ${index} with **bold** and \`code\` spans.\n`,
]

const UNICODE_TOKENS: readonly string[] = [
  "多语言段落内容。",
  "中文😀表情符号",
  "全角，标点。混合",
  "字符🎉混合内容。",
]

const LONG_LINE_HITS: readonly number[] = [
  1024,
  1 * MIB,
  5 * MIB,
  10 * MIB,
  15 * MIB,
  LONG_LINE_TOTAL - 1024,
]

function fillLines(target: number, seed: number): string {
  const parts: string[] = []
  let remaining = target
  let index = seed
  while (remaining > 0) {
    const line = NORMAL_LINES[index % NORMAL_LINES.length](index)
    if (line.length <= remaining) {
      parts.push(line)
      remaining -= line.length
      index++
    } else {
      parts.push("\n".repeat(remaining))
      remaining = 0
    }
  }
  return parts.join("")
}

function fillUnicode(target: number): string {
  const parts: string[] = []
  let remaining = target - 1
  let index = 0
  while (remaining > 0) {
    const token = UNICODE_TOKENS[index % UNICODE_TOKENS.length]
    if (token.length <= remaining) {
      parts.push(token)
      remaining -= token.length
      index++
    } else {
      parts.push("字".repeat(remaining))
      remaining = 0
    }
  }
  parts.push("\n")
  return parts.join("")
}

function fillDense(target: number): string {
  const parts: string[] = []
  let length = 0
  while (length < target) {
    parts.push(DENSE_ALPHABET)
    length += DENSE_ALPHABET.length
  }
  return parts.join("").slice(0, target)
}

function buildParagraphFixture(
  name: SearchFixtureName,
  periodCount: number,
  hitBefore: string,
  hitAfter: string,
  filler: (length: number, seed: number) => string,
): SearchFixture {
  const assembler = createTextAssembler()
  const hitLine = hitBefore + NEEDLE + hitAfter
  const fillerLength = PARAGRAPH_PERIOD - hitLine.length
  const offsets: number[] = []
  for (let index = 0; index < periodCount; index++) {
    offsets.push(index * PARAGRAPH_PERIOD + hitBefore.length)
    assembler.push(hitLine + filler(fillerLength, index))
  }
  return {
    name,
    text: assembler.finish(),
    expectedLiteralOffsets: offsets,
    expectedLiteralCount: offsets.length,
  }
}

function buildDenseFixture(): SearchFixture {
  const assembler = createTextAssembler()
  const period = fillDense(DENSE_PRE) + NEEDLE + fillDense(DENSE_POST) + "\n"
  const periodCount = (100 * MIB) / DENSE_PERIOD
  const offsets: number[] = []
  for (let index = 0; index < periodCount; index++) {
    if (index < DENSE_RECORDED_OFFSETS) offsets.push(index * DENSE_PERIOD + DENSE_PRE)
    assembler.push(period)
  }
  return {
    name: "dense-100m",
    text: assembler.finish(),
    expectedLiteralOffsets: offsets,
    expectedLiteralCount: periodCount,
  }
}

function buildLongLineFixture(): SearchFixture {
  const assembler = createTextAssembler()
  let hitIndex = 0
  for (let start = 0; start < LONG_LINE_TOTAL; start += LONG_LINE_CHUNK) {
    const end = Math.min(LONG_LINE_TOTAL, start + LONG_LINE_CHUNK)
    const parts: string[] = []
    let position = start
    while (position < end) {
      const hit = hitIndex < LONG_LINE_HITS.length ? LONG_LINE_HITS[hitIndex] : -1
      if (hit >= position && hit + NEEDLE.length <= end) {
        parts.push("x".repeat(hit - position), NEEDLE)
        position = hit + NEEDLE.length
        hitIndex++
      } else {
        parts.push("x".repeat(end - position))
        position = end
      }
    }
    assembler.push(parts.join(""))
  }
  return {
    name: "long-line-20m",
    text: assembler.finish(),
    expectedLiteralOffsets: LONG_LINE_HITS,
    expectedLiteralCount: LONG_LINE_HITS.length,
  }
}

export function buildSearchFixture(name: SearchFixtureName): SearchFixture {
  switch (name) {
    case "normal-10m":
      return buildParagraphFixture(
        name,
        (10 * MIB) / PARAGRAPH_PERIOD,
        NORMAL_HIT_BEFORE,
        NORMAL_HIT_AFTER,
        fillLines,
      )
    case "normal-100m":
      return buildParagraphFixture(
        name,
        (100 * MIB) / PARAGRAPH_PERIOD,
        NORMAL_HIT_BEFORE,
        NORMAL_HIT_AFTER,
        fillLines,
      )
    case "unicode-100m":
      return buildParagraphFixture(
        name,
        (100 * MIB) / PARAGRAPH_PERIOD,
        UNICODE_HIT_BEFORE,
        UNICODE_HIT_AFTER,
        (length) => fillUnicode(length),
      )
    case "dense-100m":
      return buildDenseFixture()
    case "long-line-20m":
      return buildLongLineFixture()
  }
}
