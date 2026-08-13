# oh-my-md

> **What is this?** A macOS-first, open-source desktop Markdown editor built around CodeMirror 6 live preview and a Tauri 2 host.
>
> **Progressive disclosure:** Use this file for workspace orientation and cross-layer rules. Before changing a domain, read its nearest `AGENTS.md`.

## Task Routing


| If you are working on...                                                     | Read first                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Markdown parsing, decorations, live/source mode, block widgets, engine tests | `[packages/engine/AGENTS.md](./packages/engine/AGENTS.md)`                                                       |
| React lifecycle, editor hosting, styles, shortcuts, image paste, Tauri IPC   | `[apps/desktop/AGENTS.md](./apps/desktop/AGENTS.md)`                                                             |
| Product scope or architecture decisions                                      | `[docs/superpowers/specs/2026-08-10-oh-my-md-design.md](./docs/superpowers/specs/2026-08-10-oh-my-md-design.md)` |
| Known rendering, testing, or integration traps                               | `[docs/memory/known-gotchas.md](./docs/memory/known-gotchas.md)`                                                 |
| A bug spanning domains                                                       | Read this file, then every affected domain guide                                                                 |




## Workspace Map

```text
oh-my-md/
├── apps/desktop/          # React 19 + CodeMirror host + Tauri 2 application
│   ├── src/               # Frontend lifecycle, editor assembly, IPC callers, CSS
│   └── src-tauri/         # Rust commands and native application host
├── packages/engine/       # Markdown language support and live-preview behavior
│   ├── src/               # Lezer parsing, decorations, modes, widgets
│   └── test/              # Vitest tests and Markdown fixtures
└── docs/                  # Product specs, implementation plans, QA, agent memory
```

The repository intentionally uses plain pnpm workspaces; do not add Turborepo or Nx for the current two-package graph.

## Runtime Graph

```text
React App
  ├── Editor.ts ──► @omd/engine ──► CodeMirror / Lezer / DOM widgets
  ├── styles.css ──► visual styles for engine-emitted omd-* classes
  └── Tauri invoke ──► src-tauri Rust commands ──► filesystem / native OS
```

`@omd/engine` is consumed directly from `src/index.ts`; it has no separate package build step.

## Commands and Verification

Use pnpm for JavaScript workspace tasks and Cargo for Rust tasks.

```sh
pnpm dev
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

- `pnpm test` runs engine TypeScript checking (`tsc --noEmit`) before Vitest.
- Use `pnpm --filter @omd/desktop tauri build` only when a packaged desktop build is relevant.
- Run the checks matching the changed domains; cross-layer changes require both frontend/engine and Rust checks.
- Before a release or interaction-sensitive editor change, review `[docs/manual-qa.md](./docs/manual-qa.md)`. Its recorded test counts are historical, not assertions about the current suite.
- There is currently no repository-wide lint, format, or CI command. Do not claim those checks passed.



## Cross-Layer Boundaries

1. **Engine owns Markdown semantics.** Lezer extensions, Markdown-specific decorations, live/source mode, and preview widgets belong in `packages/engine`.
2. **Desktop owns host behavior.** React lifecycle, generic CodeMirror editing behavior, base theme, CSS, file dialogs, shortcuts, and IPC orchestration belong in `apps/desktop/src`.
3. **Rust owns native effects.** Filesystem writes and other OS operations belong in `apps/desktop/src-tauri`; expose narrow Tauri commands and call them from TypeScript.
4. **Do not duplicate parsing.** Desktop and Rust code must not reimplement Markdown syntax detection already owned by the engine.
5. **Keep the engine framework-independent.** It must not import React or Tauri. It may use browser DOM APIs for CodeMirror widgets; tests provide `happy-dom`.
6. **Preserve source text.** Preview is a projection of the Markdown document. Decorations and widgets must not silently rewrite user content.



## Workspace Conventions

- Write strict TypeScript and avoid `any`; use named exports except framework/config files that conventionally require default exports.
- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion` in `createEditor`; they conflict with current live-preview behavior. Gemoji completion is a `:`-only override inside `editorExtensions`.
- Keep window-level handlers stable with refs so listeners are not repeatedly registered as React state changes.
- Do not edit or discard unrelated working-tree changes. Inspect the current diff before broad or mechanical edits.
- Prefer the smallest rule set that preserves current behavior; future milestones in design documents are not automatically current implementation requirements.



## Documentation Maintenance

Before finishing a task, check whether these need updates:

- [ ] Root or domain `AGENTS.md` — Did routing, ownership, constraints, or recurring pitfalls change?
- [ ] `docs/memory/known-gotchas.md` — Did you discover a reusable trap or invalidate an existing one?
- [ ] Product spec or implementation plan — Did an approved architecture or milestone decision change?
- [ ] `docs/manual-qa.md` — Did user-visible interaction behavior or the release verification matrix change?
- [ ] README or changelog — Did public setup or user-visible behavior change?

Add permanent agent rules only when they describe verified, recurring project constraints rather than a one-off implementation choice.