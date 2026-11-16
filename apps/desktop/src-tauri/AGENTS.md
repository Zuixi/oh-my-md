# Desktop Tauri & Rust Host

> **Parent:** [`../AGENTS.md`](../AGENTS.md)
> **Scope:** Native filesystem/window/menu/export commands, guarded document IO, and Tauri configuration (`apps/desktop/src-tauri/**`).

## Module Organization

- Apply the root size policy, including inline tests. Extract command domains into focused modules instead of growing `lib.rs` or `workspace.rs`; keep `lib.rs` focused on setup and `tauri::generate_handler!`.
- Move large inline test modules into sibling files (follow `src/documents/tests.rs`).
- Use `cfg!(target_os = "macos")` for runtime checks and `#[cfg(target_os = "macos")]` to exclude platform-specific imports/items from compilation; combine conditions with `any(...)`, not `|`. `export_preview` routes to the platform backend. Windows PDF uses the shared offscreen host and `export_pdf_windows.rs`; keep the PNG height cap out of paginated PDF printing.

## IPC Contract & Concurrency Rules

1. **Thin command boundary:** Follow the root IPC update contract. Validate argument names (Rust snake_case maps to JS camelCase), register commands in `tauri::generate_handler!`, and return `Result` or an explicit typed outcome rather than hiding errors.
2. **Enum variant camelCase trap:** `#[serde(tag = "kind", rename_all = "camelCase")]` on a Rust enum only renames variant tags, **not** struct variant fields. Add `#[serde(rename_all = "camelCase")]` on every struct variant with multi-word fields (`SaveDocumentResult`, `DiskSnapshot`) and assert the output with a `serde_json::to_string` unit test.
3. **Never block the main thread on IO:** Non-`async` commands run synchronously on the main thread and stall all queued IPC. Any command performing disk IO or blocking work must be `async fn` + `tauri::async_runtime::spawn_blocking` (only fast in-memory state or main-thread-required window/menu calls like `set_window_theme` / `set_recent_files` stay sync).
4. **Targeted window events (`emit_to`):** When emitting window-scoped events (`menu-command`, `open-file`, `session-flush`), the frontend listener in `desktopServices.ts` must use `listenTarget()` (`EventTarget::AnyLabel`), because Tauri's default `listen()` matches `Any` and fires in every window.
5. **Cross-layer constants:** Use the root named-value policy; `apps/desktop/test/crossLayerConstants.test.ts` guards native/TS contract drift.

## Subsystem Contracts

- **Guarded document IO (`documents.rs`, `documents/save.rs`):** Editor documents must use `stat_document`, `read_document`, `read_document_streaming`, `read_document_version`, and `save_document` (double-compare atomic write; `DocumentVersionCache` stat-first `(mtime_ns, size)` fingerprint). Never use legacy `read_file`/`write_file` for editor tabs.
- **Image & asset scope (`lib.rs` / `assets.rs`):** `write_image` requires `document_path`, validates magic bytes against extension, enforces `MAX_IMAGE_BYTES`, rejects symlinks/traversal, and writes only inside `<doc_dir>/assets/`. Call `allow_document_assets` after open/save.
- **Native menu (`menu.rs`):** Installs as global menubar on macOS only (`rebuild_from_state` no-ops off macOS). Window items (`window-minimize`, `window-zoom`, `window-fullscreen`, `window-bring-all-to-front`) use regular `MenuItem`s handled in `handle_window_command` — never `PredefinedMenuItem`. All other item ids/accelerators must match `commands.ts::MENU_TO_COMMAND` and `shortcuts.ts` (`test/crossLayerMenu.test.ts`).
- **Session flush & updater (`session_flush.rs`, `lib.rs`):** `prepare_update_restart` is `async` + `spawn_blocking` so `session_flush_ack` can arrive; it never exits on timeout and clears the flushed marker afterwards. `update_capability` derives install support from runtime `bundle_type()` (MSI/deb/rpm are check-only `manualPackage`).
- **App lifecycle (`app_lifecycle.rs`):** `quit_app` and `restart_app` live here (not `lib.rs`) and both go through `FlushGate`; `restart_app` uses `request_restart` so `ExitRequested`/`Exit` still run and the `session end clean=true` marker is written — a bare `restart()` would make the next launch report an abnormal exit.
- **Pre-paint theme (`lib.rs::startup_window_theme`):** Reads persisted `settings.json` during `setup` and applies `window.set_theme` before first paint.
- **Recovery drafts (`workspace/recovery.rs`):** A record is a versioned header (`OMD-RECOVERY 1` + one-line JSON `{"path": …}`) followed by the raw document bytes, so the draft's identity is not the lossy filename; headerless legacy files are still read as raw contents with `path: null`, and a corrupt header is preserved verbatim rather than guessed. `list_recoveries` reads only the header (never the body) and hides the `.`-prefixed staging leftovers a crash can leave. Keys are opaque frontend-derived names; writes go through `crate::atomic_write`. Reject empty/`..`/slash keys before joining the recovery directory.
- **Logging & diagnostics (`logging.rs`, `logging/{session,fields,frontend}.rs`, `diagnostics.rs`, `diagnostics/redaction/`):** Logging is opt-in: the composition root reads `settings.json` **once** and passes `logging_preferences(&raw)` into `install()`; `effective_level(LoggingPreferences)` is a pure function, and `logging.rs` never touches settings IO. An opted-out install probes nothing, creates no directory, registers no plugin, and reports `LogDestination::Off` (not `degraded`); `OMD_LOG=off` reports `LevelOff`. Install the panic hook before `Builder::default()`; register `tauri-plugin-log` inside `.setup()` after `probe_writable` (degrading to `temp_dir()` then `disabled` without panicking). Scan previous-session markers after plugin registration and before writing this run's `session start`; compare `loggingGeneration` so an unlogged interval cannot reuse old markers, and use the previous PID file for a fallback destination. Format paths via `logging::path_field` / `paths_field` (neutralizing boundary markers); redact only at diagnostics export time, including `environment.txt`'s `log_dir`. Export collects only this writer's own names (`{stem}.log` and `{stem}_YYYY-MM-DD_HH-MM-SS.log`), decodes non-UTF-8 lossily, and lists unreadable files in `manifest.json`'s `skipped_logs` instead of failing the bundle. Both `log_frontend` and `export_diagnostics` use `async` + `spawn_blocking` for file IO. `documents/save.rs` logs one terminal result; `save begin` is Debug-only.

## Verification

```sh
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

- IPC changes also require desktop contract tests; payload changes need serialized-JSON casing assertions. Run `pnpm verify` for the binary link gate, especially before multi-domain merges.
