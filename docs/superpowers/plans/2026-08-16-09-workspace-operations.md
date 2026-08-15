# 09 Workspace Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create, rename, delete markdown files and empty dirs inside the authorized folder; Reveal in Finder.

**Architecture:** Thin Rust commands with canonicalize + workspace-root checks. FileTree context menu. Rename updates open tab paths without rereading.

**Tech Stack:** Rust, Tauri 2, React, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-08-16-09-workspace-operations-design.md`

## Global Constraints

- Paths must stay inside the authorized workspace root. Reject `..`.
- Never overwrite existing targets.
- Delete directory only if empty.
- New files are `.md` only.
- Multi-word IPC fields need serde camelCase JSON tests.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `pnpm --filter @omd/desktop test`
- Update `apps/desktop/AGENTS.md` command list.

---

### Task 1: Rust path commands

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- `create_markdown(dir, name) -> Result<String, String>`
- `create_dir(dir, name) -> Result<String, String>`
- `rename_path(from, to_name) -> Result<String, String>`
- `delete_path(path) -> Result<(), String>`

- [ ] **Step 1: cargo tests in temp dirs for create/rename/delete, reject `../x`, reject overwrite, reject non-empty dir delete**
- [ ] **Step 2: Fail**
- [ ] **Step 3: Implement with same path validation style as `list_dir`**
- [ ] **Step 4: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`**
- [ ] **Step 5: Commit** `feat: add workspace create rename and delete commands`

---

### Task 2: FileTree menu and services

**Files:**
- Modify: `apps/desktop/src/desktopServices.ts`
- Modify: `apps/desktop/src/FileTree.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/appHarness.ts`
- Create: `apps/desktop/test/FileTree.menu.test.tsx`

- [ ] **Step 1: Tests that New File / Rename / Delete invoke services and refresh listDir**
- [ ] **Step 2: Fail**
- [ ] **Step 3: Context menu + confirm delete via `confirmClose` or `window.confirm` through services**
- [ ] **Step 4: Desktop tests pass**
- [ ] **Step 5: Commit** `feat: manage files from the sidebar menu`

Update `docs/manual-qa.md` and `apps/desktop/AGENTS.md`.
