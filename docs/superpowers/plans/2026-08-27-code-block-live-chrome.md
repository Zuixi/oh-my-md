# Code Block Live Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans (or subagent-driven-development) task-by-task. TDD per `@omd/engine` AGENTS.md.

**Goal:** Typora-like live code blocks: container chrome, mandatory line numbers, hover-only fence-info toolbar, keyboard entry keeps Shiki + in-block edit, label/lang in fence info.

**Architecture:** Always mount `CodeWidget` for fenced+lang blocks; `editing` flag from `blockSelected`; hover-only header via CSS; `fenceInfo.ts` parse/format; contenteditable sync to `CodeText`.

**Tech stack:** `@omd/engine`, Shiki, CodeMirror 6, desktop `styles.css`

---

### Task 1: fence info parse/format

**Files:**
- Create: `packages/engine/src/fenceInfo.ts`
- Create: `packages/engine/test/fenceInfo.test.ts`

**Steps:** TDD `parseFenceInfo("cpp Code block")` → `{ lang: "cpp", title: "Code block" }`; `formatFenceInfo`; round-trip.

---

### Task 2: Always widget + pass meta

**Files:**
- Modify: `packages/engine/src/decorations/blocks.ts`
- Modify: `packages/engine/test/blocks.test.ts`, `blockwidgets.test.ts`

Remove `blockSelected` → line styles for lang blocks. Pass `infoFrom/infoTo`, `title`, `editing` into `CodeWidget`. Test: cursor inside → still `widget:block:code`.

---

### Task 3: CodeWidget chrome (hover header, line numbers, copy)

**Files:**
- Modify: `packages/engine/src/decorations/widgets/code.ts`
- Modify: `apps/desktop/src/styles.css`
- Optional: `apps/desktop/src/constants.ts` + drift test for `#f8f8f8` token

Header hidden by default; visible on `.omd-code:hover`. Line numbers via `.omd-code-lines .line::before`. Copy writes `this.src`.

---

### Task 4: In-widget edit (keyboard + pointer)

**Files:**
- Modify: `packages/engine/src/decorations/widgets/code.ts`
- Modify: `packages/engine/test/view.test.ts`

When `editing=true`: contenteditable plain layer or sync; dispatch to `CodeText`; auto-focus on mount; `ignoreEvent` for input/keydown. Arrow entry keeps `.omd-code` in DOM with Shiki after debounce.

---

### Task 5: Lang/title mutators

**Files:**
- Modify: `code.ts` — dispatch replace `CodeInfo` on select/change
- Test: info string updates in doc

---

### Task 6: Docs & QA

**Files:**
- `docs/manual-qa.md`, `packages/engine/AGENTS.md`, `docs/memory/known-gotchas.md` (remove「编辑态无 Shiki」)

---

## Interaction matrix (review lock-in)

| 输入 | 顶栏 | 编辑 | Shiki |
|------|------|------|-------|
| 无交互 | 隐藏 | 否 | ✓ |
| mouseenter/hover | 显示 | 点击 body 可聚焦 | ✓ |
| ↑/↓ 进入块 | 隐藏* | ✓ | ✓ |
| ⌘E Source | N/A（无 Live 装饰） | CM 源码 | N/A |

\*除非此时鼠标也在块上（`:hover`）
