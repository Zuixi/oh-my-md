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
| Finding or writing a doc (spec, plan, QA, guide, competitor note)            | `[docs/AGENTS.md](./docs/AGENTS.md)`                                                                            |
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
├── .github/               # CI：changes 路径过滤 + engine/desktop/rust(含 link gate)/bench；复合 action 在 .github/actions（发布流水线阻塞于 Apple 账号）
└── docs/                  # Product specs, implementation plans, QA, guides, agent memory
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
pnpm verify
pnpm --filter @omd/engine bench
scripts/build.sh
scripts/test.sh
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm release:version <x.y.z>
pnpm release:changelog
```

- `pnpm test` runs engine TypeScript checking (`tsc --noEmit`) before Vitest.
- `pnpm --filter @omd/engine bench` 跑 advisory 大文档基准（typing p95/冷解析/装饰重建/字数统计/切Live种子/open-live摄入/安全模式窗口化typing）；预算超限只告警不阻断，CI 中 continue-on-error。
- `scripts/build.sh` and `scripts/test.sh` are the standalone build/test entry points for agents and humans; `pnpm verify` runs `test.sh` then `build.sh`. `build.sh` links the Rust app binary (`cargo build --no-default-features`, matching what `tauri dev` runs); `test.sh` covers engine, desktop, and `cargo test` — but `cargo test` alone never links the app binary, so it cannot catch link-stage failures such as stale `src-tauri/target` artifacts after a toolchain upgrade. Use `pnpm verify` before a release or any multi-domain merge.
- Use `pnpm --filter @omd/desktop tauri build` only when a packaged desktop build is relevant.
- Run the checks matching the changed domains; cross-layer changes require both frontend/engine and Rust checks.
- Before a release or interaction-sensitive editor change, review `docs/manual-qa.md`. Its recorded test counts are historical, not assertions about the current suite.
- There is no repository-wide lint or format command, and `pnpm verify` does not lint or format. Do not claim lint/format checks passed.
- `release:version` 同步四处版本号（tauri.conf.json 为单一来源），`release:changelog` 用 git-cliff 从 conventional commits 生成 CHANGELOG。两者只在发版时使用；`release:changelog` 依赖本机 `git-cliff`。



## Cross-Layer Boundaries

1. **Engine owns Markdown semantics.** Lezer extensions, Markdown-specific decorations, live/source mode, and preview widgets belong in `packages/engine`.
2. **Desktop owns host behavior.** React lifecycle, generic CodeMirror editing behavior, base theme, CSS, file dialogs, shortcuts, and IPC orchestration belong in `apps/desktop/src`.
3. **Rust owns native effects.** Filesystem writes and other OS operations belong in `apps/desktop/src-tauri`; expose narrow Tauri commands and call them from TypeScript.
4. **Do not duplicate parsing.** Desktop and Rust code must not reimplement Markdown syntax detection already owned by the engine.
5. **Keep the engine framework-independent.** It must not import React or Tauri. It may use browser DOM APIs for CodeMirror widgets; tests provide `happy-dom`.
6. **Preserve source text.** Preview is a projection of the Markdown document. Decorations and widgets must not silently rewrite user content.
7. **IPC field casing is a tested contract.** TypeScript types cannot catch wire-format drift (runtime `undefined` compiles fine), and desktop tests mock services at the TS boundary. Any Rust payload with multi-word fields needs a serialized-JSON assertion in Rust tests — see the "IPC casing trap" in `apps/desktop/AGENTS.md`.
8. **IPC changes span both sides — or they silently do nothing.** A Tauri command change to arguments or return type must update the Rust command, the `desktopServices.ts` invoke caller, and every TypeScript consumer in the same change. Leaving the frontend on the old contract makes the invoke reject (missing/extra arg) or the UI read the wrong shape — it compiles, passes tests (which mock services at the TS boundary), and fails only at runtime. This is what broke folder search: `search_markdown` gained `case_sensitive` and returned `SearchResponse` while `desktopServices.ts` still called it with `{ root, query }` and typed the result as `SearchHit[]`.



## Workspace Conventions

- Write strict TypeScript and avoid `any`; use named exports except framework/config files that conventionally require default exports.
- Do not enable `indentOnInput`, `closeBrackets`, or generic `autocompletion` in `createEditor`; they conflict with current live-preview behavior. Gemoji completion is a `:`-only override inside `editorExtensions`.
- Keep window-level handlers stable with refs so listeners are not repeatedly registered as React state changes.
- Do not hard-code values that have a named home. Shared/cross-layer limits and storage keys live in `apps/desktop/src/constants.ts` (drift-guarded against Rust/CSS by `apps/desktop/test/crossLayerConstants.test.ts`); ASCII punctuation in the engine parsers uses the named constants in `packages/engine/src/parse/chars.ts`; shortcut labels are owned by the engine keymap and `apps/desktop/src/shortcuts.ts`; native menu wiring must match `commands.ts` `MENU_TO_COMMAND` (guarded by `apps/desktop/test/crossLayerMenu.test.ts`). If a value must agree across two sides (TS↔Rust, TS↔CSS, keymap↔palette), define it on both sides as a named constant and add a drift test — never leave one side as a bare literal.
- Do not edit or discard unrelated working-tree changes. Inspect the current diff before broad or mechanical edits.
- Prefer the smallest rule set that preserves current behavior; future milestones in design documents are not automatically current implementation requirements.
- Dangerous shell commands are blocked by [`.cursor/hooks.json`](./.cursor/hooks.json) (`beforeShellExecution`). Cursor currently ignores hook `permission: ask`, so the guard returns `deny`. Add or adjust patterns in [`.cursor/hooks/guard-dangerous.sh`](./.cursor/hooks/guard-dangerous.sh). To run a blocked command, execute it yourself in the integrated terminal (human terminals do not trigger hooks).
- Never spawn CPU-saturating processes on the dev machine — busy loops (`while :; do :; done`), fork bombs, `stress`/`stress-ng`, or any load-generation script — for any reason, including "verifying flaky tests under load". Make such tests deterministic by construction instead; load-sensitive checks are the user's to run.
- 平台分支只经 `apps/desktop/src/platform.ts`（TS）或 `cfg!(target_os = …)`（Rust），不得散落 UA/平台字符串比较；未知平台按 macOS 处理。
- Git hooks live in [`.githooks/`](./.githooks/). `pnpm install` sets `core.hooksPath` via the root `prepare` script.
  - `pre-commit` runs domain tests for staged paths: `packages/engine/**` → `pnpm test`; `apps/desktop/src|test|package files` → `pnpm --filter @omd/desktop test`; `apps/desktop/src-tauri/**` → `cargo fmt --check` and `cargo test`. Docs-only commits skip.
  - `commit-msg` strips any `Co-authored-by:` trailer (Cursor, Copilot, etc.), then requires `<type>: <why>` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`). Merge and Revert subjects are allowed.



## Documentation Maintenance

Before finishing a task, check whether these need updates:

- [ ] Root or domain `AGENTS.md` — Did routing, ownership, constraints, or recurring pitfalls change?
- [ ] `docs/memory/known-gotchas.md` — Did you discover a reusable trap or invalidate an existing one?
- [ ] Product spec or implementation plan — Did an approved architecture or milestone decision change?
- [ ] `docs/manual-qa.md` — Did user-visible interaction behavior or the release verification matrix change?
- [ ] README or changelog — Did public setup or user-visible behavior change?

Add permanent agent rules only when they describe verified, recurring project constraints rather than a one-off implementation choice.