import { describe, expect, it } from "vitest"
import { parseComplexTableBlock } from "../src/parse/complexTable"
import { prepareSmartPaste } from "../src/paste/smartPaste"
import { serializePasteDocument } from "../src/paste/serialize"
import { serializeComplexTable } from "../src/paste/serializeComplexTable"

describe("serializeComplexTable", () => {
  it("serializes a rowspan/colspan table into canonical Type 6 HTML with no blank lines and htmlBlock boundary", () => {
    const html = [
      "<table>",
      '  <thead><tr><th scope="col" colspan="2">Summary</th></tr></thead>',
      "  <tbody>",
      '    <tr><td rowspan="2" style="text-align:center;color:red">Group</td><td><strong>One</strong><br><em>Two</em></td></tr>',
      '    <tr><td><a href="https://example.com">Link</a></td></tr>',
      "  </tbody>",
      "</table>",
    ].join("\n")

    const prepared = prepareSmartPaste({ html, plainText: "Summary\nGroup\tOne Two\nLink" })
    const tableBlock = prepared.document.blocks[0]
    if (tableBlock?.type !== "table") throw new Error("expected table block")

    const lowered = serializeComplexTable(tableBlock.table, {
      mode: "minimal",
      resolveAsset: () => null,
    })

    expect(lowered.boundary).toEqual({ start: "block", end: "htmlBlock" })
    expect(lowered.diagnostics).toEqual([])
    expect(lowered.text).toBe([
      "<table>",
      "<thead>",
      "<tr>",
      '<th scope="col" colspan="2">Summary</th>',
      "</tr>",
      "</thead>",
      "<tbody>",
      "<tr>",
      '<td rowspan="2" align="center">Group</td>',
      "<td><strong>One</strong><br><em>Two</em></td>",
      "</tr>",
      "<tr>",
      '<td><a href="https://example.com">Link</a></td>',
      "</tr>",
      "</tbody>",
      "</table>",
    ].join("\n"))
    expect(lowered.text).not.toMatch(/\n[ \t]*\n/)
    expect(parseComplexTableBlock(lowered.text)).not.toBeNull()
  })

  it("flattens multi-block cell content deterministically with <br> separators", () => {
    const html = [
      "<table>",
      "  <tbody>",
      '    <tr><td rowspan="2"><p>First</p><ul><li>item a</li><li>item b</li></ul></td><td>Right</td></tr>',
      "    <tr><td>Bottom</td></tr>",
      "  </tbody>",
      "</table>",
    ].join("\n")

    const prepared = prepareSmartPaste({ html, plainText: "First\nitem a\nitem b\tRight\nBottom" })
    const serialized = serializePasteDocument(prepared.document, {
      mode: "minimal",
      resolveAsset: () => null,
    })

    expect(serialized.boundary).toEqual({ start: "block", end: "htmlBlock" })
    expect(serialized.diagnostics).toEqual([])
    expect(serialized.text).toContain('<td rowspan="2">First<br>item a<br>item b</td>')
    expect(parseComplexTableBlock(serialized.text)).not.toBeNull()
  })

  it("resolves embedded image assets via resolveAsset and lowers unresolved images to escaped alt text", () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    const html = [
      "<table>",
      "  <tbody>",
      `    <tr><td colspan="2"><img src="data:image/png;base64,${base64}" alt="ok"><img src="blob:https://example.com/1" alt="missing &lt;img&gt;"></td></tr>`,
      "  </tbody>",
      "</table>",
    ].join("\n")

    const prepared = prepareSmartPaste({ html, plainText: "ok missing" })
    const key = prepared.assets[0]?.key
    expect(key).toBe("paste-embedded-1")

    const serialized = serializePasteDocument(prepared.document, {
      mode: "minimal",
      resolveAsset: k => (k === key ? "./assets/pasted.png" : null),
    })

    expect(serialized.diagnostics).toEqual([{ kind: "unresolvedAsset", count: 1 }])
    expect(serialized.text).toContain('<img src="./assets/pasted.png" alt="ok">missing &lt;img&gt;')
    expect(serialized.text).not.toContain("paste-embedded")
    expect(serialized.text).not.toContain("paste-unavailable")
    expect(parseComplexTableBlock(serialized.text)).not.toBeNull()
  })

  it("falls back to strict visible cell text when allowComplexTable is false or mode is strict", () => {
    const html = '<table><thead><tr><th scope="col">Stage</th><th scope="col">Owner</th></tr></thead><tbody><tr><td rowspan="2">Review | 1</td><td>Ada</td></tr><tr><td>Lin</td></tr></tbody></table>'
    const prepared = prepareSmartPaste({ html, plainText: "Stage\tOwner\nReview | 1\tAda\nLin" })

    const strictResult = serializePasteDocument(prepared.document, {
      mode: "strict",
      resolveAsset: () => null,
    })
    expect(strictResult.boundary).toEqual({ start: "block", end: "opaque" })
    expect(strictResult.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])
    expect(strictResult.text).toContain(String.raw`| Review \| 1 | Ada |`)

    const disallowedResult = serializePasteDocument(prepared.document, {
      mode: "minimal",
      allowComplexTable: false,
      resolveAsset: () => null,
    })
    expect(disallowedResult.boundary).toEqual({ start: "block", end: "opaque" })
    expect(disallowedResult.diagnostics).toEqual([{ kind: "unsupportedTable", count: 1 }])
  })
})
