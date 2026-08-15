# User Settings & Session Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement user preferences/settings (theme, font size, font family, line height, tab size, default mode, spellcheck) with a Settings modal (`⌘,`), and automatic workspace session restore (restoring folder, open tabs, and active tab on startup).

**Architecture:** Rust commands provide atomic persistence for `settings.json` and `session.json` in user config directory. React models and services load/save settings and session state. Settings apply dynamically to root CSS variables and CodeMirror editor options. Workspace changes trigger debounced session state saving.

**Tech Stack:** React 19, TypeScript 5.8, CodeMirror 6, Rust 2021, Tauri 2, Vitest 3, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-15-settings-and-session-restore-design.md`

## Global Constraints

- Engine package remains framework-independent (no React or Tauri dependencies).
- Desktop `App.tsx` remains under file-size budget; modularize settings and session restore helpers.
- All IPC payloads follow camelCase serialization contracts.
- Every task includes unit/integration tests with TDD methodology.
- Every task must be committed and pushed as requested by the user.

---

### Task 1: Rust IPC Backend for Settings and Session Persistence

**Files:**
- Modify: `apps/desktop/src-tauri/src/workspace.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces Tauri commands:
  - `get_settings() -> Result<String, String>`
  - `save_settings(contents: String) -> Result<(), String>`
  - `get_session_state() -> Result<String, String>`
  - `save_session_state(contents: String) -> Result<(), String>`

- [x] **Step 1: Write failing Rust tests in `apps/desktop/src-tauri/src/workspace.rs`**
  Add unit tests for `get_settings`, `save_settings`, `get_session_state`, and `save_session_state` verifying roundtrip and empty default handling.

- [x] **Step 2: Run `cargo test` to verify failure**

- [x] **Step 3: Implement config directory and settings/session functions in `workspace.rs`**
  Implement `config_dir()`, `read_config_file(name)`, and `write_config_file(name, contents)` using atomic write.

- [x] **Step 4: Register commands in `apps/desktop/src-tauri/src/lib.rs`**

- [x] **Step 5: Run `cargo test` to verify pass**

- [x] **Step 6: Commit and push**
  `feat(tauri): add settings and session state persistence commands`

---

### Task 2: Desktop Settings & Session State Models and DesktopServices

**Files:**
- Create: `apps/desktop/src/settings.ts`
- Create: `apps/desktop/src/sessionRestore.ts`
- Create: `apps/desktop/test/settings.test.ts`
- Create: `apps/desktop/test/sessionRestore.test.ts`
- Modify: `apps/desktop/src/desktopServices.ts`
- Modify: `apps/desktop/test/appHarness.ts`

**Interfaces:**
- Produces: `UserSettings`, `DEFAULT_SETTINGS`, `parseSettings`, `sanitizeSettings`, `extractSessionState`, `SavedSessionState`.
- Extends: `DesktopServices` with `getSettings`, `saveSettings`, `getSessionState`, `saveSessionState`.

- [x] **Step 1: Write tests for `settings.test.ts` and `sessionRestore.test.ts`**
  Validate default values, boundary clamping (e.g. fontSize 12..32, lineHeight 1.2..2.4), and session extraction from workspace.

- [x] **Step 2: Run tests to verify failure**
  `pnpm --filter @omd/desktop test test/settings.test.ts test/sessionRestore.test.ts`

- [x] **Step 3: Implement `settings.ts`, `sessionRestore.ts`, and update `desktopServices.ts` & `appHarness.ts`**

- [x] **Step 4: Run tests to verify pass**
  `pnpm --filter @omd/desktop test`

- [x] **Step 5: Commit and push**
  `feat(desktop): add settings and session restore models and services`

---

### Task 3: Settings Modal Component and UI Styling

**Files:**
- Create: `apps/desktop/src/SettingsModal.tsx`
- Create: `apps/desktop/test/SettingsModal.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Produces: `<SettingsModal isOpen={boolean} settings={UserSettings} onSave={(settings: UserSettings) => void} onClose={() => void} />`

- [x] **Step 1: Write tests for `SettingsModal.test.tsx`**
  Test rendering, changing theme, font size, line height, tab size, default mode, spellcheck, saving, and pressing Escape / clicking backdrop to close.

- [x] **Step 2: Run tests to verify failure**
  `pnpm --filter @omd/desktop test test/SettingsModal.test.tsx`

- [x] **Step 3: Implement `SettingsModal.tsx` and modal styles in `styles.css`**

- [x] **Step 4: Run tests to verify pass**
  `pnpm --filter @omd/desktop test test/SettingsModal.test.tsx`

- [x] **Step 5: Commit and push**
  `feat(desktop): add SettingsModal component and styles`

---

### Task 4: App Integration for User Settings (Shortcuts, CSS Props, Palette)

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/commands.ts`
- Modify: `apps/desktop/test/commands.test.ts`
- Modify: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- Wires `⌘,` keydown handler, Command Palette "Settings...", menu command "open-settings".
- Dynamically applies `--omd-font-size`, `--omd-line-height`, `--omd-font-family` to root element.

- [x] **Step 1: Write test in `App.test.tsx` for opening Settings on ⌘, and saving settings**

- [x] **Step 2: Run tests to verify failure**

- [x] **Step 3: Implement settings loading, CSS variable application, and modal toggling in `App.tsx`**

- [x] **Step 4: Run tests to verify pass**
  `pnpm --filter @omd/desktop test`

- [x] **Step 5: Commit and push**
  `feat(desktop): integrate user settings into App and command palette`

---

### Task 5: App Integration for Workspace Session Restore

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- On startup: loads `getSessionState()`, reopens folder and tabs.
- On workspace change: debounced `saveSessionState(state)` to persist active session.

- [x] **Step 1: Write test in `App.test.tsx` for session state save and startup restore**

- [x] **Step 2: Run tests to verify failure**

- [x] **Step 3: Implement startup session restore and debounced saving in `App.tsx`**

- [x] **Step 4: Run all verification tests (`pnpm verify`)**

- [x] **Step 5: Commit and push**
  `feat(desktop): integrate workspace session restore on app startup`
