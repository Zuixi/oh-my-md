<div align="center">
  <img src="docs/images/logo.png" width="110" alt="oh-my-md app icon" />

# oh-my-md

**A free, open-source Markdown editor with true live preview — built to stay fast on documents with hundreds of thousands of lines.**

[English](./README.md) · [简体中文](./README-zh.md)

[![CI](https://github.com/Zuixi/oh-my-md/actions/workflows/ci.yml/badge.svg)](https://github.com/Zuixi/oh-my-md/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20·%20Windows%20·%20Linux-black)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](./CONTRIBUTING.md)

</div>

![oh-my-md: dark theme with file tree and outline, live preview rendering KaTeX math and an inline Mermaid diagram](docs/images/hero.png)

<!-- TODO(demo-gif): record a 10–15 s demo GIF — ⌘E live⇄source toggle plus typing — save it as docs/images/demo.gif, then uncomment the line below.
![demo: toggle live preview and source mode with ⌘E](docs/images/demo.gif)
-->

## Why oh-my-md?

Typora proved that a Markdown editor can feel like a modern word processor — then it went closed-source and paid. MarkText kept the faith but hasn't shipped a release since 2022. **oh-my-md is a fresh attempt: free, Apache-2.0, wrapped in a lightweight Tauri shell, with an editing engine designed from day one for very large documents.**

|  | oh-my-md | Typora | MarkText |
| --- | --- | --- | --- |
| Open source | ✅ Apache-2.0 | ❌ | ✅ MIT |
| Price | Free | $14.99 | Free |
| Live preview, no split pane | ✅ | ✅ | ✅ |
| Responsive on 100k+ lines¹ | ✅ measured | — | — |
| Export | HTML · PDF · PNG | HTML · PDF · DOCX … | HTML · PDF |
| App shell | Tauri 2 | Electron | Electron |
| Platforms | macOS · Windows · Linux | macOS · Windows · Linux | macOS · Windows · Linux |

¹ "—" means no published figures, not a judgment on those editors.

## Features

**Writing**
- **True live preview** — Markdown marks fade into rendered content as you type; `⌘E` flips to a plain source mode any time
- **Full CommonMark + GFM** — tables, task lists, footnotes, strikethrough
- **Rich blocks** — KaTeX math, Mermaid diagrams, Shiki code highlighting, `==highlights==`, `:gemoji:`
- **Typewriter & Focus modes**, with careful IME handling for CJK input

**Files & workspace**
- Single-file centered — double-click any `.md` to open it; mount a folder workspace for a file tree, folder search, outline panel, and tabs
- Paste, drag, or pick images — they are stored in a local `assets/` folder beside your file
- Conflict-safe saving, external-change detection, crash and session recovery

**Export**
- HTML, PDF, and PNG output that matches the live preview exactly — formulas, code, and diagrams included

**Appearance**
- Light and dark themes with matching code themes, plus custom CSS
- Custom CSS themes the editor through public tokens — override `--omd-bg`, `--omd-fg`, `--omd-link`, `--omd-cursor`, `--omd-selection-bg`, `--omd-selection-bg-unfocused`, or the `--omd-syn-*` syntax palette on `html[data-theme="dark"|"light"]`

## Performance

One promise: **you should never split a document up because of the editor.**

- Keystroke latency stays far inside the 16 ms frame budget on every document we benchmark — **2 ms (p95, source mode) even on a 20 MB / 750k-line file**
- `⌘E` mode switching builds only a seed around the cursor — **sub-millisecond, independent of document size**
- Documents past 50k lines enter a *safe mode* (source view by default, viewport-windowed live rendering, remembered for the session) so editing stays responsive — you can still toggle live preview any time

| Document | Typing p95 (live / source) | Main-thread open |
| --- | --- | --- |
| 10k lines | 5.5 / 2 ms | 32 ms |
| 10 MB · 380k lines | 2.5 / 2 ms² | ~15 ms |
| 20 MB · 750k lines | — / 2 ms | ~30 ms |

² Safe mode: live rendering is viewport-windowed.

Figures come from the built-in advisory benchmark on an M-series machine — run `pnpm --filter @omd/engine bench` and see for yourself.

## Installation

oh-my-md is at **v0.1.0** and supports **macOS, Windows, and Linux**.

**Download** — builds will appear on the [Releases](https://github.com/Zuixi/oh-my-md/releases) page as soon as release automation is finalized. Until then, building from source takes about five minutes.

**Build from source** — you need [pnpm](https://pnpm.io/) (or Corepack) and a [Rust toolchain](https://rustup.rs/). Platform-specific: macOS requires Xcode Command Line Tools (`xcode-select --install`), Linux needs `libwebkit2gtk` and friends (see the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux)), and Windows needs Microsoft Visual Studio C++ Build Tools.

```sh
git clone https://github.com/Zuixi/oh-my-md.git
cd oh-my-md
pnpm install
pnpm dev        # launches the app
```

For a packaged `.app` / `.dmg`: `pnpm --filter @omd/desktop tauri build`.

## Keyboard shortcuts

Formatting sits on familiar keys (`⌘B`, `⌘I`, `⌘1`–`⌘6`, …), and every command is reachable from the command palette (`⇧⌘P`) — nothing to memorize. See the [full shortcut reference](./docs/guides/keyboard-shortcuts.md).

## Roadmap

- [ ] Signed, auto-updating releases
- [ ] Block-level AI actions (polish / continue / translate) via OpenAI-compatible APIs and local Ollama
- [ ] Plugin architecture — foundations already reserved in the design

## FAQ

- **Is it really free?** Yes. Apache-2.0, no account, no feature gates.
- **Where does my data live?** In plain `.md` files on your disk — nothing is uploaded, ever.
- **Windows or Linux?** All three platforms are supported.
- **Will it open my existing notes?** If they are Markdown, yes — CommonMark + GFM plus common extras such as `==highlight==`, footnotes, KaTeX math, and Mermaid.
- **What about AI?** Designed but not shipped yet — see the [roadmap](#roadmap).

## Contributing

Issues and pull requests are welcome! Start with [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup, the per-domain test matrix, and commit conventions. `pnpm verify` should pass before you open a PR.

## Acknowledgments

Built on excellent open source: [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/), [Tauri](https://tauri.app/), [KaTeX](https://katex.org/), [Mermaid](https://mermaid.js.org/), [Shiki](https://shiki.style/), [React](https://react.dev/), and [Vite](https://vite.dev/). Typora's interaction design remains a standing inspiration.

## License

[Apache-2.0](./LICENSE)
