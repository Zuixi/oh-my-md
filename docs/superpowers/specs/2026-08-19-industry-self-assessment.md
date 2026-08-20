
h-my-md 业内定位自我剖析

**日期：** 2026-08-19  
**状态：** 分析快照（非批准规格；供路线图与优先级讨论）  
**父文档：** [2026-08-16-industry-gap-analysis.md](./2026-08-16-industry-gap-analysis.md)  
**关联：** [2026-08-18-27-cross-platform-design.md](./2026-08-18-27-cross-platform-design.md)、[manual-qa.md](../../manual-qa.md)

> 本文汇总 2026-08-19 对话中的三项分析：Windows `pnpm dev` 失败根因、整体业内水平判断、导出/平台与日常写作长尾缺口。  
> 2026-08-16 差距分析中的 P0/P1 多项已落地（06–07、11、15–16、19–26 等）；本文在彼基础上更新状态并展开细节。

## 对标范围

**Typora / MarkText** 类「单文件 + Live Preview」桌面编辑器，不是 Obsidian 库/双链/插件生态。

---

## 一、总体结论

| 维度 | 判断 |
|------|------|
| 架构与工程 | 达到或超过开源 Markdown 编辑器主流；引擎拆分、冲突保存、测试/CI 偏上游 |
| 编辑内核 | Live Preview + GFM 主干 + 大文档策略 ≈ 主流 |
| 产品完成度 | Typora 向 Alpha/Beta：能写能存，日常长尾与 polish 未齐 |
| 跨平台 | CI 三 OS 已有；本地 dev / 发布 / 平台 QA 仍在 P1/P2/P3 |

**一句话：** 技术路线正确、底座专业；距「可替代 Typora 当主力」差在跨平台成品度、导出可控性、日常写作长尾与 a11y/i18n。

---

## 二、Windows `pnpm dev` 失败（EACCES :1420）

### 现象

```
Error: listen EACCES: permission denied 127.0.0.1:1420
```

### 启动链

```text
pnpm dev → tauri dev → beforeDevCommand: vite → 绑定 127.0.0.1:1420 (strictPort: true)
```

端口配置：`apps/desktop/vite.config.ts`（1420、strictPort、127.0.0.1）与 `apps/desktop/src-tauri/tauri.conf.json`（devUrl）必须一致。

### 根因（按可能性）

1. **Windows TCP 保留端口段（主因）** — Hyper-V / WSL2 / Docker Desktop（WinNAT）动态保留区间常含 1420；绑定报 `EACCES`（非 `EADDRINUSE`）。见 [tauri#6804](https://github.com/tauri-apps/tauri/issues/6804)。
2. **IPv6 localhost（已缓解）** — `vite.config.ts` 已强制 `127.0.0.1`，当前错误指向端口本身不可绑。
3. **项目背景** — README 写明 Windows 本地 dev 属 P2；`known-gotchas.md` 仅记录端口占用（EADDRINUSE），未记录 Win 保留端口 EACCES。

### 验证

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
netstat -ano | findstr ":1420"
```

### 处理方向

- **最快：** 同步修改 `vite.config.ts` 与 `tauri.conf.json` 为未占用端口（如 3173）。
- **项目级：** 可配置 dev 端口 + `known-gotchas.md` 补充 + 考虑默认可避开常见保留段。

---

## 三、与业内主流的分项评估

| 层级 | 评分（参考） | 说明 |
|------|-------------|------|
| 架构 | ★★★★☆ | CM6 装饰、engine/host 分离、薄 IPC |
| 引擎 / Live Preview | ★★★★☆ | 增量装饰、大文档安全模式 |
| 保存 / 冲突 / 恢复 | ★★★★★ | 优于多数开源同类 |
| 测试 / CI | ★★★★☆ | 78+ 测试文件、三 OS link job；无 E2E |
| 产品完成度 | ★★★☆☆ | 核心链路专业；长尾未齐 |
| 跨平台 | ★★☆☆☆ | 编译矩阵有，dev/发布/QA 未完成 |
| 规格化 / 可维护性 | ★★★★★ | specs/plans/AGENTS/gotchas 完整 |

### 与竞品简表

| 维度 | oh-my-md | MarkText | Typora |
|------|----------|----------|--------|
| 技术栈 | Tauri 2 + CM6 | Electron + CM | 闭源 |
| 冲突保存 | 强 | 弱 | 够用 |
| 测试深度 | 强 | 中 | 未知 |
| 三平台成品 | 进行中 | 成熟 | 成熟 |

---

## 四、导出 / 平台特性 — 待补全清单

### 4.1 导出能力

| 缺口 | 现状 |
|------|------|
| PDF/PNG 仅 macOS | `export.rs` 非 macOS 返回错误；Win/Linux 菜单已门控 |
| Win/Linux PDF 方案 | 路线图 P4（WebView2 / WebKitGTK）未实现 |
| PDF/PNG 固定亮色 | 规格 19：导出预览不按暗色主题 |
| 导出 HTML 排版 CSS 薄 | `exportRichHtml` 模板缺正文样式；不继承 `styles.css` |
| 自定义 CSS 不进导出 | `customCss` 仅 `applyTheme` 作用于编辑器 |
| 远程 http 图不进 PDF | 规格 11：不内嵌 data URL |
| 无 DOCX/Epub、无 PDF 版式（页边距等） | 产品非目标 |
| 无系统打印预览 | macOS 离屏 WKWebView + createPDF |

### 4.2 跨平台与发布

| 缺口 | 现状 |
|------|------|
| Windows 本地 dev | 1420 EACCES；脚本依赖 Git Bash |
| 三平台 release | CI link 有；签名/NSIS/deb 等待 P3；Apple 账号阻塞 |
| Win/Linux 自动更新 | 产物配置有；端到端未验证 |
| 文件关联 | macOS 需打包验证；Win/Linux manual-qa NOT RUN |
| Win/Linux 菜单 | AppMenu 下拉 vs macOS 原生 menubar |
| Windows 原子写回退 | 规格 D4；以 Windows CI 实证 |
| i18n 长尾 | 错误 alert、冲突 banner 等 zh 仍为英文（manual-qa 已知） |

### 4.3 平台质量门槛

| 缺口 | 现状 |
|------|------|
| 无障碍规格 12 | 未启动；VoiceOver/键盘 QA NOT RUN |
| E2E | 发布规格 deliberate 不做 |
| IME / 中文路径 | QA 未跑 |
| macOS Finder tags | QA NOT RUN |
| UTF-8 only / 不改 CRLF | 规格明确 |
| dev 端口硬编码 1420 | Tauri 惯例 + Win 保留段风险 |

---

## 五、日常写作长尾 — 待补全清单

### 5.1 未实现或仅规格

| 缺口 | 说明 |
|------|------|
| AI 块操作 | 规格 14，零代码 |
| 插件生态 | 规格边界有，无运行时 |
| Smart Punctuation | 06 明确不做 |
| 下标 / 上标 | 差距分析后置 |
| 查找历史 / 跨文件替换 | 20 明确不做 |
| 「粘贴为纯文本」命令 | HTML 粘贴有；无显式命令 |
| 拖文件夹开工作区 | 22：v1 仅单 .md |
| 多文件拖入多标签 | v1 只取第一个 md |
| 图床 | 16 不做 |

### 5.2 已有但深度不足（manual-qa 已知限制）

| 缺口 | 说明 |
|------|------|
| 代码块编辑态无高亮 | 进入即源码 |
| 表格单元格引用式链接 | 不解析 |
| 脚注跨空行多段 | 不合并 |
| 行内 HTML 有限 | 仅 mark/u/实体 |
| GitHub 自定义 emoji | 无 :octocat: |
| 数学定界符 | 仅 $ / $$ |
| Phase 08 polish 余项 | 暗色数学/表格微调 |
| front matter | 仅 chip；无字段面板/YAML 校验 |
| GIF/SVG 图片 | 仅 PNG/JPEG/WebP |
| 无障碍 | banner/tree/dialog 未系统验收 |
| 拼写检查 | WebView 原生，无词典管理 |

---

## 六、优先级建议

### 导出 / 平台（阻塞「能发、能用」）

1. Win/Linux PDF 方案 + 三平台 release 烟测  
2. Windows dev 体验（端口/脚本）  
3. 导出 HTML 排版 CSS + custom CSS 注入  
4. 各 OS 文件关联、回收站、Reveal 实证  

### 日常写作（阻塞「愿每天用」）

1. Phase 08 剩余（暗色数学/表格、导出边角一致）  
2. 无障碍 12（keyboard + 主要 dialog/banner）  
3. Smart punctuation、上下标  
4. 代码块编辑态高亮（成本高）  
5. front matter 字段视图  

### 差异化（不阻塞 Typora 对标）

- AI、插件 — 排在发布可靠性之后（路线图 Phase C）。

---

## 七、文档放置说明

本文 intentionally 放在 **`docs/superpowers/specs/`**：

- 与 [2026-08-16-industry-gap-analysis.md](./2026-08-16-industry-gap-analysis.md) 同族，便于路线图引用。
- 使用 `YYYY-MM-DD-*` 日期前缀，可排序、可快照。
- **不**写入 `docs/memory/`（仅 verified 可复用陷阱）。
- **不**写入 `docs/competitors/`（该目录为本地竞品笔记且 gitignore；自我剖析若需仅本机保留可选用 `docs/competitors/oh-my-md/`）。

状态为「分析快照」而非「已确认规格」：落地项应另开 spec/plan 或更新既有 gap 分析的状态块。

---

## 八、后续维护

- 重大里程碑（P2 Win 可用、P3 发布、08/a11y 完成）后更新本文或 supersede 为新日期快照。
- 单点陷阱（如 Win dev 端口）验证后摘入 `docs/memory/known-gotchas.md`。
- 用户可见行为变化同步 `docs/manual-qa.md`。

---

## 九、可行方案（业内最佳实践对齐）

> 本节为分析快照的 remediation 建议；落地时应另开 spec/plan 或更新 [27-cross-platform-design.md](./2026-08-18-27-cross-platform-design.md) 等既有规格。  
> 原则：**单一 HTML 真相源**（预览 widget ↔ `exportRichHtml` ↔ 未来 PDF）、**引擎无 Tauri**、**跨层常量 + drift 测试**、**小 spec 独立交付**。

### 9.1 总策略：三条并行轨道

```text
轨道 A — 跨平台可用（P2/P3）   → Win/Linux dev + 装包 + HTML 导出
轨道 B — 导出质量（HTML 先行） → 一条管道、三平台一致；PDF 分阶段
轨道 C — 日常写作长尾         → 小步 spec，不碰引擎大重构
```

对标 MarkText：**先三平台可安装可写，PDF 后补；HTML 导出是跨平台基线。**

### 9.2 Windows dev / 跨平台地基

#### Dev 端口（1420 EACCES）

| 方案 | 做法 | 评价 |
|------|------|------|
| **A. 统一常量 + 环境变量（推荐）** | `constants.ts` 定义 `DEV_SERVER_PORT`（默认避开 Win 保留段，如 `3173` 或 `14200`）；`vite.config.ts` 读 `process.env.OMD_DEV_PORT ?? 常量`；`tauri.conf.json` 的 `devUrl` 与 Vite 同步（build 脚本或 drift 测试守卫） | Tauri/electron 社区常见；见 [tauri#6804](https://github.com/tauri-apps/tauri/issues/6804) |
| **B. 文档 + 故障指引** | README + `known-gotchas.md` 写 `netsh` 排查；`OMD_DEV_PORT=3173 pnpm dev` | 作 A 的补充 |
| **C. strictPort: false** | Vite 自动换端口 | Tauri `devUrl` 固定，**不可行** | ❌ |

验证后把 Win 保留端口 EACCES 摘入 `docs/memory/known-gotchas.md`。

#### 脚本可移植

- 根 `package.json` 已有 `verify:win` / `verify:unix`；README 写清 Windows 前置（VS Build Tools + Git Bash 或 PowerShell 脚本）。
- CI / 本地：`scripts/build.ps1` 与 `build.sh` 双入口（27 规格 P0）；`pnpm verify` 在 win32 默认走 ps1。

#### 三平台 PDF（对齐 27 规格 P4）

| 方案 | 平台 | 做法 |
|------|------|------|
| **P4-a 系统打印 PDF** | Win/Linux | WebView2 PrintToPdf / WebKitGTK 打印，或「Export HTML + 浏览器打印为 PDF」指引 |
| **P4-b 离屏 WebView** | macOS | 保持现有 `export_preview` + `__omdExportReady` |
| **P4-c headless Chromium** | 全平台 | Playwright/chromium 渲染 HTML→PDF | 依赖重，非 v1 首选 |

**推荐：** 分平台实现、**统一 HTML 输入**（`exportRichHtml`）；macOS 保持 Rust 离屏 WebView；Win/Linux Phase 1 仅 HTML + 打印指引，Phase 2 接 WebView2 PrintToPdf。PNG 可 macOS-only 或后置。

### 9.3 导出能力

#### 导出 HTML 排版与 custom CSS

| 方案 | 做法 |
|------|------|
| **A. 共享 export 样式包（必做）** | 新建 `packages/engine/src/export/export.css`（或从 desktop 抽离 `omd-export-*` 子集）；`exportRichHtml` 模板内联该 CSS + 已有 Shiki 暗色块；`export-rich.test.ts` 断言 |
| **B. 注入用户 customCss** | `exportRichHtml(state, { customCss?: string })`；桌面从 settings 传入 |
| **C. 外链 stylesheet** | HTML `<link>` 引用外部 CSS | 离线差，不作默认 |

业内惯例：**self-contained HTML**（内联 CSS + 已渲染 math/code），对标 MarkText / Pandoc 静态站导出。

#### 远程图片与 PDF 缺图

1. **保守（现状）：** 远程 URL 原样保留，PDF 需联网。
2. **渐进：** 导出选项「仅本地 / 尝试内嵌 http（需确认）」；Rust `reqwest` + 大小上限（复用 10 MiB 常量）。
3. **务实（推荐先做）：** 检测到远程 `img` 时 toast 警告「PDF 可能缺图」。

#### PDF 版式 / 暗色

- 页边距：HTML `@page { margin: … }` + 打印 CSS。
- 暗色 PDF：设置项 **「导出 PDF 使用亮色主题」**（与预览主题解耦）；规格 19 已倾向打印白底。
- **v1 不做：** DOCX、模板商店（差距分析已排除）。

### 9.4 跨平台发布与 OS 集成

#### 发布流水线（P3，27 规格已有蓝图）

1. CI release matrix：`ubuntu-22.04` + `windows-latest` + mac 签名。
2. 产物：deb / AppImage / NSIS + `SHA256SUMS.txt`。
3. 未签名：README SmartScreen / AppImage chmod 说明（MarkText 先例）。
4. Updater：AppImage + NSIS 走 Tauri updater；deb/rpm 文档写手动升级。

#### 文件关联与 argv

- Tauri `fileAssociations` + `single_instance` 已有；P2 交付 = **NSIS 安装包 + 干净 VM 烟测 checklist**。
- 下一 spec：拖文件夹 → `openFolder`（22 规格 v1 仅单 `.md`）。

#### i18n 长尾

- 冲突 banner、save 状态、error alert 全部迁入 `i18n/messages/{zh,en}.ts`。
- `i18n.test.ts` 扩展：user-facing key 中英成对。
- 优先级：conflict / normalization / export 错误 → 次要 settings 文案。

#### 无障碍（补写规格 12）

| 期 | 范围 |
|----|------|
| 1 | FileTree roving tabindex；banner 按钮 Tab 顺序；CommandPalette/QuickOpen 键盘闭环 |
| 2 | tablist / tree / dialog ARIA（FindReplaceBar 无效正则 `role="alert"` 已有） |
| 3 | manual-qa VoiceOver/NVDA；不强制全量 E2E |

与发布规格一致：**键盘模型 + 少量 smoke**，不全量 E2E。

### 9.5 日常写作长尾

#### 低成本、高感知

| 项 | 方案 |
|----|------|
| 粘贴为纯文本 | 命令 `paste-plain-text`：`readText()` + dispatch，与 HTML 粘贴并列 |
| Smart punctuation | 可选设置 + CM `inputHandler` 处理 `"` `'` `--` `...`；**默认关** |
| 上标 / 下标 | `~x~` / `^x^`（Typora 语法）；Lezer/inline + export 同步 |
| 数学定界符 | `parse/math.ts` 增加 `\(...\)` / `\[...\]`，与 `$` 共用 KaTeX |
| front matter 面板 | v1：chip 展开 YAML 源码；v2：简单 key-value 表单（不引入 YAML 校验库） |

#### 中成本、Typora 差距明显

| 项 | 方案 |
|----|------|
| Phase 08 余项 | 暗色 KaTeX/表格 CSS 与 `styles.css`、export 对齐 |
| 代码块编辑高亮 | 光标在 fence 内挂轻量 highlight；**禁止** forceParse 全文档（见 complete-tree gotcha） |
| 表格引用式链接 | 单元格内限制或扩展 inline 子集 |

#### 明确后置

- AI / 插件：规格 14，发布稳定后。
- 图床 / DOCX / 双链：不纳入 Typora 对标 v1。
- Vim / 行号：非目标用户群。

#### 工作区体验

- 拖文件夹：`listenDragDrop` 识别目录 → `openFolder`。
- 多文件拖入：过滤 `.md`，循环 `runOpen`（上限如 10）。
- Quick Open：最近打开权重 + 排序微调（子串过滤已有）。

### 9.6 工程与质量支撑

| 实践 | 做法 |
|------|------|
| Smoke E2E（可选） | 一条：启动 → 输入 → 保存 → 读盘（tauri-driver / WebDriver）；可 amend 13 规格 |
| Win 保存实证 | `atomic_write_replaces_existing_file` 必须在 `windows-latest` CI 绿（27 D4） |
| 导出回归 | fixture 含 math/code/mermaid/table/front matter；`exportRichHtml` 快照 hash |
| 常量 drift | `crossLayerConstants.test.ts` 增加 `DEV_SERVER_PORT`（若采用 9.2 方案 A） |

### 9.7 推荐实施顺序（示意）

```text
Week 1–2   Dev 端口常量化 + known-gotchas + README Win 前置
Week 2–4   export.css + customCss 进 exportRichHtml；远程图警告
Week 4–6   P2：Win VM QA（安装/关联/保存/HTML 导出）；i18n 冲突/错误
Week 6–8   P3 release 矩阵 + SHA256；Updater 烟测
Week 8–10  粘贴纯文本 + smart punct（可选）+ 上下标/数学定界符
Week 10–12 a11y spec 12 一期 + Phase 08 CSS；P4 Win 打印 PDF spike
```

PDF 全平台统一放在 **P4 spike 成功后再 spec**，避免阻塞 P2/P3。

### 9.8 与第六节优先级对照

| 第六节优先级 | 第九节对应方案 |
|-------------|----------------|
| Win/Linux PDF + release 烟测 | 9.2 P4-a/b、9.4 发布流水线 |
| Windows dev 体验 | 9.2 Dev 端口 A + 脚本 ps1 |
| 导出 HTML + custom CSS | 9.3 export.css + customCss 注入 |
| 各 OS 文件关联 QA | 9.4 NSIS + VM checklist |
| Phase 08 / a11y | 9.5 中成本表 + 9.4 无障碍三期 |
| Smart punct / 上下标 / front matter | 9.5 低成本表 |


