# Known Gotchas — Index

> **How to use this file.** Before non-trivial work in a domain, read the matching domain
> file end to end (they are targeted, ~25 entries each): engine →
> [`gotchas-engine.md`](./gotchas-engine.md), desktop → [`gotchas-desktop.md`](./gotchas-desktop.md),
> Rust/IPC → [`gotchas-rust.md`](./gotchas-rust.md). Come back here to find a trap by symptom.
> A new trap gets a full entry in the domain file plus one index line; delete entries that
> stop being true. Tooling/process notes live inline below.

## Engine — rendering, parsing, widgets ([full file](./gotchas-engine.md))

- **Decoration ranges can invalidate the whole preview** — replaces must not overlap; a block widget suppresses its subtree's decorations and any enclosed outer decorations.
- **Editing state depends on selection, not only document text** — Route A: decorative marks fold unconditionally; link/image/math/footnote reveal via node-level `cursorInside`; `blockSelected` is inclusive and a fully-covering selection keeps the widget.
- **Engine is React-free, not DOM-free** — happy-dom misses DOM APIs and the widget error boundary can mask a broken render as a passing test.
- **Block decorations are illegal in ViewPlugins** — `block: true` decorations must come from a StateField; spec-only tests stay green while the app crashes, so every widget needs a `view.test.ts` smoke.
- **Unclosed fences run to document end** — decide "unterminated" by counting CodeMark children; never treat `lineAt(node.to)` as the closing fence.
- **atomicRanges: three rules** — no `mark:`/`line:` tags, no `widget:block:*`, no line-start or cross-line atoms.
- **Selection is visual, the caret is editing** — a non-empty selection reveals nothing; mid-drag reveal relayouts shift `posAtCoords`.
- **Tests may need to force the syntax tree** — use `makeState`; for large docs mount a temp view + `forceParsing`; compare incremental against `buildLiveDecorations` on the same state.
- **Block widget geometry can desync CM's heightmap** — async widgets need a sync placeholder plus a field refresh; no vertical margins on block DOM; identity before `eq()`; opaque replaces quantize `posAtCoords`.
- **Structure and appearance live in different packages** — a green engine test does not prove the desktop looks right.
- **Ordered-list preview numbers are written back to the source** — the rewrite must stay revertible; never gate reversibility on a "first pass" flag; merge rules per batch kind.
- **Underscore emphasis next to CJK is not CommonMark** — `parse/cjkUnderscore.ts` exists for a reason; do not remove it to "simplify".
- **Horizontal rules are block widgets when unselected** — keep `HorizontalRule` in `SELECTION_BLOCKS`.
- **Table cells are a single-line Markdown mini-document** — only `parse/cell.ts` parses cells; never a second inline parser; cell `mousedown` stops propagation; the cell input gets a caret, never `select()`.
- **Table edits are Lezer-range-based and per-view** — no whole-table serialize/parse revival; pending focus lives in per-view `WeakMap`s; real-`EditorView` tests are mandatory.
- **Async widgets can outlive their original DOM** — check `isConnected` after awaits; `eq` compares `src`+`embed` (plus `lang`/cells/resolver when they feed rendering).
- **Lezer has runtime-only internals missing from the typings** — cast with a comment; `tsc --noEmit` catches what vitest silently accepts.
- **Desktop `defaultKeymap` is registered before engine keymaps** — engine Enter/Tab/arrow bindings need `Prec.high`.
- **Parser character codes are named, not magic** — use `parse/chars.ts` constants.
- **Doc-start `---` is front matter, not a thematic rule** — unclosed front matter swallows to EOF.
- **The complete-tree trap** — production code must never `forceParsing`/`ensureSyntaxTree` to `doc.length` (`crossLayerNoFullTree.test.ts` guards it).
- **Decorations are seeded and windowed** — never assume a decoration exists outside the viewport window; `drainPendingLiveBuild` is test-only.
- **Multi-line link constructs leave a dangling empty preview row** — cosmetic, accepted.
- **`Text.append` continues the last line** — batched assembly needs an empty junction line (`docText.ts`).

## Desktop — React host, CSS, IPC callers ([full file](./gotchas-desktop.md))

- **Right-click paste on macOS deletes extra lines** — the paste handler must dispatch from a saved `posAtCoords` position, not CM's `doPaste`.
- **Dispatching changes without a selection leaves the caret before the insert** — always set an explicit anchor; never `replaceSelection` on async paths.
- **Normalization banner accessibility** — `aria-disabled`, never native `disabled`; the live-region host mounts on the first frame.
- **Relative image source and filesystem path are different concerns** — resolve through the `resolveImageSrc` host callback only.
- **Image paste is a two-step consistency operation** — bytes are written before the Markdown reference is inserted; operations are serialized per view.
- **Window listeners can capture stale React state** — keep handlers behind refs.
- **Tab identity and document identity are different** — stable `EditorSession.id`, incrementing `documentId`; export goes through an offscreen WKWebView, never iframe print or `html-to-image`.
- **Dirty state needs a saved-content baseline** — compare text against the last saved snapshot; a one-way boolean breaks on undo.
- **Cross-layer constants must stay in sync (TS ↔ Rust)** — named constants on both sides plus the drift test.
- **Shortcut sources: menu, window, keymap, palette** — change a binding in one entry point; never `PredefinedMenuItem` for window actions.
- **Statusbar word count is debounced** — wait out 250 ms (or fake timers) before asserting.
- **CodeMirror `readOnly` is advisory** — every dispatch site guards `state.readOnly` itself.
- **Editing hot path owns zero O(doc) work** — no doc string on the update path; materialize on the trailing cadence.
- **Open-path scale policy has one entry point** — `resetTabDocument` and `ensureViews`; budget/windowing globals follow the active tab only.
- **Path containment checks must normalize separators** — use `pathWithinDir`.
- **Bounded waits on the save queue** — `awaitWithTimeout`; the save chain keeps running after a timeout.
- **Stock `drawSelection` extends line ends to the content edge** — the vendored `tightSelection.ts` is the only selection layer; re-diff it on every `@codemirror/view` bump (guard test enforces).
- **`highlightActiveLine` paints nothing but is load-bearing** — focus mode needs the class; overrides need more classes than the base theme (it is injected later); `.omd-codeblock.cm-activeLine` must repaint.
- **`contentRect` is the border box** — `.cm-content` padding (16/24) breaks borrowed geometry formulas; `documentTop` excludes padding; `defaultLineHeight` is a default, not a row pitch.
- **Selection colors are driven by `--omd-selection-bg`** — CM's dark flag is never set; the token stays translucent on purpose.
- **Font family names must be quoted** — route through `cssFamily`; presets pass through unchanged.
- **`html[data-theme]` only restyles the webview** — native chrome needs `color-scheme` plus `set_window_theme`, applied pre-paint from Rust; the frontend must not push before settings load.
- **CM base-theme `&dark` variants never apply** — theme via CSS variables, never `EditorView.theme(..., {dark: true})`.

## Rust & IPC wire contracts ([full file](./gotchas-rust.md))

- **Guarded save is double-compare + atomic replace, not strict CAS** — document the residual race, never "CAS".
- **Expected version binds to the resolved path** — a retargeted symlink is `PathChangedConflict`, never a silent identity switch.
- **Missing-file publish uses a same-filesystem hard link** — crash can leave a temp alias; directory-fsync failure is a durability warning, not an error.
- **macOS metadata and xattr expectations** — FinderInfo/user tags must copy on overwrite; quarantine and ACLs intentionally do not.
- **Watcher fingerprints are hints** — probe all open tabs; never trust event paths; the version probe is stat-first with a fingerprint cache.
- **serde enum-level `rename_all` does not rename variant fields** — put it on each struct variant; assert serialized JSON in Rust tests for every multi-word IPC field.
- **Folder search IPC is `SearchResponse` with UTF-16 offsets** — slice with UTF-16 code units in tests; `ignore`/`globset` are pinned to the toolchain floor.
- **Tauri 2 sync commands run on the Rust main thread** — IO-bound commands must be `async` + `spawn_blocking`; menu mutation stays sync.
- **A debounced save cannot persist quit-time state** — Rust gates all three exit paths; register the ack round before emitting; ack even when persistence throws.
- **Rust `line_count` must match CM's DefaultSplit** — lone `\r` is a separator too (`count_line_separators`).
- **Tauri plugin commands are wire contracts** — prefer official JS bindings; never fire-and-forget a plugin invoke.
- **macOS font enumeration must use CoreText** — NSFontManager is main-thread-confined; the enumeration body runs under `spawn_blocking`.

## Tooling and process

## Tauri updater signing keys and macOS targets are exact contracts

`tauri signer generate` already writes a single-line Base64 private key. Do not Base64 it again. More subtly, Tauri's strict decoder rejects any whitespace after the final `=` padding: a valid 348-byte key ends with `==` at offsets 346–347, but a trailing space/CRLF makes the error misleadingly point at offset 346 (`Invalid symbol 61`). Release jobs therefore pass the repository secret only to `scripts/prepare-updater-key.mjs`, which trims surrounding whitespace, validates/canonicalizes the Base64, writes a mode-0600 runner-temp key file, and exports that file path as `TAURI_SIGNING_PRIVATE_KEY`. The workflow runs a small signer probe before the multi-minute package build. Never print the secret while debugging.

`bundle.createUpdaterArtifacts: true` is not enough by itself: the build must include an updater-enabled target. On macOS, `--bundles dmg` creates only the DMG and emits `no updater-enabled targets were built`; use `--bundles app,dmg` so Tauri creates `.app.tar.gz` and `.app.tar.gz.sig`. Windows uses `nsis,msi` (`wix` is a config section, not a CLI bundle name); Linux uses `deb,appimage`.

Release jobs compile Rust with `RUSTFLAGS=-D warnings`, so platform-only helpers need matching `cfg` gates instead of tolerated dead code. The frontend equivalent is not to suppress Vite warnings: CodeMirror's HTML/Markdown dependency chain already loads CSS/HTML/JavaScript language packages, so `parse/codeLanguages.ts` imports those three statically and only lazily imports languages that can actually split into separate chunks.

## Manual QA baselines can become stale

`docs/manual-qa.md` is valuable for IME, undo/redo, scrolling, and file workflows, but embedded test counts and milestone labels are snapshots of the time they were written.

Treat its interaction checklist as guidance and obtain current automated counts from command output. Update the document when supported behavior changes.

## Cursor hook `permission: ask` is not enforced

As of Cursor 3.15, `beforeShellExecution` returning `permission: "ask"` does not prompt; the command still runs (sandbox and autorun included). Only `deny` reliably blocks. The project guard in `.cursor/hooks/guard-dangerous.sh` therefore denies dangerous commands. Commands typed in the integrated terminal do not go through hooks.

## `.githooks/` does nothing until `core.hooksPath` is set

The repo stores hooks in `.githooks/`, not `.git/hooks`. Git ignores that directory unless `core.hooksPath=.githooks`. The root `prepare` script sets this on `pnpm install`. A clone that never ran install still uses the sample hooks under `.git/hooks`, so `commit-msg` will not strip Cursor co-author trailers.

## Stale Rust target artifacts break the link after a toolchain upgrade

After upgrading the Rust toolchain (e.g. Homebrew `brew upgrade rust`), `pnpm dev` / `cargo build` can fail at the final link with:

```
Undefined symbols for architecture arm64:
  "alloc::slice::stable_sort::hcaebff4dcd0e3274", referenced from:
      alloc::slice::...::sort_by::... in libappsdesktop_lib.rlib
ld: warning: object file ... was built for newer 'macOS' version (15.0) than being linked (11.0)
```

Cause: `src-tauri/target/` holds `.rlib`s compiled against the previous toolchain's std; mixing them with the new std leaves the shared `stable_sort` instantiation unresolved. `cargo test` can still pass from cached test artifacts, so a green test run does not prove the bin links.

Fix: `cargo clean --manifest-path apps/desktop/src-tauri/Cargo.toml` and rebuild. A minimal `rustc` program using `sort_by` links fine on a fresh build, so this is stale-state, not a code or std defect. If `pnpm dev` reports `Port 9420 is already in use` instead, a stale dev server holds the Vite port — kill the leftover `pnpm dev`/`tauri dev`/`vite.js` processes.

Prevention: the repo-wide `pnpm verify` gate links the app binary (`cargo build --no-default-features`) before `cargo test`, so a toolchain-upgrade breakage surfaces there instead of at `pnpm dev`.

Related trap: hand-declared C functions that are actually macros do not link. `dispatch_get_main_queue` is a macro expanding to `(&_dispatch_main_q)`; declaring `extern "C" { fn dispatch_get_main_queue() -> ... }` compiles but the symbol does not exist in libdispatch, so the bin link fails with `Undefined symbols: "_dispatch_get_main_queue"`. `cargo test` misses it when the calling code is dead-code-eliminated (its tests only assert the timeout constants). Reference the exported global object instead: `extern "C" { static _dispatch_main_q: c_void }` then take its address (`&raw const _dispatch_main_q`). Verify FFI additions with `cargo build`, not just `cargo test`.

## happy-dom test env needs explicit globals (Node 25 + KaTeX)

Two environment gaps produce stray warnings in `pnpm verify` if you break their setup files:

- **Node 25 shadows `localStorage`.** Node 25 ships an experimental file-backed `globalThis.localStorage` that warns `--localstorage-file was provided without a valid path` on any access, and the happy-dom vitest env wires `window.localStorage` to that same Node object — so a bare `localStorage.getItem()` in app code (recents, outline toggle) warns in every desktop worker. Fix: `apps/desktop/test/setup.ts` installs an in-memory `Storage` on both `globalThis.localStorage` and `window.localStorage`. If you drop that override, the warning returns and tests still pass.
- **happy-dom leaves `document.compatMode` undefined.** KaTeX checks `document.compatMode !== "CSS1Compat"` at module load and warns "doesn't work in quirks mode" (rendering still works because `renderToString` bypasses the disabled DOM `render`). Fix: `packages/engine/test/setup.ts` pins `compatMode` to `"CSS1Compat"` via `Object.defineProperty`. Keep the engine's `setupFiles` entry in `vitest.config.ts`.
- **happy-dom's default user agent advertises `X11`, so `isMacOS()` is false in every desktop test.** The default agent is `Mozilla/5.0 (X11; Darwin arm64) …` and `detectPlatform` maps `X11` to linux — even on a Mac dev machine. Any test exercising macOS-only behavior (e.g. the `MACOS_ONLY_COMMANDS` export gating in `exportGating.test.ts`, `App.test.tsx`'s native export tests) must stub the agent with `Object.defineProperty(window.navigator, "userAgent", { value: <mac UA>, configurable: true })` before `renderApp()` and restore it in `afterEach`. Tests that don't care about platform run as "linux" — do not assert mac glyphs or mac-only commands in them. When restoring, note the stub may be the *only own* property on `navigator` (the real `userAgent` lives on the prototype): if `getOwnPropertyDescriptor` returned `undefined` before the stub, restore with `delete (window.navigator as { userAgent?: string }).userAgent` — skipping the restore leaves the stub active and silently breaks every later test in the file (a mac stub makes `AppMenu` render `null`).

## Benchmark jitter is real — budgets warn, they never gate

CI runner and local numbers differ by multiples; any machine under load can
double a p95. That is why `bench/typing.bench.ts` logs budget verdicts
(`budgetLine` prints `OK` / `OVER BUDGET (> Nms)` for `TYPING_P95_BUDGET_MS =
16` and `STATS_BUDGET_MS = 8`) instead of using `expect`, and the CI bench job
sets `continue-on-error: true`. Never convert these to hard assertions;
regressions are judged by comparing runs on the same machine (same
`makeBenchmarkDoc` input, which is deterministic by design — do not introduce
randomness into the generator).

## Windows installer branding must use fixed-aspect BMPs

NSIS and WiX do not letterbox arbitrary PNG/ICO assets. A square app icon forced into the NSIS header slot (150×57) or the WiX banner (493×58) stretches the logo horizontally, which is the squashed `omd` seen in setup wizards.

Use the generated assets referenced from `tauri.conf.json`:

- NSIS `sidebarImage` → `icons/nsis-sidebar.bmp` (164×314) — **only** welcome/finish brand panel; do not set `headerImage` (inner pages stay clean without a top-right logo).
- WiX `bannerPath` → `icons/wix-banner.bmp` (493×58)
- WiX `dialogImagePath` → `icons/wix-dialog.bmp` (493×312)

### WiX banner: WixUI paints transparent page titles over its left strip

Tauri's MSI uses `WixUI_InstallDir`, which draws a transparent black page title — "Installing oh-my-md", "Ready to install oh-my-md", … — over X=15..215 dialog units at the top of **every inner page**, on top of `WixUIBannerBmp`. Anything baked into that strip of `wix-banner.bmp` collides with the live title and renders as overlapping, unreadable glyphs (spotted 2026-08-28: a baked left-aligned logo + wordmark under "Installing oh-my-md" at 150% DPI). The failure is invisible on macOS dev machines; it only appears when the MSI is actually installed on Windows, so the pixel drift test is the only dev-time guard.

Rule: `render_wix_banner()` keeps `x < WIX_BANNER_TITLE_SAFE_W` (220) flat `BANNER_BG`; branding goes only at the banner's right end, with the icon's baked white backdrop keyed out (`strip_white_background`) so no white tile shows on the gray strip. `apps/desktop/test/tauriConfig.test.ts` asserts both the strip's pixels and every BMP's dimensions — run it after any regeneration. Positions are dialog units scaled by DPI (150% scaling turns a 40-unit tile into ~60px), never pixels.

Related traps in the same generator:

- `wix-dialog.bmp` (Welcome/Exit background) is safe with branding on its left 164px because those dialogs draw their title at x=135 **over the flat right area** — the inverse of the banner rule.
- `nsis-sidebar.bmp` bakes the version string from `tauri.conf.json`; rerun `scripts/generate-installer-images.sh` after `pnpm release:version` or the wizard shows a stale version.

Regenerate from `apps/desktop/app-icon.png` with `scripts/generate-installer-images.sh` after changing the master icon. `installerIcon` stays the `.ico` for the exe/setup file icon only — it is not the wizard header bitmap.

## CM keymap tests under happy-dom: `Mod` means Ctrl, not Cmd

happy-dom reports `navigator.platform` as `"X11; Darwin arm64"` — it does not contain "Mac", so `@codemirror/keymap`'s platform detection resolves `Mod` to **Ctrl** in the test environment even when the host is macOS. Tests that dispatch keymap-bound keys (e.g. popup inner-editor `Mod-z` undo in `packages/engine/test/mathPopup.test.ts`) must mirror the detection instead of hardcoding `metaKey`:

```ts
const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
```

Real WKWebView (macOS) and WebView2 (Windows) report proper platforms, so runtime bindings are unaffected — this is test-only. Symptom of getting it wrong: the dispatched key does nothing and the keymap "silently" never matches.
