# 06 Core Writing Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship document find/replace, CJK-aware stats, working spellcheck, and list Enter/Tab continuation without enabling generic `indentOnInput`.

**Architecture:** Engine owns `documentStats` and list transactions. Desktop owns find UI, shortcut remapping (`⌘F` document, `⇧⌘F` folder), and `spellcheck` content attributes. Find is literal string match over the CodeMirror document.

**Tech Stack:** TypeScript, CodeMirror 6, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-06-core-writing-experience-design.md`

## Global Constraints

- Engine must not import React or Tauri.
- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion`.
- Do not change ordered-list normalization.
- `⌘F` opens document find; `⇧⌘F` opens folder search.
- Stats: Latin/digit runs = 1 word; each Han/Hiragana/Katakana/Hangul syllable = 1 word.
- Spellcheck is the WebView `spellcheck` attribute only.
- Desktop tests: `pnpm --filter @omd/desktop test`. Engine tests: `pnpm test`.
- Commit messages: `<type>: <why>` with no `Co-authored-by` trailer written by hooks (hook strips it).
- Do not edit unrelated dirty files (`imagePaste.ts`, engine decoration files already modified on this branch).

---

### Task 1: documentStats

**Files:**
- Create: `packages/engine/src/stats.ts`
- Create: `packages/engine/test/stats.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces: `documentStats(text: string): { readonly words: number; readonly chars: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { documentStats } from "../src/stats"

describe("documentStats", () => {
  it("counts latin words and trimmed chars", () => {
    expect(documentStats("  hello world  ")).toEqual({ words: 2, chars: 11 })
  })
  it("counts each CJK character as a word", () => {
    expect(documentStats("中文测试")).toEqual({ words: 4, chars: 4 })
  })
  it("mixes CJK and latin", () => {
    expect(documentStats("写 hello 文档")).toEqual({ words: 4, chars: 10 })
  })
  it("empty is zero", () => {
    expect(documentStats("   ")).toEqual({ words: 0, chars: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omd/engine exec vitest run test/stats.test.ts`

Expected: FAIL because `../src/stats` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u
const LATIN = /[A-Za-z0-9]+/g

export interface DocumentStats {
  readonly words: number
  readonly chars: number
}

export function documentStats(text: string): DocumentStats {
  const trimmed = text.trim()
  if (!trimmed) return { words: 0, chars: 0 }
  let words = 0
  for (const ch of trimmed) {
    if (CJK.test(ch)) words += 1
  }
  const withoutCjk = trimmed.replace(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu, " ")
  const latin = withoutCjk.match(LATIN)
  words += latin?.length ?? 0
  return { words, chars: trimmed.length }
}
```

Export `documentStats` and `DocumentStats` from `packages/engine/src/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @omd/engine exec vitest run test/stats.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/stats.ts packages/engine/test/stats.test.ts packages/engine/src/index.ts
git commit -m "feat: count CJK-aware document stats"
```

---

### Task 2: list continuation commands

**Files:**
- Create: `packages/engine/src/format/lists.ts`
- Create: `packages/engine/test/list-continue.test.ts`
- Modify: `packages/engine/src/format/commands.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Consumes: `EditorState` from `@codemirror/state`
- Produces: `continueList`, `indentList`, `outdentList` as `Command`; `listKeymap`

- [ ] **Step 1: Write the failing test**

Use `makeState` from `packages/engine/test/helpers.ts`.

```ts
import { EditorState } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import { continueListSpec, indentListSpec, outdentListSpec } from "../src/format/lists"

function state(doc: string, head: number) {
  return EditorState.create({ doc, selection: { anchor: head } })
}

describe("continueListSpec", () => {
  it("continues an unordered item", () => {
    const s = state("- hello", 7)
    const spec = continueListSpec(s)
    expect(spec?.changes).toEqual({ from: 7, to: 7, insert: "\n- " })
  })
  it("exits an empty unordered item", () => {
    const s = state("- hello\n- ", 10)
    const spec = continueListSpec(s)
    expect(spec).toBeTruthy()
    const next = s.update(spec!)
    expect(next.state.doc.toString()).toBe("- hello\n")
  })
  it("continues an ordered item with next number", () => {
    const s = state("1. a\n2. b", 9)
    const spec = continueListSpec(s)
    expect(spec).toBeTruthy()
    const next = s.update(spec!)
    expect(next.state.doc.toString()).toBe("1. a\n2. b\n3. ")
  })
  it("continues a task item with empty checkbox", () => {
    const s = state("- [x] done", 10)
    const next = s.update(continueListSpec(s)!)
    expect(next.state.doc.toString()).toBe("- [x] done\n- [ ] ")
  })
  it("returns null outside lists", () => {
    expect(continueListSpec(state("hello", 5))).toBeNull()
  })
})

describe("indentListSpec", () => {
  it("indents two spaces", () => {
    const s = state("- a", 3)
    const next = s.update(indentListSpec(s)!)
    expect(next.state.doc.toString()).toBe("  - a")
  })
  it("outdents two spaces", () => {
    const s = state("  - a", 5)
    const next = s.update(outdentListSpec(s)!)
    expect(next.state.doc.toString()).toBe("- a")
  })
})
```

Export the spec functions from `lists.ts` (not only Commands) so tests stay headless.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @omd/engine exec vitest run test/list-continue.test.ts`

Expected: FAIL missing module.

- [ ] **Step 3: Write minimal implementation**

Detect list prefix with:

```ts
const LINE = /^(\s*)(> )*([-*+]|\d+[.)])( \[[ xX]\])?(\s|$)/
```

`continueListSpec`: if line matches and the text after marker is empty, delete from line.from to line.to (and the preceding newline if any); else insert `\n` + same indent + next marker. Ordered next number = current + 1. Task always continues as ` [ ]`.

`indentListSpec` / `outdentListSpec`: only if LINE matches; insert or remove two spaces at line.from.

Add to `markdownKeymap` or a sibling `listKeymap` in `editorExtensions`:

```ts
{ key: "Enter", run: continueList }
{ key: "Tab", run: indentList }
{ key: "Shift-Tab", run: outdentList }
```

Commands return false when spec is null so default keymap runs.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @omd/engine exec vitest run test/list-continue.test.ts`

Expected: PASS. Then `pnpm test` for engine suite.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/format/lists.ts packages/engine/test/list-continue.test.ts packages/engine/src/format/commands.ts packages/engine/src/index.ts
git commit -m "feat: continue and indent lists from the keyboard"
```

---

### Task 3: find/replace model

**Files:**
- Create: `apps/desktop/src/findReplace.ts`
- Create: `apps/desktop/test/findReplace.test.ts`

**Interfaces:**
- Produces: `collectMatches`, `nextIndex`, `prevIndex`, `replaceAll`

```ts
export function collectMatches(doc: string, query: string, caseSensitive: boolean): readonly { from: number; to: number }[]
export function nextIndex(count: number, current: number): number
export function prevIndex(count: number, current: number): number
export function replaceAll(doc: string, query: string, replacement: string, caseSensitive: boolean): string
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { collectMatches, nextIndex, prevIndex, replaceAll } from "../src/findReplace"

describe("collectMatches", () => {
  it("finds overlapping-safe literal matches", () => {
    expect(collectMatches("aaa", "aa", false)).toEqual([
      { from: 0, to: 2 },
    ])
  })
  it("honors case sensitivity", () => {
    expect(collectMatches("Ab", "ab", false)).toHaveLength(1)
    expect(collectMatches("Ab", "ab", true)).toHaveLength(0)
  })
  it("empty query is empty", () => {
    expect(collectMatches("abc", "", false)).toEqual([])
  })
})

describe("index wrap", () => {
  it("wraps next and prev", () => {
    expect(nextIndex(3, 2)).toBe(0)
    expect(prevIndex(3, 0)).toBe(2)
    expect(nextIndex(0, 0)).toBe(0)
  })
})

describe("replaceAll", () => {
  it("replaces every non-overlapping match", () => {
    expect(replaceAll("foo foo", "foo", "bar", true)).toBe("bar bar")
  })
})
```

Non-overlapping: after a match, continue at `to`.

- [ ] **Step 2: Run to verify fail**

`pnpm --filter @omd/desktop test test/findReplace.test.ts`

- [ ] **Step 3: Implement `findReplace.ts`**

- [ ] **Step 4: Run to verify pass**

- [ ] **Step 5: Commit**

`feat: add literal find and replace helpers`

---

### Task 4: FindReplaceBar and App wiring

**Files:**
- Create: `apps/desktop/src/FindReplaceBar.tsx`
- Create: `apps/desktop/test/FindReplaceBar.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/StatusBar.tsx`
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/src/FileTree.tsx`
- Modify: `apps/desktop/src/commands.ts` (only if needed)
- Modify: `apps/desktop/test/App.test.tsx` and harness as required
- Modify: `docs/guides/keyboard-shortcuts.md`
- Modify: `docs/manual-qa.md`

**Interfaces:**
- Consumes: `collectMatches`, `documentStats`, `UserSettings.spellcheck`
- `CreateEditorOptions` adds `spellcheck?: boolean`
- `editorExtensions` unchanged

- [ ] **Step 1: Write failing UI tests**

`FindReplaceBar.test.tsx`: render with `open: true`, change query calls `onQuery`.

`App` test: dispatch `meta+f` does not set folder search open when a document find flag is used. Add a test that StatusBar receives CJK stats if you expose a testid; otherwise unit-test StatusBar new copy:

```tsx
expect(screen.getByText("4 words · 4 chars")).toBeTruthy()
```

Editor test: `createEditor` with `spellcheck: true` sets `cm-content` `spellcheck="true"`.

- [ ] **Step 2: Run tests, expect fail**

- [ ] **Step 3: Implement**

`FindReplaceBar`: query input, optional replace input, case checkbox, next/prev/replace/replace-all/close.

`App.tsx`:
- state `findOpen`, `findQuery`, `findReplace`, `findCase`, `replaceOpen`
- `⌘F` (no shift) → document find; `⇧⌘F` → existing `setSearchOpen(true)`
- `⌘H` → find + replaceOpen
- On next: `collectMatches(doc, query, case)` then `view.dispatch({ selection, scrollIntoView: true })`
- Replace current / replace all via `replaceAll` or single range `dispatch`
- StatusBar: `const stats = documentStats(doc)` pass words and chars
- FileTree kbd: `⇧⌘F`
- `createEditor` / `resetEditorDocument` pass `spellcheck: settings.spellcheck`
- `EditorState` `EditorView.contentAttributes.of({ spellcheck: options.spellcheck ? "true" : "false" })`

Command palette:
- `{ id: "find", label: "Find in document", shortcut: "⌘F", run: () => setFindOpen(true) }`
- `{ id: "search", label: "Search in folder", shortcut: "⇧⌘F", ... }`

- [ ] **Step 4: Run** `pnpm --filter @omd/desktop test` and `pnpm test`

- [ ] **Step 5: Commit**

`feat: add document find, spellcheck, and CJK status counts`

---

## Self-review

- Spec find/replace → Tasks 3–4
- Spec stats → Tasks 1, 4
- Spec spellcheck → Task 4
- Spec list keys → Task 2
- No TBD. Shortcuts match spec.
