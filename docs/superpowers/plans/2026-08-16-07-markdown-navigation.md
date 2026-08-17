# 07 Markdown Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click footnotes to jump, click local `.md` links to open tabs.

**Architecture:** Engine classifies links and resolves footnote positions. Desktop `activateLink` opens markdown files via existing `openFile`. Last footnote jump is stored on the EditorView via a `StateField`.

**Tech Stack:** TypeScript, CodeMirror 6, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-07-markdown-navigation-design.md`

## Global Constraints

- Engine must not import React or Tauri.
- No wikilinks. Missing local files error; do not create them.
- Keep `#` heading and `http(s)` / `mailto:` behavior.
- `pnpm test` and `pnpm --filter @omd/desktop test`.

---

### Task 1: classifyLink and footnote lookups

**Files:**
- Modify: `packages/engine/src/links.ts`
- Create: `packages/engine/src/footnotesNav.ts` (or extend `links.ts`)
- Create: `packages/engine/test/navigation.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces: `classifyLink`, `footnoteAt`, `footnoteDefinitionPosition`, `footnoteReferencePosition`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest"
import { EditorState } from "@codemirror/state"
import { classifyLink, footnoteAt, footnoteDefinitionPosition } from "../src/index"
import { editorExtensions } from "../src/index"

function md(doc: string) {
  return EditorState.create({ doc, extensions: editorExtensions() })
}

it("classifies hrefs", () => {
  expect(classifyLink("https://a.com").kind).toBe("external")
  expect(classifyLink("notes/a.md").kind).toBe("markdown")
  expect(classifyLink("./a.markdown#x").kind).toBe("markdown")
  expect(classifyLink("pic.png").kind).toBe("other")
})

it("finds footnote definition", () => {
  const s = md("Hi[^a]\n\n[^a]: note")
  const ref = footnoteAt(s, 3)
  expect(ref?.kind).toBe("reference")
  expect(footnoteDefinitionPosition(s, "a")).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run vitest, expect fail**
- [ ] **Step 3: Implement lookups using Lezer `FootnoteReference` / `FootnoteDefinition`**
- [ ] **Step 4: `pnpm test` pass**
- [ ] **Step 5: Commit** `feat: resolve footnote and local markdown targets`

---

### Task 2: activateLink host callback

**Files:**
- Modify: `apps/desktop/src/Editor.ts`
- Create or modify: `apps/desktop/test/Editor.test.ts`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- `CreateEditorOptions.onOpenMarkdownHref?: (href: string) => void`
- Footnote click handled inside Editor without host.

- [ ] **Step 1: Test `activateLink` calls `onOpenMarkdownHref` for `a.md` and `window.open` for `https://`**
- [ ] **Step 2: Fail**
- [ ] **Step 3: Implement; App resolves href against `sessionPath` dirname and `openFile`**
- [ ] **Step 4: Desktop tests pass**
- [ ] **Step 5: Commit** `feat: open local markdown links and jump footnotes`

Update `docs/manual-qa.md`.
