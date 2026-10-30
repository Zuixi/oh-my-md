import { describe, expect, it } from "vitest"
import { parseComplexTableBlock } from "../src/parse/complexTable"

const CANONICAL_ROWSPAN = [
  "<table>",
  "<thead>",
  "<tr>",
  '<th scope="col">Stage</th>',
  '<th scope="col">Owner</th>',
  "</tr>",
  "</thead>",
  "<tbody>",
  "<tr>",
  '<td rowspan="2">Review</td>',
  "<td>Ada</td>",
  "</tr>",
  "<tr>",
  "<td>Lin</td>",
  "</tr>",
  "</tbody>",
  "</table>",
].join("\n")

describe("parseComplexTableBlock", () => {
  it("parses a canonical complex table with rowspan, colspan, scope, align, and closed inline nodes", () => {
    const src = [
      "<table>",
      "<thead>",
      "<tr>",
      '<th scope="col" colspan="2" align="center"><strong>Plan</strong> <em>&amp;</em> <kbd>Ctrl</kbd></th>',
      "</tr>",
      "</thead>",
      "<tbody>",
      "<tr>",
      '<th scope="row" rowspan="2" align="left">Phase<sub>1</sub><sup>a</sup></th>',
      '<td align="right"><del>old</del> <u>new</u> <mark>tag</mark> <code>x = 1</code><br><a href="https://example.com/docs" title="Docs">link</a> <img src="./assets/pic.png" alt="diagram" title="Cap"></td>',
      "</tr>",
      "<tr>",
      "<td>done</td>",
      "</tr>",
      "</tbody>",
      "</table>",
    ].join("\n")

    const model = parseComplexTableBlock(src)
    expect(model).toEqual({
      rows: [
        [
          {
            header: true,
            rowSpan: 1,
            colSpan: 2,
            scope: "col",
            align: "center",
            children: [
              { type: "strong", children: [{ type: "text", value: "Plan" }] },
              { type: "text", value: " " },
              { type: "emphasis", children: [{ type: "text", value: "&" }] },
              { type: "text", value: " " },
              { type: "kbd", children: [{ type: "text", value: "Ctrl" }] },
            ],
          },
        ],
        [
          {
            header: true,
            rowSpan: 2,
            colSpan: 1,
            scope: "row",
            align: "left",
            children: [
              { type: "text", value: "Phase" },
              { type: "subscript", children: [{ type: "text", value: "1" }] },
              { type: "superscript", children: [{ type: "text", value: "a" }] },
            ],
          },
          {
            header: false,
            rowSpan: 1,
            colSpan: 1,
            scope: null,
            align: "right",
            children: [
              { type: "strike", children: [{ type: "text", value: "old" }] },
              { type: "text", value: " " },
              { type: "underline", children: [{ type: "text", value: "new" }] },
              { type: "text", value: " " },
              { type: "highlight", children: [{ type: "text", value: "tag" }] },
              { type: "text", value: " " },
              { type: "code", value: "x = 1" },
              { type: "break" },
              {
                type: "link",
                href: "https://example.com/docs",
                title: "Docs",
                children: [{ type: "text", value: "link" }],
              },
              { type: "text", value: " " },
              {
                type: "image",
                src: "./assets/pic.png",
                alt: "diagram",
                title: "Cap",
              },
            ],
          },
        ],
        [
          {
            header: false,
            rowSpan: 1,
            colSpan: 1,
            scope: null,
            align: null,
            children: [{ type: "text", value: "done" }],
          },
        ],
      ],
    })
  })

  it("rejects source envelopes with blank physical lines, missing closing tags, or sibling content", () => {
    const withBlankLine = CANONICAL_ROWSPAN.replace("</thead>\n<tbody>", "</thead>\n\n<tbody>")
    const withSpacesBlankLine = CANONICAL_ROWSPAN.replace("</thead>\n<tbody>", "</thead>\n   \n<tbody>")
    const missingClose = CANONICAL_ROWSPAN.replace(/\n<\/table>$/, "")
    const trailingSibling = `${CANONICAL_ROWSPAN}\n<p>extra</p>`
    const leadingSibling = `<p>extra</p>\n${CANONICAL_ROWSPAN}`

    expect(parseComplexTableBlock(withBlankLine)).toBeNull()
    expect(parseComplexTableBlock(withSpacesBlankLine)).toBeNull()
    expect(parseComplexTableBlock(missingClose)).toBeNull()
    expect(parseComplexTableBlock(trailingSibling)).toBeNull()
    expect(parseComplexTableBlock(leadingSibling)).toBeNull()
  })

  it("rejects arbitrary HTML blocks, scripts, styles, event handlers, and disallowed attributes", () => {
    const cases = [
      "<div><table>\n<tr>\n<td>a</td>\n</tr>\n</table></div>",
      '<table class="grid">\n<tr>\n<td>a</td>\n</tr>\n</table>',
      '<table>\n<tr>\n<td style="color:red">a</td>\n</tr>\n</table>',
      '<table>\n<tr>\n<td onclick="alert(1)">a</td>\n</tr>\n</table>',
      '<table>\n<tr>\n<td data-id="1">a</td>\n</tr>\n</table>',
      "<table>\n<tr>\n<td><script>alert(1)</script></td>\n</tr>\n</table>",
      "<table>\n<tr>\n<td><style>td{color:red}</style></td>\n</tr>\n</table>",
      "<table>\n<tr>\n<td><svg><text>x</text></svg></td>\n</tr>\n</table>",
      "<table>\n<tr>\n<td><form><input></form></td>\n</tr>\n</table>",
      "<table>\n<tr>\n<td><table><tr><td>nested</td></tr></table></td>\n</tr>\n</table>",
      '<table>\n<tr>\n<td scope="row">scope on td</td>\n</tr>\n</table>',
    ]
    for (const raw of cases) {
      expect(parseComplexTableBlock(raw), raw).toBeNull()
    }
  })

  it("rejects unsafe link/image URLs and invalid span geometry", () => {
    const badUrls = [
      '<table>\n<tr>\n<td><a href="javascript:alert(1)">x</a></td>\n</tr>\n</table>',
      '<table>\n<tr>\n<td><img src="data:image/png;base64,AAAA" alt="x"></td>\n</tr>\n</table>',
      '<table>\n<tr>\n<td><img src="blob:https://example.com/1" alt="x"></td>\n</tr>\n</table>',
      '<table>\n<tr>\n<td><img src="file:///tmp/a.png" alt="x"></td>\n</tr>\n</table>',
    ]
    for (const raw of badUrls) {
      expect(parseComplexTableBlock(raw), raw).toBeNull()
    }

    const danglingRowSpan = [
      "<table>",
      "<tbody>",
      "<tr>",
      '<td rowspan="3">too tall</td>',
      "<td>ok</td>",
      "</tr>",
      "</tbody>",
      "</table>",
    ].join("\n")
    expect(parseComplexTableBlock(danglingRowSpan)).toBeNull()

    const zeroSpan = [
      "<table>",
      "<tbody>",
      "<tr>",
      '<td colspan="0">bad</td>',
      "</tr>",
      "</tbody>",
      "</table>",
    ].join("\n")
    expect(parseComplexTableBlock(zeroSpan)).toBeNull()
  })
})
