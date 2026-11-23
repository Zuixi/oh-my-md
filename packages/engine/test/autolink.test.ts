import { syntaxTree } from "@codemirror/language"
import { describe, expect, it } from "vitest"
import { makeState } from "./helpers"

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
