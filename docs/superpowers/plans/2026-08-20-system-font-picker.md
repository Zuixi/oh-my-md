# Plan: System font picker (Typora-style)

Date: 2026-08-20. Type: feature (user-visible settings interaction).

## Problem

The settings panel's Font Family control only offers three presets (System
Default / Monospace / Serif). Windows systems typically have 300+ installed
fonts and users want to pick any of them, as Typora does.

## Root cause (verified)

- `apps/desktop/src/SettingsModal.tsx:111-138` renders a native `<select>`
  populated only from `FONT_FAMILY_PRESETS`
  (`apps/desktop/src/settings.ts:20-24`).
- `UserSettings.fontFamily` is already a free-form CSS font-family string
  end-to-end: `sanitizeSettings` accepts any non-empty trimmed string
  (`settings.ts:59-61`), `App.tsx:826-830` applies it via the
  `--omd-font-family` CSS variable, and the synthetic "custom" option already
  displays values outside the presets.
- Nothing in the app enumerates installed system fonts (no Rust command, no
  WebView API use), so the gap is purely font discovery + picker UI.

## Goal (spec)

1. A new Tauri command `list_system_fonts` returns the sorted, deduplicated
   family names of all fonts installed on the machine.
   - macOS: CoreText `CTFontCollectionCreateFromAvailableFonts` (thread-safe
     off the main thread — NSFontManager is AppKit main-thread-confined and
     must NOT be used because the command runs on a `spawn_blocking` thread).
   - Windows: DirectWrite (`DWriteCreateFactory` →
     `IDWriteFactory::GetSystemFontCollection` → per-family
     `GetFamilyNames`, preferring the en-US locale entry, falling back to
     index 0).
   - Linux: best-effort `fc-list : family` subprocess; on spawn failure
     return an empty list.
   - All platforms share one post-processing step: trim, drop empties,
     case-insensitive dedupe (keep first), case-insensitive sort.
2. `desktopServices.ts` exposes an optional
   `listSystemFonts?: () => Promise<string[] | null>` service; `null` means
   enumeration failed or the runtime is not Tauri.
3. The Font Family settings row becomes a trigger button + popover picker:
   search box (case-insensitive substring filter, focused on open), the three
   presets pinned at the top, then all system fonts each rendered in its own
   typeface as a live preview, keyboard navigation (ArrowUp/ArrowDown move
   the active row, Enter commits, Escape closes only the popover), and a
   rendering cap of 200 visible rows (module-level constant, QuickOpenModal
   precedent).
4. Picking a preset saves `preset.value` verbatim; picking a system font
   saves the quoted CSS family name (e.g. `Microsoft YaHei` →
   `'Microsoft YaHei'`, internal `'` escaped as `\'`). Saving flows through
   the existing `sanitizeSettings` → `onSave` path.
5. Degradation: when the service resolves `null` the popover shows an inline
   failure note and keeps the presets selectable; when the service is absent
   (browser dev mode) the popover shows presets only.
6. When the current `settings.fontFamily` equals a preset value the trigger
   shows the preset label; when it equals a loaded system family's quoted
   form it shows that family name; otherwise it shows the existing
   `settings.font.custom` label.

## Non-goals

- No engine (`packages/engine`) changes.
- Code blocks / inline code keep their hardcoded monospace stack; a separate
  code-font setting is a possible follow-up.
- No cross-platform font crate (font-kit/fontdb): they pull C fontconfig
  into the Linux build and threaten the CI matrix. No capability/permission
  changes (custom commands are covered by `core:default`). No new shared
  cross-layer constants (the 200-row cap is TS-only).
- Manual entry of arbitrary font names is not added; the existing "custom"
  display path remains the escape hatch for hand-edited settings.

## Global Constraints

- IPC contract rules (root AGENTS.md boundaries 7-8, desktop AGENTS.md "When
  adding or changing a command" checklist): the Rust command, the
  `desktopServices.ts` invoke caller, and every TypeScript consumer change
  in the same task; the command is `async fn` returning
  `Result<Vec<String>, String>` and wraps its work in
  `tauri::async_runtime::spawn_blocking` (sync-command trap, lib.rs:31-33);
  it is registered in the single `tauri::generate_handler!` list in
  `lib.rs::run()` (~L573-613).
- Platform branching in Rust only through `#[cfg(...)]` (the `export.rs`
  module-swap pattern); platform detection in TS only via
  `apps/desktop/src/platform.ts`.
- macOS font enumeration must use CoreText APIs (thread-safe), never
  NSFontManager (main-thread-confined).
- Strict TypeScript, no `any`, named exports.
- Every new i18n key lands in both `apps/desktop/src/i18n/messages/en.ts`
  and `zh.ts`.
- Follow existing code/test conventions: Vitest for desktop, inline
  `#[cfg(test)] mod tests` for Rust, `cargo fmt` clean, commit subjects as
  `<type>: <why>` (types: feat/fix/refactor/docs/test/chore/perf/ci).
- Rust payload is `Vec<String>` (no multi-word fields), so no serialized-JSON
  casing test is required; do not add one.
- Do not touch unrelated files. The main checkout keeps its own uncommitted
  work; this branch starts from `1b62526`.

## Task 1: Rust `list_system_fonts` command

Create `apps/desktop/src-tauri/src/fonts.rs`:

- `#[tauri::command] pub async fn list_system_fonts() -> Result<Vec<String>, String>`:
  `tauri::async_runtime::spawn_blocking(collect_families)` with the join
  error mapped as `format!("font listing task failed: {error}")` (mirror
  `list_snapshots`, lib.rs:202-207).
- `fn collect_families() -> Vec<String>` dispatching by `#[cfg]` to a
  macOS/Windows/Linux collector, then post-processing through
  `fn normalize_families(raw: Vec<String>) -> Vec<String>` (trim, drop
  empties, case-insensitive dedupe keeping the first occurrence,
  case-insensitive sort).
- macOS collector: `objc2-core-text` — `CTFontCollectionCreateFromAvailableFonts`
  → `CTFontCollectionCreateMatchingFontDescriptors` → per-descriptor
  `CTFontDescriptorCopyAttribute(kCTFontFamilyNameAttribute)` → CFString
  names. Verify the exact feature names to enable against docs.rs
  (`objc2-core-text` 0.3) and add the dependency to the existing
  `[target.'cfg(target_os = "macos")'.dependencies]` section in
  `apps/desktop/src-tauri/Cargo.toml` (it may also need
  `objc2-core-foundation` types).
- Windows collector: `windows` crate — add
  `[target.'cfg(windows)'.dependencies] windows = { version = "0.61", features = ["Win32_Graphics_DirectWrite"] }`
  (0.61.3 is already in Cargo.lock transitively). Enumerate:
  `DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)` → `IDWriteFactory` →
  `GetSystemFontCollection` → `GetFontFamilyCount` / `GetFontFamily(i)` →
  `GetFamilyNames` (IDWriteLocalizedStrings) → prefer the en-US locale
  entry via `FindLocaleName`, fall back to index 0 → read with
  `GetStringLength`/`GetString` into a UTF-16 buffer, convert to String.
- Linux collector (`#[cfg(not(any(windows, target_os = "macos")))]`):
  `std::process::Command::new("fc-list").args([":", "family"])`, split each
  stdout line on `,`, trim pieces; on spawn/output failure return an empty
  vec (best-effort).
- Register in `lib.rs`: `mod fonts;` near the other module declarations and
  `fonts::list_system_fonts` appended to `generate_handler!`.
- Rust tests (inline `#[cfg(test)] mod tests` in fonts.rs):
  - `normalize_families` unit test: mixed-case duplicates collapse to the
    first spelling, output is sorted case-insensitively, empties/whitespace
    dropped.
  - `#[cfg(target_os = "macos")]`: `collect_families()` is non-empty,
    contains "Helvetica", and satisfies the normalize invariants.
  - `#[cfg(windows)]`: contains "Segoe UI", normalize invariants hold.
  - `#[cfg(target_os = "linux")]`: non-empty (CI ubuntu runners have
    fonts), normalize invariants hold.
- Verify: `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`
  then `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  (requires `pnpm --filter @omd/desktop build` to have produced
  frontendDist — the worktree baseline does this).
- Commit: `feat: enumerate installed font families for the settings picker`.

## Task 2: TS service layer + font-family value helpers

- `apps/desktop/src/desktopServices.ts`:
  - Add to `DesktopServices` (near `getSettings`/`saveSettings`, ~L189-192):
    `/** null when font enumeration fails or the runtime is not Tauri */`
    `listSystemFonts?: () => Promise<string[] | null>`.
  - Add to `defaultServices`: `listSystemFonts: async () => { try { return
    await invoke<string[]>("list_system_fonts") } catch { return null } }`
    — internal try/catch fallback mirrors `getSettings`.
- `apps/desktop/test/desktopServices.test.ts`: extend the mocked-invoke
  suite — calling `listSystemFonts` invokes `"list_system_fonts"` with no
  arguments; when `invoke` rejects, the service resolves `null`.
- `apps/desktop/src/settings.ts`: add two named exports:
  - `cssFamily(name: string): string` — wraps a font family name as a single
    CSS font-family token: single quotes, internal `'` escaped as `\'`.
  - `familyFromCssValue(value: string, families: readonly string[]): string | null`
    — returns the family whose `cssFamily(name)` equals `value`, else null.
- `apps/desktop/test/settings.test.ts`: new cases for quoting
  (`Microsoft YaHei` → `'Microsoft YaHei'`; a name containing `'` is
  escaped), and `familyFromCssValue` match/miss.
- `apps/desktop/test/appHarness.ts`: `harnessServices` gains
  `listSystemFonts: vi.fn(async () => ["Arial", "Menlo"])`.
- Verify: `pnpm --filter @omd/desktop test`.
- Commit: `feat: expose the system font list service and family helpers`.

## Task 3: FontFamilyPicker UI + integration

- New component `apps/desktop/src/FontFamilyPicker.tsx` (presentational):
  - Props: `{ value: string; families: string[] | null; loading: boolean;
    onSelect: (cssValue: string) => void }`.
  - Trigger: `<button type="button" id="setting-font-family">` styled like
    `.settings-select` (label per Goal #6).
  - Popover: search input (focused on open, case-insensitive substring
    filter), presets pinned top, `settings.font.systemFonts` divider label,
    family rows each with `style={{ fontFamily: cssFamily(name) }}`,
    `MAX_RENDERED = 200` cap with a count note (QuickOpenModal pattern).
  - Keyboard: ArrowUp/ArrowDown move the active row, Enter commits, Escape
    closes only the popover (stopPropagation so the modal stays open).
    Click-outside closes (document listener held via ref; stable handler
    convention).
  - ARIA: `role="listbox"` rows `role="option"` + `aria-selected`.
  - `families === null` → inline `settings.font.loadFailed` note, presets
    still selectable. Loading → row list shows a loading state.
- `apps/desktop/src/SettingsModal.tsx`:
  - New prop `listSystemFonts?: () => Promise<string[] | null>`.
  - Replace the Font Family `<select>` (L111-138) with `<FontFamilyPicker>`;
    lazy-load the family list on first popover open, cache in a `useRef`
    (the component stays mounted across open/close, so the cache persists).
  - Selecting flows through the existing `update({ fontFamily })` path.
- `apps/desktop/src/App.tsx`: pass `listSystemFonts={services.listSystemFonts}`
  to the `<SettingsModal>` render (~L2386) — touch only this wiring.
- `apps/desktop/src/styles.css`: trigger (match `.settings-select`
  metrics), popover (absolute, right-aligned under the trigger, max-height
  ~260px, overflow-y auto, above modal content), active-row highlight,
  preview text, divider label, failure note. Use existing theme tokens and
  the `.palette*` patterns; no hardcoded colors outside token vars.
- i18n (`en.ts` + `zh.ts`):
  - `settings.font.searchPlaceholder`: "Search fonts…" / "搜索字体…"
  - `settings.font.systemFonts`: "System fonts" / "系统字体"
  - `settings.font.loadFailed`: "Failed to load system fonts" / "系统字体加载失败"
- Tests (`apps/desktop/test/SettingsModal.test.tsx` + any new
  `FontFamilyPicker.test.tsx`):
  - trigger shows the active preset label;
  - open popover → type in search filters families → click a family →
    `onSave` receives `cssFamily(name)`;
  - clicking a preset saves `preset.value`;
  - `families === null` → failure note renders, presets still selectable;
  - no `listSystemFonts` prop → presets only, no crash;
  - Escape inside the popover closes the popover, not the modal.
- Verify: `pnpm --filter @omd/desktop test`.
- Commit: `feat: searchable system font picker in the settings panel`.

## Task 4: Documentation updates

- `docs/manual-qa.md`: add font picker verification rows — Windows: pick
  Microsoft YaHei and confirm the editor font changes; macOS: pick any
  family; degradation: settings still usable when enumeration fails.
- `docs/memory/known-gotchas.md`: add two entries:
  - NSFontManager is main-thread-confined; macOS font enumeration under
    `spawn_blocking` must use CoreText (CTFontCollection APIs).
  - Multi-word font family names written into the `--omd-font-family` CSS
    variable must be quoted (`cssFamily` helper) or the declaration breaks.
- Commit: `docs: cover the system font picker in QA notes and gotchas`.
