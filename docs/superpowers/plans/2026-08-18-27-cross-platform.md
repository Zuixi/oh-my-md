# 27 Cross-Platform Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 oh-my-md 从 macOS-only 扩展为 macOS / Windows / Linux 三平台可开发、可构建、可发布,分 P0(可移植地基)→ P1(Linux)→ P2(Windows)→ P3(发布)四个里程碑,每个里程碑独立交付。

**Architecture:** 前端平台分支收敛到单一 `platform.ts`(三布尔 + 快捷键格式化器);菜单策略为「macOS 保留原生全局菜单,Win/Linux 用 TopBar ☰ + React 应用内菜单,两棵菜单树由 drift 测试锁死」;Rust 侧只在 `menu.rs`(cfg 门控)、诊断目录解析、原子写回退三处有平台分支;CI/release 扩为三 OS 矩阵。Win/Linux 构建只发生在 CI(本机 macOS 无法交叉编译 Tauri webview 应用)。

**Tech Stack:** Tauri 2(既有)、`os_info` crate(新增,唯一新依赖)、GitHub Actions 三 OS 矩阵、Vitest + cargo test。

**Spec:** `docs/superpowers/specs/2026-08-18-27-cross-platform-design.md`(决策 D1–D12 均以 [Dn] 标注引用)

## Global Constraints

- 未知/无法识别的平台一律按 macOS 处理(D1);P0 全部改动在 macOS 上可见行为不变,现有测试全绿是每个任务的门槛。
- 平台分支唯一入口:desktop TS 经 `platform.ts` 的 `isMacOS/isWindows/isLinux`;Rust 经 `cfg!(target_os = …)` / `std::env::consts::OS`。禁止散落的 `navigator.platform`、`process.platform` 式比较。
- IPC 契约不变:不新增命令、不改命令签名(`export_diagnostics` 仅内部实现变化,wire 格式不变)。
- engine 保持框架无关与平台无关:只导出 binding 规范形,不做平台检测(D7)。
- 新增依赖仅 `os_info`;不引入内置字体、不做自定义标题栏、不做 Win/Linux 签名(非目标)。
- 键位匹配逻辑(`metaKey || ctrlKey`、CM6 `Mod-`)一律不改——匹配早已跨平台,只动展示层。
- commit 遵循 `commit-msg` 钩子:`<type>: <why>`,允许类型 `feat|fix|refactor|docs|test|chore|perf|ci`。
- 验证命令:`pnpm test`(engine tsc+vitest)、`pnpm --filter @omd/desktop test`、`cargo fmt --check && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`;跨层改动跑 `pnpm verify`。
- P3 依赖 13-B Task B3(release workflow)已落地;B3 仍阻塞于 Apple 账号时不启动 P3。

---

## Phase P0:可移植地基(全部在 macOS 开发验证)

### Task 1: `platform.ts` 平台检测模块

**Files:**
- Create: `apps/desktop/src/platform.ts`
- Test: `apps/desktop/test/platform.test.ts`

**Interfaces:**
- Produces: `type AppPlatform = "macos" | "windows" | "linux"`;`currentPlatform(): AppPlatform`;`isMacOS(): boolean`;`isWindows(): boolean`;`isLinux(): boolean`。后续所有任务(D3/D7/D10/D11、AppMenu)消费这五个导出。

- [ ] **Step 1: 写失败测试** `apps/desktop/test/platform.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest"
import { currentPlatform, isLinux, isMacOS, isWindows } from "../src/platform"

function setUserAgent(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
}

afterEach(() => setUserAgent(""))

describe("currentPlatform", () => {
  it("detects macOS WKWebView", () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")
    expect(currentPlatform()).toBe("macos")
  })
  it("detects Windows WebView2", () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
    expect(currentPlatform()).toBe("windows")
  })
  it("detects Linux WebKitGTK", () => {
    setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/4.0 Safari/605.1.15")
    expect(currentPlatform()).toBe("linux")
  })
  it("falls back to macos for unknown agents", () => {
    setUserAgent("")
    expect(currentPlatform()).toBe("macos")
    expect(isMacOS()).toBe(true)
    expect(isWindows()).toBe(false)
    expect(isLinux()).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败** — `pnpm --filter @omd/desktop test -- platform` → FAIL(`Cannot find module "../src/platform"`)。
- [ ] **Step 3: 实现** `apps/desktop/src/platform.ts`

```ts
/**
 * Single source of truth for platform detection (spec D1).
 *
 * The Tauri webview is sandboxed and exposes no `process.platform`; the user
 * agent is the pragmatic equivalent. Unknown agents resolve to "macos" so
 * existing behavior and tests are unchanged on unrecognized environments.
 */
export type AppPlatform = "macos" | "windows" | "linux"

let cached: AppPlatform | undefined

function detectPlatform(userAgent: string): AppPlatform {
  if (/Windows/i.test(userAgent)) return "windows"
  if (/Linux|X11/i.test(userAgent)) return "linux"
  return "macos"
}

export function currentPlatform(): AppPlatform {
  cached ??= detectPlatform(navigator.userAgent)
  return cached
}

export function isMacOS(): boolean {
  return currentPlatform() === "macos"
}

export function isWindows(): boolean {
  return currentPlatform() === "windows"
}

export function isLinux(): boolean {
  return currentPlatform() === "linux"
}
```

- [ ] **Step 4: 运行确认通过** — 同 Step 2 → PASS;随后跑全量 `pnpm --filter @omd/desktop test` 确认无回归。
- [ ] **Step 5: Commit** — `feat: add platform detection module for cross-platform support`

---

### Task 2: 快捷键 binding 单一来源 + 平台格式化(D7)

**Files:**
- Modify: `packages/engine/src/format/commands.ts`(在 `markdownShortcutLabels` 旁新增导出)
- Modify: `packages/engine/src/modes/livePreview.ts`(在 `toggleShortcutLabels` 旁新增导出)
- Modify: `packages/engine/src/index.ts`(re-export)
- Modify: `apps/desktop/src/platform.ts`(新增 `formatBinding`)
- Modify: `apps/desktop/src/shortcuts.ts`(`keys` 字段改 `binding`、`FORMAT_SHORTCUTS` 改 bindings)
- Modify: `apps/desktop/test/crossLayerMenu.test.ts`(`shortcutDisplay` 改用 binding + `formatBinding`,它直接消费 `.keys`/`FORMAT_SHORTCUTS`)
- Test: `packages/engine/test/shortcut-bindings.test.ts`(新建)
- Test: `apps/desktop/test/platform.test.ts`(追加 formatBinding 用例)

**Interfaces:**
- Consumes: Task 1 的 `currentPlatform`。
- Produces: engine `markdownShortcutBindings: Readonly<Record<string, string>>` 与 `toggleShortcutBindings: Readonly<Record<string, string>>`(id → CM6 key 规范形,如 `"Mod-Shift-x"`);desktop `formatBinding(binding: string, platform?: AppPlatform): string`;`WindowShortcut` 的展示字段由 `keys: string` 改为 `binding: string`,`shortcutFor(id)` 返回格式化标签。Task 3/10 消费 `formatBinding`。

- [ ] **Step 1: engine 失败测试** `packages/engine/test/shortcut-bindings.test.ts`

```ts
import { describe, expect, it } from "vitest"
import {
  markdownKeyBindings,
  markdownShortcutBindings,
  markdownShortcutLabels,
  toggleKeyBindings,
  toggleShortcutBindings,
  toggleShortcutLabels,
} from "../src"

/** 与 desktop formatBinding(macOS) 等价的参考实现,锁死 display == mac 格式。 */
function macLabel(key: string): string {
  const parts = key.split("-").filter(part => part !== "")
  const modifiers = parts.slice(0, -1)
  const main = parts[parts.length - 1]
  const mac: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" }
  const order = ["Shift", "Alt", "Mod"]
  const sorted = order.filter(mod => modifiers.includes(mod)).map(mod => mac[mod])
  return [...sorted, main.toUpperCase()].join("")
}

describe("shortcut bindings", () => {
  it("exposes a binding for every labeled command", () => {
    for (const binding of markdownKeyBindings) {
      if (binding.display === undefined) continue
      expect(markdownShortcutBindings[binding.id]).toBe(binding.key)
    }
    for (const binding of toggleKeyBindings) {
      expect(toggleShortcutBindings[binding.id]).toBe(binding.key)
    }
  })
  it("mac display label equals formatted binding (no drift)", () => {
    for (const [id, label] of Object.entries(markdownShortcutLabels)) {
      expect(label).toBe(macLabel(markdownShortcutBindings[id]))
    }
    for (const [id, label] of Object.entries(toggleShortcutLabels)) {
      expect(label).toBe(macLabel(toggleShortcutBindings[id]))
    }
  })
})
```

- [ ] **Step 2: 运行确认失败** — `pnpm test -- shortcut-bindings` → FAIL(导出不存在)。
- [ ] **Step 3: engine 实现** — `format/commands.ts` 在 `markdownShortcutLabels` 定义之后加:

```ts
export const markdownShortcutBindings: Readonly<Record<string, string>> = Object.fromEntries(
  markdownKeyBindings
    .filter(binding => binding.display !== undefined)
    .map(binding => [binding.id, binding.key]),
)
```

  `modes/livePreview.ts` 在 `toggleShortcutLabels` 之后加:

```ts
export const toggleShortcutBindings: Readonly<Record<string, string>> = Object.fromEntries(
  toggleKeyBindings.map(binding => [binding.id, binding.key]),
)
```

  `index.ts` 补 re-export(`toggleShortcutBindings`、`markdownShortcutBindings`)。同时导出 `toggleKeyBindings`(若尚未导出,加到 livePreview 的导出行,测试需要)。
- [ ] **Step 4: 运行确认通过** — `pnpm test` 全量(engine tsc + vitest)。
- [ ] **Step 5: desktop 失败测试** — `apps/desktop/test/platform.test.ts` 追加:

```ts
import { formatBinding } from "../src/platform"

describe("formatBinding", () => {
  it("renders mac glyphs", () => {
    expect(formatBinding("Mod+s", "macos")).toBe("⌘S")
    expect(formatBinding("Mod+Shift+o", "macos")).toBe("⇧⌘O")
    expect(formatBinding("Mod-Alt-7", "macos")).toBe("⌥⌘7")
  })
  it("renders ctrl words on windows and linux", () => {
    expect(formatBinding("Mod+s", "windows")).toBe("Ctrl+S")
    expect(formatBinding("Mod+Shift+o", "linux")).toBe("Ctrl+Shift+O")
    expect(formatBinding("Mod-Alt-7", "windows")).toBe("Ctrl+Alt+7")
  })
})
```

- [ ] **Step 6: 实现 `formatBinding`** — `platform.ts` 追加:

```ts
const MAC_GLYPHS: Readonly<Record<string, string>> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" }
const MAC_ORDER = ["Shift", "Alt", "Mod"]
const WORD_ORDER = ["Mod", "Alt", "Shift"]

/** Renders a "Mod-Shift-x" / "Mod+Shift+x" binding for display (spec D7). */
export function formatBinding(binding: string, platform: AppPlatform = currentPlatform()): string {
  const parts = binding.split(/[-+]/).filter(part => part !== "")
  const main = parts[parts.length - 1]
  const modifiers = parts.slice(0, -1)
  if (platform === "macos") {
    const glyphs = MAC_ORDER.filter(mod => modifiers.includes(mod)).map(mod => MAC_GLYPHS[mod])
    return [...glyphs, main.toUpperCase()].join("")
  }
  const words = WORD_ORDER
    .filter(mod => modifiers.includes(mod))
    .map(mod => (mod === "Mod" ? "Ctrl" : mod))
  return [...words, main.toUpperCase()].join("+")
}
```

- [ ] **Step 7: 改造 `shortcuts.ts`** — `WindowShortcut.keys` 改名 `binding` 并使用规范形,`shortcutFor` 格式化:

```ts
export interface WindowShortcut {
  id: string
  /** Normalized binding, e.g. "Mod+s"; display via formatBinding. */
  binding: string
  key: string
  shift?: boolean
}

export const WINDOW_SHORTCUTS: readonly WindowShortcut[] = [
  { id: "preferences", binding: "Mod+,", key: "," },
  { id: "sidebar", binding: "Mod+\\", key: "\\" },
  { id: "outline", binding: "Mod+Shift+o", key: "O", shift: true },
  { id: "search", binding: "Mod+Shift+f", key: "f", shift: true },
  { id: "find", binding: "Mod+f", key: "f" },
  { id: "quick-open", binding: "Mod+p", key: "p" },
  { id: "open", binding: "Mod+o", key: "o" },
  { id: "tab", binding: "Mod+n", key: "n" },
  { id: "close", binding: "Mod+w", key: "w" },
  { id: "save", binding: "Mod+s", key: "s" },
  { id: "save-as", binding: "Mod+Shift+s", key: "s", shift: true },
]

export function shortcutFor(commandId: string): string | undefined {
  const windowBinding = WINDOW_SHORTCUTS.find(shortcut => shortcut.id === commandId)?.binding
  if (windowBinding !== undefined) return formatBinding(windowBinding)
  const formatBinding_ = FORMAT_SHORTCUT_BINDINGS[commandId]
  return formatBinding_ !== undefined ? formatBinding(formatBinding_) : undefined
}
```

  其中 `FORMAT_SHORTCUT_BINDINGS` 替换原 `FORMAT_SHORTCUTS`(值来自 engine bindings;变量命名避免与导入的 `formatBinding` 函数冲突,导入处用 `import { formatBinding, … } from "./platform"`、`import { markdownShortcutBindings, toggleShortcutBindings } from "@omd/engine"`):

```ts
export const FORMAT_SHORTCUT_BINDINGS: Readonly<Record<string, string>> = {
  ...markdownShortcutBindings,
  ...toggleShortcutBindings,
}
```

  删除 `markdownShortcutLabels` / `toggleShortcutLabels` 导入。`matchesWindowShortcut` 不变(只用 `key`/`shift`)。
- [ ] **Step 8: 同步 drift 测试** — `crossLayerMenu.test.ts` 的导入改为 `import { FORMAT_SHORTCUT_BINDINGS, WINDOW_SHORTCUTS } from "../src/shortcuts"` + `import { formatBinding } from "../src/platform"`,`shortcutDisplay`(:52-55)改为:

```ts
function shortcutDisplay(commandId: string): string | undefined {
  const windowBinding = WINDOW_SHORTCUTS.find(shortcut => shortcut.id === commandId)?.binding
  if (windowBinding !== undefined) return formatBinding(windowBinding, "macos")
  const formatBindingId = FORMAT_SHORTCUT_BINDINGS[commandId]
  return formatBindingId !== undefined ? formatBinding(formatBindingId, "macos") : undefined
}
```

  (该测试的 `rustAccelToDisplay` 产出 ⌥⌘7/⇧⌘X 序,与 `formatBinding` 的 mac 修饰键序 Shift→Alt→Mod 一致,断言值逐字不变。)
- [ ] **Step 9: 全量验证** — `pnpm test` + `pnpm --filter @omd/desktop test`;若有测试断言旧 `keys` 字面量("⌘S" 等),逐一改为 `formatBinding(binding, "macos")` 期望值(默认平台 mac,字符串应逐字相同,预期无改动;有则修测试断言)。
- [ ] **Step 10: Commit** — `refactor: derive shortcut labels from bindings per platform`

---

### Task 3: 导出门控 + 文案中性化(D3/D10)

**Files:**
- Modify: `apps/desktop/src/App.tsx`(命令列表过滤,命令条目在 ~1317–1366)
- Modify: `apps/desktop/src/i18n/messages/en.ts`(:125、:151、:210)
- Modify: `apps/desktop/src/i18n/messages/zh.ts`(对应三键)
- Test: `apps/desktop/test/exportGating.test.ts`(新建)

**Interfaces:**
- Consumes: Task 1 `isMacOS`。
- Produces: 常量 `MACOS_ONLY_COMMANDS`(id 集合),Task 10 的 AppMenu 对导出条目的隐藏沿用同一集合(从 App.tsx 或抽到 `commands.ts` 导出;本任务放 `commands.ts` 导出更稳)。放 `apps/desktop/src/commands.ts`:`export const MACOS_ONLY_COMMANDS: ReadonlySet<string> = new Set(["export-pdf", "export-image"])`。

- [ ] **Step 1: 写失败测试** `apps/desktop/test/exportGating.test.ts`

```ts
import { describe, expect, it } from "vitest"
import { MACOS_ONLY_COMMANDS } from "../src/commands"

describe("macOS-only commands", () => {
  it("lists exactly the native-export commands", () => {
    expect([...MACOS_ONLY_COMMANDS].sort()).toEqual(["export-image", "export-pdf"])
  })
})
```

- [ ] **Step 2: 确认失败** → FAIL(常量不存在)。
- [ ] **Step 3: 实现** — `commands.ts` 加上述常量;`App.tsx` 在命令数组定义处(:1317 起,`export-pdf`/`export-image` 在 :1362-1363)对数组字面量做过滤——过滤落在唯一定义点,palette、`commandsRef`、`runMenuCommand`、后续 AppMenu 全部继承,macOS 上集合不过滤任何项:

```ts
import { isMacOS } from "./platform"
import { MACOS_ONLY_COMMANDS } from "./commands"
// …原命令数组字面量赋给 allCommands 后:
const commands = allCommands.filter(
  command => isMacOS() || !MACOS_ONLY_COMMANDS.has(command.id),
)
```

  (后续所有对原数组的引用改指 `commands`;`commandsRef` 的赋值源同步。)
- [ ] **Step 4: i18n 改动** — `en.ts`:`"filetree.menu.reveal": "Reveal in File Manager"`、`"conflict.action.revealInFinder": "Reveal in File Manager"`、`"error.export.desktopOnly": "PDF and image export are currently only available on macOS"`;`zh.ts` 对应改为「在文件管理器中显示」(两处)与「PDF 与图片导出目前仅在 macOS 上可用」。若 i18n 有 key 完整性/快照测试,同步更新断言。
- [ ] **Step 5: 全量验证 + Commit** — `pnpm --filter @omd/desktop test`;`fix: hide mac-only export commands off macOS and neutralize reveal copy`。

---

### Task 4: 字体栈跨平台(D6)

**Files:**
- Modify: `apps/desktop/src/styles.css`(:49、:268-271、:519、:522)
- Modify: `apps/desktop/src/settings.ts`(:26-29 预设)
- Test: 既有 desktop 测试(样式无专测;依赖 `tauriConfig.test.ts` 类文本断言不在此时新增)

**Interfaces:** 无新接口;纯 CSS/预设值变更。

- [ ] **Step 1: 编辑区字体栈** — `styles.css:49` 改为:

```css
  font-family: var(--omd-font-family, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif);
```

- [ ] **Step 2: 补全等宽栈** — `styles.css:519` 与 `:522` 的 `ui-monospace, SFMono-Regular, Menlo, monospace` 改为 `ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace`;:268-271 的 autocomplete 字体栈同步 Step 1 的新 sans 栈。
- [ ] **Step 3: 设置预设** — `settings.ts:26-29`:sans 预设改 `system-ui, -apple-system, "Segoe UI", sans-serif`;mono 预设改 `ui-monospace, Menlo, Monaco, "Cascadia Mono", Consolas, monospace`(与现有 CSS 中 :223 的 Consolas 用法一致)。
- [ ] **Step 4: 验证 + Commit** — `pnpm --filter @omd/desktop test` + `pnpm --filter @omd/desktop build`(确认 CSS 经构建无误);`fix: cover windows and linux fonts in editor stacks`。

---

### Task 5: 诊断包跨平台(D5)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`(依赖)
- Modify: `apps/desktop/src-tauri/src/diagnostics.rs`
- Test: `diagnostics.rs` 内 `#[cfg(test)]`(既有测试改造 + 新增)

**Interfaces:**
- Produces: `write_diagnostics_bundle(path: &Path, log_dir: &Path, home: &str) -> Result<(), String>`(签名变更:第二参从 home 变 log_dir;私有函数,无 wire 影响)。`export_diagnostics` 命令签名与返回不变。

- [ ] **Step 1: 加依赖** — `Cargo.toml` `[dependencies]` 加 `os_info = "3"`。
- [ ] **Step 2: 写失败测试**(改造 `diagnostics.rs` tests):既有 `export_diagnostics_writes_zip_without_logs` 改为传临时 `log_dir`;新增日志收集用例:

```rust
#[test]
fn export_diagnostics_collects_and_redacts_logs_from_dir() {
    let dir = tempfile::tempdir().unwrap();
    let log_dir = dir.path().join("logs");
    std::fs::create_dir_all(&log_dir).unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let home_str = home.to_str().unwrap().to_string();
    std::fs::write(
        log_dir.join("app.log"),
        format!("opened {}/notes/a.md asset file:///{}/notes/a.png", home_str, home_str),
    )
    .unwrap();

    let bundle = dir.path().join("bundle.zip");
    write_diagnostics_bundle(&bundle, &log_dir, &home_str).unwrap();

    let mut archive = zip::ZipArchive::new(std::fs::File::open(&bundle).unwrap()).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_string())
        .collect();
    assert!(names.iter().any(|n| n == "os.txt"));
    assert!(names.iter().any(|n| n == "diagnostics.txt"));
    let mut diagnostics = String::new();
    use std::io::Read;
    archive.by_name("diagnostics.txt").unwrap().read_to_string(&mut diagnostics).unwrap();
    assert!(diagnostics.contains("a.md"));
    assert!(diagnostics.contains("<home>/notes"));
    assert!(!diagnostics.contains(&home_str));
}
```

- [ ] **Step 3: 确认失败** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml diagnostics` → FAIL(签名不匹配)。
- [ ] **Step 4: 实现** — `diagnostics.rs`:

```rust
use tauri::Manager;

fn os_summary() -> String {
    let os = os_info::get();
    format!("{} {} ({})", os.os_type(), os.version(), os.bitness())
}

fn write_diagnostics_bundle(path: &Path, log_dir: &Path, home: &str) -> Result<(), String> {
    // …前段不变;uname 段替换为:
    zip.start_file("os.txt", options).map_err(|e| e.to_string())?;
    zip.write_all(os_summary().as_bytes()).map_err(|e| e.to_string())?;
    // …log_files 收集改为遍历 log_dir 参数(删除原 log_dir(home) 函数与 LOG_DIR_NAME 常量)
}

#[tauri::command]
pub fn export_diagnostics(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let home = dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default();
    write_diagnostics_bundle(Path::new(&path), &log_dir, &home)
}
```

  `redact_text` 的 home 取值同步改为 `dirs::home_dir()`(Windows 无 `HOME` 环境变量)。既有两条 redact 测试不动;`…without_logs` 测试改新签名并断言 `os.txt`。
- [ ] **Step 5: 确认通过 + Commit** — `cargo fmt` + `cargo test`(macOS 上 `app_log_dir` 为 `~/Library/Logs/md.ohmy.desktop`,与旧硬编码一致,行为不变);`fix: resolve diagnostics log dir and os info cross-platform`。

---

### Task 6: `sync-version.sh` 可移植化(D9)

**Files:**
- Modify: `scripts/sync-version.sh:37-38`

**Interfaces:** 无(脚本对外行为不变)。

- [ ] **Step 1: 改写 sed 行** — BSD 专属 `sed -i ''` 换成带后缀的可移植形式(`-i.bak` 在 BSD/GNU 皆合法),随后清理备份:

```sh
sed -i.bak -E 's/^version = ".*"/version = "'"$VERSION"'"/' \
  apps/desktop/src-tauri/Cargo.toml
rm -f apps/desktop/src-tauri/Cargo.toml.bak
```

- [ ] **Step 2: 本机验证** — `bash scripts/sync-version.sh 0.1.0`(当前版本原值重写,应无 diff);若版本测试存在(`rg -l "sync-version" apps/desktop/test`)一并跑过。
- [ ] **Step 3: Commit** — `fix: make version sync script portable across sed variants`

---

### Task 7: WebKit 右键 workaround 门控(D11)

**Files:**
- Modify: `apps/desktop/src/imagePaste.ts:66-143`
- Test: `apps/desktop/test/imagePaste.test.ts`(若存在则追加;否则新建最小用例)

**Interfaces:** Consumes Task 1 `isWindows`。

- [ ] **Step 1: 失败测试**(新建或追加):

```ts
import { describe, expect, it, vi } from "vitest"

describe("contextmenu selection workaround", () => {
  it("skips the WebKit selectionchange dispatch on Windows", async () => {
    const { installImagePaste } = await import("../src/imagePaste")
    const dispatch = vi.fn()
    const view = {
      dispatch,
      state: { selection: { main: { head: 0, anchor: 0 } } },
      dom: document.createElement("div"),
      focus: () => {},
    }
    const userAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0",
      configurable: true,
    })
    try {
      const handler = installImagePaste(/* 既有测试同款入参 */)
      handler?.contextmenu?.(view, new MouseEvent("contextmenu"))
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      if (userAgent) Object.defineProperty(window.navigator, "userAgent", userAgent)
    }
  })
})
```

  (以仓库中 imagePaste 既有测试的实际装配方式为准调整 `view` 构造;断言核心只有一条:Windows UA 下右键不派发选区变更。)
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** — `imagePaste.ts` 顶部 `import { isWindows } from "./platform"`;contextmenu 处理块(发送选区变更的 workaround 段)包裹:

```ts
// The selectionchange dispatch works around a WKWebView bug (WebKit-family
// engines only); WebView2 is Chromium and must keep native caret behavior.
if (!isWindows()) {
  // …既有 workaround 段…
}
```

- [ ] **Step 4: 确认通过 + Commit** — desktop 全量测试;`fix: gate webkit contextmenu workaround off windows webview2`。mac/Linux 行为不变(默认/WebKit 均执行 workaround;Linux 是否收窄到仅 mac 由 P1 QA 裁决)。

---

### Task 8: P0 文档收尾

**Files:**
- Modify: `docs/guides/keyboard-shortcuts.md`(补平台说明)
- Modify: `AGENTS.md`(Workspace Conventions 增一条)
- Modify: `docs/manual-qa.md`(macOS 回归小节)
- Modify: `README.md`(开发前置声明三平台计划中,Linux/Windows 前置标注「P1/P2 起」)

**Interfaces:** 无。

- [ ] **Step 1: 键位指南** — 文首加说明块:「快捷键以 ⌘/⌥ 表示主修饰键;Windows/Linux 上 ⌘→Ctrl、⌥→Alt,其余不变(引擎以 `Mod-` 匹配,自动映射)。」
- [ ] **Step 2: 根 AGENTS.md** — Workspace Conventions 列表追加一行:「平台分支只经 `apps/desktop/src/platform.ts`(TS)或 `cfg!(target_os = …)`(Rust),不得散落 UA/平台字符串比较;未知平台按 macOS 处理。」
- [ ] **Step 3: manual-qa** — 增「P0 平台地基回归(macOS)」小节:palette 快捷键标签抽查(⌘S/⌥⌘7 与改动前逐字一致)、reveal 文案、命令面板无导出 PDF/图片项异常(mac 上应仍显示)、诊断包导出含 `os.txt`。
- [ ] **Step 4: 验证 + Commit** — `pnpm verify`(本任务只动文档,跑全量作最终 P0 门槛);`docs: document platform conventions and p0 regression checks`。

---

## Phase P1:Linux 可用

### Task 9: CI ubuntu 编译/测试/链接(A2, 部分)

**Files:**
- Modify: `.github/workflows/ci.yml`(rust、link 两个 job)

**Interfaces:** Produces: 三 OS 矩阵机制(Task 12 复用加 windows)。

- [ ] **Step 1: rust job 矩阵化** —

```yaml
rust:
  strategy:
    fail-fast: false
    matrix:
      os: [macos-latest, ubuntu-latest]
  runs-on: ${{ matrix.os }}
  steps:
    - uses: actions/checkout@v4
    - uses: dtolnay/rust-toolchain@1.87.0
    - name: Install Tauri Linux system dependencies
      if: runner.os == 'Linux'
      run: |
        sudo apt-get update
        sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev
    - run: cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
    - run: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

- [ ] **Step 2: link job 同矩阵** — link job 复制同样的 `strategy`/`runs-on`/apt 步骤(其步骤为既有 pnpm 装配 + `bash scripts/build.sh`)。
- [ ] **Step 3: 真实验证** — push 分支,观察 Actions:`rust(ubuntu-latest)` 与 `link(ubuntu-latest)` 首次跑;若 Linux 编译报缺系统库,按报错补 apt 包(仅允许改 apt 列表,不改代码绕过)。**这一步是本 task 唯一可信验证。**
- [ ] **Step 4: Commit** — `ci: compile and link the rust app on linux`

---

### Task 10: 应用内菜单(D2)

**Files:**
- Create: `apps/desktop/src/menuTree.ts`
- Create: `apps/desktop/src/AppMenu.tsx`
- Modify: `apps/desktop/src/TopBar.tsx`(挂载 AppMenu)
- Modify: `apps/desktop/src/App.tsx`(渲染 AppMenu、装配 recents)
- Modify: `apps/desktop/src/styles.css`(下拉样式)
- Modify: `apps/desktop/src/i18n/messages/en.ts`、`zh.ts`(`menu.*` 键)
- Modify: `apps/desktop/src-tauri/src/menu.rs`(`rebuild_from_state` cfg 门控)
- Test: `apps/desktop/test/AppMenu.test.tsx`(新建)
- Test: `apps/desktop/test/crossLayerMenu.test.ts`(扩展)

**Interfaces:**
- Consumes: Task 1 `isMacOS`;Task 3 `MACOS_ONLY_COMMANDS`;既有 `MENU_TO_COMMAND`、`runMenuCommand`、`AppCommand`。
- Produces: `APP_MENU_TREE: readonly MenuSection[]`(结构见 Step 1);`AppMenu` 组件 props `{ getRecents: () => string[]; onCommand: (id: string) => void }`(自含 ☰ 按钮与下拉);TopBar 新可选 prop `menu?: { getRecents: () => string[]; onCommand: (id: string) => void }`。

- [ ] **Step 1: 定义菜单树** `menuTree.ts`(id 全部来自 `MENU_TO_COMMAND` 的键 + 特殊 `recents`):

```ts
export interface MenuEntry {
  /** MENU_TO_COMMAND key, or "recents" for the Open Recent submenu. */
  id: string
  macOSOnly?: boolean
  separatorAfter?: boolean
}

export interface MenuSection {
  labelKey: string
  entries: readonly MenuEntry[]
}

/** In-app menu for non-macOS platforms; mirrors src-tauri/src/menu.rs (drift-tested). */
export const APP_MENU_TREE: readonly MenuSection[] = [
  {
    labelKey: "menu.file",
    entries: [
      { id: "new-tab" },
      { id: "open-file" },
      { id: "quick-open" },
      { id: "open-folder", separatorAfter: true },
      { id: "close" },
      { id: "save" },
      { id: "save-as", separatorAfter: true },
      { id: "version-history" },
      { id: "export-html" },
      { id: "export-pdf", macOSOnly: true },
      { id: "export-image", macOSOnly: true, separatorAfter: true },
      { id: "recents" },
      { id: "clear-recents" },
    ],
  },
  {
    labelKey: "menu.edit",
    entries: [{ id: "find" }, { id: "search" }],
  },
  {
    labelKey: "menu.format",
    entries: [
      { id: "bold" },
      { id: "italic" },
      { id: "strikethrough" },
      { id: "inline-code" },
      { id: "code-block", separatorAfter: true },
      { id: "heading-1" },
      { id: "heading-2" },
      { id: "heading-3" },
      { id: "heading-4" },
      { id: "heading-5" },
      { id: "heading-6", separatorAfter: true },
      { id: "ordered-list" },
      { id: "unordered-list" },
      { id: "blockquote" },
      { id: "link" },
      { id: "insert-image" },
    ],
  },
  {
    labelKey: "menu.view",
    entries: [
      { id: "view-source" },
      { id: "view-sidebar" },
      { id: "view-outline" },
      { id: "view-typewriter" },
      { id: "view-focus" },
      { id: "toggle-theme" },
      { id: "load-css", separatorAfter: true },
      { id: "preferences" },
      { id: "check-updates" },
    ],
  },
]
```

- [ ] **Step 2: 写失败 drift 测试** — `crossLayerMenu.test.ts` 追加(复用该文件既有的 `menuItems()` 与 `isNativeWindowItem()` 助手,:19-35):

```ts
import { APP_MENU_TREE } from "../src/menuTree"

describe("in-app menu tree parity", () => {
  const treeIds = new Set(
    APP_MENU_TREE.flatMap(section => section.entries.map(entry => entry.id)),
  )
  it("every tree entry maps to a palette command (recents excluded)", () => {
    for (const id of treeIds) {
      if (id === "recents") continue
      expect(MENU_TO_COMMAND[id], `menuTree id ${id}`).toBeTruthy()
    }
  })
  it("covers every forwarded native menu id", () => {
    for (const item of menuItems()) {
      if (isNativeWindowItem(item.id)) continue
      expect(
        treeIds.has(item.id),
        `menu.rs id ${item.id} missing from APP_MENU_TREE`,
      ).toBe(true)
    }
  })
})
```

  (第二个用例跑红后,把 menu.rs 中实际转发、而树里缺失的 id——例如历史遗留的 `new`——补进 `APP_MENU_TREE` 对应分区,直到两向断言都绿;这正是该测试存在的意义。)

- [ ] **Step 3: 确认失败** — `pnpm --filter @omd/desktop test -- crossLayerMenu` → FAIL(menuTree 不存在)。
- [ ] **Step 4: Rust 门控** — `menu.rs` 的 `rebuild_from_state` 顶部加:

```rust
    // The native app menu only renders as a global menubar on macOS; on
    // Windows/Linux the frontend serves an in-app menu instead (spec D2).
    // Gating here makes install/set_recent_files/set_view_state/set_menu_locale
    // natural no-ops while keeping every IPC command registered.
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
```

  (macOS 行为不变,`cargo test` 全绿即可;非 macOS 路径由 Task 14 QA 验证。)
- [ ] **Step 5: 写失败组件测试** `AppMenu.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AppMenu } from "../src/AppMenu"

function withUserAgent(userAgent: string, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(window.navigator, "userAgent", original)
  }
}

describe("AppMenu", () => {
  it("renders sections and dispatches command ids", () => {
    const onCommand = vi.fn()
    render(<AppMenu getRecents={() => []} onCommand={onCommand} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    const item = screen.getByRole("menuitem", { name: /^save$/i })
    fireEvent.click(item)
    expect(onCommand).toHaveBeenCalledWith("save")
  })
  it("hides macOS-only export entries on windows", () => {
    withUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", () => {
      render(<AppMenu getRecents={() => []} onCommand={() => {}} />)
      fireEvent.click(screen.getByRole("button", { name: /menu/i }))
      expect(screen.queryByRole("menuitem", { name: /export as pdf/i })).toBeNull()
    })
  })
  it("lists recent files via recent: ids", () => {
    render(<AppMenu getRecents={() => ["/tmp/a.md"]} onCommand={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /open recent/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /a\.md/i }))
    // recent: 前缀 id 由 App 侧 runMenuCommand 消费;这里只断言透传
  })
  it("closes on Escape", () => {
    render(<AppMenu getRecents={() => []} onCommand={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /menu/i }))
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
  })
})
```

- [ ] **Step 6: 实现 `AppMenu.tsx`** — 结构要点(完整实现按仓库 React 组件惯例,参照 `TopBar.tsx` 的 props/命名风格):

```tsx
import { Menu } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { MACOS_ONLY_COMMANDS, MENU_TO_COMMAND } from "./commands"
import { isMacOS } from "./platform"
import { APP_MENU_TREE } from "./menuTree"
import { useT } from "./i18n"
import { shortcutFor } from "./shortcuts"

export function AppMenu(props: { getRecents: () => string[]; onCommand: (id: string) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [recentsOpen, setRecentsOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setRecents(props.getRecents())
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("keydown", onKeyDown)
    }
    // props.getRecents 在调用时读取 App 的 ref,闭包不陈旧
  }, [open])

  if (isMacOS()) return null

  const labelFor = (id: string): string => {
    if (id === "recents") return t("menu.recents")
    if (id.startsWith("recent:")) {
      return id.slice("recent:".length).replace(/\\/g, "/").split("/").pop() ?? id
    }
    return t(`cmd.label.${MENU_TO_COMMAND[id] ?? id}`)
  }

  const visible = (id: string): boolean =>
    !(MACOS_ONLY_COMMANDS.has(MENU_TO_COMMAND[id] ?? id) && !isMacOS())

  const run = (id: string): void => {
    props.onCommand(id)
    setOpen(false)
    setRecentsOpen(false)
  }

  return (
    <div className="app-menu" ref={rootRef}>
      <button
        type="button"
        className="app-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("menu.aria.open")}
        onClick={() => setOpen(current => !current)}
      >
        <Menu size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="app-menu-panel" role="menu" aria-label={t("menu.aria.open")}>
          {APP_MENU_TREE.map(section => (
            <div className="app-menu-section" key={section.labelKey}>
              <div className="app-menu-section-title">{t(section.labelKey)}</div>
              {section.entries
                .filter(entry => visible(entry.id))
                .map(entry => (
                  <div className="app-menu-entry" key={entry.id}>
                    {entry.id === "recents" ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          className="app-menu-item"
                          aria-expanded={recentsOpen}
                          onClick={() => setRecentsOpen(current => !current)}
                        >
                          {t("menu.recents")}
                        </button>
                        {recentsOpen
                          ? recents.map(path => (
                              <button
                                type="button"
                                role="menuitem"
                                className="app-menu-item app-menu-recent"
                                key={path}
                                onClick={() => run(`recent:${path}`)}
                              >
                                {labelFor(`recent:${path}`)}
                              </button>
                            ))
                          : null}
                      </>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className="app-menu-item"
                        onClick={() => run(entry.id)}
                      >
                        <span>{labelFor(entry.id)}</span>
                        {shortcutFor(MENU_TO_COMMAND[entry.id] ?? "") ? (
                          <span className="app-menu-hint">
                            {shortcutFor(MENU_TO_COMMAND[entry.id] ?? "")}
                          </span>
                        ) : null}
                      </button>
                    )}
                    {entry.separatorAfter ? (
                      <div className="app-menu-separator" aria-hidden="true" />
                    ) : null}
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
```
- [ ] **Step 7: TopBar + App 装配** — ☰ 按钮由 `AppMenu` 自带(见 Step 6 与组件测试),TopBar 只负责挂载位置:增可选 prop `menu?: { getRecents: () => string[]; onCommand: (id: string) => void }`,在 `<header>` 最前(sidebar 切换按钮之前)渲染 `{!isMacOS() && props.menu ? <AppMenu getRecents={props.menu.getRecents} onCommand={props.menu.onCommand} /> : null}`。`App.tsx` 传 prop(装配完全镜像既有 `listenMenu` 的 :1378 写法):

```tsx
import { AppMenu } from "./AppMenu"
// TopBar 的 menu prop:
menu={{
  getRecents: () => recentsRef.current,
  onCommand: id => runMenuCommand(id, commandsRef.current, {
    openRecent: path => { void openRecentRef.current(path) },
  }),
}}
```

  (`openRecentRef`/`commandsRef`/`recentsRef` 均为 App.tsx 既有 ref,见 :305、:950、:1211、:1378;`commandsRef` 的赋值源已是 Task 3 过滤后的数组,AppMenu 天然不派发被隐藏命令。)
- [ ] **Step 8: i18n + CSS** — `en.ts`/`zh.ts` 增键:`menu.file` File/文件、`menu.edit` Edit/编辑、`menu.format` Format/格式、`menu.view` View/显示、`menu.recents` Open Recent/最近打开、`menu.aria.open` Open menu/打开菜单;`styles.css` 追加 `.app-menu` 下拉定位(absolute,挂 TopBar 下沿)、分区标题、条目 hover、分隔线样式。
- [ ] **Step 9: 全量验证 + Commit** — `pnpm --filter @omd/desktop test` + `cargo test` + `pnpm verify`;`feat: in-app menu for windows and linux parity with native menubar`。

---

### Task 11: Linux 手动 QA 清单

**Files:**
- Modify: `docs/manual-qa.md`(新增「Linux」章节)
- Modify: `docs/memory/known-gotchas.md`(仅当实证出新坑)

**Interfaces:** 无代码;产出 QA 结论(尤其 D11 裁决与 D12 前置)。

- [ ] **Step 1: 在 Linux VM(UTM/arm64 Ubuntu 亦可,交互 QA 不要求与发布同 arch)跑 dev 版** — `pnpm install && pnpm dev`,执行清单:

```markdown
## Linux(P1)
- [ ] 启动无 crash;窗口标题/图标正常。
- [ ] ☰ 菜单:全部分区/条目可打开;Open Recent 子菜单列出最近文件并打开;Escape/外点关闭。
- [ ] Ctrl 系快捷键:保存 Ctrl+S、查找 Ctrl+F、格式化 Ctrl+B/I/K、列表 Ctrl+Alt+7/8/9 与键位指南一致。
- [ ] 打开/保存/另存为对话框;覆盖保存已有文件(内容正确落盘)。
- [ ] 文件树:reveal(在文件管理器中显示)、删除进回收站(freedesktop Trash)、新建/重命名。
- [ ] 右键粘贴图片(裁决 D11:WebKitGTK 下右键是否异常移动光标;异常则维持 workaround,正常则把门控收窄为 isMacOS())。
- [ ] 拖拽 .md 到窗口打开;CJK 中文字体渲染(PingFang 缺失时回落 Noto/YaHei 正常)。
- [ ] 外部修改文件 → watcher 提示;HTML 导出;PDF/PNG 入口不可见。
- [ ] Export Diagnostics 产出含 os.txt 与日志。
```

- [ ] **Step 2: 依 QA 结果收尾** — D11 若收窄,改 `imagePaste.ts` 门控并补 windows/linux 两向测试;新坑写入 known-gotchas。
- [ ] **Step 3: Commit** — `docs: add linux manual qa checklist`(+可能的 `fix:` 提交)。

---

## Phase P2:Windows 可用

### Task 12: CI windows 编译/测试/链接

**Files:**
- Modify: `.github/workflows/ci.yml`(矩阵加 windows-latest)

**Interfaces:** 复用 Task 9 矩阵。

- [ ] **Step 1: 矩阵加 windows** — rust/link 两个 job 的 `os` 列表加 `windows-latest`;两 job 各加一步:

```yaml
    - name: Enable long paths
      if: runner.os == 'Windows'
      run: git config --global core.longpaths true
```

  (在 checkout 之前执行;MSVC 工具链 windows-latest 预装,无需安装步骤。)
- [ ] **Step 2: 真实验证** — push 分支观察 Actions:`rust(windows-latest)`、`link(windows-latest)` 首跑;典型首败:pnpm shell 脚本(`bash scripts/build.sh` 在 windows runner 走 Git Bash,一般可用)、路径长度(已开 longpaths)、`cargo test` 中 `#[cfg(unix)]` 用例自动跳过(预期)。按报错修,禁止砍测试绕过。
- [ ] **Step 3: Commit** — `ci: compile and link the rust app on windows`

---

### Task 13: 原子写 Windows 回退(D4)

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`(抽 `replace_existing`;`atomic_write` 改用)
- Modify: `apps/desktop/src-tauri/src/documents/save.rs`(:190 附近的 `persist` 调用点改用同一助手)
- Test: `lib.rs` tests(新增)

**Interfaces:**
- Produces: `pub(crate) fn replace_existing(temporary: tempfile::NamedTempFile, path: &Path) -> Result<(), String>`;`atomic_write` 与 documents 的覆盖保存共用。

- [ ] **Step 1: 写失败测试**(`lib.rs` tests 模块):

```rust
#[test]
fn atomic_write_replaces_existing_file_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.md");
    std::fs::write(&path, "old").unwrap();
    atomic_write(&path, b"new").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
}
```

- [ ] **Step 2: 确认失败/通过情况记录** — mac 上应直接 PASS(记录结果);该测试的裁决权在 Task 12 之后的 `rust(windows-latest)` CI:红 = persist 覆盖不可靠 = 必须让回退生效。
- [ ] **Step 3: 实现助手与接线** — `lib.rs`:

```rust
pub(crate) fn replace_existing(
    temporary: tempfile::NamedTempFile,
    path: &Path,
) -> Result<(), String> {
    match temporary.persist(path) {
        Ok(_) => Ok(()),
        Err(first) => {
            if !cfg!(windows) {
                return Err(format!(
                    "failed to atomically replace destination: {}",
                    first.error
                ));
            }
            // Windows can refuse to rename over a destination another handle
            // holds (indexer, antivirus); retry via a backup rename so the
            // write still lands, restoring the original if the retry fails.
            let backup = path.with_extension("omd-save-backup");
            if let Err(rename_error) = std::fs::rename(path, &backup) {
                return Err(format!(
                    "failed to atomically replace destination: {} (backup rename failed: {})",
                    first.error, rename_error
                ));
            }
            match first.file.persist(path) {
                Ok(_) => {
                    let _ = std::fs::remove_file(&backup);
                    Ok(())
                }
                Err(retry) => {
                    let _ = std::fs::rename(&backup, path);
                    Err(format!(
                        "failed to atomically replace destination: {}",
                        retry.error
                    ))
                }
            }
        }
    }
}
```

  `atomic_write` 末段 `temporary.persist(path).map_err(...)` 改为 `replace_existing(temporary, path)`;`documents/save.rs` 的 `persist` 覆盖调用点同样替换(必要时经 `use crate::replace_existing;` 引入)。回退是否真的被走到由 Windows CI 上 Step 1 的测试实证(经验性激活,不做无法跨平台复现的失败注入)。
- [ ] **Step 4: 确认通过 + Commit** — `cargo fmt` + `cargo test`(mac)+ 推分支看 `rust(windows-latest)` 绿;`fix: keep overwriting saves reliable on windows rename semantics`。

---

### Task 14: Windows 手动 QA 清单

**Files:**
- Modify: `docs/manual-qa.md`(新增「Windows」章节)
- Modify: `docs/memory/known-gotchas.md`(实证新坑)

**Interfaces:** 无代码;裁决 D12(argv 打开)与 A6(覆盖保存)。

- [ ] **Step 1: Windows VM(或 CI 产出的 NSIS 包 + VM 安装;P3 前用 dev 版)执行清单**:

```markdown
## Windows(P2)
- [ ] 启动无 crash、无多余控制台窗口(windows_subsystem 属性)。
- [ ] ☰ 菜单全量走查(同 Linux 清单)。
- [ ] Ctrl 系快捷键全测(同 Linux 清单)。
- [ ] 双击 .md 经文件关联打开(argv 路径裁决 D12:中文/空格路径正常;失败则修 lib.rs 的 argv 处理并补单测)。
- [ ] 覆盖保存已有文件(裁决 A6:多次保存、保存同时被杀毒扫描不丢数据)。
- [ ] Explorer reveal、删除进回收站、重命名、新建。
- [ ] 右键粘贴截图/复制图片(WebView2 无 workaround 门控生效,光标不跳)。
- [ ] 拖拽 .md 到窗口打开;CJK 字体(YaHei 回落)。
- [ ] 外部修改 watcher 提示;HTML 导出;PDF/PNG 入口不可见;诊断包含 os.txt。
```

- [ ] **Step 2: 依 QA 结果修缺(如 D12 argv 编码)并记录 gotchas。**
- [ ] **Step 3: Commit** — `docs: add windows manual qa checklist`(+可能的 `fix:`)。

---

## Phase P3:三平台发布(门控:13-B Task B3 已落地)

### Task 15: release 三平台矩阵 + 校验和(D8)

**Files:**
- Modify: `.github/workflows/release.yml`(build job 矩阵化)
- Modify: `scripts/gen-update-manifest.sh`(补 linux/windows target)

**Interfaces:**
- Consumes: 13-B 的 release workflow、`TAURI_SIGNING_PRIVATE_KEY` secret(已配,见 13-B plan 状态注记)。
- Produces: Release 产物 = mac(.app/.dmg + 签名公证)+ linux(deb/rpm/AppImage,x86_64,ubuntu-22.04 构建)+ windows(NSIS x64)+ `latest.json`(含 darwin/linux/windows target)+ `SHA256SUMS.txt`。

- [ ] **Step 1: build job 矩阵化** — 在既有 mac job 基础上:

```yaml
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest      # 既有签名公证步骤原样保留
          - os: ubuntu-22.04      # 钉旧 LTS 保 glibc 兼容
          - os: windows-latest
    runs-on: ${{ matrix.os }}
    steps:
      # …既有 checkout/pnpm/rust 装配(Task 9/12 的 apt 与 longpaths 步骤照搬)…
      - name: Build (linux)
        if: runner.os == 'Linux'
        run: pnpm --filter @omd/desktop tauri build --bundles deb,rpm,appimage
      - name: Build (windows)
        if: runner.os == 'Windows'
        run: pnpm --filter @omd/desktop tauri build --bundles nsis
      # mac 分支维持既有 tauri build + 公证步骤
```

  Win/Linux 不配置签名(`bundle.macOS` 配置不影响;`createUpdaterArtifacts: true` 会为 AppImage/NSIS 自动产出 `.sig`,复用现有 updater 私钥)。
- [ ] **Step 2: 清单补 target** — `gen-update-manifest.sh` 的 `latest.json` 平台键补:`linux-x86_64`(AppImage 下载 URL + sig)与 `windows-x86_64`(NSIS `.exe` + sig);deb/rpm 不入清单(不支持自动更新,README 说明手动升级)。
- [ ] **Step 3: SHA256SUMS** — release job 合并产物后确定性生成(排序后 `sha256sum`/`shasum -a 256`):

```sh
find . -maxdepth 1 -type f ! -name 'SHA256SUMS.txt' -print0 \
  | sort -z | xargs -0 shasum -a 256 > SHA256SUMS.txt
```

- [ ] **Step 4: 真实验证** — 打临时 tag(或先 `workflow_dispatch` 到测试 repo),确认 Release 出现三类产物 + `latest.json` 三平台 target + SHA256SUMS;旧 mac 版检查更新不受影响(清单向后兼容)。
- [ ] **Step 5: Commit** — `ci: ship unsigned linux and windows builds with checksums`

---

### Task 16: 发布与用户文档

**Files:**
- Modify: `README.md`(下载安装三平台、Linux 依赖说明、未签名说明 + Windows SmartScreen/Linux AppImage chmod 提示)
- Modify: `docs/manual-qa.md`(「发布与升级」矩阵扩展三平台安装烟测)
- Modify: `docs/guides/keyboard-shortcuts.md`(如 Task 8 后有标签来源变化,复核)
- Modify: 根 `AGENTS.md` / `apps/desktop/AGENTS.md`(菜单策略 D2、导出门控 D3、platform.ts 约定、三 OS CI 为默认门槛)

**Interfaces:** 无。

- [ ] **Step 1: README** — 新增「Download & Install」三平台小节 + 「Building from source」按 OS 列前置(ubuntu apt 列表与 CI 一致;Windows:VS BuildTools + Git Bash + Node + pnpm)。
- [ ] **Step 2: manual-qa 发布矩阵** — 三平台各一条「干净环境下载 → 校验 SHA256 → 安装 → 打开 → 建/存 .md」;Linux 额外验证 AppImage updater;Windows 额外验证 NSIS updater 与 SmartScreen 提示文案。
- [ ] **Step 3: AGENTS 同步** — 按上方文件清单补约定(引用 spec D1/D2/D3 而非复述)。
- [ ] **Step 4: 验证 + Commit** — `pnpm verify`;`docs: document three-platform install and release verification`。

---

## 后续接口(本计划不实现)

- **P4 print-PDF 导出**(spec D3/P4):非 macOS 经系统打印对话框导出 PDF,需独立 spec(打印样式路由、页边距/分页控制)后再立 plan。
- **Win/Linux 代码签名**:Windows EV/OV 证书与 Linux 签名(AppImage gpg)是发布质量升级项,独立规格处理。
- **Linux/Windows arm64 产物**:矩阵扩展项,非目标中已排除。
