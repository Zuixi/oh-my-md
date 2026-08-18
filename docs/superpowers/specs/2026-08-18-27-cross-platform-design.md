# 27 Cross-Platform Support(Windows / Linux)

**日期：** 2026-08-18  
**状态：** 待用户审核  
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`  
**关联：** `docs/superpowers/specs/2026-08-16-13-release-engineering-design.md`(其非目标「不做 Windows/Linux 打包」由本规格接手)、`docs/competitors/marktext/cross-platform.md`(本地竞品分析)

## 目标

把「v1 仅支持 macOS」扩展为三平台(macOS / Windows / Linux)可开发、可构建、可发布。分五个里程碑，每个都独立交付可用软件：

1. **P0 可移植地基** —— 平台检测层、快捷键展示分层、导出门控、字体栈、i18n 中性文案、诊断包跨平台、脚本可移植性。全部改动在 macOS 上开发并用现有 Vitest / cargo test 验证，不改变任何 macOS 行为。
2. **P1 Linux 可用** —— CI 增加 ubuntu Rust 编译/测试/链接；应用内菜单(替代 macOS 全局 menubar)；Linux 手动 QA 清单。
3. **P2 Windows 可用** —— CI 增加 windows；原子写覆盖验证与回退；argv 打开与文件关联 QA。
4. **P3 三平台发布** —— release 矩阵(mac 签名公证 + Linux deb/rpm/AppImage + Windows NSIS,后两者不签名)+ SHA256SUMS + updater 产物。
5. **P4 导出对齐(可选后续)** —— 非 macOS 通过系统打印对话框导出 PDF。

依据：全仓平台耦合点审计(2026-08-18)与 MarkText 竞品分析。审计结论概要：

- **硬阻塞**：菜单走 macOS 全局 menubar(`menu.rs:316`,Win/Linux 不可见)；PDF/PNG 导出为 WKWebView/macOS 专用(`export.rs:99-107`);CI 从不在非 macOS 编译 Rust;`sync-version.sh:37` 用 BSD sed;Windows 上 `NamedTempFile::persist` 覆盖已有文件不可靠(`lib.rs:293-314`,坐拥所有保存路径)。
- **行为差异**：诊断包硬编码 `Library/Logs` 布局、仅读 `HOME`、调 `uname`(`diagnostics.rs`);快捷键匹配已双修饰(`metaKey || ctrlKey`)但展示标签全是 ⌘ 字形；macOS WebKit 右键粘贴 workaround 会改变其他引擎行为(`imagePaste.ts:66-143`);「Reveal in Finder」文案;Cairo 字体栈缺失 Win/Linux 字体。
- **已可移植的部分**(无需动)：全部 35 个 Tauri 命令的签名与语义、`dirs::data_dir` 存储、notify 文件监听 + 轮询兜底、trash crate、路径 `\`→`/` 归一化(多数入口)、`main.rs` 的 `windows_subsystem` 属性、图标三格式齐备。

## 非目标

- **不做自定义标题栏/无边框窗口**(MarkText 的最大复杂度来源)；三平台保留系统装饰。
- **不做 Windows/Linux 代码签名**。沿用 MarkText 先例：不签名 + SHA256SUMS + 用户侧说明；macOS 签名公证维持 13 号规格不变。
- **不承诺导出全平台对齐**：PDF/PNG 导出在非 macOS 上隐藏入口(P4 才做打印对话框 PDF);HTML 导出本就跨平台。
- **不做 E2E 自动化**(路线图已定)；非 macOS 验证 = CI 自动检查 + VM 手动 QA。
- 不构建 arm64 Linux / Windows 产物(仅 x86_64;macOS 维持现有 arch)。
- 不引入三份硬编码键位表(见决策 D7,与 MarkText 不同)。
- 不改变任何 v1 macOS 行为；所有平台分支在未知平台默认按 macOS 处理(保证现有测试与用户零感知)。

## 用户流程

**Linux / Windows 用户(P3 后)**

1. 从 GitHub Release 下载 `.deb` / `.AppImage` / `.exe`(或 `.rpm`),校验 SHA256。
2. 安装并启动；系统文件关联已注册(Tauri bundle `fileAssociations`),双击 `.md` 直接打开。
3. 编辑体验与 macOS 一致：Ctrl 系快捷键、命令面板、格式化、表格、图片粘贴、快照、工作区/搜索。
4. 菜单入口:TopBar 左侧 ☰ 按钮打开应用内菜单(文件/编辑/格式/显示 + Open Recent)。
5. 保存/自动保存/冲突保护照常；HTML 导出可用;PDF/PNG 入口隐藏。
6. 更新:AppImage / NSIS 版本经 updater 自动检查;deb/rpm 手动升级(文档说明)。

**开发者**

- 任一平台克隆仓库 → 按 README 装平台前置(Linux 需 webkit2gtk 系统包;Windows 需 VS Build Tools + Git Bash)→ `pnpm install && pnpm dev`。
- push 即在三个 OS 的 CI runner 上编译、测试、链接。

## 接口与架构

### D1 平台检测层(唯一入口)

新增 `apps/desktop/src/platform.ts`:

```ts
export type AppPlatform = "macos" | "windows" | "linux"
export function currentPlatform(): AppPlatform   // 解析 navigator.userAgent
export function isMacOS(): boolean
export function isWindows(): boolean
export function isLinux(): boolean
```

- UA 匹配:`Windows` → windows;`Linux`/`X11` → linux;其余(含无法识别)→ **macos**(保持现状语义，现有测试与用户零感知)。
- 全 desktop 代码的平台分支只允许经过这三个布尔(MarkText 同款纪律)；Rust 侧用 `std::env::consts::OS` / `cfg!`。
- 理由：Tauri 渲染进程沙箱内没有 `process.platform`;不引入内部 API(`__TAURI_INTERNALS__`);测试用 `Object.defineProperty(navigator, "userAgent", …)` 显式注入。

### D2 菜单策略：macOS 原生菜单保留，Win/Linux 应用内菜单

- macOS:`menu::install` / 全局 menubar 完全不变。
- Win/Linux:`menu.rs` 的 `install` 与 `rebuild_from_state` 在 `!cfg!(target_os = "macos")` 时直接返回 —— 不装原生菜单(`app.set_menu` 在 Win/Linux 无处渲染);`set_recent_files` / `set_view_menu_state` / `set_menu_locale` 三个命令保持注册与签名(IPC 契约不变)，变为自然 no-op。
- 前端：TopBar 在 `!isMacOS()` 时渲染 ☰ 按钮，弹出新的 `AppMenu.tsx` 下拉菜单。菜单树定义在新 `menuTree.ts`(id 复用 `MENU_TO_COMMAND` 的菜单 id 空间 + `recent:` 前缀，执行复用现有 `runMenuCommand`),条目标签复用现有 `cmd.label.*` i18n key,分区标签新增 `menu.file/edit/format/view` key。PDF/PNG 导出条目带 `macOSOnly` 标记,非 macOS 隐藏。
- 漂移防线：扩展 `crossLayerMenu.test.ts` —— 断言 `menuTree.ts` 的 id 集合与从 `menu.rs` 解析出的 id 集合一致(两棵树一源化校验)。
- 快捷键可用性:无原生菜单后，快捷键全部走现有 webview 路径(engine keymap `Mod-*` + `App.tsx` 的 `matchesWindowShortcut` 双修饰匹配)——已天然支持 Ctrl。
- 否决的替代方案：Tauri window menu(Win/Linux 会插入窗口内原生菜单栏，改变布局且 GTK 行为不稳)；自绘标题栏(非目标)。

### D3 导出门控

- `export_preview`(`export.rs`)的 macOS 分支与错误兜底不变(后端是唯一事实)。
- 前端在 `!isMacOS()` 时从命令面板与 AppMenu 隐藏 `export-pdf` / `export-image`(HTML 导出保留);过滤作用于命令数组的唯一定义点,palette、`runMenuCommand`、AppMenu 一并继承。既有 `error.export.desktopOnly` 文案改为 macOS 语义(该错误实际只在非 macOS 桌面触发,不新增死键)。

### D4 原子写 Windows 回退

- `lib.rs` 抽出 `replace_existing(temp: NamedTempFile, path: &Path)`:`persist` 失败且 `cfg!(windows)` 时执行 备份→重命名→清理 的回退链(备份失败回滚)；`atomic_write` 与 `documents/save.rs` 的覆盖保存统一走它。
- 回退链是否被走到由 CI Windows 上的「覆盖已有文件」测试实证决定(测试红 = persist 不可靠 = 回退生效)。

### D5 诊断包跨平台

- `export_diagnostics` 用 `app.path().app_log_dir()`(macOS 与现状同路径,Win/Linux 自动正确)替代硬编码 `Library/Logs/md.ohmy.desktop`;home 用 `dirs::home_dir()`(Windows 下 `HOME` 为空);`uname -a` 子进程替换为 `os_info` crate(产出写 `os.txt`)。
- 脱敏 `redact_line` 的 home 前缀替换在 `C:\Users\...` 形态下同样成立(纯字符串替换),不改算法。

### D6 字体栈

- `styles.css` 编辑区字体栈补 `"Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC"`;等宽栈补 `"Cascadia Mono", Consolas, "Liberation Mono"`;`settings.ts` 预设同步。不内置字体文件(YAGNI,与 MarkText 不同)：系统栈足够，留待用户反馈。

### D7 快捷键：binding 单一来源 + 平台格式化

- `WindowShortcut.keys`("⌘S" 字面量)改为 `binding`("Mod+s" 规范形);`shortcutFor()` 返回 `formatBinding(binding, currentPlatform())` —— mac 显示 ⌘⇧⌥,Win/Linux 显示 Ctrl/Shift/Alt。
- engine 侧从 `markdownKeyBindings` / livePreview 的 toggle 定义派生导出 `markdownShortcutBindings` / `toggleShortcutBindings`(id → CM6 key 规范形)，engine 保持平台无关(不做检测，只暴露 binding);`display` 字段保留(= macOS 格式)，新增 parity 测试锁死「display == formatBinding(key, macos)」。
- 匹配逻辑(`metaKey || ctrlKey`、engine `Mod-`)不变 —— 匹配早已跨平台，本决策只修展示层。

### D8 CI 与发布矩阵

- `ci.yml` 的 `rust` 与 `link` job 改为矩阵 `macos-latest / ubuntu-latest / windows-latest`(`fail-fast: false`);ubuntu 装 webkit2gtk-4.1 等 Tauri Linux 依赖；windows 开 `core.longpaths`。
- `release.yml`(13-B B3 落地后扩展)：mac 签名公证照旧；Linux 钉 `ubuntu-22.04`(glibc 兼容，MarkText 同款教训)产 deb/rpm/AppImage;Windows 产 NSIS。`createUpdaterArtifacts` 已开 → AppImage/NSIS 自动获得更新签名；统一 `latest.json` 清单补 linux/windows target。发布产物附确定性生成的 `SHA256SUMS.txt`,draft release 流程照旧。deb/rpm 不支持自动更新 → 文档明示手动升级。

### D9 脚本可移植

- `sync-version.sh` 的 `sed -i ''` 改为 `sed -i.bak` + 清理(BSD/GNU 通用)。根 package.json 的 bash 脚本在 Windows 依赖 Git Bash —— README 前置要求写明，不重写。

### D10 文案中性化

- `filetree.menu.reveal` / `conflict.action.revealInFinder` 的值改为中性「Reveal in File Manager / 在文件管理器中显示」(调用的是跨平台 opener,无需平台分支文案)。

### D11 WebKit 右键 workaround 门控

- `imagePaste.ts` 的 contextmenu 选区补偿(workaround macOS WKWebView `selectionchange` bug)仅在 `!isWindows()` 时执行(WebView2 无此 bug);WebKitGTK 是否需要由 P1 Linux QA 实证后收窄或维持。

### D12 打开文件路径

- 现状已覆盖:`RunEvent::Opened`(mac)与 `tauri_plugin_single_instance` argv(Win/Linux)+ `take_pending_open_files` 队列。P2 QA 实证 Windows argv 的 UTF-16/拖拽路径形态,不改代码除非 QA 变红。

## 约束

- **安全**：新增依赖仅 `os_info`(纯只读系统信息)；不新增 IPC 命令、不改任何命令签名(`export_diagnostics` 内部实现变化，wire 格式不变);Win/Linux 产物未签名的事实必须写进 Release 说明。
- **行为冻结**：所有 P0 改动在 macOS 上的可见行为不变(标签格式化后字符串逐字相同、菜单不变、导出不变)；以现有测试全绿为门槛。
- **性能**：平台检测为纯字符串解析,模块级记忆化;菜单组件懒挂载。
- **无障碍**：☰ 按钮与 AppMenu 满足 `aria-haspopup` / `aria-expanded` / Escape 关闭 / 方向键导航;导出条目隐藏而非 disabled(屏幕阅读器不播报不可用项)。
- **迁移**：用户数据目录已按 OS 正确(`dirs::data_dir`),无数据迁移;`WindowShortcut.keys` 字段改名是 desktop 内部 API,一次性同步全部消费方。
- **构建环境**：本机为 macOS,Win/Linux 构建只发生在 CI;本机不可交叉编译 Tauri webview 应用,这是流程约束而非可选。

## 测试矩阵

| 层 | 测什么 | 工具 |
|---|---|---|
| desktop | `currentPlatform()` 对 mac/win/linux/未知 UA 的判定 | Vitest(mock UA) |
| desktop | `formatBinding` 三平台输出；palette 标签 mac 下与旧字符串逐字一致 | Vitest |
| engine | `markdownShortcutBindings` 与 keymap/`display` parity | Vitest |
| desktop | AppMenu 渲染分区/条目、`recent:` 派发、非 mac 隐藏 `macOSOnly` 条目、Escape 关闭 | Vitest(happy-dom) |
| desktop | `menuTree` id 与 `menu.rs` 解析出的 id 集合一致(扩展现有 drift 测试) | Vitest |
| desktop | 非 mac 平台下命令面板不含 export-pdf/export-image | Vitest |
| Rust | 诊断包:注入临时 log dir → `os.txt` 存在、日志内容脱敏;`write_diagnostics_bundle` 新签名 | cargo test(三 OS CI) |
| Rust | `atomic_write` 覆盖已有文件成功;persist 失败(目标为目录)时回退链保全数据 | cargo test(三 OS CI,Windows 红即回退生效) |
| CI | 三 OS × (fmt/test + 前端构建 + 二进制链接) 全绿 | GitHub Actions |
| 发布 | tag → 三平台产物 + `latest.json` 含新 target + SHA256SUMS | release workflow + 人工核对 |

## 手动 QA(摘要，清单全文随实施写入 `docs/manual-qa.md`)

- **Linux VM**:安装 deb → 打开/编辑/保存；文件管理器 reveal;回收站删除；CJK 字体；右键粘贴行为(裁决 D11);拖拽 .md 到窗口打开；Ctrl 快捷键全测。
- **Windows VM**:NSIS 安装 → 关联 .md 双击打开(argv 路径,裁决 D12);**覆盖保存已有文件**(A6 实证)；Explorer reveal;回收站；Ctrl 快捷键； ☰ 菜单完整走查。
- **macOS 回归**:P0 全量 + 菜单/导出/标签字符串抽查。

## 文档

- `README.md`:三平台开发前置(Linux 系统包、Windows VS BuildTools + Git Bash)、下载安装说明、未签名说明。
- `docs/manual-qa.md`:新增 Linux / Windows 章节(上述清单)。
- `docs/guides/keyboard-shortcuts.md`:补「Windows/Linux 上 ⌘→Ctrl、⌥→Alt」说明。
- 根 `AGENTS.md`:Workspace Conventions 增「平台分支只经 `platform.ts` / `cfg!`」一条。
- `apps/desktop/AGENTS.md`:菜单策略(D2)与导出门控(D3)说明。
- `docs/memory/known-gotchas.md`:Linux/Windows 实证中的新坑(如 WebKitGTK 右键、Windows persist)。

## 对后续规格提供的稳定接口

- `platform.ts` 的三布尔 + `formatBinding` 是所有前端平台分支与快捷键展示的唯一入口，后续规格不得绕过。
- `menuTree.ts` 是应用内菜单结构的单一来源；新增菜单项 = 同时更新 `menu.rs` 与 `menuTree.ts`(drift 测试强制)。
- 三 OS CI 矩阵成为所有后续 Rust 改动的默认门槛(替换现 macOS-only 编译检查)。
- P4(print-PDF)与 Win/Linux 代码签名是明确的后续接口，本规格不实现。
