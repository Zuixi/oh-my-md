# User Settings & Session Restore Design Spec

**Date:** 2026-08-15  
**Scope:** User Preferences & Settings Modal + Workspace Session Restore (Rust IPC & React Host)

---

## 1. Problem & Goals

1. **User Settings & Preferences (用户设置与偏好面板)**
   - Users need to customize their editor experience: font size, font family, line height, tab indent size, default edit mode (live preview vs. source mode), spellcheck toggle, and theme (system / light / dark).
   - Settings must persist locally across application launches (stored in user config directory in JSON format).
   - The settings dialog must follow macOS desktop standards: accessible via `⌘,`, Command Palette (`Settings...`), and the application menu.
   - Settings changes should apply immediately to active and newly created editor instances without requiring an application restart.

2. **Session Restore (工作区与会话恢复)**
   - When users reopen oh-my-md, they expect their previously open folder workspace, open document tabs, and active tab to be restored automatically.
   - Closed or missing files on disk must degrade gracefully (skipped without crashing or interrupting other tabs).
   - Session state must be debounced and safely saved to user config directory (`session.json`).
   - Crash recovery drafts (unnamed or uncommitted drafts) retain priority, while pathed clean/dirty file tabs restore seamlessly.

---

## 2. Architecture & Data Structures

```text
┌──────────────────────────────────────────────────────────────────────┐
│  React App                                                           │
│  ├── SettingsModal (⌘, / Palette) ──► UserSettings State / Context   │
│  │                                 └── Apply to Editor CSS/CM6 props │
│  ├── Session Restore Hook ──► On startup: read_session_state         │
│  │                         └── On tab/folder change: save_session_state (debounced)
│  └── DesktopServices ──► Tauri IPC                                  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Rust Backend (src-tauri)                                            │
│  ├── get_settings / save_settings ──► ~/.config/oh-my-md/settings.json
│  └── get_session_state / save_session_state ──► ~/.config/oh-my-md/session.json
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 UserSettings Model (`apps/desktop/src/settings.ts`)

```ts
export type AppTheme = "system" | "light" | "dark"
export type DefaultEditorMode = "live" | "source"
export type TabSize = 2 | 4

export interface UserSettings {
  // Theme
  theme: AppTheme
  // Typography & Layout
  fontSize: number // Default: 16 (px), bounds: 12..32
  fontFamily: string // Default: "system-ui, -apple-system, sans-serif"
  lineHeight: number // Default: 1.6, bounds: 1.2..2.4
  tabSize: TabSize // Default: 2
  // Editor Behavior
  defaultMode: DefaultEditorMode // Default: "live"
  spellcheck: boolean // Default: false
}

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "system",
  fontSize: 16,
  fontFamily: "system-ui, -apple-system, sans-serif",
  lineHeight: 1.6,
  tabSize: 2,
  defaultMode: "live",
  spellcheck: false,
}
```

### 2.2 RestoredSession Model (`apps/desktop/src/sessionRestore.ts`)

```ts
export interface SavedSessionState {
  folder: string | null
  openPaths: readonly string[]
  activePath: string | null
}
```

---

## 3. Rust Backend Commands (`apps/desktop/src-tauri/src/workspace.rs` & `lib.rs`)

### 3.1 Storage Paths
- Directory: `config_dir().join("oh-my-md")` or `OMD_CONFIG_DIR` if set.
- Settings: `settings.json`
- Session: `session.json`

### 3.2 Commands
1. `get_settings() -> Result<String, String>`: Read `settings.json`, return `{}` if missing.
2. `save_settings(contents: String) -> Result<(), String>`: Atomic write `settings.json`.
3. `get_session_state() -> Result<String, String>`: Read `session.json`, return `{}` if missing.
4. `save_session_state(contents: String) -> Result<(), String>`: Atomic write `session.json`.

---

## 4. Frontend Integration

### 4.1 Desktop Services
Extend `DesktopServices`:
- `getSettings: () => Promise<UserSettings>`
- `saveSettings: (settings: UserSettings) => Promise<void>`
- `getSessionState: () => Promise<SavedSessionState | null>`
- `saveSessionState: (state: SavedSessionState) => Promise<void>`

### 4.2 Editor & Theme Wiring
- Apply `fontSize`, `lineHeight`, `fontFamily` via CSS custom properties on document root (`--omd-font-size`, `--omd-line-height`, `--omd-font-family`).
- Pass `tabSize` and `defaultMode` to `CreateEditorOptions` in `Editor.ts`.
- Listen for `⌘,` keyboard shortcut to toggle `SettingsModal`.
- Command palette includes "Preferences / Settings..." item.
- Native application menu includes "Preferences..." binding.

### 4.3 Session Restore Flow
1. On initial mount of `App`:
   - Load `getSettings()`, apply to state and CSS variables.
   - If recovery draft restore is pending, handle recovery first.
   - Otherwise, call `getSessionState()`.
   - If `folder` is present and exists on disk, open folder and populate tree.
   - For each path in `openPaths`: check file existence via `readDocument`, open as tab if existing.
   - Activate `activePath` if present among opened tabs.
2. During runtime:
   - When `workspace.folder`, `workspace.tabs`, or `workspace.activeTabId` changes, run a 500ms debounced save of `SavedSessionState`.

---

## 5. Testing & Verification

1. **Rust Tests**:
   - Roundtrip test for `save_settings` / `get_settings`.
   - Roundtrip test for `save_session_state` / `get_session_state`.
   - Missing file fallback handling.

2. **Frontend Unit Tests**:
   - `settings.test.ts`: default settings merge, validation, bounds clamping.
   - `sessionRestore.test.ts`: session state extraction from workspace, validation of valid paths.
   - `SettingsModal.test.tsx`: rendering, form inputs, change propagation, shortcut closing.
   - `App.test.tsx`: integration test verifying settings modal opening on ⌘,, settings persistence, and session state restore on startup.
