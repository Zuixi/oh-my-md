# oh-my-md

> **What is this?** A cross-platform, open-source desktop Markdown editor built around CodeMirror 6 live preview and a Tauri 2 host. macOS, Windows (NSIS/MSI), and Linux (AppImage/deb/rpm) are first-class targets; platform branches go only through `apps/desktop/src/platform.ts` (TS, unknown → macOS) or `cfg!(target_os = …)` (Rust). Native PDF/PNG export (`export_preview`) is the single deliberate macOS-only feature.
>
> **Progressive disclosure:** Read this file, every applicable ancestor `AGENTS.md`, then the nearest guide before editing. Rules accumulate; a deeper guide overrides only a conflicting local rule, not the rest of its parents. Follow explicit cross-directory links too: a `Scope` description does not extend filesystem inheritance. For tests, also read the guide governing the behavior under test.

## Task Routing

| If you are working on... | Read first |
| --- | --- |
| Engine public surface, outline, stats, HTML export, ordered-list state | [`packages/engine/AGENTS.md`](./packages/engine/AGENTS.md) |
| Live-preview `StateField`, progressive/windowed build, `atomicRanges`, `BlockWidget` | [`packages/engine/src/decorations/AGENTS.md`](./packages/engine/src/decorations/AGENTS.md) |
| Formatting commands, `Prec.highest` Enter/Tab/Backspace chain, `blockPrefix` | [`packages/engine/src/format/AGENTS.md`](./packages/engine/src/format/AGENTS.md) |
| Table model, Lezer-range edits, toolbars, cell parsing | [`packages/engine/src/tables/AGENTS.md`](./packages/engine/src/tables/AGENTS.md) |
| Lezer Markdown dialect extensions, `chars.ts`, `inVerbatim` | [`packages/engine/src/parse/AGENTS.md`](./packages/engine/src/parse/AGENTS.md) |
| React shell, CodeMirror host (`Editor.ts`), CSS, shortcuts, save/update flows | [`apps/desktop/AGENTS.md`](./apps/desktop/AGENTS.md) |
| Tauri Rust commands, guarded IO, native menu, asset scope, installer bitmaps | [`apps/desktop/src-tauri/AGENTS.md`](./apps/desktop/src-tauri/AGENTS.md) |
| Quality gates, scripts, Git hooks, CI | `scripts/check-module-size.mjs`, `.githooks/classify.py`, `.github/workflows/ci.yml` |
| Product scope or architecture decisions | [`docs/superpowers/specs/2026-08-10-oh-my-md-design.md`](./docs/superpowers/specs/2026-08-10-oh-my-md-design.md) |
| Known traps & historical debugging notes | [`docs/memory/known-gotchas.md`](./docs/memory/known-gotchas.md) → `gotchas-engine/desktop/rust.md` |
| Finding or writing a doc (spec, plan, QA, guide) | [`docs/AGENTS.md`](./docs/AGENTS.md) |

## Workspace Map

```text
oh-my-md/
├── apps/desktop/          # React 19 + CodeMirror host + Tauri 2 application
│   ├── src/               # Frontend lifecycle, editor assembly, IPC callers, i18n/, CSS
│   └── src-tauri/         # Rust commands, guarded document IO, menu, watcher, native export
├── packages/engine/       # Framework-independent Markdown language support & live preview
│   ├── src/               # parse/ · decorations/ · format/ · tables/ · navigation/ · export/ · paste/
│   └── test/              # Vitest tests and Markdown fixtures
├── scripts/               # Build/test/release entry points (*.sh, *.ps1), installer bitmaps, perf smoke
├── .github/               # CI path filters + engine/desktop/rust/bench + release workflows
├── .githooks/             # pre-commit (domain tests) + commit-msg (conventional type prefix)
└── docs/                  # Product specs, implementation plans, manual QA, guides, agent memory
```

`@omd/engine` is consumed directly from `packages/engine/src/index.ts` (plain pnpm workspace; do not add Turborepo or Nx).

## Commands and Verification

```sh
pnpm dev
pnpm check:quality                                                 # module-size gate + its behavior tests
pnpm test                                                          # engine tsc --noEmit + Vitest
pnpm --filter @omd/engine bench                                    # advisory large-doc benchmarks
pnpm --filter @omd/desktop test                                    # desktop Vitest suite
pnpm --filter @omd/desktop build                                   # desktop tsc + Vite bundle
pnpm --filter @omd/desktop test:e2e                                # Playwright real-browser layout suite
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml       # Rust unit tests
pnpm verify                                                        # full test + Rust binary link check
```

- Run the checks matching the changed domains; cross-layer changes require both frontend/engine and Rust checks.
- Add a focused regression test for changed behavior; for bug fixes, observe it fail before the fix and pass afterwards. Test observable outcomes, stale/error paths, and relevant boundaries, not private implementation text or arbitrary coverage percentages.
- Engine changes also require desktop contract tests. Appearance/interaction changes require the relevant real-browser checks and `docs/manual-qa.md`; structural happy-dom assertions do not prove layout.
- `cargo test` does not link the app binary; `pnpm verify` (`scripts/test.*` + `scripts/build.*`) runs `cargo build --no-default-features` to catch link-stage failures.
- Run `pnpm verify` before releases or multi-domain merges. Local hooks are feedback, not a substitute for CI.
- There is no repo-wide lint/format script in `pnpm verify`; do not claim lint/format passed unless run explicitly.

## Cross-Layer Boundaries

1. **Engine owns Markdown semantics.** Lezer extensions, Markdown decorations, live/source mode, and preview widgets belong in `packages/engine` (zero React or Tauri imports).
2. **Desktop owns host behavior.** React lifecycle, generic CodeMirror host setup, base theme, CSS (`styles.css`), file dialogs, shortcuts, and IPC orchestration belong in `apps/desktop/src`.
3. **Rust owns native effects.** Filesystem writes, menus, and OS integration belong in `apps/desktop/src-tauri` behind narrow Tauri commands.
4. **Do not duplicate parsing.** Desktop and Rust code must never reimplement Markdown syntax detection owned by the engine.
5. **Preserve source text.** Preview is a projection of the Markdown document; decorations and widgets must not silently rewrite user content.
6. **IPC changes span both sides.** Any change to a Tauri command's arguments or return type must update the Rust command, `desktopServices.ts`, all TS consumers, and a Rust `serde_json::to_string` field-casing assertion in the same change.
7. **Shared constants have named homes and drift guards.** Cross-layer limits/keys live in `apps/desktop/src/constants.ts` ↔ Rust (`crossLayerConstants.test.ts`); ASCII parser codes live in `packages/engine/src/parse/chars.ts`; shortcuts live in engine keymaps and `apps/desktop/src/shortcuts.ts` (`crossLayerMenu.test.ts`).

## Code & Module Style

### Module Size & Ownership
- **Target <= 500 physical lines; hard limit 800.** Count comments, blank lines, and tests, including inline Rust tests. The gate covers TS/JS, Rust, and Python; generated or vendored names are not automatic exemptions. Never compress formatting or delete useful explanations to evade it.
- **Legacy oversized files may only shrink.** `scripts/module-size-baseline.json` records existing caps; the gate also compares against the base revision so reductions cannot be reclaimed. Never add or increase a legacy allowance. Remove entries when files are deleted or reach the hard limit.
- Split by cohesive responsibility and state ownership, not arbitrary line counts. A module should have one explainable purpose and a narrow interface; avoid pass-through wrappers, catch-all `utils`, or abstractions for hypothetical reuse.
- Put new behavior outside growth-frozen hotspots (`App.tsx`, Rust `lib.rs`/`workspace.rs`, engine `decorations/widgets/table.ts`/`blocks.ts`); keep only thin wiring there. Move large Rust inline tests into sibling test modules.
- Reuse existing helpers before adding logic. Keep one owner for each state; derive projections instead of synchronizing duplicate mutable facts. Keep parsers/edit plans pure where possible and put dispatch, IO, and notifications at explicit execution boundaries.

### Numbers, Units & Shared Contracts
- Name behavioral values: delays/timeouts (`*_MS`), byte limits (`*_BYTES`), retries, cache capacities, parser codes, and protocol identifiers. Reuse an existing named home; do not introduce unexplained literals or vague names such as `LIMIT`.
- Keep single-use constants private and near their use. Promote only genuinely shared contracts; never turn `constants.ts` into a dump of unrelated values. Cross-layer values require named definitions on both sides and drift assertions.
- Do not extract self-evident indexes, increments, or empty checks into `ZERO`/`ONE`. Use CSS tokens for semantic/reused theme values, not every ordinary `1px` border.

### State, Errors & Async Work
- Validate at trust boundaries and represent mutually exclusive states with discriminated unions. Do not bypass contracts with unsafe assertions.
- Capture and revalidate target identity/version before applying async results. Cancellation, stale completion, and failure are distinct outcomes; none may masquerade as success or erase newer edits.
- Surface failures through the domain's error channel. Never use empty catches, silent data loss, or success-shaped fallback values. A deliberate degraded rendering path must preserve source and expose its degraded state.

### TypeScript & Control Flow
- Write strict TypeScript without `any`; use named exports (except `App.tsx` and framework configs).
- Make exported functions read as the happy path; place supporting validation or lowering helpers below them in the same file.
- Do not extract single-use helpers preemptively unless they name a real domain boundary or clarify a complex caller.
- Prefer `const` over `let` and early returns over `else` branches.
- Add comments for non-obvious invariants and browser/OS quirks, not for obvious control flow.

### Operational Safety
- Inspect the working-tree diff before editing. Preserve unrelated WIP, including changes in files you touch; never switch branches, stash, revert, or clean up someone else's work without permission.
- **Isolate parallel feature branches in `.worktrees/<name>`** when working concurrently so you never switch branches, stash, or revert unrelated WIP in the main checkout.
- **Never spawn CPU-saturating processes** (busy loops, `stress`, load generators) on the dev machine; make timing-sensitive tests deterministic by construction.
- **`AGENTS.md` authoring:** Give each rule one authoritative home. Local guides describe scope/entry points, invariants, approved exceptions, related guides/tests, and verification; link shared rules rather than repeating them. State the trigger and required behavior with a code/test anchor. Keep only verified current contracts mandatory; label future designs explicitly. Put incident narratives in `docs/memory/gotchas-*.md`.

## Documentation Maintenance

Before finishing a task, check whether updates are needed in:
- [ ] Nearest `AGENTS.md` (routing, module layout, or recurring invariants)
- [ ] `docs/memory/known-gotchas.md` + `gotchas-engine/desktop/rust.md` (new reusable traps)
- [ ] `docs/superpowers/specs/` or `docs/superpowers/plans/` (architecture or milestone changes)
- [ ] `docs/manual-qa.md` or `docs/guides/` (user-visible interaction or shortcut changes)
