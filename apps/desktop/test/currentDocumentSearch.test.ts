import { describe, expect, it, vi } from "vitest"
import { ChangeSet, EditorState, Text } from "@codemirror/state"
import type { TransactionSpec } from "@codemirror/state"
import { buildSearchFixture } from "../bench/searchFixtures"
import {
  PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS,
  buildReplaceAll,
  collectViewportMatches,
  createMatchCursor,
  findNextMatch,
  findPreviousMatch,
  matchStillValid,
  replaceCurrentSpec,
  validateSearchRequest,
  type ReplaceAllResult,
  type SearchMatch,
  type SearchRequest,
} from "../src/currentDocumentSearch"
import { startSearchCount, type SearchCount, type SearchScheduler } from "../src/searchCountJob"
import { currentSearchRevision, searchRevisionField } from "../src/searchRevision"

const KIB = 1024
const MIB = 1024 * 1024
const NEEDLE = "needle"

function request(query: string, options: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query,
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
    revision: 0,
    ...options,
  }
}

interface GuardCalls {
  readonly stringify: number
  readonly slices: readonly (readonly [number, number])[]
  readonly textSlices: readonly (readonly [number, number])[]
  readonly ranges: readonly (readonly [number, number])[]
}

function guardText(doc: Text): { readonly doc: Text; readonly calls: GuardCalls } {
  const state = {
    stringify: 0,
    slices: [] as [number, number][],
    textSlices: [] as [number, number][],
    ranges: [] as [number, number][],
  }
  const guarded = new Proxy(doc, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "toString") {
        return () => {
          state.stringify++
          return target.toString()
        }
      }
      if (property === "slice") {
        return (from: number, to?: number) => {
          state.textSlices.push([from, to ?? target.length])
          state.slices.push([from, to ?? target.length])
          return target.slice(from, to)
        }
      }
      if (property === "sliceString") {
        return (from: number, to: number, lineSep?: string) => {
          state.slices.push([from, to])
          return target.sliceString(from, to, lineSep)
        }
      }
      if (property === "iterRange") {
        return (from: number, to: number) => {
          state.ranges.push([from, to])
          return target.iterRange(from, to)
        }
      }
      return value.bind(target)
    },
  })
  return { doc: guarded, calls: state }
}

function textWithHits(length: number, hits: readonly number[]): Text {
  const parts: string[] = []
  let position = 0
  for (const hit of hits) {
    parts.push("x".repeat(hit - position), NEEDLE)
    position = hit + NEEDLE.length
  }
  parts.push("x".repeat(length - position))
  return Text.of([parts.join("")])
}

function found(match: SearchMatch | null): SearchMatch {
  expect(match).not.toBeNull()
  return match as SearchMatch
}

describe("validateSearchRequest", () => {
  it("accepts empty queries and reports invalid regex sources", () => {
    expect(validateSearchRequest(request(""))).toBeNull()
    expect(validateSearchRequest(request("[", { regexp: true }))).toBeTruthy()
    expect(validateSearchRequest(request("["))).toBeNull()
    expect(validateSearchRequest(request("\\d", { regexp: true }))).toBeNull()
  })
})

describe("literal navigation parity", () => {
  it("treats an empty query as no matches", () => {
    const doc = Text.of(["abc"])
    const empty = request("")
    expect(findNextMatch(doc, empty, 0)).toBeNull()
    expect(findPreviousMatch(doc, empty, 3)).toBeNull()
    expect(createMatchCursor(doc, empty, 0, 3).next()).toBeNull()
    expect(collectViewportMatches(doc, empty, [{ from: 0, to: 3 }])).toEqual([])
  })

  it("matches punctuation literally", () => {
    const doc = Text.of(["a.b axb", "price $5 (x)"])
    expect(collectViewportMatches(doc, request("a.b"), [{ from: 0, to: doc.length }])).toEqual([
      { from: 0, to: 3, revision: 0 },
    ])
    expect(collectViewportMatches(doc, request("$5 (x)"), [{ from: 0, to: doc.length }])).toEqual([
      { from: 14, to: 20, revision: 0 },
    ])
    expect(collectViewportMatches(doc, request("a.b", { regexp: true }), [{ from: 0, to: doc.length }])).toEqual([
      { from: 0, to: 3, revision: 0 },
      { from: 4, to: 7, revision: 0 },
    ])
  })

  it("honors case sensitivity", () => {
    const doc = Text.of(["Ab ab AB"])
    const all = [{ from: 0, to: doc.length }]
    expect(collectViewportMatches(doc, request("ab"), all).map((m) => m.from)).toEqual([0, 3, 6])
    expect(
      collectViewportMatches(doc, request("ab", { caseSensitive: true }), all).map((m) => m.from),
    ).toEqual([3])
  })

  it("finds forward matches and wraps", () => {
    const doc = Text.of(["one two one"])
    const q = request("one")
    expect(findNextMatch(doc, q, 0)).toEqual({ from: 0, to: 3, revision: 0 })
    expect(findNextMatch(doc, q, 3)).toEqual({ from: 8, to: 11, revision: 0 })
    expect(findNextMatch(doc, q, doc.length)).toEqual({ from: 0, to: 3, revision: 0 })
    expect(findNextMatch(doc, q, 4)).toEqual({ from: 8, to: 11, revision: 0 })
  })

  it("finds previous matches and wraps", () => {
    const doc = Text.of(["one two one"])
    const q = request("one")
    expect(findPreviousMatch(doc, q, 11)).toEqual({ from: 8, to: 11, revision: 0 })
    expect(findPreviousMatch(doc, q, 8)).toEqual({ from: 0, to: 3, revision: 0 })
    expect(findPreviousMatch(doc, q, 0)).toEqual({ from: 8, to: 11, revision: 0 })
    expect(findPreviousMatch(Text.of(["nothing here"]), q, 4)).toBeNull()
  })

  it("matches only whole ASCII words when wholeWord is on", () => {
    const doc = Text.of(["cat category concatenate cat"])
    const all = [{ from: 0, to: doc.length }]
    expect(collectViewportMatches(doc, request("cat", { wholeWord: true }), all).map((m) => m.from)).toEqual(
      [0, 25],
    )
    expect(collectViewportMatches(doc, request("cat"), all)).toHaveLength(4)
    expect(findPreviousMatch(doc, request("cat", { wholeWord: true }), doc.length)?.from).toBe(25)
  })

  it("never blocks CJK whole-word queries", () => {
    const doc = Text.of(["中文片段中"])
    expect(collectViewportMatches(doc, request("中文", { wholeWord: true }), [{ from: 0, to: 5 }])).toEqual([
      { from: 0, to: 2, revision: 0 },
    ])
    const repeated = Text.of(["中文中文"])
    expect(
      collectViewportMatches(repeated, request("中文", { wholeWord: true }), [
        { from: 0, to: repeated.length },
      ]).map((m) => m.from),
    ).toEqual([0, 2])
  })

  it("skips zero-length regex matches and ignores invalid patterns", () => {
    const doc = Text.of(["abc"])
    const all = [{ from: 0, to: doc.length }]
    expect(collectViewportMatches(doc, request("x*", { regexp: true }), all)).toEqual([])
    expect(findNextMatch(doc, request("x*", { regexp: true }), 0)).toBeNull()
    expect(findPreviousMatch(doc, request("x*", { regexp: true }), doc.length)).toBeNull()
    expect(collectViewportMatches(doc, request("[", { regexp: true }), all)).toEqual([])
    expect(findNextMatch(doc, request("[", { regexp: true }), 0)).toBeNull()
  })

  it("finds regex matches case-insensitively by default", () => {
    const doc = Text.of(["a1b2"])
    const all = [{ from: 0, to: doc.length }]
    expect(collectViewportMatches(doc, request("\\d", { regexp: true }), all)).toHaveLength(2)
    expect(
      collectViewportMatches(Text.of(["ABC"]), request("abc", { regexp: true, caseSensitive: true }), [
        { from: 0, to: 3 },
      ]),
    ).toEqual([])
  })
})

describe("match cursor and viewport collection", () => {
  it("enumerates only the supplied range", () => {
    const doc = Text.of(["aa aa aa"])
    const cursor = createMatchCursor(doc, request("aa"), 4, doc.length)
    expect(cursor.next()?.from).toBe(6)
    expect(cursor.next()).toBeNull()
  })

  it("caps two supplied ranges without an implicit full-document range", () => {
    const doc = Text.of(["aa aa aa", "aa aa aa"])
    const q = request("aa")
    const ranges = [
      { from: 0, to: 8 },
      { from: 9, to: doc.length },
    ]
    expect(collectViewportMatches(doc, q, ranges, 3)).toHaveLength(3)
    expect(collectViewportMatches(doc, q, ranges)).toHaveLength(6)
    expect(collectViewportMatches(doc, q, ranges, 0)).toEqual([])
    expect(collectViewportMatches(doc, q, [])).toEqual([])
    expect(collectViewportMatches(doc, q, [{ from: 0, to: 5 }]).map((m) => m.from)).toEqual([0, 3])
  })
})

describe("matchStillValid", () => {
  it("rejects stale revisions, out-of-range and text-mismatched matches", () => {
    const doc = Text.of(["needle here"])
    const q = request("needle")
    const match = found(findNextMatch(doc, q, 0))
    expect(matchStillValid(doc, q, match)).toBe(true)
    expect(matchStillValid(doc, request("needle", { revision: 1 }), match)).toBe(false)
    expect(matchStillValid(Text.of(["needle her3"]), q, match)).toBe(true)
    expect(matchStillValid(Text.of(["n33dle here"]), q, match)).toBe(false)
    expect(matchStillValid(doc, q, { from: 2, to: 99, revision: 0 })).toBe(false)
    expect(matchStillValid(doc, q, { from: 4, to: 4, revision: 0 })).toBe(false)
  })
})

describe("search revision field", () => {
  it("starts at zero and increments once per doc-changing transaction", () => {
    expect(currentSearchRevision(EditorState.create({ doc: "abc" }))).toBe(0)
    const initial = EditorState.create({ doc: "abc", extensions: [searchRevisionField] })
    expect(currentSearchRevision(initial)).toBe(0)
    const inserted = initial.update({ changes: { from: 0, insert: "x" } }).state
    expect(currentSearchRevision(inserted)).toBe(1)
    const selected = inserted.update({ selection: { anchor: 1 } }).state
    expect(currentSearchRevision(selected)).toBe(1)
    const multi = selected.update({
      changes: [
        { from: 0, insert: "a" },
        { from: 2, insert: "b" },
      ],
    }).state
    expect(currentSearchRevision(multi)).toBe(2)
    const reconfigured = multi.update({ effects: [] }).state
    expect(currentSearchRevision(reconfigured)).toBe(2)
  })
})

describe("previous windowing", () => {
  it("starts near the 100 MiB tail instead of the document start", () => {
    const fixture = buildSearchFixture("normal-100m")
    const { doc, calls } = guardText(fixture.text)
    const anchor = fixture.text.length
    const match = found(findPreviousMatch(doc, request(NEEDLE), anchor))
    expect(match).toEqual({
      from: fixture.expectedLiteralOffsets[fixture.expectedLiteralOffsets.length - 1],
      to: fixture.expectedLiteralOffsets[fixture.expectedLiteralOffsets.length - 1] + NEEDLE.length,
      revision: 0,
    })
    expect(calls.ranges).toEqual([[anchor - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS, anchor]])
    expect(calls.ranges.some(([from, to]) => from === 0 && to === anchor)).toBe(false)
    expect(calls.stringify).toBe(0)
    expect(calls.slices.some(([from, to]) => from === 0 && to === fixture.text.length)).toBe(false)
  })

  it("expands only the newly exposed left interval plus a needle overlap", () => {
    const anchor = 2 * MIB
    const hitAt = anchor - (MIB + 512 * KIB)
    const plain = textWithHits(anchor, [hitAt])
    const { doc, calls } = guardText(plain)
    const overlap = NEEDLE.length - 1
    const match = found(findPreviousMatch(doc, request(NEEDLE), anchor))
    expect(match).toEqual({ from: hitAt, to: hitAt + NEEDLE.length, revision: 0 })
    expect(calls.ranges).toEqual([
      [anchor - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS, anchor],
      [anchor - 512 * KIB, anchor - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS + overlap],
      [anchor - MIB, anchor - 512 * KIB + overlap],
      [0, anchor - MIB + overlap],
    ])
    expect(calls.stringify).toBe(0)
  })

  it("never rescans the collapsed prefix when no match exists", () => {
    const stop = 4 * MIB
    const { doc, calls } = guardText(textWithHits(stop, []))
    expect(findPreviousMatch(doc, request(NEEDLE), stop)).toBeNull()
    const scanned = calls.ranges.reduce((sum, [from, to]) => sum + (to - from), 0)
    // Each expansion may look back only `NEEDLE.length - 1` chars into text it already scanned.
    expect(scanned).toBeLessThanOrEqual(stop + calls.ranges.length * (NEEDLE.length - 1))
    expect(calls.stringify).toBe(0)
  })

  it("windows a one-character literal instead of rescanning cumulatively", () => {
    const stop = 4 * MIB
    const { doc, calls } = guardText(Text.of(["y".repeat(stop)]))
    expect(findPreviousMatch(doc, request("x"), stop)).toBeNull()
    // Zero overlap, but still one window per newly exposed left interval.
    expect(calls.ranges).toEqual([
      [stop - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS, stop],
      [stop - 512 * KIB, stop - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS],
      [stop - MIB, stop - 512 * KIB],
      [stop - 2 * MIB, stop - MIB],
      [0, stop - 2 * MIB],
    ])
    expect(calls.stringify).toBe(0)
  })

  it("finds a decomposed literal straddling a window boundary", () => {
    const boundary = PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS
    const length = 2 * boundary
    // Query `é` normalizes (NFKD) to two code units, so it can match the decomposed
    // source pair `e` + U+0301 across the first/second window boundary.
    const doc = Text.of(["x".repeat(boundary - 1) + "e\u0301" + "x".repeat(length - boundary - 1)])
    const expected = { from: boundary - 1, to: boundary + 1, revision: 0 }
    expect(findPreviousMatch(doc, request("\u00e9", { caseSensitive: true }), length)).toEqual(expected)
    expect(findPreviousMatch(doc, request("\u00c9"), length)).toEqual(expected)
  })

  it("wraps from the document end without rescanning earlier wrap windows", () => {
    const length = 4 * MIB
    const anchor = MIB
    const hitAt = 3 * MIB
    const overlap = NEEDLE.length - 1
    const { doc, calls } = guardText(textWithHits(length, [hitAt]))
    const match = found(findPreviousMatch(doc, request(NEEDLE), anchor))
    expect(match).toEqual({ from: hitAt, to: hitAt + NEEDLE.length, revision: 0 })
    expect(calls.ranges).toEqual([
      [anchor - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS, anchor],
      [anchor - 512 * KIB, anchor - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS + overlap],
      [0, anchor - 512 * KIB + overlap],
      [length - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS, length],
      [length - 512 * KIB, length - PREVIOUS_SEARCH_INITIAL_WINDOW_CHARS + overlap],
      [length - MIB, length - 512 * KIB + overlap],
    ])
    expect(calls.stringify).toBe(0)
    expect(calls.slices.some(([from, to]) => from === 0 && to === length)).toBe(false)
  })

  it("keeps regex previous search correct across windows", () => {
    const length = 2 * MIB
    const hitAt = 512 * KIB
    const { doc, calls } = guardText(textWithHits(length, [hitAt]))
    const match = found(findPreviousMatch(doc, request("ne+dle", { regexp: true }), length))
    expect(match).toEqual({ from: hitAt, to: hitAt + NEEDLE.length, revision: 0 })
    expect(calls.stringify).toBe(0)
    expect(calls.slices.some(([from, to]) => from === 0 && to === length)).toBe(false)
  })

  it("navigates a 100 MiB document without materializing it", () => {
    const fixture = buildSearchFixture("normal-100m")
    const { doc, calls } = guardText(fixture.text)
    const q = request(NEEDLE, { wholeWord: true })
    expect(found(findNextMatch(doc, q, 0)).from).toBe(fixture.expectedLiteralOffsets[0])
    expect(found(findNextMatch(doc, q, fixture.text.length)).from).toBe(
      fixture.expectedLiteralOffsets[0],
    )
    expect(found(findPreviousMatch(doc, q, fixture.text.length)).from).toBe(
      fixture.expectedLiteralOffsets[fixture.expectedLiteralOffsets.length - 1],
    )
    expect(found(findPreviousMatch(doc, q, 0)).from).toBe(
      fixture.expectedLiteralOffsets[fixture.expectedLiteralOffsets.length - 1],
    )
    expect(collectViewportMatches(doc, q, [{ from: fixture.text.length - 300 * KIB, to: fixture.text.length }])).toHaveLength(4)
    expect(calls.stringify).toBe(0)
    expect(calls.slices.some(([from, to]) => from === 0 && to === fixture.text.length)).toBe(false)
  })
})

function specOf(spec: TransactionSpec | null): TransactionSpec {
  expect(spec).not.toBeNull()
  return spec as TransactionSpec
}

interface ChangeSpecItem {
  readonly from: number
  readonly to?: number
  readonly insert?: string | Text
}

function resultOf(result: ReplaceAllResult | null): ReplaceAllResult {
  expect(result).not.toBeNull()
  return result as ReplaceAllResult
}

function stateAt(doc: string, head = 0): EditorState {
  return EditorState.create({ doc, selection: { anchor: head } })
}
function applied(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update(spec).state
}

describe("replaceCurrentSpec", () => {
  it("replaces a valid active match and selects the inserted text", () => {
    const state = stateAt("one two one")
    const spec = specOf(
      replaceCurrentSpec(state, request("one"), { from: 8, to: 11, revision: 0 }, "X"),
    )
    const next = applied(state, spec)
    expect(next.doc.toString()).toBe("one two X")
    expect(next.selection.main.from).toBe(8)
    expect(next.selection.main.to).toBe(9)
  })

  it("falls back to the next match from the selection head for unusable active matches", () => {
    const doc = "one two one"
    const stale = specOf(
      replaceCurrentSpec(stateAt(doc), request("one"), { from: 8, to: 11, revision: 7 }, "Z"),
    )
    expect(applied(stateAt(doc), stale).doc.toString()).toBe("Z two one")

    const missing = specOf(replaceCurrentSpec(stateAt(doc, 4), request("one"), null, "Z"))
    expect(applied(stateAt(doc, 4), missing).doc.toString()).toBe("one two Z")

    const outOfRange = specOf(
      replaceCurrentSpec(stateAt(doc), request("one"), { from: 0, to: 99, revision: 0 }, "Z"),
    )
    expect(applied(stateAt(doc), outOfRange).doc.toString()).toBe("Z two one")

    const mismatched = specOf(
      replaceCurrentSpec(stateAt(doc, 4), request("one"), { from: 4, to: 7, revision: 0 }, "Z"),
    )
    expect(applied(stateAt(doc, 4), mismatched).doc.toString()).toBe("one two Z")
  })

  it("returns null when no match is usable", () => {
    const state = stateAt("nothing here")
    expect(replaceCurrentSpec(state, request("one"), null, "X")).toBeNull()
    expect(replaceCurrentSpec(state, request(""), null, "X")).toBeNull()
    expect(replaceCurrentSpec(stateAt("abc"), request("[", { regexp: true }), null, "X")).toBeNull()
    expect(replaceCurrentSpec(stateAt("abc"), request("x*", { regexp: true }), null, "X")).toBeNull()
  })

  it("keeps literal replacements literal", () => {
    const state = stateAt("price 5")
    const spec = specOf(replaceCurrentSpec(state, request("price"), null, "$&"))
    expect(applied(state, spec).doc.toString()).toBe("$& 5")
    const context = specOf(replaceCurrentSpec(state, request("price"), null, "$`$'"))
    expect(applied(state, context).doc.toString()).toBe("$`$' 5")
  })

  it("expands regex capture references", () => {
    const state = stateAt("abc123")
    const spec = specOf(
      replaceCurrentSpec(state, request("(\\w+?)(\\d+)", { regexp: true }), null, "$2-$1"),
    )
    const next = applied(state, spec)
    expect(next.doc.toString()).toBe("123-abc")
    expect(next.selection.main.from).toBe(0)
    expect(next.selection.main.to).toBe(7)
  })

  it("replaces the active regex range once it is validated", () => {
    const state = stateAt("abc123 tail")
    const spec = specOf(
      replaceCurrentSpec(state, request("(\\w+?)(\\d+)", { regexp: true }), { from: 0, to: 6, revision: 0 }, "<$1>"),
    )
    expect(applied(state, spec).doc.toString()).toBe("<abc> tail")
  })

  it("expands $$ / $& and numeric captures including the two-digit fallback", () => {
    const state = stateAt("abc123")
    const spec = specOf(
      replaceCurrentSpec(state, request("(\\w+?)(\\d+)", { regexp: true }), null, "$$$1-$2-$12"),
    )
    const next = applied(state, spec)
    expect(next.doc.toString()).toBe("$abc-123-abc2")
    expect(next.selection.main.from).toBe(0)
    expect(next.selection.main.to).toBe("$abc-123-abc2".length)
  })

  it("keeps unsupported prefix and suffix references literal", () => {
    const state = stateAt("one two three")
    const insert = "[$`|$'|two]"
    const spec = specOf(
      replaceCurrentSpec(state, request("two", { regexp: true }), null, "[$`|$'|$&]"),
    )
    const next = applied(state, spec)
    expect(next.doc.toString()).toBe(`one ${insert} three`)
    expect(next.selection.main.from).toBe(4)
    expect(next.selection.main.to).toBe(4 + insert.length)
  })

  it("keeps named-group references literal in regex replacements", () => {
    const state = stateAt("abc def")
    const spec = specOf(
      replaceCurrentSpec(state, request("(?<word>\\w+)", { regexp: true }), null, "<[$<word>]>"),
    )
    expect(applied(state, spec).doc.toString()).toBe("<[$<word>]> def")
  })

  it("never slices document prefix or suffix for unsupported references", () => {
    const source = "alpha b beta"
    const plain = Text.of([source])
    const { doc, calls } = guardText(plain)
    const state = EditorState.create({ doc, selection: { anchor: 0 } })
    const spec = specOf(replaceCurrentSpec(state, request("b", { regexp: true }), null, "[$`$']"))
    const insert = (spec.changes as { readonly insert?: string | Text }).insert
    expect(typeof insert).toBe("string")
    expect(calls.textSlices).toEqual([])
    expect(calls.slices).not.toContainEqual([0, 6])
    expect(calls.slices).not.toContainEqual([7, source.length])
    expect(calls.stringify).toBe(0)
    expect(plain.toString()).toBe(source)
    expect(applied(state, spec).doc.toString()).toBe("alpha [$`$'] beta")
    expect(calls.stringify).toBe(0)
  })
})

describe("buildReplaceAll", () => {
  it("produces one exact changeset without touching the source text", () => {
    const doc = Text.of(["one two one"])
    const result = resultOf(buildReplaceAll(doc, request("one"), "X"))
    expect(result.replacements).toBe(2)
    expect(result.revision).toBe(0)
    expect(doc.toString()).toBe("one two one")
    expect(EditorState.create({ doc }).update({ changes: result.changes }).state.doc.toString()).toBe(
      "X two X",
    )
  })

  it("keeps literal replacement text literal and expands regex captures", () => {
    const literal = resultOf(buildReplaceAll(Text.of(["one two"]), request("one"), "$&"))
    expect(EditorState.create({ doc: Text.of(["one two"]) }).update({ changes: literal.changes }).state.doc.toString()).toBe(
      "$& two",
    )
    const regex = resultOf(
      buildReplaceAll(Text.of(["a1 b2"]), request("(\\w)(\\d)", { regexp: true }), "$2$1"),
    )
    expect(regex.replacements).toBe(2)
    expect(EditorState.create({ doc: Text.of(["a1 b2"]) }).update({ changes: regex.changes }).state.doc.toString()).toBe(
      "1a 2b",
    )
  })

  it("keeps unsupported prefix and suffix references literal in every replacement", () => {
    const plain = Text.of(["x y z"])
    const result = resultOf(buildReplaceAll(plain, request(" ", { regexp: true }), "[$`|$']"))
    expect(result.replacements).toBe(2)
    expect(EditorState.create({ doc: plain }).update({ changes: result.changes }).state.doc.toString()).toBe(
      "x[$`|$']y[$`|$']z",
    )
  })

  it("keeps a many-match unsupported-token replace-all bounded and string-only", () => {
    const total = 2000
    const source = "aa ".repeat(total)
    const plain = Text.of([source])
    const { doc, calls } = guardText(plain)
    const ofSpy = vi.spyOn(ChangeSet, "of")
    let result: ReplaceAllResult | null = null
    let specs: readonly ChangeSpecItem[] = []
    try {
      result = buildReplaceAll(doc, request("a+", { regexp: true }), "[$`$']")
      specs = (ofSpy.mock.calls[0]?.[0] ?? []) as readonly ChangeSpecItem[]
    } finally {
      ofSpy.mockRestore()
    }
    expect(resultOf(result).replacements).toBe(total)
    expect(specs).toHaveLength(total)
    for (const spec of specs) expect(typeof spec.insert).toBe("string")
    expect(calls.textSlices).toEqual([])
    expect(calls.stringify).toBe(0)
    expect(plain.toString()).toBe(source)
    const applied = EditorState.create({ doc: plain })
      .update({ changes: resultOf(result).changes })
      .state.doc.toString()
    expect(applied).toBe("[$`$'] ".repeat(total))
    expect(calls.stringify).toBe(0)
  })

  it("is a no-op for invalid and zero-length patterns", () => {
    expect(buildReplaceAll(Text.of(["abc"]), request("", {}), "X")).toBeNull()
    expect(buildReplaceAll(Text.of(["abc"]), request("[", { regexp: true }), "X")).toBeNull()
    expect(buildReplaceAll(Text.of(["abc"]), request("x*", { regexp: true }), "X")).toBeNull()
    expect(buildReplaceAll(Text.of(["abc"]), request("zzz"), "X")).toBeNull()
  })

  it("replaces every match even past the 10,000 display cap", () => {
    const total = 10_001
    const doc = Text.of(["aa ".repeat(total)])
    const { doc: guarded, calls } = guardText(doc)
    let published: SearchCount | null = null
    const scheduler: SearchScheduler = {
      now: () => 0,
      schedule(run) {
        run()
        return () => {}
      },
    }
    startSearchCount(guarded, request("aa"), scheduler, (count) => {
      published = count
    })
    expect(published).toEqual({ count: 10_000, complete: false, revision: 0 })

    const result = resultOf(buildReplaceAll(guarded, request("aa"), "bb"))
    expect(result.replacements).toBe(total)
    expect(doc.toString()).toBe("aa ".repeat(total))
    expect(calls.stringify).toBe(0)
    expect(EditorState.create({ doc }).update({ changes: result.changes }).state.doc.toString()).toBe(
      "bb ".repeat(total),
    )
  })
})
