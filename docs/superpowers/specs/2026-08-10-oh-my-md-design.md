# oh-my-md 设计文档

一个对标 Typora 的开源桌面 Markdown 编辑器。

## 定位与差异化

- **竞品**：Typora（闭源、买断制）。
- **定位**：开源免费打底，两个尖刀：
  1. **大文档性能**——CM6 视口虚拟化 + Tauri 轻量壳，主打万行级文档流畅。
  2. **AI 原生**——块级 AI 操作（润色/续写/翻译），Typora 没有的维度。

## 已定决策

| 决策点 | 选择 |
|---|---|
| 产品形态 | 桌面 App |
| 外壳 | Tauri 2（Rust 壳 + WebView） |
| 编辑引擎 | CodeMirror 6 + Live Preview（装饰方案） |
| 编辑模式 | 所见即所得 + 源码模式，可切换（切换 = 挂载/卸载装饰集） |
| 文件模型 | 单文件为中心（双击打开）+ 可选文件夹树侧边栏，不做"库"概念 |
| 功能范围 | v1 全量：见功能清单 |
| 平台 | macOS 先行（Windows/Linux 放 V1.x） |
| 商业模式 | 免费打磨，架构预留授权口子，v1 不做付费门 |
| 差异化 | 开源免费 + AI + 大文档性能 |

## v1 功能清单

**编辑核心**
- GFM 全量：表格、任务列表、脚注、删除线
- Live Preview + 源码模式切换
- 中文输入法 / 光标 / 撤销重做的正确性

**内容**
- 数学公式（KaTeX）
- Mermaid 图表
- 图片：粘贴截图插入 + 本地图片目录管理（图床上传不做）
- 导出：HTML / PDF（DOCX 不做）
- 主题系统：亮/暗 + 自定义 CSS
- 文件树侧边栏 + 全局搜索
- Typewriter / Focus 模式
- 拼写检查 / 字数统计
- 大纲 / TOC 面板
- 多标签页

## 总体架构

```
┌────────────────────────────── Tauri 2 ──────────────────────────────┐
│  前端 (WebView, Vite + TypeScript)                                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ App 壳 (React): 标签页 / 侧边栏文件树 / 命令面板 / 设置        │   │
│  │  ┌────────────────────────────────────────────────────────┐  │   │
│  │  │ 编辑引擎包 (@omd/engine) — 纯 TS，无 UI 框架依赖         │  │   │
│  │  │  · CM6 核心 + Lezer markdown 语法树                     │  │   │
│  │  │  · 装饰管线: 行内折叠 + 块级 Widget                      │  │   │
│  │  │  · 渲染器: KaTeX / Mermaid / Shiki 代码高亮              │  │   │
│  │  │  · AI 层: provider 抽象 (OpenAI 兼容 / Ollama)          │  │   │
│  │  └────────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              ↕ Tauri IPC (薄接口)                    │
│  Rust 侧: 文件读写 / 文件监听(notify) / 原生菜单 / 窗口管理           │
└──────────────────────────────────────────────────────────────────────┘
```

**关键决策理由**

1. 引擎做成独立的纯 TS 包，不依赖 React：可单测、未来可出 Web 版，渲染 bug 排查不被 UI 框架干扰。
2. 文件 IO 全走 Rust 侧：读写 + 外部变更监听，IPC 面刻意薄：`read / write / watch / openDialog / saveDialog` 五个命令起步。
3. 语法树用 Lezer（CM6 自带），不自造 markdown parser；脚注等 GFM 之外语法走 Lezer 语法扩展，不 fork 解析器。

##
## 仓库组织（最小 monorepo）

pnpm workspaces + 两个包，不引入 Turborepo/Nx。目录按最佳实践摆，工具链按当前痛点上。

```
oh-my-md/
├─ package.json            # workspaces 声明
├─ pnpm-workspace.yaml     # packages: ["apps/*", "packages/*"]
├─ apps/
│   └─ desktop/            # Tauri 壳 + React UI + Vite
│       └─ src-tauri/      # Rust 侧
└─ packages/
    └─ engine/             # @omd/engine, 纯 TS, 独立可测
```

- `apps/ packages/` 目录照业内约定摆，成本为零，未来加包不搬家。
- 不做 `servers/`——当前无服务端需求；真做授权时再加，或直接用 Gumroad/Lemon Squeezy。
- 不上 Turborepo/Nx——两个包的构建图，pnpm workspaces + script 足够；到 3~4 个包、CI 变慢再加。

## 组件细分

**前端组件树（React 壳）**

```
App
├─ TitleBar (拖拽区 + 窗口控制)
├─ Sidebar (可折叠)
│   ├─ FileTree (懒加载目录, 监听 Rust notify 事件增量刷新)
│   └─ Outline (从当前文档 Lezer 树提取标题)
├─ TabBar (多标签页, 脏状态标记)
├─ EditorPane ← CM6 EditorView 挂载点 (每标签一个 view)
├─ CommandPalette (Cmd+K, 所有功能入口, 快捷键全走这里)
└─ StatusBar (字数 / 光标位置 / 保存状态 / 模式指示)
```

**引擎包内部模块**

```
@omd/engine
├─ core/        CM6 装配: 主题扩展、键位、历史、自动保存 debounce
├─ parse/       Lezer markdown + GFM 扩展 (表格/脚注/任务列表)
├─ decorations/
│   ├─ inline/  标题/加粗/斜体/链接/代码span → 折叠语法符号的 RangeSet
│   ├─ blocks/  块检测器: 把 math/mermaid/表格/代码块标为 widget 区
│   └─ widgets/ KaTeXWidget / MermaidWidget / CodeWidget / TableWidget
│               (统一生命周期: 创建→渲染→进入编辑态→销毁, 渲染结果缓存)
├─ modes/       live-preview ⇄ source 切换 = 挂载/卸载装饰集
├─ export/      AST → HTML 序列化; PDF 经 Tauri WebView print-to-pdf
├─ ai/          provider 接口 (chat/complete) + OpenAI 兼容 + Ollama 实现
└─ commands/    命令注册表 (CommandPalette 和键位共用同一来源)
```

## 数据流

1. **输入 → 渲染**：敲键 → CM6 transaction → Lezer 增量重解析（只碰视口内）→ 装饰管线重建 RangeSet → 视口内块 widget 按需渲染（KaTeX/Mermaid 结果按"块文本 hash"缓存，未变块不重算）。
2. **保存**：debounce 1.5s 自动保存 → IPC write → Rust 写盘 → 状态栏更新。Rust watch 事件回推时若文档脏则弹冲突提示，不静默覆盖。
3. **AI**：块级 widget 挂操作菜单 → 取块文本 → provider 流式返回 → diff 视图呈现建议，用户确认才写回。**AI 永不直接改文档。**

**性能底线**：大文档靠 CM6 视口虚拟化天然成立；风险在块 widget——离屏块只占位不渲染、渲染结果缓存、Mermaid 重编译 debounce 500ms。

## 错误处理（按数据丢失风险排序）

1. **保存链路（最高优先级）**：写盘失败 → 文档保持脏标记 + 状态栏红色告警 + 内容不丢（留在内存）。外部变更冲突 → 三方选择弹窗（保留我的 / 加载磁盘版 / 看 diff），永不静默覆盖。App 崩溃兜底：每次 transaction 后把内容写入本地 crash-recovery 文件（Rust 侧，按路径 hash 命名），启动时检测到孤儿恢复文件则提示恢复。
2. **块 Widget 渲染失败**：KaTeX 语法错、Mermaid 编译失败 → widget 内展示错误信息 + 原文，不白屏、不崩编辑器，点进去就能修。
3. **AI 调用**：网络/超时/key 失效 → toast 提示，文档不受影响（本来就只是建议流）。
4. **IPC/Rust 侧 panic**：统一错误信封 `{ok, error}` 回传，前端兜底 toast，不出现未处理 promise。

## 测试策略（按 ROI 排，不追求覆盖率数字）

| 层 | 测什么 | 工具 |
|---|---|---|
| 引擎单测 | 装饰管线正确性：给定 markdown 源 → 断言 RangeSet/widget 位置；模式切换往返不丢字。引擎的命，覆盖最厚 | Vitest |
| 解析回归 | ~50 个 .md 样本（表格、脚注、嵌套列表、中文标点、大文件）快照测试，防升级 Lezer/渲染器时炸 | Vitest snapshot |
| Rust 侧 | IPC 命令 + 文件 watch 逻辑单测 | cargo test |
| 手动矩阵 | IME 中文输入、撤销/重做、大文档滚动——自动化成本高、人眼判断快，写成手动清单 | checklist |
| E2E | v1 不做（Tauri E2E 成本远超收益），v2 有用户反馈热点再补 | — |

## 里程碑（全部属 v1，每步都是可用版本）

- **M1 引擎**：CM6 装配 + Lezer 装饰管线 + live/source 切换 + GFM 全量 + IME/撤销正确性 ← 最难，先啃
  - 注：M1 的"GFM 全量"指解析全量；表格在 M1 只做解析验证，TableWidget 渲染归 M2（见 M1 plan 范围边界）
- **M2 块渲染**：KaTeX / Mermaid / 代码高亮 / 图片粘贴
- **M3 产品壳**：标签页、文件树、大纲、全局搜索、导出 HTML/PDF、主题、Typewriter/Focus
- **M4 AI + 发布**：AI provider 层 + 打磨 + GitHub 开源发布 + 自动更新

## 明确不做（YAGNI）

- 库/Vault 概念、双链、标签系统（V2 视社区需求再说）
- 图床上传、DOCX 导出
- Windows/Linux 打包（V1.x）
- 授权/付费基础设施（只留架构口子）
- E2E 测试
