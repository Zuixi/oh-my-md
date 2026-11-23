import { syntaxTree } from "@codemirror/language"
import type { InlineContext } from "@lezer/markdown"
import { describe, expect, it } from "vitest"
import { makeState } from "./helpers"
import { BareAutolink } from "../src/parse/autolink"

function collect(doc: string): { names: string[]; autolinks: string[] } {
  const state = makeState(doc)
  const names: string[] = []
  const autolinks: string[] = []
  syntaxTree(state).iterate({
    enter(node) {
      names.push(node.name)
      if (node.name === "Autolink") autolinks.push(state.doc.sliceString(node.from, node.to))
    },
  })
  return { names, autolinks }
}

describe("bare autolink boundaries", () => {
  it("keeps strong emphasis around a bare URL", () => {
    const { names, autolinks } = collect("**https://example.com**")
    expect(names).toContain("StrongEmphasis")
    expect(autolinks).toEqual(["https://example.com"])
  })

  it("keeps strikethrough and single emphasis around a bare URL", () => {
    const strike = collect("~~https://example.com~~")
    expect(strike.names).toContain("Strikethrough")
    expect(strike.autolinks).toEqual(["https://example.com"])

    const emphasis = collect("*https://example.com*")
    expect(emphasis.names).toContain("Emphasis")
    expect(emphasis.autolinks).toEqual(["https://example.com"])
  })

  it("allows a single underscore opener but not an intra-word underscore", () => {
    const strong = collect("__https://example.com__")
    expect(strong.names).toContain("StrongEmphasis")
    expect(strong.autolinks).toEqual(["https://example.com"])

    const nested = collect("*_https://example.com_*")
    expect(nested.names).toContain("Emphasis")
    expect(nested.autolinks).toEqual(["https://example.com"])

    expect(collect("foo_https://example.com").autolinks).toEqual([])
  })

  it("trims a trailing underscore that closes emphasis but keeps a plain URL underscore", () => {
    const emphasized = collect("**https://example.com_**")
    expect(emphasized.names).toContain("StrongEmphasis")
    expect(emphasized.autolinks).toEqual(["https://example.com"])

    const plain = collect("https://example.com/a_")
    expect(plain.autolinks).toEqual(["https://example.com/a_"])
  })

  it("keeps www and email autolinks", () => {
    expect(collect("www.example.com").autolinks).toEqual(["www.example.com"])
    expect(collect("hello@example.com").autolinks).toEqual(["hello@example.com"])
  })

  it("rejects a multi-underscore intra-word prefix", () => {
    expect(collect("foo__https://example.com").autolinks).toEqual([])
    expect(collect("foo__bar_https://example.com").autolinks).toEqual([])
    expect(collect("__https://example.com__").autolinks).toEqual(["https://example.com"])
    expect(collect("_**https://example.com**_").autolinks).toEqual(["https://example.com"])
  })

  it("treats non-CJK letters as word characters", () => {
    expect(collect("über@example.com").autolinks).toEqual(["über@example.com"])
    expect(collect("überhttps://example.com").autolinks).toEqual([])
    expect(collect("über_https://example.com").autolinks).toEqual([])
    expect(collect("see über@example.com now").autolinks).toEqual(["über@example.com"])
  })

  it("treats CJK text before a URL as a boundary", () => {
    expect(collect("中文https://example.com").autolinks).toEqual(["https://example.com"])
    expect(collect("见https://example.com").autolinks).toEqual(["https://example.com"])
    expect(collect("カナhttps://example.com").autolinks).toEqual(["https://example.com"])
    expect(collect("한글https://example.com").autolinks).toEqual(["https://example.com"])
    // Astral Han (surrogate pair) before the URL stays a boundary too.
    expect(collect("𠀀https://example.com").autolinks).toEqual(["https://example.com"])
    // An astral non-CJK letter is a word character: no boundary.
    expect(collect("𝐚https://example.com").autolinks).toEqual([])
  })

  it("keeps emails inside Cyrillic and accented prose", () => {
    expect(collect("Привет über@example.com мир").autolinks).toEqual(["über@example.com"])
    expect(collect("Привет, мир").autolinks).toEqual([])
    expect(collect("café über@example.com déjà").autolinks).toEqual(["über@example.com"])
  })

  it("starts an email after CJK prose but never at the CJK character", () => {
    // The `@` gate runs before the code-point test: `见` is CJK prose and
    // rejects, `ü` is a word character and matches.
    expect(collect("见über@example.com").autolinks).toEqual(["über@example.com"])
    expect(collect("见@example.com").autolinks).toEqual([])
    expect(collect("中文见uber@example.com").autolinks).toEqual(["uber@example.com"])
  })

  it("treats fullwidth forms as CJK prose, not as a link start", () => {
    // Fullwidth Latin is `\p{L}`, but the block belongs to CJK typography, so
    // the integer gate rejects it with the rest of the CJK prose blocks.
    expect(collect("Ａ@example.com").autolinks).toEqual([])
  })

  it("rejects URLs whose host is empty or dot-only", () => {
    expect(collect("https://.").autolinks).toEqual([])
    expect(collect("**https://**").autolinks).toEqual([])
    expect(collect("https://..").autolinks).toEqual([])
    expect(collect("see https://. next").autolinks).toEqual([])
    expect(collect("https:///?q").autolinks).toEqual([])
    expect(collect("https://example.com").autolinks).toEqual(["https://example.com"])
    expect(collect("https://example.com/x?y#z").autolinks).toEqual(["https://example.com/x?y#z"])
    expect(collect("ftp://host").autolinks).toEqual(["ftp://host"])
  })

  it("rejects www autolinks without a dotted host", () => {
    expect(collect("www...").autolinks).toEqual([])
    expect(collect("www.").autolinks).toEqual([])
    expect(collect("www.a").autolinks).toEqual([])
    expect(collect("www.a.b").autolinks).toEqual(["www.a.b"])
  })

  it("bounds the candidate scan to the token", () => {
    const words = "lorem ipsum dolor sit amet ".repeat(200)
    expect(collect(`${words}https://example.com tail`).autolinks).toEqual(["https://example.com"])
    expect(collect("a https://example.com>b").autolinks).toEqual(["https://example.com"])
    expect(collect("https://example.com, next").autolinks).toEqual(["https://example.com"])
  })
})

describe("bare autolink convergent trimming", () => {
  it("trims punctuation that sits outside the emphasis span", () => {
    expect(collect("See **https://example.com**.").autolinks).toEqual(["https://example.com"])
    expect(collect("See **https://example.com**.").names).toContain("StrongEmphasis")

    const strike = collect("(~~https://old.com~~, new)")
    expect(strike.autolinks).toEqual(["https://old.com"])
    expect(strike.names).toContain("Strikethrough")
  })

  it("trims a trailing underscore for composite openers", () => {
    const composite = collect("_**https://example.com**_")
    expect(composite.autolinks).toEqual(["https://example.com"])
    expect(composite.names).toContain("StrongEmphasis")
    expect(composite.names).toContain("Emphasis")
  })

  it("balances parentheses around and inside URLs", () => {
    expect(collect("(https://example.com)").autolinks).toEqual(["https://example.com"])
    expect(collect("(https://en.wikipedia.org/wiki/Foo_(bar))").autolinks)
      .toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"])
    expect(collect("https://en.wikipedia.org/wiki/Foo_(bar)").autolinks)
      .toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"])
  })

  it("strips trailing punctuation without dropping a URL underscore", () => {
    expect(collect("https://example.com/a_.").autolinks).toEqual(["https://example.com/a_"])
  })
})

/**
 * `BareAutolink.parse` runs at every position of every inline section, so a
 * prose character must cost neither a string nor a regex. These tests drive the
 * parser directly with a counting context: `cx.char` reads and `cx.slice` calls
 * are counted, and every `RegExp` execution during the run is counted too.
 */
interface CountingContext {
  readonly cx: InlineContext
  readonly slices: () => number
  readonly charReads: () => number
}

function countingContext(text: string): CountingContext {
  let slices = 0
  let charReads = 0
  const cx = {
    char(pos: number) {
      charReads++
      return pos >= text.length ? -1 : text.charCodeAt(pos)
    },
    end: text.length,
    offset: 0,
    hasOpenLink: false,
    slice(from: number, to: number) {
      slices++
      return text.slice(from, to)
    },
    // Enough of the element API for a successful match to report its end.
    elt: (name: string, from: number, to: number) => ({ name, from, to, children: [] }),
    addElement: (element: { to: number }) => element.to,
  } as unknown as InlineContext
  return { cx, slices: () => slices, charReads: () => charReads }
}

/** Runs `run` with every `RegExp.prototype.exec`/`test` call counted. */
function countRegexCalls(run: () => void): number {
  const exec = RegExp.prototype.exec
  const test = RegExp.prototype.test
  let calls = 0
  RegExp.prototype.exec = function (this: RegExp, value: string) {
    calls++
    return exec.call(this, value)
  }
  RegExp.prototype.test = function (this: RegExp, value: string) {
    calls++
    return test.call(this, value)
  }
  try {
    run()
  } finally {
    RegExp.prototype.exec = exec
    RegExp.prototype.test = test
  }
  return calls
}

function parseEveryPosition(context: CountingContext, text: string): void {
  for (let pos = 0; pos < text.length; pos++) {
    BareAutolink.parse(context.cx, text.charCodeAt(pos), pos)
  }
}

describe("bare autolink allocation gate", () => {
  it.each([
    ["ASCII", "Lorem ipsum dolor sit amet, consectetur adipiscing elit"],
    ["Latin accented", "café déjà vu über naïve coöperate"],
    ["Cyrillic", "Привет мир как дела сегодня"],
    ["CJK", "中文段落包含加粗与普通文本收尾。"],
    ["Kana", "カタカナの文章とひらがなの文章。"],
    ["Hangul", "한글 문장과 낱말"],
  ])("rejects %s prose without a slice or a regex", (_script, text) => {
    const context = countingContext(text)
    const regexCalls = countRegexCalls(() => { parseEveryPosition(context, text) })

    expect(context.slices()).toBe(0)
    expect(regexCalls).toBe(0)
  })

  it("stops a space-less CJK run on its first code unit", () => {
    // No space in the sample: only the integer block check can end it without
    // scanning forward, so zero `cx.char` reads is the assertion that proves it.
    const text = "中文段落包含加粗与普通文本收尾"
    const context = countingContext(text)
    const regexCalls = countRegexCalls(() => { parseEveryPosition(context, text) })

    expect(context.charReads()).toBe(0)
    expect(context.slices()).toBe(0)
    expect(regexCalls).toBe(0)
  })

  it("still links a URL or email that follows prose", () => {
    // The gate must not swallow real autolinks: one `@` token and one `www.` /
    // scheme token still parse from a counting context.
    const context = countingContext("wie über@example.com und www.example.com")
    const emailPos = "wie ".length
    const urlPos = "wie über@example.com und ".length

    expect(BareAutolink.parse(context.cx, context.cx.char(emailPos), emailPos))
      .toBe(emailPos + "über@example.com".length)
    expect(BareAutolink.parse(context.cx, context.cx.char(urlPos), urlPos))
      .toBe(urlPos + "www.example.com".length)
  })

  it("stays O(n) on a pathological space-less ASCII run", () => {
    const text = "x".repeat(200_000)
    const context = countingContext(text)
    parseEveryPosition(context, text)

    expect(context.slices()).toBe(0)
    // Position 0 scans at most the local-part cap; every intra-word position reads 1 char.
    expect(context.charReads()).toBeLessThanOrEqual(text.length + 256)
  })
})
