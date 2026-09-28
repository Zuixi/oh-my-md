# Rust and IPC Gotchas

Deep-dive traps for `apps/desktop/src-tauri` and the TS↔Rust wire contracts.
One-line index: [`known-gotchas.md`](./known-gotchas.md).

## Guarded save is double-compare + atomic replace, not strict CAS

Rust `save_document` compares the expected opaque version twice around temp-file write and rename. That catches most external edits, but standard file APIs cannot merge "compare against arbitrary other processes" with "persist" into one indivisible step. A cooperating or racing writer can still change the file after the last compare and before `persist`. Document and logs must call this **residual race**; never describe guarded-save as strict compare-and-swap.

## Expected version binds to resolved path, not the symlink node

`DocumentVersion.resolved_path` is the canonical target at open/save time. If a symlink later points elsewhere, the next save returns `PathChangedConflict` instead of writing either target. `PathChanged` and `UnexpectedSymlinkConflict` do not expose the new target; desktop must offer reopen-previous / choose-another-path, never silently adopt the new identity.

## Missing-file publish uses a same-filesystem hard link

Creating a file from `ExpectedDocumentVersion::Missing` writes a temp file, hard-links it into place, then removes the temp link. A crash between link and temp cleanup can leave an extra temp hard-link alias on disk (recorded residual risk). Parent-directory `fsync` failure returns `Saved` with a `directorySyncFailed` durability warning — the save succeeded but directory metadata may not be durable across power loss.

## macOS metadata and xattr expectations

Required user metadata (`com.apple.FinderInfo`, `com.apple.metadata:_kMDItemUserTags`) must copy on overwrite; failure returns `MetadataFailed` and does not replace the target. Quarantine, provenance, ACLs, and birthtime are intentionally not copied. Other xattrs are best-effort (ENOTSUP/EPERM logged, save continues).

## Watcher fingerprints are hints; conflict banner replaces silent reload

File-tab polling uses `readDocumentVersion` only. External changes on a clean tab surface a non-modal **external changed** notice; dirty tabs and active conflicts keep editing/recovery and pause autosave until the user resolves via banner actions. Do not auto-reload disk over local edits.

## serde enum-level `rename_all` does not rename variant fields

`#[serde(tag = "kind", rename_all = "camelCase")]` on a Rust enum only camelCases the **variant names**, not the fields inside struct variants. `DiskSnapshot` shipped with `Existing { requested_path, .. }` relying on the enum-level attribute, so `read_document` returned `requested_path` over IPC while the webview read `requestedPath` — every opened file tab silently became "unnamed" (path `undefined`), with duplicate tabs on re-open and no autosave. Symptom looked frontend; cause was wire-format.

Fix pattern (already used by `SaveDocumentResult`): put `#[serde(rename_all = "camelCase")]` on **each struct variant**. Regression guard: `documents::tests::disk_snapshot_serializes_requested_path_as_camel_case` asserts the JSON field names. TS-side tests mock `services.readDocument`, so they cannot catch IPC casing drift — assert serialized JSON in Rust tests for any new IPC payload with multi-word fields.

## Folder search IPC is `SearchResponse`, offsets are UTF-16

`search_markdown(root, query, case_sensitive)` returns `{ hits, truncated }`, not a bare array, and each `SearchHit.start`/`end` is a **UTF-16 code-unit offset** into the possibly truncated `text` so the frontend can `text.slice(start, end)` to highlight the match. Slicing by byte offset in Rust tests will fail on non-BMP text (emoji); assert with `text.encode_utf16().skip(start).take(len)` instead. `start`/`end` are plain single-word fields, so they serialize as-is, but a Rust `serde_json::to_string` test still locks the whole contract. The frontend caller must pass `caseSensitive` and destructure `.hits`/`.truncated` — an invoke missing the arg or reading the old array shape fails silently.

`ignore`/`globset` are pinned (`ignore = "=0.4.22"`) because 0.4.33+/0.4.20+ require rustc 1.88; the local toolchain is 1.87. Do not `cargo update` these without also bumping the documented toolchain floor.

## The notify watcher is a hint; FSEvents latency and dropped events are expected

`watcher.rs` coalesces notify events for 300 ms before emitting `workspace-changed`, and macOS FSEvents may batch or reorder paths. The webview handler therefore probes **all** open tabs (fingerprint compare in Rust decides) instead of trusting event paths, and the old poll survives as a 30 s fallback (`watchMs` default in `App.tsx`). Never make an event path the basis for a reload decision — only `read_document_version`/guarded-save comparisons may change document state. Watch paths are canonicalized on both set and update; a non-canonical path in `state.watched` would make `diff_watches` leak watches that `unwatch` can never remove.

`read_document_version` is stat-first (2026-08-20, Spec 05b §14.9 follow-up): Rust keeps a `(mtime_ns, size) → version` cache (`DocumentVersionCache`, keyed by requested path). A matching stat returns the cached fingerprint **without reading the file**; a mismatch pays the full read + blake3 and refreshes the cache (re-stat after read — a torn mid-read write is not cached); a missing/deleted file returns `Missing` and evicts its entry. Guarded-save still always reads fresh. Residual risk (accepted): on coarse-mtime filesystems (HFS+ 1s ticks) a same-size external write inside one mtime tick is invisible until the next stat change — the poll under-reports external changes for that window; likewise a symlink retargeted to a file with an identical (mtime_ns, size) pair.

## Tauri 2 sync commands run on the Rust main thread (Spec 05b)

Non-`async` `#[tauri::command]` fns execute on the main thread and serialize
behind each other (and window event processing). During the 50MB open bug this
meant `openPath` could hang forever with content already in hand: it
`await allow_document_assets` after a successful read, and that sync command sat
queued behind a synchronous 50MB `write_recovery` `fs::write`. IO-bound commands
must be `async fn` + `tauri::async_runtime::spawn_blocking` (see the document
commands; `write_recovery`/`read_recovery`/`save_session_state`/
`watch_paths`/`allow_*` were converted). `set_recent_files` stayed sync on
purpose: its menu rebuild is macOS-only (no-op on Windows/Linux, menu.rs gates
on `target_os`), and menu mutation must stay on the main thread.

## A debounced save cannot persist quit-time state; Rust must gate the quit

The 1s trailing debounce on `SavedSessionState` (App.tsx) resets on every
workspace change and is *cancelled* by teardown, so a rapid close-tabs-then-quit
lost every close — `session.json` kept the last snapshot that had a full second
of quiet (this restored 10 tabs after the user closed 9 and quit). WKWebView
teardown runs no JS and fires no `beforeunload` you can rely on, so the flush
must be coordinated from Rust: prevent close/exit → emit `session-flush` →
wait for the `session_flush_ack` command (bounded, 2s timeout; timeout still
finishes so a hung webview never traps the user). Three exit paths need three
hooks: `WindowEvent::CloseRequested` (red X / Cmd+W; finish with
`window.destroy()` — `close()` would re-trigger CloseRequested),
`RunEvent::ExitRequested` with `code: None` (user-initiated, macOS Cmd+Q;
prevent_exit → flush → `app.exit(0)`), and the `quit_app` command itself
(`app.exit` skips ExitRequested, so it must run the gate inline). Order inside
the gate is load-bearing: register the round *before* emitting, or an ack
racing an unregistered round no-ops and stalls the close until the timeout.
The webview handler must ack even when persistence throws — an escaping
rejection from an event handler is an unhandled webview rejection and the
un-acked quit burns the full timeout.

## Rust line_count must match CM's DefaultSplit, including lone CR

`DocumentFileStats.line_count` promises CM's `doc.lines` convention, and CM
splits on `/\r\n?|\n/` — a lone `\r` (classic Mac file) is a separator too.
Counting only `b'\n'` under-reports for such files; use
`count_line_separators` (documents.rs), which also carries a chunk-trailing
`\r` across streaming chunk boundaries so a CRLF split mid-stream is not
misread as two separators.

## Tauri plugin commands are wire contracts; raw `invoke("plugin:…")` drifts silently

`tauri-plugin-opener`'s `reveal_item_in_dir` expects `paths: Vec<PathBuf>`
(a JSON array), but `desktopServices.ts` raw-invoked it with `{ path }` — the
invoke rejected during argument deserialization before any OS code ran, so
"Reveal in File Manager" (file-tree context menu + save-conflict banner) was a
silent no-op on every platform since it landed (66be269). Both call sites fired
it with `void` and no `.catch`, so the rejection was invisible: the bug read as
"the button does nothing" instead of surfacing an error.

Plugin commands are wire contracts exactly like custom IPC (same trap family as
the `search_markdown` casing drift). Rules:

- Prefer the official JS binding (`revealItemInDir`, `openUrl` from
  `@tauri-apps/plugin-opener`) over hand-written `invoke("plugin:…", …)` — the
  binding owns the argument shape and evolves with the plugin.
- Never fire-and-forget a plugin invoke with `void` and no `.catch`; attach a
  handler that reports through `services.reportError` so payload drift becomes
  a visible error, not a dead button.
- `apps/desktop/test/desktopServices.test.ts` pins the delegation
  (`revealInFinder` → `revealItemInDir(path)`); add the same pin when wiring
  another plugin binding.

## macOS font enumeration must use CoreText, not NSFontManager

`list_system_fonts` (`apps/desktop/src-tauri/src/fonts.rs`) is an `async`
command whose enumeration body runs under
`tauri::async_runtime::spawn_blocking` (the blocking-work rule from
"Tauri 2 sync commands run on the Rust main thread (Spec 05b)"). That pool
thread is not the main thread, and AppKit's `NSFontManager` / `NSFont` are
**main-thread-confined**: enumeration written against them compiles and then
misbehaves at runtime. macOS font enumeration under `spawn_blocking` must use
CoreText, which is thread-safe for read-only enumeration:
`CTFontCollection::from_available_fonts` → `matching_font_descriptors()` →
read the `kCTFontFamilyNameAttribute` attribute (via `objc2-core-text` /
`objc2-core-foundation`, already Cargo dependencies).

The other platforms follow the same shape: Windows uses DirectWrite
(`GetSystemFontCollection` on the shared factory, callable from any thread,
en-US preferred name); Linux shells out to `fc-list : family` best-effort and
reports an empty list when fontconfig is absent — the picker then offers
presets only, which is the designed degradation, not an error to fix.

## Capability `windows` patterns are label-matched with globs; an uncovered label gets zero IPC

Tauri 2 grants permissions per window **label**, and the `windows` array in
`capabilities/default.json` accepts glob patterns (documented in
`gen/schemas/desktop-schema.json`). A window whose label matches no capability
gets no IPC permissions at all, so every `invoke` from it rejects at runtime —
while every TypeScript test stays green, because desktop tests mock
`desktopServices` at the TS boundary and never cross the real capability
check. Dynamically created windows are the trap: the multi-window host's
`editor-N` labels (`src-tauri/src/windows.rs`) exist nowhere in config, so
shipping them without a covering pattern would make every invoke in a new
editor window fail at runtime. This is the config-file sibling of the IPC
wire-drift traps above — it compiles, passes tests, and breaks only in the
running app.

Rules: when Rust code creates a window with a new label family, extend the
capability in the same change. `default.json` uses `["main", "editor-*"]` —
the explicit `editor-*` glob, not a bare `"*"`, so future utility windows
cannot silently inherit editor permissions — and `tauri.conf.json` declares
`"label": "main"` explicitly so the config-declared window and the capability
stay visibly linked. Drift guard:
`apps/desktop/test/windowCapabilities.test.ts` asserts both patterns; extend
it when adding another label family.

## Menu events carry no window identity; route through the registry MRU

Tauri's app-level `on_menu_event` reaches Rust as `(handle, event)` with only
the item id — there is no window in the event, because the native (macOS)
menu bar belongs to the application, not to a window. With several webview
windows live, "which window runs Save?" has no answer in the event itself:
menu.rs resolves it from the `WindowRegistry` MRU via `focused_label` — the
MRU head if it still has a live webview (the head can be mid-destroy), else
any live webview as fallback, else `None`. `None` means the command is
dropped: zero windows (macOS after closing everything) has no webview to
receive an emit, and silently doing nothing beats crashing or inventing a
target. The `Destroyed` handler unregisters the label, which is what keeps
the MRU honest; routing through a stale MRU head without the live-webview
check would emit into a destroyed window.

Two exemptions to the forwarding path: `new-window` creates an editor window
natively in the handler (it targets no existing window), and the `window-*`
commands are handled natively in Rust against the same `focused_label`
resolution (`handle_window_command`) — except `window-bring-all-to-front`,
which needs no target because it iterates every window. Forwarding itself is
`emit_to(&label, MENU_EVENT, id)` — targeted, matching the AnyLabel listener
pinning on the JS side (see the desktop Any/AnyLabel gotcha). Any new
menu-driven command must decide its target the same way; a hardcoded
`"main"` label is wrong in every multi-window scenario.

## FlushGate rounds are counting: one global deadline over the target set

`session_flush.rs` runs one round per quit attempt, not one timeout per
window: `begin(timeout, targets, finish)` arms a single
`SESSION_FLUSH_TIMEOUT` (2s) deadline covering the whole target set, and the
`finish` callback runs exactly once — when the last target acks or when the
deadline hits, whichever comes first. A per-window serial timeout would
multiply the worst case (N hung webviews × 2s) and still have to finish;
counting keeps "a hung webview never traps the user" true at any window
count. `ack(window_label)` removes exactly the calling window's label from
the pending set; acks from labels outside the target set are ignored (a
stale or foreign webview ack cannot complete the round), and `begin` while a
round is in flight returns `false` — the second round never runs, so its
finish must not either (guarded by `begin_while_in_progress_is_ignored`).
Empty `targets` complete immediately with `Acknowledged`.

Load-bearing ordering, same as the single-window gate but now per round:
call `begin` **before** emitting `session-flush` — an ack racing an
unregistered round no-ops and stalls the close until the timeout. The ack
command injects the calling `WebviewWindow`, so the label the gate removes
is the window that actually flushed, never a hardcoded `"main"`. `finish`
receives the `FlushOutcome`: ordinary quit paths ignore it (a timeout still
finishes), but `prepare_update_restart` aborts the install on `TimedOut`
instead of exiting. The one-shot `flushed` flag (`consume_flushed`) exists
because the window-close round's finisher destroys the last window, which
re-triggers `ExitRequested` — that follow-up exit must pass through without
re-flushing.

## Session shards: window close drops its shard, app exit keeps them all

Session state is one `session.json` holding a per-window shard keyed by
label (`workspace::save_session_shard` / `remove_session_shard` /
`session_payload_for`, all under `SessionFileLock`). The lifecycle rule:
`WindowEvent::CloseRequested`'s flush finisher removes the closing window's
shard (a window the user closed must not come back), while app exit
(`ExitRequested`, `quit_app`) keeps every shard (the user expects the whole
workspace back). `get_session_state` answers `"{}"` for a label with no
shard so a fresh editor window keeps its untitled tab instead of adopting
another window's session.

Shard removal is a read-modify-write over the shared `session.json`, so the
finisher must hold the same `SessionFileLock` as shard saves — a surviving
window's debounced save straddling the removal would otherwise resurrect the
closed shard from its stale in-memory copy. A failed removal must not trap
the window open: log and destroy regardless. Accepted residual (VS Code
parity): a **crash** can restore a window the user closed after that
window's last flush — the shard only disappears at close time, so a crash
before the finisher leaves the last-flushed shard on disk.
