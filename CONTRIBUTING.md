# Contributing to oh-my-md

Thanks for helping build a Markdown editor that stays out of your way. This guide covers setup, everyday commands, and the rules that keep a three-layer codebase (engine / desktop / Rust) healthy. For the full workspace conventions, see the [AGENTS.md](./AGENTS.md) family — it is written for coding agents but documents the same engineering rules.

> **Platform note:** oh-my-md runs on macOS, Windows, and Linux. Local development uses pnpm + Rust toolchain on any supported platform. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform-specific system dependencies.

## Setup

Prerequisites: Node.js LTS, [pnpm](https://pnpm.io/) ≥ 11 (or Corepack), a [Rust toolchain](https://rustup.rs/), and Xcode Command Line Tools.

```sh
git clone https://github.com/Zuixi/oh-my-md.git
cd oh-my-md
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

- The single source of version truth is `version` in `apps/desktop/src-tauri/tauri.conf.json`; the first public release is already synchronized at `0.0.1` across both `package.json` files, `Cargo.toml`, and the local `omd` entry in `Cargo.lock`. For later releases, `pnpm release:version <x.y.z>` synchronizes the source declarations. Generate release notes with `pnpm release:changelog` (requires a local [git-cliff](https://git-cliff.ch/)).
- Local packaged build: `pnpm --filter @omd/desktop tauri build`; the generated package format depends on the host platform.
- Pushing an unused matching `v<x.y.z>` tag builds an unsigned macOS Universal DMG, Windows x64 NSIS/MSI installers, Linux x64 AppImage/deb packages, **minisign-signed updater artifacts** (`.app.tar.gz(.sig)`, `-setup.exe.sig`, `.AppImage.tar.gz(.sig)`), and the **candidate updater manifest** `latest.json`, then creates exactly one Draft in GitHub Releases. Review every package, updater artifact, `latest.json`, and `SHA256SUMS.txt`, complete the packaging checklist in `docs/manual-qa.md`, and publish the Draft manually. A manual workflow run (`workflow_dispatch`) exercises the same builders/signing but stops at downloadable workflow artifacts — it does not create a Release. Releases are immutable: never reuse or move a tag, and promotion requires a strictly greater version.
- **Stable-channel promotion is separate from publication.** Publishing a Draft does not push any update. After the human publishes, the *protected manual* `promote-update.yml` (and `withdraw-update.yml`) workflows move the candidate to the GitHub Pages stable endpoint `https://zuixi.github.io/oh-my-md/updates/stable/latest.json`. They verify a public, non-Draft, non-prerelease Release at the exact tag, download only the manifest + signed updater artifacts, verify each with the committed minisign public key, require a strict version increase, deploy `updates/stable/*` through Pages, and re-fetch the public endpoint to compare its SHA-256. Withdrawal restores the previous known-good manifest and never deletes or edits a Release, tag, or asset; a defective version is fixed by a higher release, never a downgrade.
- **Repository settings are external prerequisites (not automated by the workflows):** GitHub Pages source must be **GitHub Actions**, and the `stable-updates` GitHub Environment must have **required reviewers** configured. Promotion/withdrawal runs fail closed until a maintainer configures both.
- **Updater key custody.** The minisign public key ships in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The private key lives only in the GitHub Actions secrets **`TAURI_SIGNING_PRIVATE_KEY`** (plus **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** when password-protected), which the tag workflow passes to the three package-building jobs only. The current key pair was generated previously: the public key has already shipped in repository configuration, the secret already exists in GitHub Actions, and the local recovery key is permission-restricted — this repository never inspected or rewrote the private-key contents. Maintainers must hold **at least two encrypted offline backup copies**; creating and verifying the second copy is a required prerequisite before the first updater-capable promotion. Never commit, print, log, cache, or upload the private key (repository files, `.env`, workflow artifacts, Release assets, and diagnostics are all forbidden). If the key is lost, existing clients can no longer trust future updates: withdraw the stable manifest, stop promotion, and ship a manually installed release carrying a new trust root. If it is suspected compromised, do the same plus remove the secrets and publish an advisory.
- **Package routing.** macOS (from DMG), Windows NSIS, and Linux AppImage installations can download and install updates in-app. Windows MSI and Linux deb are check-only by design: they surface the update and open the official GitHub Release page instead — the updater never mixes installer ownership.
- **`0.0.1` → `0.1.0`:** the originally released `0.0.1` cannot self-update; the first updater-capable public version is `0.1.0`, which 0.0.1 users must install manually once.

## Updating docs

If your change alters behavior, check whether these need updates before you finish: the domain `AGENTS.md` files, `docs/memory/known-gotchas.md`, `docs/manual-qa.md`, and the READMEs (user-visible behavior or setup changes).
