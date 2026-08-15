# 16 Image Insert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag-drop and Insert image… reuse the existing paste write path.

**Architecture:** Extract `insertImageFile` from `imagePaste.ts`. Add drop handler and a file-input picker command. No new Rust command.

**Tech Stack:** TypeScript, CodeMirror, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-16-image-insert-design.md`

## Global Constraints

- Same MIME/size/untitled rules as paste (PNG/JPEG/WebP, 10 MiB, saved path required).
- Non-image drops must not be preventDefaulted.
- Do not invent image upload or resize.
- `pnpm --filter @omd/desktop test`.

---

### Task 1: extract insertImageFile and drop

**Files:**
- Modify: `apps/desktop/src/imagePaste.ts`
- Modify: `apps/desktop/test/imagePaste.test.ts`
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- `insertImageFile(file, view, options, mime, range?)`
- `imageDropHandler(options)` or extend existing handler with `drop`
- `pickAndInsertImage(view, options)` using `<input type="file" accept="image/png,image/jpeg,image/webp">`

- [ ] **Step 1: Tests: drop image calls writeImage; drop without image does not; untitled reports error; pick mock inserts**
- [ ] **Step 2: Fail if APIs missing**
- [ ] **Step 3: Implement; command id `insert-image`**
- [ ] **Step 4: Desktop tests pass**
- [ ] **Step 5: Commit** `feat: insert images by drop and file picker`

Update `docs/manual-qa.md`.
