import { describe, expect, it } from "vitest"
import { Text } from "@codemirror/state"
import { buildTextFromChunks, createTextAssembler } from "../src/docText"

/**
 * Task 10 parity 守护：分块切行组装出的 Text 必须与 CodeMirror 的整串路径
 * `Text.of(string.split(/\r\n?|\n/))`（EditorState.create 对字符串 doc 的内部
 * 行为）完全同构。危险点是 chunk 边界落在 \r 与 \n 之间，故对每个样例串做
 * 全边界扫描（每个偏移二分、小串三分为任意双切点）+ 定长切块（逐字符是最
 * 恶劣边界）穷举。
 */
const reference = (s: string): Text => Text.of(s.split(/\r\n?|\n/))

function expectParity(s: string, chunks: readonly string[]): void {
  const built = buildTextFromChunks(chunks)
  const ref = reference(s)
  expect(chunks.join("")).toBe(s)
  expect(built.eq(ref)).toBe(true)
  expect(built.toString()).toBe(ref.toString())
  expect(built.lines).toBe(ref.lines)
  expect(built.length).toBe(ref.length)
}

/** 对 s 在每个偏移处二分、并对所有双切点三分，穷举全部 chunk 边界组合。 */
function expectParityAtEveryBoundary(s: string): void {
  for (let cut = 0; cut <= s.length; cut++) {
    expectParity(s, [s.slice(0, cut), s.slice(cut)])
  }
  for (let a = 0; a <= s.length; a++) {
    for (let b = a; b <= s.length; b++) {
      expectParity(s, [s.slice(0, a), s.slice(a, b), s.slice(b)])
    }
  }
}

/** 定长切块（size=1 即逐字符喂入：每个边界都踩在最恶劣的位置）。 */
function chunkedBy(s: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < s.length; i += size) chunks.push(s.slice(i, i + size))
  return chunks
}

const PATHOLOGICAL = [
  "",
  "a",
  "\n",
  "\r",
  "\r\n",
  "\r\r",
  "\n\r",
  "\r\n\r",
  "\r\r\n",
  "\r\n\n",
  "\n\r\n",
  "\r\n\r\n",
  "a\n",
  "a\r",
  "a\r\n",
  "\na",
  "\ra",
  "\r\na",
  "a\nb",
  "a\rb",
  "a\r\nb",
  "a\n\nb",
  "a\r\rb",
  "a\r\n\r\nb",
  "a\n\r\nb",
  "a\r\n\rb",
  "ab\ncd\ref\r\ngh",
  "line1\r\nline2\nline3\rline4",
  "# t\r\n\r\n- a\r- b\n\n```ts\r\nx()\n```\r",
  "\n\n\n\n",
  "\r\r\r\r",
  "a\n\r\r\n\nb\r",
]

describe("buildTextFromChunks parity with Text.of(string.split)", () => {
  it("matches the reference for every 2/3-chunk boundary of pathological strings", () => {
    for (const s of PATHOLOGICAL) expectParityAtEveryBoundary(s)
  })

  it("matches the reference for fixed-size chunking down to single characters", () => {
    for (const s of PATHOLOGICAL) {
      for (const size of [1, 2, 3, 5]) expectParity(s, chunkedBy(s, size))
    }
  })

  it("assembles a many-line document across interleaved chunk sizes", () => {
    const lines = Array.from({ length: 2000 }, (_, i) =>
      i % 3 === 0 ? `row ${i}\r` : i % 3 === 1 ? `row ${i}\n` : `row ${i}\r\n`)
    const s = lines.join("")
    // 混合尺寸切块（含大于 FLUSH_LINES 一次 flush 的批）再整体逐字符对照。
    const mixed: string[] = []
    let i = 0
    for (const size of [4096, 1, 777, 3, 8192, 2]) {
      if (i >= s.length) break
      mixed.push(s.slice(i, i + size))
      i += size
    }
    mixed.push(s.slice(i))
    expectParity(s, mixed)
    expectParity(s, chunkedBy(s, 1))
  })

  it("keeps a separator-free chunk tail open across chunks (cons append)", () => {
    // 单行长文档跨多个无分隔符 chunk：全部内容属同一行，finish 前不落行。
    const s = "x".repeat(5000)
    expectParity(s, chunkedBy(s, 512))
    const built = buildTextFromChunks(chunkedBy(s, 512))
    expect(built.lines).toBe(1)
    expect(built.line(1).text).toBe(s)
  })

  it("feeds through the incremental assembler identically", () => {
    const assembler = createTextAssembler()
    for (const chunk of ["alpha\r", "\nbeta\n", "gamma\r", "\r", "delta"]) assembler.push(chunk)
    expect(assembler.finish().eq(reference("alpha\r\nbeta\ngamma\r\rdelta"))).toBe(true)
  })

  it("does not let an empty chunk split a \\r\\n straddling the boundary", () => {
    // 回归：空 chunk 不得裁决 pendingCr —— "\r" + "" + "\n" 是一个 \r\n 分隔符，
    // 提前裁决会把它拆成两个分隔符、多出一个空行。
    expectParity("\r\n", ["\r", "", "\n"])
    expectParity("a\r\nb", ["a\r", "", "", "\nb"])
    expectParity("a\rb", ["a\r", "", "b"])
    expectParity("a\r\nb", ["", "a\r\nb", ""])
  })

  it("returns Text.empty for an empty stream and empty chunks", () => {
    expect(buildTextFromChunks([]).eq(Text.empty)).toBe(true)
    expect(buildTextFromChunks([""]).eq(Text.empty)).toBe(true)
    expect(buildTextFromChunks(["", "", ""]).eq(reference(""))).toBe(true)
  })

  it("keeps parity against EditorState.create's own doc materialization", async () => {
    // 直接引用 @codemirror/state（而非本地复刻正则）做端到端对照：
    // Text 构造的 state 与字符串构造的 state 必须产出同一个 doc。逐
    // PATHOLOGICAL 样例对照 —— 本地切行正则一旦偏离 CM 的 DefaultSplit，
    // 这里最先炸（单个样例串覆盖不了所有行尾组合）。
    const { EditorState } = await import("@codemirror/state")
    for (const s of PATHOLOGICAL) {
      const fromString = EditorState.create({ doc: s })
      for (const chunks of [[s], chunkedBy(s, 1), chunkedBy(s, 3)]) {
        const fromText = EditorState.create({ doc: buildTextFromChunks(chunks) })
        expect(fromText.doc.eq(fromString.doc)).toBe(true)
      }
    }
  })
})
