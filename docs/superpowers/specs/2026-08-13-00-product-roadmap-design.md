# oh-my-md 产品成熟化路线图

**日期：** 2026-08-13  
**状态：** 已确认拆分方式，按单规格循环推进  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

> **状态更新（2026-08-18 产品化差距收敛轮）：** 03 的核心（恢复稿/设置迁入 app data + 原子迁移）已随 1A 提交落地，"恢复中心/退出协议"余项待续；04 的授权根/symlink/fingerprint 边界在既有实现与 notify watcher（规格 23）中部分覆盖，独立规格仍待写；05 与 14 规格已于 2026-08-18 成文待审核（本目录）；08 的暗色代码主题已落地（规格 19），其余项待续；12 未启动。日常体验八项（暗色代码、正则查找、Quick Open、拖拽打开、notify、HTML 粘贴、front matter、版本快照）见规格 19–26。

## 目标

将当前 Markdown 引擎 Alpha+ 与桌面壳 Alpha 原型推进为可日常使用、可安全发布、并能承载 AI 与插件扩展的 macOS 产品。

本路线图只定义规格边界、依赖顺序和统一完成标准。每个子项目必须先形成独立设计规格，经用户审核后，再编写对应 implementation plan。不得将多个子项目重新合并为一份巨型计划。

## 已批准的组织决策

1. 使用风险优先的纵向切片，不按 Engine、React、Rust 技术层分别规划。
2. 覆盖 P0、P1 和长期差异化方向。
3. 采用单规格循环：`spec → 用户审核 → plan → 后续执行选择 → 下一个 spec`。
4. Rust 是文件系统事实来源，负责授权、fingerprint、watch、CAS、恢复和原子 IO。
5. 前端负责 CodeMirror 编辑状态、标签、dirty 展示和交互，不自行推断磁盘事实。
6. 当前保留 Live Preview 自动规范化有序列表编号的产品行为。
7. 仅由打开文档或进入 Live Preview 引发的规范化必须标记 dirty、暂停自动保存，并显示非模态确认条。
8. 用户选择“保留原编号”后，当前文档本次打开期间不再自动规范化。
9. 不自动创建 Git commit；commit 需要用户明确要求。

## 全局架构约束

### Markdown 引擎

- `packages/engine` 拥有 Markdown 语义、Lezer 遍历、CodeMirror transaction 标记和渲染投影。
- 引擎不得导入 React、Tauri 或原生文件系统 API。
- 自动文本变换必须能被宿主识别，且不能吞掉用户后续编辑。

### Desktop 前端

- Desktop 只协调 EditorView、文档会话和用户交互。
- 随着规格推进，从 `App.tsx` 提取当前规格需要的 controller；不做无关重构。
- 用户可见的自动操作必须可发现、可确认或可撤销。
- 后台标签与前台标签使用相同的数据安全规则。

### Rust/Tauri

- Rust 维护用户授权的文件和目录集合。
- 所有输入路径先 canonicalize，再验证是否位于授权范围。
- 保存时以 Rust 当前读取的 fingerprint 为准；watcher 只做提前通知，不替代 CAS。
- 恢复、搜索、导出落盘等文件操作均使用有界输入和明确错误。

### AI 与插件

- AI 和插件不得直接获得通用 Tauri `invoke` 或任意路径读写能力。
- AI 建议先进入 diff，只有用户确认后才产生 CodeMirror transaction。
- 第三方扩展必须声明 capability，文件、网络、剪贴板和密钥权限默认关闭。

## 规格序列

### Phase A：文档可靠性与安全

#### 01 Source Fidelity

**文件：** `docs/superpowers/specs/2026-08-13-01-source-fidelity-design.md`  
**目标：** 保留自动编号规范化，同时让打开时的自动改源可发现、可拒绝且不会未经确认自动落盘。  
**依赖：** 当前 M2/M3 工作树。  
**完成后提供：** 自动编辑来源标记、规范化待确认状态、自动保存暂停规则。

#### 02 Conflict-Safe Save

**文件：** `docs/superpowers/specs/2026-08-13-02-conflict-safe-save-design.md`  
**目标：** 建立每文档保存状态机，以及基于 Rust fingerprint 的 CAS 写入。  
**依赖：** 01 的自动保存暂停语义。  
**完成后提供：** `clean / dirty / saving / saveFailed / conflict` 状态和冲突结果类型。

#### 03 Recovery and Shutdown

**文件：** `docs/superpowers/specs/2026-08-13-03-recovery-and-shutdown-design.md`  
**目标：** 将恢复稿迁入 app data，原子去抖写入，并在关闭/退出前统一 flush。  
**依赖：** 02 的文档身份和保存状态。  
**完成后提供：** 恢复记录 schema、恢复中心、窗口退出协议。

#### 04 Filesystem Security

**文件：** `docs/superpowers/specs/2026-08-13-04-filesystem-security-design.md`  
**目标：** 由 Rust 统一实施授权范围、路径规范化、symlink 边界和远程资源策略。  
**依赖：** 02 的 Rust 文件服务接口。  
**完成后提供：** 授权 token 或授权集合、受限读写与搜索 API。

#### 05 Large Document Performance

**文件：** `docs/superpowers/specs/2026-08-13-05-large-document-performance-design.md`  
**目标：** 先定义 10k/50k 行和多标签基线，再消除每次输入的全量主线程工作。  
**依赖：** 01–03 的稳定文档生命周期。  
**完成后提供：** 性能基准、预算、增量统计和大文件安全模式。

### Phase B：日常写作产品

#### 06 Core Writing Experience

**文件：** `docs/superpowers/specs/2026-08-16-06-core-writing-experience-design.md`  
**目标：** 文档内查找替换、中文友好统计、拼写检查生效、列表 Enter/Tab 续写。

#### 07 Markdown Navigation

**文件：** `docs/superpowers/specs/2026-08-16-07-markdown-navigation-design.md`  
**目标：** 脚注跳转/返回、本地 `.md` 链接打开；保留锚点与外链。

#### 08 Markdown Rendering Polish

**文件：** `docs/superpowers/specs/2026-08-13-08-markdown-rendering-polish-design.md`  
**目标：** 表格内联格式、数学兼容、暗色代码主题（拼写检查已并入 06）。尚未单独成文。

#### 09 Workspace Operations

**文件：** `docs/superpowers/specs/2026-08-16-09-workspace-operations-design.md`  
**目标：** 文件树新建、重命名、删除、Reveal in Finder。

#### 10 Session and Settings

**文件：** `docs/superpowers/specs/2026-08-13-10-session-and-settings-design.md`  
**目标：** 持久化工作区、标签、光标、滚动、主题和模式，并提供 schema migration。

#### 11 Export Pipeline

**文件：** `docs/superpowers/specs/2026-08-16-11-export-pipeline-design.md`  
**目标：** `exportRichHtml`：KaTeX / Shiki / Mermaid 与预览一致；PDF 等待 `__omdExportReady`。

#### 15 Table Editing

**文件：** `docs/superpowers/specs/2026-08-16-15-table-editing-design.md`  
**目标：** Live Preview 单元格就地编辑与增删行列。

#### 16 Image Insert

**文件：** `docs/superpowers/specs/2026-08-16-16-image-insert-design.md`  
**目标：** 拖放与「Insert image…」复用 `write_image`。

差距分析：`docs/superpowers/specs/2026-08-16-industry-gap-analysis.md`。

#### 12 Accessibility

**文件：** `docs/superpowers/specs/2026-08-13-12-accessibility-design.md`  
**目标：** 完整实现 tablist、tree、dialog 键盘模型，以及 VoiceOver、焦点、对比度和缩放验收。

### Phase C：发布与差异化

#### 13 Release Engineering

**文件：** `docs/superpowers/specs/2026-08-16-13-release-engineering-design.md`  
**目标：** CI、版本同步、macOS 签名公证、安装烟测、自动更新、结构化日志和诊断包。

当前 v1 规格继续不引入完整 E2E 套件；发布门槛使用自动化单元/集成检查、Rust 测试、前端构建、安装烟测和明确的人工 QA。

#### 14 AI and Plugin Boundaries

**文件：** `docs/superpowers/specs/2026-08-13-14-ai-and-plugin-boundaries-design.md`  
**目标：** 定义 AI diff 确认流、Keychain 密钥隔离、provider 适配和插件 capability 模型。

AI 功能可以在本规格中设计，但实现排在发布可靠性之后。第三方插件运行时只有在 capability、隔离和版本化 API 均明确后才进入实现计划。

## 每份规格的固定结构

每份设计规格必须包含：

1. 目标与非目标。
2. 当前代码证据与待替换行为。
3. 用户流程和状态机。
4. TypeScript/Rust 接口及错误语义。
5. 安全、无障碍、性能与迁移约束。
6. 自动化测试矩阵。
7. 手动 QA。
8. 文档更新。
9. 对后续规格提供的稳定接口。

## 每份实施计划的固定结构

每份 implementation plan 必须：

- 使用 `docs/superpowers/plans/2026-08-13-NN-<topic>.md` 命名。
- 列出精确创建、修改和测试文件。
- 先测试后实现，逐步记录预期失败和通过结果。
- 每个步骤控制为单一 2–5 分钟动作。
- 为相邻任务写明输入、输出、类型和函数签名。
- 每个 Task 形成独立可测试、可审查的交付物。
- 写出建议 commit 边界，但不自动执行 commit。
- 不使用 `TBD`、`TODO`、“适当处理错误”或无代码依据的占位描述。

## 统一完成标准

一个子项目只有同时满足以下条件才算完成：

- 规格中的自动化测试全部通过。
- 相关 engine、desktop、Rust 构建检查按影响范围通过。
- 用户可见交互已加入 `docs/manual-qa.md` 并执行适用条目。
- 不允许影响文档状态或 UI 正确性的 Promise rejection 未被处理；有意 fire-and-forget 的清理必须自行处理失败且不得改变文档正确性。
- 新接口已记录在最近的 domain `AGENTS.md` 或无需更新的理由已确认。
- 可复用陷阱已加入 `docs/memory/known-gotchas.md`。
- 规格中声明的非目标没有被顺手实现。

## 推进规则

当前只进入 01 Source Fidelity。其设计规格通过用户审核后，才使用 writing-plans 流程生成 01 的 implementation plan。后续规格按本路线图顺序重复同一循环。
