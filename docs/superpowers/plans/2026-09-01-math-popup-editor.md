# Math Popup Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Math blocks open an in-place popup editor below the rendered formula with live KaTeX re-rendering, instead of revealing raw source; math widgets get hover highlight and pointer cursor.

**Architecture:** Identity-stable widget — `MathBlockWidget.eq()` ignores `src` and `updateDOM` re-renders KaTeX in place, so per-keystroke document dispatches never rebuild the widget DOM (popup/textarea/focus survive). A new `BlockWidget.onWrapClick` hook lets math take over click behavior while code blocks keep today's focus-only behavior.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/view@6.43.8`), KaTeX (already a dependency), Vitest + happy-dom.

**Spec:** `docs/superpowers/specs/2026-09-01-math-popup-editor-design.md`

## Global Constraints

- Engine stays framework-independent (no React/Tauri imports).
- Preserve source text: the popup dispatches explicit user-driven replacements only; no silent rewrites.
- No new dependencies.
- Keyboard entry into the block range keeps revealing source (`blockSelected` unchanged).
- Read-only documents never open the popup; dispatch guards mirror the `TableWidget.replace()` precedent.
- Styles live in `apps/desktop/src/styles.css`; engine only emits `omd-*` class names.
- Conventional commits; `.githooks/pre-commit` runs domain tests for staged paths.
- Benchmarks are advisory: no new warning *categories* allowed; pre-existing `documentStats 50k` warnings are known.

---

### Task 1: Hover highlight and pointer cursor for math widgets

**Files:**
- Modify: `apps/desktop/src/styles.css` (near the existing `.editor-host .omd-math` rule, ~line 475)

**Interfaces:**
- Consumes: existing classes `omd-math` (block widget wrap), `omd-inline-math` (inline widget span), token `--omd-code-bg`.
- Produces: visual affordance only; no code contract.

- [ ] **Step 1: Add the rules**

Near the existing `.editor-host .omd-math { overflow-x: auto; padding: 4px 0; }` rule add:

```css
.editor-host .omd-math { cursor: pointer; }
.editor-host .omd-block.omd-math:hover { background: var(--omd-code-bg); border-radius: 6px; }
.editor-host .omd-inline-math { cursor: pointer; border-radius: 4px; }
.editor-host .omd-inline-math:hover { background: var(--omd-code-bg); }
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @omd/desktop build`
Expected: PASS (CSS-only change; behavior tests unaffected).

- [ ] **Step 3: Commit**

```sh
git add apps/desktop/src/styles.css
git commit -m "feat: highlight math widgets on hover"
```

---

### Task 2: Identity-stable math widget core (mechanism, no popup UI yet)

**Files:**
- Modify: `packages/engine/src/decorations/blockWidget.ts` (mousedown branch ~line 78-90, hook near `enterSourceOnClick`)
- Modify: `packages/engine/src/decorations/widgets/math.ts`
- Test: `packages/engine/test/mathWidget.test.ts` (new)

**Interfaces:**
- Produces: protected `BlockWidget.onWrapClick(view: EditorView, wrap: HTMLElement)` hook (default calls `view.focus()`);
  exported `mathTexOf(src: string): string` and `rebuildMathSrc(src: string, tex: string): string`;
  `MathBlockWidget.eq()` comparing embed only; `MathBlockWidget.updateDOM(dom, view, from): boolean`.
- Consumes: `blockWidgetRange` from `../blockSelectionOverlay`; internal `renderMath` gains an optional `throwOnError` parameter (default `true`).

- [ ] **Step 1: Write the failing pure tests**

Create `packages/engine/test/mathWidget.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { MathBlockWidget, mathTexOf, rebuildMathSrc } from "../src/decorations/widgets/math"

describe("math source helpers", () => {
  it("extracts tex from single-line and multi-line blocks", () => {
    expect(mathTexOf("$$x+y$$")).toBe("x+y")
    expect(mathTexOf("$$\na = b\n$$")).toBe("a = b")
    expect(mathTexOf("$$ x $$")).toBe("x")
  })

  it("rebuilds preserving the original delimiter shape", () => {
    expect(rebuildMathSrc("$$a$$", "b+c")).toBe("$$b+c$$")
    expect(rebuildMathSrc("$$\na\n$$", "b\nc")).toBe("$$\nb\nc\n$$")
    // 单行形态收到多行草稿时保留单行包裹（Lezer 仍解析为 MathBlock）
    expect(rebuildMathSrc("$$a$$", "b\nc")).toBe("$$b\nc$$")
  })
})

describe("MathBlockWidget identity stability", () => {
  it("eq ignores src and compares embed only", () => {
    const a = new MathBlockWidget("$$a$$", 0)
    const b = new MathBlockWidget("$$totally different$$", 0)
    expect(a.eq(b)).toBe(true)
    const nested = new MathBlockWidget("$$a$$", 0, { quoteDepth: 1, listDepth: 0, quoteInList: false })
    expect(a.eq(nested)).toBe(false)
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @omd/engine test test/mathWidget.test.ts`
Expected: FAIL (missing exports / eq currently compares src).

- [ ] **Step 3: Implement the hook in `blockWidget.ts`**

Add near `enterSourceOnClick()`:

```ts
/** 点击不进源码的块（代码块、数学弹窗）由此钩子接管后续交互；默认保持聚焦编辑器。 */
protected onWrapClick(view: EditorView, _wrap: HTMLElement): void { view.focus() }
```

Replace the mousedown early-return body:

```ts
if (!this.enterSourceOnClick()) {
  this.onWrapClick(view, wrap)
  return
}
```

(Code blocks keep exactly today's behavior via the default hook.)

- [ ] **Step 4: Implement helpers and identity-stable eq/updateDOM in `widgets/math.ts`**

Exported helpers (top of file, above the classes):

```ts
export function mathTexOf(src: string): string {
  return src.replace(/^\$\$|\$\$\s*$/g, "").trim()
}

/** 按原分隔符形态重建块文本：原块含换行 → 多行包裹，否则单行包裹。 */
export function rebuildMathSrc(src: string, tex: string): string {
  return src.includes("\n") ? `$$\n${tex}\n$$` : `$$${tex}$$`
}
```

`renderMath` gains the parameter (existing call sites unchanged):

```ts
async function renderMath(
  el: HTMLElement,
  tex: string,
  displayMode: boolean,
  isActive: () => boolean,
  throwOnError = true,
) {
  const katex = (await import("katex")).default
  if (!isActive()) return
  el.innerHTML = katex.renderToString(tex, { displayMode, throwOnError })
}
```

`MathBlockWidget` body:

```ts
export class MathBlockWidget extends BlockWidget {
  protected get cssClass() { return "omd-math" }

  // 身份稳定契约：编辑期逐键回写改变 src，eq 忽略 src、由 updateDOM 原地
  // 同步预览，DOM/popup/焦点全部复用。RangeSet 只对位置匹配的装饰调 eq，
  // 不会跨块误复用。
  eq(other: MathBlockWidget) {
    return this.embed.quoteDepth === other.embed.quoteDepth
      && this.embed.listDepth === other.embed.listDepth
      && this.embed.quoteInList === other.embed.quoteInList
  }

  updateDOM(dom: HTMLElement, view: EditorView, _from: MathBlockWidget): boolean {
    const body = dom.querySelector<HTMLElement>(".omd-block-body")
    if (!body) return false
    // popup 打开但焦点不在输入框时，外部改动把草稿同步到最新（自己的回写不触发，
    // 因为输入中的值与新文档一致）。
    const ta = dom.querySelector<HTMLTextAreaElement>(".omd-math-editor")
    if (ta && dom.ownerDocument.activeElement !== ta && ta.value !== mathTexOf(this.src)) {
      ta.value = mathTexOf(this.src)
    }
    this.schedulePreview(dom, body, view)
    return true
  }

  private schedulePreview(dom: HTMLElement, body: HTMLElement, view: EditorView) {
    const host = dom as HTMLElement & { __omdMathRaf?: number }
    if (host.__omdMathRaf) cancelAnimationFrame(host.__omdMathRaf)
    const tex = mathTexOf(this.src)
    host.__omdMathRaf = requestAnimationFrame(() => {
      host.__omdMathRaf = 0
      if (!this.isActive(body)) return
      renderMath(body, tex, true, () => this.isActive(body), false)
        .then(() => { if (this.isActive(body)) view.requestMeasure() })
        .catch(() => { /* 编辑期预览失败保留上一次渲染，不整块消失 */ })
    })
  }

  protected renderPlaceholder(el: HTMLElement) {
    const pre = document.createElement("pre")
    pre.className = "omd-block-placeholder"
    pre.textContent = this.src
    el.appendChild(pre)
  }

  protected renderInto(el: HTMLElement) {
    return renderMath(el, mathTexOf(this.src), true, () => this.isActive(el))
  }
}
```

Note: `updateDOM` only re-renders the preview; it does not touch the popup DOM,
so focus and caret survive. The `requestMeasure` import path is already
available via `view.requestMeasure()`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @omd/engine test test/mathWidget.test.ts test/blocks.test.ts`
Expected: PASS. Also run the full engine suite to catch regressions:
`pnpm --filter @omd/engine test`.

- [ ] **Step 6: Commit**

```sh
git add packages/engine/src/decorations/blockWidget.ts \
        packages/engine/src/decorations/widgets/math.ts \
        packages/engine/test/mathWidget.test.ts
git commit -m "feat(engine): identity-stable math widget with in-place preview"
```

---

Important: Task 2 does NOT override `enterSourceOnClick`/`onWrapClick` on
`MathBlockWidget` — click behavior is unchanged until Task 3 lands the popup.

### Task 3: Popup editor with live preview

**Files:**
- Modify: `packages/engine/src/decorations/widgets/math.ts`
- Test: `packages/engine/test/mathPopup.test.ts` (new)
- Modify: `packages/engine/AGENTS.md` (widget invariants)
- Modify: `docs/manual-qa.md` (interaction change)

**Interfaces:**
- Consumes: Task 2 helpers/hook; `blockWidgetRange` from `../blockSelectionOverlay`.
- Produces: popup DOM classes `omd-math-popup`, `omd-math-editor` (styles added
  in Task 1's CSS file — see Step 5).

- [ ] **Step 1: Write the failing integration tests**

Create `packages/engine/test/mathPopup.test.ts`. Follow `test/view.test.ts`
(`makeView` + `waitFor` helpers) for real-EditorView assembly. Cases:

1. click `.omd-math` opens `.omd-math-popup` with textarea prefilled with the
   TeX (`x+y` for doc `$$\nx+y\n$$`);
2. typing into the textarea updates the document (`view.state.doc` contains the
   new tex wrapped in `$$`), keeps the SAME `.omd-math` DOM node and the SAME
   popup node (identity stability), and leaves no raw `$$` source visible in
   the editor DOM;
3. Escape removes the popup;
4. read-only view (`EditorState.readOnly.of(true)`) opens no popup;
5. undo after one typed char restores the previous tex and the widget survives.

Use `el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))`
on the `.omd-math` wrap to trigger the click (same pattern as existing
code-block click tests). Drive typing with `ta.value = ...` + `ta.dispatchEvent(new Event("input"))`.
KaTeX render is async — `await waitFor(".omd-math-popup .katex, ...")` style
polling as in `view.test.ts`.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @omd/engine test test/mathPopup.test.ts`
Expected: FAIL (no popup exists yet).

- [ ] **Step 3: Implement the popup in `MathBlockWidget`**

Add to `MathBlockWidget` (imports: `blockWidgetRange` from `../blockSelectionOverlay`):

```ts
protected enterSourceOnClick() { return false }

override ignoreEvent(event: Event) {
  return super.ignoreEvent(event)
    || event.type === "keydown" || event.type === "keyup"
    || event.type === "keypress" || event.type === "input"
    || event.type === "click"
}

protected onWrapClick(view: EditorView, wrap: HTMLElement) {
  if (view.state.readOnly) { view.focus(); return }
  const existing = wrap.querySelector<HTMLTextAreaElement>(".omd-math-editor")
  if (existing) { existing.focus(); return }
  const popup = document.createElement("div")
  popup.className = "omd-math-popup"
  const ta = document.createElement("textarea")
  ta.className = "omd-math-editor"
  ta.value = mathTexOf(this.src)
  ta.spellcheck = false
  ta.rows = Math.max(1, ta.value.split("\n").length)
  popup.appendChild(ta)
  wrap.appendChild(popup)
  ta.addEventListener("input", () => this.applyDraft(view, wrap, ta.value))
  ta.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); popup.remove(); view.focus() }
  })
  ta.addEventListener("blur", e => {
    if (e.relatedTarget instanceof Node && popup.contains(e.relatedTarget)) return
    popup.remove()
  })
  new ResizeObserver(() => view.requestMeasure()).observe(popup)
  ta.focus()
  view.requestMeasure()
}

```ts
private applyDraft(view: EditorView, wrap: HTMLElement, tex: string) {
  if (view.state.readOnly) return
  // 从文档实时取块文本：wrap 监听器属于创建它的旧实例，其 this.src 可能过期；
  // blockWidgetRange 注册的旧实例仍有效，取回范围后按文档现值重建。
  const range = blockWidgetRange(this, view, wrap)
  const src = range ? view.state.sliceDoc(range.from, range.to) : this.src
  const next = rebuildMathSrc(src, tex)
  if (next === src) return
  const from = range?.from ?? this.pos
  view.dispatch({ changes: { from, to: from + src.length, insert: next } })
}
```

The dispatch keeps the selection unchanged (it is outside the block while the
widget is mounted), so the widget stays rendered. `eq` ignoring `src` +
`updateDOM` reuses the DOM; the preview re-renders via the rAF-coalesced path.

- [ ] **Step 4: Add popup styles to desktop CSS**

Append to `apps/desktop/src/styles.css` (desktop owns presentation):

```css
.editor-host .omd-math-popup {
  margin-top: 6px; padding: 6px;
  border: 1px solid var(--omd-border); border-radius: 6px;
  background: var(--omd-code-bg);
}
.editor-host .omd-math-editor {
  width: 100%; min-height: 4em; resize: vertical;
  font-family: ui-monospace, monospace; font-size: 0.9em;
  background: transparent; color: inherit;
  border: none; outline: none;
}
```

- [ ] **Step 5: Run the full suites**

Run:
```sh
pnpm --filter @omd/engine test
pnpm --filter @omd/desktop test
```
Expected: PASS.

- [ ] **Step 6: Update docs**

- `packages/engine/AGENTS.md`: add one invariant line to the widget rules:
  `MathBlockWidget` 用身份稳定 `eq`（忽略 src）+ `updateDOM` 原地重渲；
  逐键回写文档不得重建 widget DOM。
- `docs/manual-qa.md`: record the interaction change: 点击数学块在正下方弹出
  源码编辑框并实时渲染（键盘移入仍显示源码）。

- [ ] **Step 7: Commit**

```sh
git add packages/engine/src/decorations/widgets/math.ts \
        packages/engine/test/mathPopup.test.ts \
        apps/desktop/src/styles.css \
        packages/engine/AGENTS.md docs/manual-qa.md
git commit -m "feat(engine): edit math blocks in a popup with live preview"
```

---

### Task 4: Full gate, benchmarks, and PR

Owner: controller (no subagent). Runs after Tasks 1-3 are reviewed clean.

- [ ] **Step 1: Full repository gate**

Run: `pnpm verify`
Expected: engine + desktop + cargo tests PASS, Vite build and Rust link PASS.

- [ ] **Step 2: Advisory benchmarks**

Run: `pnpm --filter @omd/engine bench`
Expected: no NEW warning categories (pre-existing `documentStats 50k` budget
lines are known and acceptable); no regressions in typing p95 families.

- [ ] **Step 3: Push and open PR**

```sh
git push -u origin <feature-branch>
gh pr create --base main --head <feature-branch> \
  --title "feat: math block popup editor with live preview" \
  --body "<summary: mechanism, behavior, test counts, bench result>"
```
