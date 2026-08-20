# Toast Notification System — Design

Date: 2026-08-20. Branch: `feat/toast-notifications`. Decision: user chose `react-toastify` (v11.1.0, React 19 compatible) over hand-rolled/radix; scope = all errors + five success operations.

## Context

Every error surface in the app today is a blocking native `window.alert` (`desktopServices.ts` real `reportError`), and every successful file operation is silent. The app already has in-app feedback surfaces (normalization banner, save-conflict banner, opening overlay, statusbar) but no transient notification.

## Goals

1. Replace the production `reportError` implementation with `toast.error` — one seam change; all callers (App.tsx, conflictActions, appExportActions, recoveryWriter, desktopServices internals) inherit it with zero call-site changes.
2. Add success feedback for five operations: file created, entry deleted, entry renamed, save-as completed, export completed — via a new optional service `notifySuccess(message)`.
3. Style toasts to match the `omd-*` design system (dark/light aware, CSS variables).

## Non-goals

- Merging the save-conflict banner or normalization banner into toasts (they are workflow states, not notifications).
- Replacing `window.prompt`/`window.confirm` with in-app dialogs (separate future work).
- An undo action inside toasts.
- Toasts from the engine (engine stays framework-independent; desktop-only).

## Design

**Dependency:** `react-toastify@^11` added to `apps/desktop` only.

**Seam (services boundary, per AGENTS.md rule):**
- Real services: `reportError: message => toast.error(message)`; new optional `notifySuccess?: (message: string) => void` = `message => toast.success(message)`. Any Tauri-presence guard pattern used by neighboring members is followed.
- Fallback/default services keep `window.alert` semantics if that object is browser/test-facing — the implementer identifies which object production uses (the `window.alert` at desktopServices.ts:406) and swaps only that.
- Harness (`appHarness.ts`): add `notifySuccess: vi.fn()` to the mock services. Existing tests keep mocking `reportError` — untouched.

**Container:** mounted once in `main.tsx` (production entry), NOT inside App's render tree — tests render App without toasts. CSS import there too: `import "react-toastify/dist/ReactToastify.css"` (verify exact v11 export path against the installed package).

**Behavior rules (container + per-call options):**
- Position: bottom-right; stack limit 3; pause on hover; close button on; no drag/swipe (`draggable: false`); `newestOnTop`.
- `toast.error`: autoClose 8000; `toast.success`: autoClose 3000. a11y is handled by the library (aria-live).

**Styling:** overrides in `apps/desktop/src/styles.css` scoped to `.Toastify__toast` et al. using the same CSS custom properties/tokens the banners use (follow normalization-banner/conflict-banner patterns); respect the existing dark/light theming mechanism.

**Success call sites (all through `services.notifySuccess?.(...)`, fire-and-forget):**

| Operation | Site | i18n key (en/zh) |
|---|---|---|
| File created | `App.tsx` `createTreeFile` (after create + refresh, alongside the open) | `notify.fileCreated` `{name}` |
| Entry deleted | `App.tsx` `deleteTreeEntry` (after delete + close + refresh) | `notify.entryDeleted` `{name}` |
| Entry renamed | `App.tsx` `renameTreeEntry` (after rename + retarget) | `notify.entryRenamed` `{name}` |
| Save-as completed | `App.tsx` `saveFile` explicit save-as success with new path (locate the completion point; plain saves stay silent) | `notify.saveAsCompleted` `{name}` |
| Export completed | `appExportActions.ts` export success path (warning path stays `reportError`) | `notify.exportCompleted` `{name}` |

i18n keys live in `apps/desktop/src/i18n/messages/en.ts` + `zh.ts` next to the `error.*` block, using the existing `{param}` interpolation.

## Testing

- `desktopServices.test.ts`: real services `reportError` → `toast.error(message)`; `notifySuccess` → `toast.success(message)` (vi.mock `react-toastify`; pattern established by the revealItemInDir test).
- `FileTree.menu.test.tsx`: create-file test asserts `notifySuccess` called with the localized created message.
- Full desktop suite accounting: baseline has exactly ONE pre-existing failure (App.test.tsx outline-preview hover, stale selector, owner has local fix; this branch must NOT touch that file).
- Engine suite unaffected (`pnpm test` quick confirmation).

## Documentation

- `docs/manual-qa.md`: extend the Files-sidebar / export checklists with toast behaviors (error toasts non-blocking; five success toasts).
- `apps/desktop/AGENTS.md`: one convention line — user-visible feedback goes through `services.reportError`/`notifySuccess` (toast-backed); never call `window.alert` directly in desktop code.
