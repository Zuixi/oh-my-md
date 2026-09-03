<div align="center">
  <img src="docs/images/logo.png" width="110" alt="oh-my-md app icon" />

# oh-my-md — Fast Open-Source Markdown Editor

**A free Markdown editor with true live preview, built to stay fast on documents with hundreds of thousands of lines.**

[**Download the latest release →**](https://github.com/Zuixi/oh-my-md/releases/latest)

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
- **HTML export works on macOS, Windows, and Linux.**
- **PDF and PNG export are currently macOS-only.** All formats preserve formulas, highlighted code, tables, and diagrams from the live preview.

**Appearance**
- Light and dark themes with matching code themes, plus custom CSS
- Custom CSS themes the editor through public tokens — override `--omd-bg`, `--omd-fg`, `--omd-link`, `--omd-cursor`, `--omd-selection-bg`, `--omd-selection-bg-unfocused`, or the `--omd-syn-*` syntax palette on `html[data-theme="dark"|"light"]`

## Performance

One promise: **you should never split a document up because of the editor.**

- Keystroke latency stays far inside the 16 ms frame budget on every document we benchmark — **2 ms (p95, source mode) even on a 20 MB / 750k-line file**
- `⌘E` mode switching builds only a seed around the cursor — **sub-millisecond, independent of document size**
- Large documents use viewport-windowed live rendering so editing stays responsive

| Document | Typing p95 (live / source) | Main-thread open |
| --- | --- | --- |
| 10k lines | 5.5 / 2 ms | 32 ms |
| 10 MB · 380k lines | 2.5 / 2 ms² | ~15 ms |
| 20 MB · 750k lines | — / 2 ms | ~30 ms |

² Safe mode: live rendering is viewport-windowed.

Figures come from the built-in advisory benchmark on an M-series machine — run `pnpm --filter @omd/engine bench` and see for yourself.

## Download

[**Download the latest oh-my-md release from GitHub Releases →**](https://github.com/Zuixi/oh-my-md/releases/latest)

| Platform | Download | Notes |
| --- | --- | --- |
| macOS | Universal `.dmg` | One package for Apple Silicon and Intel Macs |
| Windows x64 | `-setup.exe` **(recommended)** or `.msi` | NSIS installer is the easiest choice; MSI is provided for managed installs |
| Linux x64 | `.AppImage` or `.deb` | AppImage is portable; deb is for Debian/Ubuntu-based systems |

### Unsigned package warning

The first release is **not code-signed**. Download only from this repository's GitHub Releases page and, when possible, verify the published `SHA256SUMS.txt`. Never disable Gatekeeper or SmartScreen globally.

**macOS (Gatekeeper):** open the `.dmg`, drag oh-my-md to Applications, then try to open it. If macOS blocks it, open **System Settings → Privacy & Security**, verify the blocked app is oh-my-md, and choose **Open Anyway**. Alternatively, Control-click the app in Finder and choose **Open**. Do not use commands that globally disable Gatekeeper.

**Windows (SmartScreen):** if Microsoft Defender SmartScreen appears, confirm the app name and that the installer came from this GitHub repository, choose **More info**, then **Run anyway**. Do not turn SmartScreen off system-wide.

### Linux

For the AppImage:

```sh
chmod +x oh-my-md_*.AppImage
./oh-my-md_*.AppImage
```

For Debian/Ubuntu:

```sh
sudo apt install ./oh-my-md_*.deb
```

If your system reports missing WebKit or desktop libraries, install the distribution packages listed in the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

## Build from source

You need [pnpm](https://pnpm.io/) (or Corepack), a [Rust toolchain](https://rustup.rs/), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. macOS requires Xcode Command Line Tools, Linux requires WebKitGTK development libraries, and Windows requires Microsoft Visual Studio C++ Build Tools.

```sh
git clone https://github.com/Zuixi/oh-my-md.git
cd oh-my-md
pnpm install
pnpm dev        # launches the app
```

Create a native package for the current host with `pnpm --filter @omd/desktop tauri build`.

## Keyboard shortcuts

Formatting sits on familiar keys (`⌘B`, `⌘I`, `⌘1`–`⌘6`, …), and every command is reachable from the command palette (`⇧⌘P`) — nothing to memorize. See the [full shortcut reference](./docs/guides/keyboard-shortcuts.md). Windows and Linux use the corresponding Ctrl-based shortcuts.

## Roadmap

- [ ] Signed packages for macOS and Windows
- [ ] Automatic updates after signed release infrastructure is available
- [ ] Block-level AI actions (polish / continue / translate) via OpenAI-compatible APIs and local Ollama
- [ ] Plugin architecture — foundations already reserved in the design

## FAQ

- **Is it really free?** Yes. Apache-2.0, no account, no feature gates.
- **Where does my data live?** In plain `.md` files on your disk — nothing is uploaded, ever.
- **Windows or Linux?** All three platforms are supported; see the platform package table above.
- **Will it open my existing notes?** If they are Markdown, yes — CommonMark + GFM plus common extras such as `==highlight==`, footnotes, KaTeX math, and Mermaid.
- **What about AI?** Designed but not shipped yet — see the [roadmap](#roadmap).

## Contributing

Issues and pull requests are welcome! Start with [CONTRIBUTING.md](./CONTRIBUTING.md) for the dev setup, the per-domain test matrix, and commit conventions. `pnpm verify` should pass before you open a PR.

## Acknowledgments

Built on excellent open source: [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/), [Tauri](https://tauri.app/), [KaTeX](https://katex.org/), [Mermaid](https://mermaid.js.org/), [Shiki](https://shiki.style/), [React](https://react.dev/), and [Vite](https://vite.dev/). Typora's interaction design remains a standing inspiration.

## License

[Apache-2.0](./LICENSE)
