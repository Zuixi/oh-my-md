# Desktop Domain

> **Parent:** [`../../AGENTS.md`](../../AGENTS.md)
>
> **Scope:** React application lifecycle, CodeMirror host assembly, desktop styles, file dialogs, image paste, and the Tauri Rust host.

## Read This When

- You are changing `apps/desktop/src/**`.
- You are changing native commands, capabilities, or packaging under `apps/desktop/src-tauri/**`.
- You are debugging behavior that crosses React, CodeMirror, CSS, and Tauri IPC.

## Local Structure

```text
apps/desktop/
├── src/
│   ├── App.tsx              # Editor lifecycle, file open/save, dirty state, shortcuts
│   ├── Editor.ts            # Generic CM6 extensions, engine assembly, base theme
│   ├── imagePaste.ts        # Clipboard image → Tauri write_image → Markdown insertion
│   ├── main.tsx             # React mount
│   └── styles.css           # App styles and all engine-emitted omd-* presentation
└── src-tauri/
    ├── src/lib.rs           # read_file, write_file, write_image commands and tests
    ├── capabilities/        # Tauri permissions
    └── tauri.conf.json      # Desktop application configuration
```

## Frontend Boundaries

1. React owns application state and lifecycle; do not put React state or hooks in `@omd/engine`.
2. `Editor.ts` owns generic editing behavior and the base editor theme. Markdown language support and preview behavior must come from `editorExtensions`.
3. Do not duplicate Lezer traversal or Markdown syntax recognition in the desktop layer.
4. Engine-generated `omd-*` classes are styled in `styles.css`. Coordinate class changes with the engine in the same task.
5. Native filesystem effects must use narrow Tauri commands. Browser-side code may select paths and orchestrate calls, but must not emulate native path/file operations.
6. Keep `App.tsx` as the current default-export exception; use named exports for ordinary modules.

## CodeMirror Host Rules

- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion`; current live-preview decorations conflict with them. Emoji `:` completion comes from `editorExtensions`.
- Preserve history, selection drawing, drop cursor, active-line highlighting, and standard editing keymaps unless the task explicitly changes host behavior.
- Pass host-dependent behavior through engine options, such as resolving Markdown image sources to loadable URLs.
- Destroy `EditorView` during React cleanup and clear retained references.
- Window-level shortcuts must use stable listeners and refs to observe current mutable state without re-registering on each render.
- CodeMirror's keymap owns editing commands; window handlers should be limited to application-level commands such as open/save.
- Replace an opened document with a fresh `EditorState`; synchronize the document path first so initial image resolution is correct and undo history cannot cross files.

## Tauri and File Rules

Current Rust commands are:

- `read_file(path)` — read Markdown as UTF-8 text.
- `write_file(path, contents)` — atomically replace the current document.
- `write_image(path, base64, documentPath)` — decode pasted image data into the current document's `assets/` directory. `documentPath` is required.
- `allow_document_assets(documentPath)` — grant the asset protocol access to that document's directory.

When adding or changing a command:

1. Keep the IPC entrypoint thin and return `Result<_, String>` or a deliberately introduced shared error shape.
2. Validate frontend argument names against the Rust command signature.
3. Register the command in `tauri::generate_handler!`.
4. Check whether Tauri capabilities or plugins must change.
5. Add Rust tests for native behavior and failure paths.

Do not silently overwrite in-memory content after a failed read/write. Preserve the current document and surface the error.

## Image Paste Invariants

- Non-image clipboard content must fall through to CodeMirror's default paste behavior.
- The document must have a saved path before inserting a relative `assets/...` reference.
- Write image bytes successfully before inserting Markdown into the document.
- Keep the stored Markdown path relative; resolve it for display through the engine host callback rather than rewriting source to an absolute file URL.
- Path handling must continue to account for slash normalization on supported desktop paths.
- Capture path, document identity, document value, and selection before asynchronous work. Serialize concurrent pastes and revalidate before writing and dispatching.
- Pass the current Markdown path as `documentPath` so Rust can bind the write to that document's `assets/` directory. The command rejects writes that omit it.
- After a successful open or save, call `allow_document_assets` before the first local image load.

## Verification

For TypeScript/React/CSS changes:

```sh
pnpm --filter @omd/desktop build
```

For engine behavior used by the desktop:

```sh
pnpm test
```

For Rust/Tauri command changes:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Use `pnpm dev` for manual interaction checks. Review the relevant sections of `docs/manual-qa.md`, especially file IO, IME, undo/redo, mode switching, and large-document scrolling.

## Common Pitfalls

- React state captured by a one-time window listener becomes stale; route changing handlers through refs.
- Dirty state is transaction-driven and compared with the last saved/opened text, so undoing to that baseline becomes clean again.
- Engine class names without matching CSS appear structurally correct in tests but broken in the desktop.
- Tauri dialog cancellation is a normal result, not an error.
- Image writing and Markdown insertion are asynchronous; inserting before a successful write or allowing concurrent operations to race creates broken or orphaned assets.
- Static window values in `tauri.conf.json` and runtime window behavior can drift if both are later used.

## Documentation Maintenance

Before concluding desktop work, check:

- [ ] Did the frontend/Rust ownership boundary or command list change?
- [ ] Did an `omd-*` class require a coordinated engine or CSS update?
- [ ] Did user-visible interaction require a `docs/manual-qa.md` update?
- [ ] Did a reusable integration trap belong in `docs/memory/known-gotchas.md`?
- [ ] Did setup, packaging, or supported behavior require README/spec updates?
