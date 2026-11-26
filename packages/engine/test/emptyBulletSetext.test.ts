import { syntaxTree } from "@codemirror/language"
import { describe, expect, it } from "vitest"
import { makeState } from "./helpers"
import { collectDecorationSpecs } from "../src/decorations/build"
import { deleteEmptyTopLevelListSpec } from "../src/format/lists"
import { collectOutline } from "../src/outline"
import { exportHtml, exportRichHtml } from "../src/export/html"

function topBlockNames(doc: string): string[] {
  const state = makeState(doc)
  const names: string[] = []
  for (let child = syntaxTree(state).topNode.firstChild; child; child = child.nextSibling) {
    names.push(child.name)
  }
  return names
}

describe("empty bullet item directly under a paragraph", () => {
  it("parses '- ', '* ', and '+ ' immediately under a paragraph as a BulletList instead of Setext/Paragraph", () => {
    for (const marker of ["- ", "* ", "+ ", "-\t", "  -  "]) {
      const doc = `dasfdas\n${marker}`
      const state = makeState(doc, [], { anchor: doc.length })
      expect(topBlockNames(doc)).toEqual(["Paragraph", "BulletList"])

      const tags = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
      expect(tags).toContain("replace:ListMark")
      expect(tags.some(t => t.includes("omd-h2"))).toBe(false)
    }
  })

  it("allows nested empty bullet items directly under a tight ordered-list paragraph", () => {
    const doc = "1. parent\n   - "
    const state = makeState(doc, [], { anchor: doc.length })
    const tags = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(tags).toContain("widget:ordered-mark")
    expect(tags).toContain("replace:ListMark")
  })

  it("keeps thematic breaks, front matter, and multi-dash Setext underlines intact", () => {
    expect(topBlockNames("---\ntitle: demo\n---")).toEqual(["FrontMatter"])
    expect(topBlockNames("para\n\n---")).toEqual(["Paragraph", "HorizontalRule"])
    expect(topBlockNames("para\n- - -")).toEqual(["Paragraph", "HorizontalRule"])
    expect(topBlockNames("para\n* * *")).toEqual(["Paragraph", "HorizontalRule"])
    expect(topBlockNames("Title\n---")).toEqual(["SetextHeading2"])
  })

  it("reproduces Bug 1: backspacing through a bullet list under a paragraph never hijacks the paragraph into H2", () => {
    const initial = "### Dashcam_NVP thread\n\nnvp的启动时机：\n- fdas\n- "
    let state = makeState(initial, [], { anchor: initial.length })

    // Step 1: Backspace on the trailing empty `- ` exits the empty item.
    const exitSecond = deleteEmptyTopLevelListSpec(state)
    expect(exitSecond).not.toBeNull()
    state = state.update(exitSecond!).state
    expect(state.doc.toString()).toBe("### Dashcam_NVP thread\n\nnvp的启动时机：\n- fdas\n")

    // Step 2: Backspace joins the empty line back to `- fdas` and deletes `f`, `d`, `a`, `s` one char at a time.
    while (state.doc.toString() !== "### Dashcam_NVP thread\n\nnvp的启动时机：\n- ") {
      const head = state.selection.main.head
      state = state.update({
        changes: { from: head - 1, to: head, insert: "" },
        selection: { anchor: head - 1 },
      }).state
      const tags = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
      expect(tags.some(t => t.includes("omd-h2"))).toBe(false)
    }

    // At `- `, the line is STILL a BulletList, so one more Backspace exits the list cleanly!
    const tagsAtEmptyBullet = collectDecorationSpecs(state, 0, state.doc.length).map(d => d.tag)
    expect(tagsAtEmptyBullet).toContain("replace:ListMark")
    expect(tagsAtEmptyBullet.some(t => t.includes("omd-h2"))).toBe(false)

    const exitFirst = deleteEmptyTopLevelListSpec(state)
    expect(exitFirst).not.toBeNull()
    state = state.update(exitFirst!).state
    expect(state.doc.toString()).toBe("### Dashcam_NVP thread\n\nnvp的启动时机：\n")
  })

  it("keeps outline and HTML export consistent with live preview on single-char '-' or '=' lines", async () => {
    const state = makeState("**nvp**的启动时机：\n-")
    expect(collectOutline(state)).toEqual([])

    const syncHtml = exportHtml(state)
    expect(syncHtml).not.toContain("<h2")
    expect(syncHtml).toContain("<p><strong>nvp</strong>的启动时机：\n-</p>")

    const richHtml = await exportRichHtml(state)
    expect(richHtml).not.toContain("<h2")
    expect(richHtml).toContain("<p><strong>nvp</strong>的启动时机：\n-</p>")
  })
})
