# Windows 安装向导品牌体验优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Tauri NSIS / WiX 技术约束内，消除内页 header 居中 logo 的突兀感，把品牌展示收敛到欢迎/完成页的左侧 sidebar，并精简中英文安装文案；不引入 Web/CSS 自定义 UI 或 fork 整套安装器（除非 P2 最小模板补丁）。

**Architecture:** NSIS Modern UI 2 已是「左 sidebar + 右操作区」分栏；问题来自我们把方形 logo 居中 pad 进 150×57 header。修复策略是 **位图职责分离**：sidebar 承载完整品牌面板（渐变底 + logo + 产品名 + 版本），header 要么移除要么只做左对齐细条；文案通过 Tauri `customLanguageFiles`（Tauri 自有字符串）+ 可选最小 `installer.nsi` 补丁（MUI 欢迎/完成页）覆盖。WiX 的 dialog/banner 与 NSIS sidebar 共用同一套视觉源文件。

**Tech Stack:** Tauri 2 `bundle.windows.nsis` / `wix`、24-bit BMP、Python 3 + Pillow（生成脚本，仅 dev）、ffmpeg（保留为 fallback 或移除）、Vitest 尺寸漂移测试、Windows 手测。

**Related:** `docs/memory/known-gotchas.md`（Windows installer BMP 约束）、`scripts/generate-installer-images.sh`、`apps/desktop/test/tauriConfig.test.ts`

---

## 约束与不做项

| 约束 | 说明 |
|------|------|
| NSIS 不是 Web UI | 不能设 CSS、`font-weight`、圆角按钮、hover 态 |
| 位图固定尺寸 | header 150×57、sidebar 164×314、WiX banner 493×58、dialog 493×312 |
| Tauri 模板升级 | 完整 fork `installer.nsi` 有合并成本；P2 只做最小 diff |
| 当前无许可页 | `tauri.conf.json` 未配置 `bundle.licenseFile`；许可协议交互 **Out of scope** |
| 步骤 Stepper | NSIS MUI 无内置步骤条；需 custom page，**Defer 到 P3** |
| 构建环境 | BMP 生成在 macOS CI/本机均可；NSIS 包必须在 Windows 上构建验证 |

**Peer review 映射：**

| Peer 建议 | 本计划对应 |
|-----------|------------|
| 左右分栏 + 左侧品牌区 | P1 `sidebarImage` 品牌面板 |
| 内页 header 居中 logo 突兀 | P0 移除或弱化 `headerImage` |
| 精简中文欢迎语 | P2 `customLanguageFiles` + 可选 MUI 字符串 |
| CSS Primary/Ghost 按钮 | **不做** |
| 步骤 1/4 Stepper | **Defer P3** |
| 许可协议默认未勾选 | **不做**（无 license 页） |

---

## 视觉规范（设计 token）

从 `app-icon.png` / 产品 UI 提取，写入生成脚本常量：

```text
OMD_BRAND_BLUE     = #2563EB   # logo「m」拱形蓝，略深于 peer 示例 #3B82F6
OMD_BRAND_BLUE_TOP = #3B82F6   # sidebar 渐变顶色
OMD_BRAND_BLUE_BOT = #1D4ED8   # sidebar 渐变底色
OMD_PANEL_TEXT     = #FFFFFF   # sidebar 上产品名/版本
OMD_HEADER_BG      = #F3F4F6   # 内页 header 条背景（若保留）
OMD_HEADER_ACCENT  = #2563EB   # header 左缘 4px 竖线（若保留）
```

**Sidebar 164×314 布局（烘焙进 BMP）：**

```text
┌────────────────┐
│  [渐变背景]     │
│                │
│     [logo]     │  ← 约 72×72，距顶 48px，水平居中
│   oh-my-md     │  ← 18px 粗体白字（Pillow 渲染）
│    v0.1.0      │  ← 12px 常规，opacity 85%
│                │
│  (底部可留白)   │
└────────────────┘
```

**Header 150×57（二选一，P0 任务中实现 A）：**

- **方案 A（推荐）：** 从 `tauri.conf.json` **删除 `headerImage`**，内页恢复 MUI 默认（无右上角 logo）。
- **方案 B（备选）：** 左对齐细条：4px 蓝竖线 + 小字 `oh-my-md`（无 logo 图），背景 `#F3F4F6`。

**WiX dialog 493×312：** 左侧 164px 宽区域复用 sidebar 视觉（或等比拉伸品牌面板），右侧留白给系统 dialog 文案区。

---

## Phase P0：消除内页突兀 logo（必做，~1h）

### Task 1: 移除内页 header logo

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `scripts/generate-installer-images.sh`
- Modify: `apps/desktop/test/tauriConfig.test.ts`
- Modify: `docs/memory/known-gotchas.md`

- [ ] **Step 1:** 从 `tauri.conf.json` 的 `nsis` 块删除 `headerImage` 键（保留 `sidebarImage`、`installerIcon`）。
- [ ] **Step 2:** 更新 `generate-installer-images.sh` — 默认不再生成 `nsis-header.bmp`；脚本注释说明 header  intentionally omitted。
- [ ] **Step 3:** 更新 `tauriConfig.test.ts` — NSIS 只断言 `sidebarImage` 存在且 164×314；不再要求 `headerImage`。
- [ ] **Step 4:** 删除仓库内 `apps/desktop/src-tauri/icons/nsis-header.bmp`（若存在）。
- [ ] **Step 5:** 更新 `known-gotchas.md` — 注明内页不应放居中 logo；sidebar 才是品牌区。
- [ ] **Step 6:** Windows 上 `pnpm --filter @omd/desktop tauri build --bundles nsis`，确认「选择安装目录」页右上角无 squashed logo。
- [ ] **Step 7:** Commit — `fix: drop NSIS header bitmap so inner installer pages stay unbranded`

---

## Phase P1：Sidebar 品牌面板（应做，~3–4h）

### Task 2: 用 Pillow 重写安装器位图生成器

**Files:**
- Create: `scripts/generate_installer_images.py`
- Modify: `scripts/generate-installer-images.sh`（改为调用 Python 脚本）
- Replace: `apps/desktop/src-tauri/icons/nsis-sidebar.bmp`
- Replace: `apps/desktop/src-tauri/icons/wix-banner.bmp`
- Replace: `apps/desktop/src-tauri/icons/wix-dialog.bmp`
- Modify: `apps/desktop/test/tauriConfig.test.ts`（可选：断言 BMP 文件大小/魔数变化）

**Interfaces:**
- 输入：`apps/desktop/app-icon.png`、`apps/desktop/src-tauri/tauri.conf.json` 的 `version`
- 输出：上述三个 BMP（+ 可选 wix-banner）

- [ ] **Step 1:** 写 `scripts/generate_installer_images.py`：
  - 读取 version（arg 或解析 `tauri.conf.json`）
  - `render_sidebar()` → 164×314 渐变 + 居中 logo + 「oh-my-md」+ `v{version}`
  - `render_wix_dialog()` → 493×312，左 164px 品牌区与 sidebar 同源
  - `render_wix_banner()` → 493×58，左对齐 logo + 产品名（无渐变，保持横幅可读）
  - 输出 24-bit BMP（Pillow `save(..., format='BMP')`）
- [ ] **Step 2:** `generate-installer-images.sh` 检测 `python3` + `Pillow`；缺失时打印 `pip install Pillow` 提示；成功则调用 Python。
- [ ] **Step 3:** 本地运行脚本，目视检查 sidebar / wix-dialog。
- [ ] **Step 4:** 跑 `pnpm --filter @omd/desktop test -- tauriConfig` → PASS。
- [ ] **Step 5:** Windows NSIS 手测 — 欢迎页左侧为品牌渐变面板，logo 不再「飘」在灰底中央。
- [ ] **Step 6:** Commit — `feat: render NSIS sidebar and WiX dialogs as branded panels`

### Task 3: 文档与发版说明

**Files:**
- Modify: `docs/manual-qa.md`
- Modify: `README.md`（仅当增加「生成安装器图片」dev 步骤时）

- [ ] **Step 1:** 在 `manual-qa.md` Windows 段增加检查项：
  - 欢迎页左侧品牌面板（渐变 + logo + 版本）
  - 目录选择页无右上角 squashed logo
  - 语言切换中/英后 Tauri 自定义字符串仍为中文（P2 完成后）
- [ ] **Step 2:** Commit — `docs: add Windows installer visual checks to manual QA`

---

## Phase P2：文案优化（应做，~2h）

### Task 4: Tauri 自定义中文字符串

**Files:**
- Create: `apps/desktop/src-tauri/windows/nsis-languages/SimpChinese.nsh`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`

**说明：** `customLanguageFiles` 仅覆盖 Tauri 在 `English.nsh` 里定义的 LangString（WebView2、重装提示等），**不**覆盖 NSIS MUI 自带欢迎页「Setup will install…」—— 后者在 Task 5 处理。

- [ ] **Step 1:** 复制 [Tauri English.nsh](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/languages/English.nsh) 结构，写 `SimpChinese.nsh`，润色已有中文并统一语气。
- [ ] **Step 2:** `tauri.conf.json` 增加：

```json
"customLanguageFiles": {
  "SimpChinese": "windows/nsis-languages/SimpChinese.nsh"
}
```

- [ ] **Step 3:** Windows 构建，触发「应用正在运行 / WebView2 安装失败」等路径（或静态 review `.nsh`），确认中文自然。
- [ ] **Step 4:** Commit — `feat: add SimpChinese NSIS strings for Tauri installer messages`

### Task 5: 欢迎/完成页 MUI 文案（最小模板补丁）

**Files:**
- Create: `apps/desktop/src-tauri/windows/installer.nsi`（基于 Tauri 上游 `installer.nsi` 最小 fork）
- Create: `apps/desktop/src-tauri/windows/installer-text.nsh`
- Modify: `apps/desktop/src-tauri/tauri.conf.json` — `"template": "windows/installer.nsi"`

**在 `MUI_PAGE_WELCOME` 之前插入（按语言切换）：**

```nsis
; English defaults — inserted before !insertmacro MUI_PAGE_WELCOME
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${PRODUCTNAME} Setup"
!define MUI_WELCOMEPAGE_TEXT "This will install ${PRODUCTNAME} ${VERSION} on your computer.$\r$\n$\r$\nClick Next to continue, or Cancel to exit."

; SimpChinese — use LangString + MUI_PAGE_CUSTOMFUNCTION or per-language defines
; 目标文案：「欢迎使用 oh-my-md 安装向导。点击“下一步”开始安装，或点击“取消”退出。」
```

**风险：** Tauri 升级可能改动 upstream `installer.nsi`；在文件头注释记录基于的 Tauri 版本与 diff 摘要；发版前 diff 上游。

- [ ] **Step 1:** 从当前项目使用的 Tauri 版本 vendor `installer.nsi` 到 `windows/installer.nsi`。
- [ ] **Step 2:** 在 Welcome / Finish 宏前加入 `installer-text.nsh` 的 `MUI_WELCOMEPAGE_*` / `MUI_FINISHPAGE_*` 定义。
- [ ] **Step 3:** 配置 `"template"` 指向 fork。
- [ ] **Step 4:** Windows 手测：英文/中文欢迎语均为短句，无冗长 “Setup Wizard will install…”。
- [ ] **Step 5:** Commit — `feat: customize NSIS welcome and finish copy for en and zh`

---

## Phase P3：Deferred（暂不实施）

| 项 | 原因 | 若未来要做 |
|----|------|------------|
| 步骤 Stepper（步骤 1/4） | 需 `Page custom` + 状态机，与 Tauri 模板深度耦合 | fork 模板 + 维护成本评估 |
| 自定义按钮样式 | NSIS 原生控件，非 CSS | 换用 NSIS Modern UI 主题插件或 Electron 安装器 |
| 许可协议页交互 | 当前无 `licenseFile` | 加 Apache-2.0 `LICENSE` + MUI license 页（默认即未勾选禁用 Next） |
| 内页 header 品牌细条（方案 B） | P0 删除 header 后若仍觉内页过素再评估 | 生成 150×57 左对齐条 BMP |

---

## 验证矩阵

| 检查 | 命令 / 方式 |
|------|-------------|
| BMP 尺寸漂移 | `pnpm --filter @omd/desktop test -- tauriConfig` |
| 脚本可复现 | `scripts/generate-installer-images.sh` 后 `git diff --stat` 仅预期 BMP |
| NSIS 包 | Windows: `pnpm --filter @omd/desktop tauri build --bundles nsis` |
| MSI 包（可选） | Windows: `pnpm --filter @omd/desktop tauri build --bundles msi` |
| 视觉 | `docs/manual-qa.md` Windows 安装向导条目 |

---

## 实施顺序与工期估计

```text
P0 Task 1          1h    立刻消除内页突兀（最高 ROI）
P1 Task 2–3        4h    品牌 sidebar + WiX 对齐
P2 Task 4          1h    Tauri 中文字符串
P2 Task 5          2h    欢迎/完成页文案（含模板 fork 维护）
────────────────────────
合计               ~8h   P3 不计
```

**推荐里程碑：**

1. **v0.1.x hotfix 级：** 仅 P0（用户已反馈 header 突兀）
2. **下一 Windows 发布：** P0 + P1 + P2 Task 4
3. **有精力时：** P2 Task 5；P3 按需

---

## 决策记录（实施前确认）

- [x] **Header 策略：** **方案 A（删除 headerImage）** — 内页无右上角 logo。
- [x] **版本号来源：** 生成脚本从 `tauri.conf.json` 读取 `version`。
- [x] **Pillow 依赖：** `scripts/.venv`（gitignore）；`generate-installer-images.sh` 自动使用。
- [x] **欢迎/完成文案：** 通过 `installerHooks`（`windows/installer-text.nsh`）注入，未 fork 完整 `installer.nsi`。
