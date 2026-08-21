# Contributing to oh-my-md

Thanks for helping build a Markdown editor that stays out of your way. This guide covers setup, everyday commands, and the rules that keep a three-layer codebase (engine / desktop / Rust) healthy. For the full workspace conventions, see the [AGENTS.md](./AGENTS.md) family — it is written for coding agents but documents the same engineering rules.

> **Platform note:** oh-my-md runs on macOS, Windows, and Linux. Local development uses pnpm + Rust toolchain on any supported platform. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform-specific system dependencies.

## Setup

Prerequisites: Node.js LTS, [pnpm](https://pnpm.io/) ≥ 11 (or Corepack), a [Rust toolchain](https://rustup.rs/), and Xcode Command Line Tools.

```sh
git clone https://github.com/Zuixi/open-md.git
cd open-md
pnpm install      # also wires up the git hooks from .githooks/
pnpm dev          # launch the Tauri dev window
```

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Tauri dev window with hot reload |
| `pnpm test` | Engine checks: `tsc --noEmit` + Vitest |
| `pnpm --filter @omd/desktop test` | Desktop checks: `tsc --noEmit` + Vitest |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | Rust unit tests |
| `pnpm --filter @omd/engine bench` | Advisory large-document benchmark (warns on budget misses, never blocks) |
| `pnpm verify` | `scripts/test.sh` + `scripts/build.sh` — everything, including linking the Rust app binary |

Run the checks matching the domains you touched; cross-layer changes need both sides. **Open a PR only after `pnpm verify` passes** — `cargo test` alone never links the app binary, so it cannot catch link-stage failures such as stale `src-tauri/target` artifacts after a toolchain upgrade.

There is no repository-wide lint or format command. Please match the style of the code you are editing.

## Repository map & boundaries

```text
apps/desktop/src/         React host: lifecycle, editor assembly, styles, shortcuts, IPC callers
apps/desktop/src-tauri/   Rust: native commands (filesystem, window/menu) — keep the IPC surface thin
packages/engine/src/      Pure-TS editor engine: Lezer parsing, decorations, live/source modes, widgets
```

The rules that matter most (full list in [AGENTS.md](./AGENTS.md)):

1. **Engine owns Markdown semantics; desktop owns host behavior; Rust owns native effects.** Don't duplicate parsing across layers.
2. **The engine stays framework-independent** — no React or Tauri imports there.
3. **Preserve source text.** Live preview is a projection of the document; decorations must never rewrite user content.
4. **IPC changes span both sides in the same PR** — the Rust command, the `desktopServices.ts` invoke caller, and every TypeScript consumer. Multi-word payload fields need a serialized-JSON assertion in a Rust test: casing drift compiles fine and only fails at runtime.
5. **Named constants over bare literals** for anything that must agree across TS/Rust/CSS/keymap, guarded by a drift test. Existing guards: `apps/desktop/test/crossLayerConstants.test.ts`, `apps/desktop/test/crossLayerMenu.test.ts`.

## Commits & hooks

Commits follow `<type>: <why>` with types `feat | fix | refactor | docs | test | chore | perf | ci` (merge and revert subjects are allowed as-is). Git hooks (installed by `pnpm install`) run domain tests for staged paths on `pre-commit` and validate the subject on `commit-msg`; `Co-authored-by:` trailers are stripped automatically.

## Releasing (maintainers)

- The single source of version truth is `version` in `apps/desktop/src-tauri/tauri.conf.json`. Bump with `pnpm release:version <x.y.z>` (syncs conf / `Cargo.toml` / both `package.json` files), then generate the changelog with `pnpm release:changelog` (requires a local [git-cliff](https://git-cliff.ch/)).
- Local packaged build: `pnpm --filter @omd/desktop tauri build` → `.app` / `.dmg` (bundle includes `.md` file association and updater signing material).
- The release pipeline (signing/notarization + GitHub Release + `latest.json`) is pending Apple Developer account approval. The updater signing key is already in GitHub secrets; once CI publishes `latest.json`, the in-app "Check for Updates…" flow works end to end.

## Updating docs

If your change alters behavior, check whether these need updates before you finish: the domain `AGENTS.md` files, `docs/memory/known-gotchas.md`, `docs/manual-qa.md`, and the READMEs (user-visible behavior or setup changes).
