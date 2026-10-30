# Smart Paste 语义导入与统一投影设计

**日期：** 2026-10-30

**状态：** 已批准，待实施计划

**父设计：** [oh-my-md 设计文档](./2026-08-10-oh-my-md-design.md)

**替代：** [24 HTML 富文本粘贴 → Markdown 设计](./2026-08-18-24-html-paste-design.md)

**影响域：** `packages/engine`、`apps/desktop`，内嵌图片资产写入时涉及 `apps/desktop/src-tauri`

## 摘要

oh-my-md 采用 Typora 式 Smart Paste：普通粘贴优先读取 `text/html`，保留结构和有意义的格式；`Cmd/Ctrl+Shift+V` 明确执行逐字节纯文本粘贴。Markdown 能准确表达的内容写成规范 Markdown；Markdown 不能表达但可以安全保真的内容写成最小化白名单 HTML；危险或未知结构删除标签但保留可见内容。

本设计不继续修补 Turndown。当前 Turndown 管线在文本层全局转义 `_`、`*`、方括号、反引号、反斜杠和行首标记，既不了解 oh-my-md 方言，也不了解粘贴点上下文，已经造成 `access_token` → `access\_token` 等可见错误。与此同时，Live Preview、HTML 导出和表格单元格分别解释 Lezer 节点，导致 `Escape`、`HardBreak` 等语义在不同投影中漂移。

替代架构由四部分组成：

1. 临时 `Paste AST`：表达剪贴板 HTML 的意图，不进入持久化文档。
2. 确定性 Markdown 序列化器：按上下文生成 Markdown，必要时输出类型安全的白名单 HTML。
3. 有界 Lezer 验证：在真实插入上下文中最多执行两次局部解析，发现不等价节点后确定性降级。
4. Lazy Semantic Adapters：从 Lezer 节点按需提取共享语义事实，供 Live Preview、导出和表格投影使用；不构建全局第二 AST。

持久化后的唯一真相仍是 Markdown 源码。Lezer 仍是持久化文档唯一的 Markdown 语义来源。DOM parser 只负责读取不可信剪贴板 HTML；Paste AST 只表达导入意图；两者都不成为文档 parser。

## 背景与当前问题

### 已确认的故障链

当前 `packages/engine/src/paste/htmlPaste.ts` 使用 Turndown + GFM 插件把 `text/html` 转成 Markdown。Turndown 对普通文本中的 Markdown 标点做全局转义；现有“纯文本等价”判断只删除空白后比较字符串，因此：

```text
HTML 可见文字       access_token
Turndown 输出        access\_token
text/plain          access_token
去空白比较          不相等
写入源码             access\_token
```

Lezer 正确地把 `\_` 解析为 `Escape`，但 Live Preview 没有投影 `Escape`，最终把反斜杠显示给用户。相同缺口还存在于同步/富 HTML 导出和表格 cell AST。`HardBreak` 也缺少统一投影：反斜杠换行在 Live Preview 中泄漏标记，导出没有稳定生成 `<br>`。

这不是 `_` 的特殊问题。当前转换还会影响：

- 普通文本中的 `*`、`[`、`]`、反引号和反斜杠；
- 行首 `#`、`-`、`+`、`>`、`1.`、围栏标记；
- oh-my-md 方言中的 `$...$`、`==...==`、`~...~`、`^...^`、`:emoji:`；
- HTML `<u>` / `<mark>` 等扩展语义；
- 代码、公式和 front matter 内必须逐字节保留的内容。

### 架构缺口

1. **HTML 导入没有语义模型。** HTML 被直接压成字符串，转换器无法区分“文字 `**x**`”与“真正的粗体 x”。
2. **序列化器不了解方言和插入上下文。** 片段在段落、列表、表格或行首的含义不同。
3. **Markdown 语义被多个投影重复解释。** Live Preview、导出、表格各自维护 switch 和 skip 集合。
4. **HTML 安全没有统一边界。** 当前只对少数 HTMLTag 特判；不存在可供预览和导出共用的安全 HTML 子集。
5. **两条粘贴通道不一致。** 键盘普通粘贴可以走 HTML 转换，但应用层普通 Paste 命令当前复用 `pastePlainText`；菜单和键盘语义不同。
6. **异步粘贴目标可能陈旧。** 动态 import/转换完成前文档或选区可能变化。
7. **Live Preview 仍有源码改写例外。** 进入预览时自动改写有序列表编号，与“预览只投影、不修改源码”的目标冲突。

## 产品契约

### 普通粘贴

普通 `Cmd/Ctrl+V` 表达“把外部内容按其可见语义导入当前 Markdown 文档”：

1. 剪贴板含真实图片 item 时，现有图片通道优先。
2. 含 `text/html` 时执行 Smart Paste。
3. 无 HTML 时插入 `text/plain`。
4. 光标或选择位于 code、math、front matter 等 verbatim 区域时，始终插入 `text/plain`，不进行富文本转换。
5. 转换失败时保留可见文字，不允许整次粘贴消失。
6. 多 selection/range 时不启动异步 Smart Paste，交还 CodeMirror 的 `text/plain` 多光标粘贴语义；当前产品不为同一份富文本定义多目标结构导入。

普通粘贴保留结构和有意义格式，不承诺像素级复制外部应用的主题、字体或页面布局。

### 粘贴为纯文本 / Markdown 源码

`Cmd/Ctrl+Shift+V`、菜单和命令面板中的“粘贴为纯文本”具有同一语义：

- 只读取 `text/plain`；
- 逐字节插入，不做 HTML 分析、转义、块边界规范化或资源下载；
- 插入内容随后自然由 Markdown parser 解释；例如纯文本粘贴 `# title` 会成为标题；
- 整次操作是一个 CodeMirror undo transaction。

### 复制来源与目标体验

目标覆盖浏览器、Word/Pages、Google Docs、Excel/Sheets、VS Code、邮件/聊天应用以及其他 Markdown 编辑器。输出策略是：

| 输入语义 | Smart Paste 源码 |
| --- | --- |
| 普通文字 `access_token` | `access_token` |
| 普通文字 `# title` | `\# title` |
| 真正的一级标题 | `# title` |
| 普通文字 `$x$` | `\$x\$` |
| 普通文字 `**bold**` | `\*\*bold\*\*` |
| 真正的粗体 | `**bold**` |
| 合并单元格表格 | 安全 HTML table block |
| 危险标签包裹的文字 | 删除标签，保留文字 |

“与 Typora 一样的体验”指上述用户可观察契约，不要求逐字节复制 Typora 未公开的内部 Markdown 输出。

## 目标与非目标

### 目标

- 消除普通富文本粘贴产生的无意义转义和可见反斜杠。
- 对 oh-my-md 全部 Markdown 方言进行上下文感知序列化。
- 使普通粘贴和纯文本粘贴在菜单、快捷键和上下文菜单中一致。
- 让 Live Preview、同步/富 HTML 导出和表格内容共享 Markdown 语义事实。
- 支持 Markdown 无法表达的安全富文本结构，同时保持源码最小、确定、可读。
- 对不可信 HTML 建立集中、可审计的安全边界。
- 保持源码、undo、选择、只读模式、大文档窗口化和现有图片资产规则。

### 非目标

- 不实现 Word/Pages 的像素级排版复制。
- 不保存外部应用的字体族、页面 margin、行高、定位、动画或 Office 私有 CSS。
- 不引入 ProseMirror、contenteditable 文档模型或新的持久化格式。
- 不让 Paste AST 成为编辑器状态或保存格式。
- 不在 Smart Paste 中执行脚本、自动激活 iframe/video 或信任任意 HTML。
- 不让复杂 HTML 表格进入现有 Markdown TableWidget 的行列编辑协议。
- 不在生产 Live Preview 中强制完整解析大文档。
- 不长期保留新旧两套粘贴实现或用户可见实验开关。

## 总体架构

```text
ClipboardEvent
  │
  ├─ image item ─────────────────────────► desktop image asset pipeline
  │
  ├─ Paste as Plain Text ────────────────► exact text/plain transaction
  │
  └─ Normal Paste
       │
       ├─ verbatim selection ────────────► exact text/plain transaction
       ├─ no text/html ──────────────────► text/plain transaction
       └─ text/html
            │
            ▼
      Clipboard HTML reader (untrusted)
            │
            ▼
      HTML → Paste AST normalizer
            │
            ├─ semantic Markdown nodes
            ├─ typed SafeHtml nodes
            └─ embedded image assets
            │
            ▼
      deterministic serializer + source map
            │
            ▼
      parse affected context with Lezer
            │
            ├─ equivalent ───────────────► accept
            └─ mismatch ─► downgrade mapped nodes ─► one final parse
            │
            ▼
      mapped paste anchor + one CM transaction

Persisted Markdown source
  │
  ▼
Lezer syntax tree
  │
  ▼
Lazy Semantic Adapters
  ├─ Live Preview decorations/widgets
  ├─ HTML export
  └─ table-cell DOM/export
```

## 所有权与模块边界

### Engine

`packages/engine` 拥有：

- Clipboard HTML 的语义读取与 Paste AST；
- Markdown 方言序列化和局部 Lezer 验证；
- Safe HTML policy、类型、解析、DOM 投影和导出；
- Lazy Semantic Adapters；
- Live Preview 的 Escape/HardBreak/HTML 投影；
- table cell 的共享语义投影；
- 普通富文本 paste handler 和可映射 paste bookmark。

Engine 不访问 React、Tauri 或文件系统。

### Desktop

`apps/desktop` 拥有：

- 图片 clipboard item 的优先级和本地资产写入；
- Smart Paste 内嵌图片资产请求的 host adapter；
- 普通 Paste / Paste as Plain Text 菜单与快捷键一致性；
- 转换失败、资源失败和大粘贴状态的本地化非模态反馈；
- 当前文档路径、tab/document identity 和 host image resolver。

Desktop 不复制 Markdown 转义或 Lezer 节点判断。

### Rust

`apps/desktop/src-tauri` 仅在 Smart Paste 需要持久化 `data:` 图片时提供窄的批量资产写入/失败清理能力。Rust 不解析 HTML 或 Markdown。

## Paste AST

Paste AST 是导入期的不可变、带来源标识的语义树。概念节点包括：

```text
Document / Paragraph / Heading / Blockquote
List / ListItem / TaskItem
Table / TableRow / TableCell(rowspan, colspan, align)
Text / Strong / Emphasis / Strike / Highlight / Underline
Subscript / Superscript / InlineCode / CodeBlock
Link / Image / HardBreak / HorizontalRule
SafeHtmlInline / SafeHtmlBlock
```

每个节点携带：

- 输入 DOM path、标签/样式来源类别，供诊断和确定性降级；DOMParser 不提供可靠字节 offset，因此不要求伪造 HTML 源范围；
- 语义属性，例如 link href、image alt、table span；
- 是否来自明确结构标签、CSS 推断或纯文本。

Serializer 返回独立的 output source map，把 Paste AST 节点 id 映射到生成范围；它不回写不可变 AST。Paste AST 不保存浏览器 DOM 节点，不进入 EditorState，不暴露为公共 API。

## HTML 读取与规范化

### 输入安全

剪贴板 HTML 永远是不可信输入。解析文档不得挂载到编辑器 DOM。脚本、事件属性和活动资源不会在规范化阶段执行。

### 结构归一

Normalizer 把标签和少量明确 CSS 语义转换为 Paste AST：

- `strong` / `b` / 明确粗体 → Strong；
- `em` / `i` / 明确斜体 → Emphasis；
- `del` / `s` / line-through → Strike；
- `h1`…`h6` → Heading；
- `pre > code` → CodeBlock；
- `ol` / `ul` / `li` → List；
- `blockquote` → Blockquote；
- `table` 结构 → Table；
- `br` → HardBreak；
- `a` / `img` → Link / Image；
- `u`、`mark`、`sub`、`sup`、`ruby`、`kbd` 等 → 可表达的方言节点或 SafeHtml。

Word/Docs 生成的无语义 span、嵌套重复样式和空容器被折叠。相邻相同样式合并。Office class、`data-*`、页面布局属性和主题默认样式不进入 Paste AST。

### 空白模型

空白不是通过 `trim()` 或“删除全部空白”处理。Normalizer 明确区分：

- HTML 可折叠空白；
- `&nbsp;`；
- `<br>` hard break；
- block boundary；
- `pre` / code 中逐字节文本；
- CSS `white-space` 白名单语义；
- 表格单元格边界。

Paste AST 的 Text 保存规范化后的可见文本；序列化器不得再次猜测 DOM 空白。

## 确定性 Markdown 序列化

### 原则

- 结构节点产生结构标记；Text 只在当前上下文确实可能改变语义时转义。
- 不使用全局 `replaceAll` 或 Turndown `escape()`。
- 相同 Paste AST、相同插入上下文必须产生相同源码。
- 输出采用项目既有规范：ATX heading、`-` bullet、fenced code、GFM table、项目方言标记。
- delimiter 宽度根据内容计算：inline code 使用大于内容最大连续反引号的 delimiter；fence 长度大于内容中同类连续 fence。

### 上下文

Serializer 至少区分：

- paragraph text；
- physical line start；
- emphasis/strong content；
- link label、destination、title；
- table cell；
- inline code / fenced code；
- HTML text/attribute；
- 相邻 Markdown delimiter；
- 当前文档的列表、引用和 block boundary。

### 纯文本 HTML 包装

浏览器经常为普通文字附带最小 HTML。只有当原始 `text/plain` 在真实插入上下文中解析后与 HTML Paste AST 语义等价时，才可逐字节复用 `text/plain`。因此：

- `access_token` 可原样复用；
- `# title` 不能原样复用，因为 HTML 表达段落而 Markdown 会表达标题；
- `$x$` 不能原样复用，因为 oh-my-md 会表达数学；
- 空白差异不能通过 squeeze 后忽略。

## 有界 Lezer 验证

### 上下文窗口

验证范围从粘贴点前一个稳定顶层块边界扩展到后一个稳定顶层块边界，包含插入前后的真实源码。它必须覆盖所有可能被粘贴改变的段落/列表/引用/表格关系，但不得推进生产 editor syntax tree 到整个文档末尾。

验证可以用同一 Markdown language 对局部合成文本独立解析；不得调用 `ensureSyntaxTree(state, state.doc.length)` 或 `forceParsing`。

### 两次解析上限

1. Serializer 生成源码和 Paste AST → output range source map。
2. 第一次局部 parse 后，Lazy Semantic Adapters 生成规范化语义签名。
3. 若等价，接受输出。
4. 若不等价，根据 source map 标记最小不一致 Paste AST 节点，并确定性降级：Markdown → SafeHtml → Text。
5. 重新序列化并执行最后一次局部 parse。
6. 第二次仍不等价时，整个富文本片段使用 fallback text 的保守 literal serialization；绝不继续循环尝试。fallback text 优先取剪贴板 `text/plain`，缺失时取 Paste AST 的可见文本；“literal”表示按当前 Markdown 上下文安全转义，而不是逐字节插入。

生产转换最多两次局部 parse，不允许逐字符/逐转义反复解析。

### 独立测试 oracle

运行时 semantic signature 不是唯一正确性来源。测试必须同时包含人工预期源码、人工预期 DOM/HTML 和真实浏览器行为，避免 serializer 与 projector 以同一种方式写错后“错误但相等”。

## Safe HTML

### 类型边界

Raw string 不能被标记为“已安全”。只有安全模块可以通过私有 `unique symbol` brand 的构造器创建 `SafeHtmlNode` 联合类型；公共模块不导出 brand 或 raw→safe 类型断言。其他模块只消费节点并通过 DOM API 或 escape-aware exporter 输出。

### Smart Paste 允许的语义

Markdown 无法准确表达时，Smart Paste 可保留：

- inline：`span`、`u`、`mark`、`sub`、`sup`、`ruby`、`rt`、`rp`、`kbd`、`br`；
- block：`details`、`summary`、含 `rowspan`/`colspan` 的 table、必要的语义容器；
- 明确且有限的视觉语义：文本色、背景高亮、font weight/style、text decoration、vertical/text alignment、受限 font size、white-space。

默认删除：

- 字体族、line-height、margin、padding、position、z-index、animation、transition、filter；
- `background-image`、CSS `url()`、CSS variables、浏览器私有属性；
- Office class、任意 class、`data-*` 和未知属性；
- 空 span 和与父节点重复的样式。

### 标签、属性与 URL

- `script`、`style`、`meta`、`object`、`embed`、form controls 永不执行；删除标签并尽量保留可见子内容。
- 所有 `on*` 属性删除。
- URL 仅允许明确协议。`javascript:`、危险 `data:` 和控制字符混淆被拒绝。
- anchor 标识在 Live Preview 中映射为应用内部数据，不把不可信 `id` 直接注入宿主 DOM；导出时可恢复安全 anchor。
- iframe/video/audio 不由普通 Smart Paste 自动激活。可见链接或 poster/alt 被保留。
- 用户在源码中显式写入的 iframe/video 也必须通过同一安全 renderer；iframe 强制 sandbox，危险来源显示为源码/错误占位。

### DOMPurify

DOMPurify 作为 engine 的直接依赖提供通用 HTML 清洗，不依赖 Mermaid 的传递依赖。DOMPurify 不是完整 policy：tag/attribute/CSS/URL 的产品白名单仍由 engine 的 Safe HTML 模块拥有并测试。

### 向后兼容

新增 renderer 后，旧文档中的未知 HTML 不得突然变为活动内容：

- 白名单语义安全投影；
- 未知但无害标签显示源码或展平为文字；
- 危险内容永不执行；
- 已有 `<a id>`、`<u>`、`<mark>` 行为保持兼容；
- HTML 源码字节不由 Live Preview 自动重写。

## 内嵌图片资产

### 分类

- `http:` / `https:`：保留 URL，不自动下载。
- `data:image/...`：通过 desktop host adapter 写入当前文档 `assets/`，改写为相对路径。
- `blob:`：优先匹配 Clipboard image item；无法解析时保留 alt 并报告降级。
- `file:`：不把不可移植绝对路径写入 Markdown；只有 host 明确取得可读 File 时才进入现有资产写入管线，否则保留 alt 并报告降级。
- 不支持或超限 MIME：保留 alt，其他粘贴内容继续成功。

### 批量写入与事务

Smart Paste 可包含多张图片。Desktop 通过窄 host adapter 批量请求写入，Rust 负责路径验证、MIME/大小限制和最终文件名。资源写入期间 paste bookmark 随文档 transaction 映射。

写入完成后：

1. 重新验证 tab、document、view 和 readOnly identity；
2. 使用已经映射的 bookmark 同步 dispatch 一次 Markdown transaction；
3. view 已销毁、身份变化或 dispatch 失败时，仅清理由本次批量操作创建且尚未被文档引用的明确路径；
4. undo 不自动删除已写入资产，因为资产可能已被其他文档位置引用；这与现有图片插入策略一致。

未保存文档无法取得合法 assets 目录时，`data:` / `file:` 图片降级为 alt 文本并显示非模态提示；周围文字和格式仍然粘贴。

## 粘贴并发、选择与 undo

- 每个 EditorView 的富文本粘贴串行化，不能让两个异步转换交叉提交。
- paste bookmark 是 engine StateField/StateEffect 管理的零宽位置，随中间 transaction 映射；不捕获永久绝对 offset。
- 非空选择的起止 bookmark 都映射；最终替换当前映射范围。
- 文档 identity 改变、view 销毁或进入 readOnly 后取消提交并清理未引用资产。
- collapsed caret 可随不相交编辑映射；原始非空选择若被任何中间 transaction 交叠修改则取消该 paste，不能在完成后删除用户的新输入。
- 一次粘贴只产生一个 `input.paste` transaction 和一个 undo step。
- 转换期间用户继续编辑不会把结果插回陈旧位置。
- readOnly handler 消费事件但不改文档、不写资产。

## Lazy Semantic Adapters

### 职责

共享层只回答 Markdown 语义事实：

- 节点的可见文字；
- syntax marker range；
- `Escape` 解码；
- `HardBreak` 类型和 marker range；
- Entity 解码；
- Link/Image URL、title、alt；
- code/math 原文范围；
- Safe HTML 节点；
- 规范化 semantic signature。

它不决定 CSS、CodeMirror decoration、HTML 字符串模板或 table widget UI。

### 性能边界

- Live Preview 只投影视口/增量 decoration 构建正在遍历的 Lezer 子树。
- 不缓存完整文档第二 AST。
- 不假设安全模式窗口外存在 decoration。
- table cell 可用同一 Markdown language 解析小片段，再调用相同 adapters。
- 显式导出可以对导出快照做独立完整 parse，但不得推进或污染 editor 的增量 syntax tree。

### HTML 节点接入

- inline 安全 HTML 以 Lezer `HTMLTag` 为边界，在当前顶层块内用线性 stack 配对 opening/closing tag；Markdown 子内容继续使用原 Lezer 节点，不由 HTML parser 重解析。
- stack 只接受 Safe HTML 白名单和合法嵌套；不匹配、跨块或未闭合标签保持源码可见。
- HTML block 按 CommonMark 规则视为 raw block，由 Safe HTML 模块以 inert fragment 解析并生成 block widget；其中不重新解析 Markdown。
- inline HTML 产生的 mark decoration 可以与 Markdown mark 嵌套，但 replacement 只覆盖标签源码。实现必须遵守现有 decoration 排序、atomic range 和 block replacement 不重叠约束。

### 必须统一的首批语义

| 源码 | Live Preview | HTML 导出 | Table cell |
| --- | --- | --- | --- |
| `access\_token` | `access_token` | `access_token` | `access_token` |
| `before\\\nafter` | hard break，无 `\` | `<br>` | `<br>` |
| `before  \nafter` | hard break，无尾空格 | `<br>` | `<br>` |
| `&copy;` | `©` | `©` / entity-safe output | `©` |

## Live Preview 与源码不变性

- Live Preview 通过 replace/mark/widget 隐藏或投影语法，不改源码。
- Escape 只隐藏反斜杠，保留被转义字符；Source Mode 显示原始 `\`。
- HardBreak 隐藏反斜杠或行尾空格，保留真实换行。
- 安全 inline HTML 隐藏标签并投影允许的语义；block HTML 使用现有 BlockWidget 源码入口模型。
- 未知/危险 HTML 保持源码可见或显示安全错误占位。
- selection、atomic range、IME 和 source/live toggle 不得改变文档字节。

现有“进入 Live Preview 自动改写有序列表编号”的例外将被移除：预览可通过 decoration 显示连续编号；修改源码只允许用户显式执行可撤销的“规范化列表编号”命令。该迁移单独成实施任务，不能混入 paste serializer 的核心提交。

## 表格

### Markdown 表格

- 无 rowspan/colspan、可由 GFM 准确表达的表格序列化为 Markdown。
- 继续使用现有 TableWidget、source toolbar 和 Lezer-range edits。
- 单元格文字通过共享 semantic adapters 投影。

### 复杂 HTML 表格

- rowspan/colspan、嵌套块或 Markdown 无法表达的结构序列化为 Safe HTML block。
- Live Preview 精确保真投影，但整块通过 `</>` / source entry 编辑。
- 不显示现有 Markdown 表格行列 toolbar，不调用 `tables/edit.ts`。
- 导出保留安全结构和 accessibility 属性。

两类表格不得在运行时互相伪装或自动重写。

## 可访问性

- 图片保留 alt；缺失 alt 时使用空 alt，而不是文件名猜测。
- 链接、details/summary 和安全媒体控件保持键盘可访问。
- table header 使用 `th`/`scope`，rowspan/colspan 保持结构。
- HTML block 的 source entry 可聚焦且有可访问名称。
- decoration 隐藏标记后不能让屏幕阅读器重复朗读源码和投影。
- 降级删除标签时必须保留可见子内容。
- 颜色/背景组合不能成为表达信息的唯一方式；导入不会凭空生成只靠颜色区分的控件。

## 错误处理与用户反馈

| 情况 | 行为 |
| --- | --- |
| HTML parse/normalize 抛错 | fallback text 的保守 literal serialization |
| 第一次语义验证失败 | 映射节点降级后重试一次 |
| 第二次验证仍失败 | 整段 literal serialization，保留可见文本 |
| 单张图片失败 | alt 降级；其他内容继续；非模态提示 |
| 所有资产失败 | 文本/格式仍粘贴；汇总提示一次 |
| view/document 失效 | 取消插入，清理本次未引用资产 |
| readOnly | 消费事件，不转换、不写资产、不 dispatch |
| 危险 HTML | 删除活动能力，保留安全文字或显示源码 |

用户提示不得为每个被删除的 span 或 CSS 属性弹 toast。只有资源失败、整段严重降级或安全阻止了用户显式粘贴的 embed 时显示一次汇总反馈。详细转换原因只进入开发诊断。

## 性能

- 正常富文本粘贴为 O(HTML 节点数 + 输出长度 + 局部 parse 长度)。
- 生产最多两次局部 Markdown parse。
- 不逐字符重新 parse，不扫描整个打开文档，不强制完成 editor syntax tree。
- 异步 normalization/asset/validation 阶段必须可取消；同步 DOM parse 必须受基准门禁约束，超出门禁时改用 worker-capable reader，不能谎称可以中途取消 DOMParser。
- 大粘贴显示非模态“正在转换”状态，但不能仅因体积静默降级成纯文本。
- 实施计划先记录典型、100 KiB、1 MiB、5 MiB HTML 的解析/序列化/验证基线；合并门禁以不造成可感知输入冻结为准。如果 DOMParser 主线程阶段超出门禁，发布前必须迁移到 worker-capable HTML reader，而不是放宽正确性。
- 新增 engine advisory benchmark；正式数值在同一硬件基线测量后固化为命名常量和 CI 告警，spec 不预设未经测量的毫秒数字。

## 安全模型

信任边界按顺序是：

```text
untrusted clipboard bytes
  → inert HTML parse
  → normalization
  → tag/attribute/style/URL policy
  → SafeHtmlNode
  → DOM/export adapter
```

安全要求：

- 无路径可以把 raw clipboard HTML 直接交给 `innerHTML`。
- Mermaid、Shiki、KaTeX 等已知受控输出的 `innerHTML` 使用不扩大到 clipboard HTML。
- Safe HTML policy 是 engine 单一来源，Live Preview 和 export 不得各自维护 allowlist。
- URL 规范化在协议判断前完成，覆盖大小写、实体、控制字符和编码混淆。
- CSS parser 按属性和值验证，不能用正则删除几个关键词后放行余下 style string。
- sanitizer 依赖升级必须运行固定攻击语料。
- 旧文档和外部 Markdown 文件与剪贴板输入同样视为不可信。

## 测试与验收

### Fixture corpus

提交最小、可审查、无版权问题的 clipboard fixture 对：`text/html` + `text/plain` + 预期源码 + 预期语义。覆盖：

- Chrome、Safari、Firefox；
- Word、Pages、Google Docs；
- Excel、Google Sheets；
- VS Code 和网页代码块；
- Typora/其他 Markdown 编辑器；
- 邮件/聊天富文本；
- 手工攻击 HTML；
- CJK、RTL、emoji、entity、NBSP；
- 嵌套列表、引用、表格、代码、数学样文字；
- 所有 ASCII Markdown punctuation 组合。

### Engine 单测

- DOM → Paste AST normalization；
- serializer 每个上下文；
- source map 和两次 parse 上限；
- 真实插入上下文等价；
- Escape/HardBreak/Entity adapters；
- Safe HTML tag/attribute/style/URL policy；
- Live Preview / export / table semantic parity；
- deterministic output；
- arbitrary DOM/property fuzz 不抛异常、不执行活动内容；
- Source/Live round trip 字节不变。

### Desktop/Rust 测试

- keyboard/menu/context menu 两条 paste 通道一致；
- image flavor 优先；
- 多图批量资产成功、部分失败、取消和失效清理；
- tab/document identity 和 mapped bookmark；
- readOnly 零副作用；
- undo 一次撤销整次文档插入；
- IPC 多词字段 Rust serialized-JSON contract。

### 真实浏览器 E2E

- Preview 不显示多余反斜杠；
- hard break 布局正确；
- Safe inline/block HTML selection 和 source entry；
- HTML/Markdown table 两种交互；
- XSS 样本不执行；
- keyboard accessibility；
- paste 后 caret 和 scroll 稳定。

### 必须满足的验收不变量

1. `Paste as Plain Text` 对 `text/plain` 逐字节一致。
2. Smart Paste 的人工 fixture 语义与预期完全一致。
3. 同一输入和上下文产生确定性源码。
4. Live Preview、HTML export 和 table cell 对共享语义一致。
5. Live/Source 往返和仅移动光标不修改源码。
6. 任意 Escape 在 Live Preview 不泄漏语法反斜杠。
7. 两种 CommonMark HardBreak 均投影为换行/`<br>`。
8. 不可信 HTML/URL/CSS 攻击语料无活动执行路径。
9. 一次 paste 是一个 undo step；异步完成不写入陈旧位置。
10. 生产不完整解析大文档，不超过两次局部验证 parse。

## 迁移顺序

本 spec 是跨层架构合同，不要求一次实现或一个巨型 PR。后续 writing-plans 阶段按下列 Phase 生成独立、可验证的实施计划；每份计划只在上一阶段合同满足后切入下一阶段。任何阶段发现需要改变本文用户契约时，先回到 spec 评审，不在 plan 中悄悄改设计。

### Phase 1：语义基线

- 固定当前正确行为和失败 fixture；
- 实现 Lazy Semantic Adapters；
- 补齐 Escape、HardBreak、Entity；
- 迁移 Live Preview、同步/富 export 和 table cell；
- 不改变 Smart Paste 主链路。

### Phase 2：Safe HTML

- 建立 SafeHtmlNode 和集中 policy；
- 添加 DOM/export adapters；
- 兼容已有 anchor/u/mark；
- 完成攻击语料、旧文档兼容和 E2E；
- 仍不切换普通粘贴。

### Phase 3：语义导入

- 实现 Paste AST、normalizer、serializer、source map；
- 实现上下文窗口和最多两次 Lezer 验证；
- 在测试中让新旧转换器并行产出，人工审核差异；
- 不在产品中暴露长期 feature flag。

### Phase 4：资产与宿主一致性

- 接通多图 host adapter 和 Rust 批量写入/失败清理；
- 实现 mapped bookmark、串行队列和 identity guard；
- 统一 keyboard/menu/context menu 的 Paste / Paste as Plain Text。

### Phase 5：切换与删除

- 完成 fixture、E2E、性能和 manual QA 门禁后原子切换主链路；
- 删除 Turndown、turndown-plugin-gfm、类型声明、converter cache 和 whitespace heuristic；
- 删除不再需要的 HTML 特判/重复 cell 语义代码；
- 更新 engine/desktop AGENTS、known gotchas、manual QA 和用户指南。

### Phase 6：严格源码投影

- 移除 Live Preview 自动改写有序列表源码；
- 保留纯显示连续编号；
- 增加显式、可撤销的规范化命令；
- 单独验证保存、恢复、冲突和大文档行为。

每个 Phase 都必须保持可发布和全套现有测试通过。Phase 3 的新实现不能在 Phase 1/2 未完成前接管生产 paste。

计划分组如下：

1. Semantic adapters 与 Escape/HardBreak 跨投影一致性（Phase 1）。
2. Safe HTML 类型、安全策略、inline/block 投影（Phase 2）。
3. Paste AST、serializer、上下文验证与 fixture program（Phase 3）。
4. Desktop/Rust 图片资产、bookmark、菜单一致性与 cutover（Phase 4–5）。
5. 有序列表严格源码投影（Phase 6，独立计划和独立合并）。

## 删除与保留

### 最终删除

- `turndown`；
- `turndown-plugin-gfm`；
- `types/turndown-plugin-gfm.d.ts`；
- `squeezeWhitespace` 等字符串启发式；
- converter lazy import/cache；
- Live Preview/export/table 中已被 adapters 替代的 Escape/HardBreak/Entity 重复解释。

### 保留

- CodeMirror + Lezer source-first 架构；
- `normalizeBlockPaste` 的块边界责任，但由新 serializer 输出和上下文验证重新定义测试；
- verbatim predicate 单一来源；
- 现有 image item 优先和资产路径规则；
- TableWidget 的 Markdown 表格双状态模型；
- safe-mode windowed decoration 和 render budget；
- rich export 的 KaTeX/Shiki/Mermaid 专用 renderer。

## 被否决的方案

### 继续修补 Turndown

否决。它不了解 oh-my-md 方言、插入上下文和安全 HTML；覆盖 `_` 后还会继续在其它标点、数学、高亮、emoji 和 block boundary 上产生漂移。

### 全局删除反斜杠

否决。会把 literal `# title`、`$x$`、`*x*` 等重新解释为结构，造成内容语义改变。

### 保存原始 clipboard HTML

否决。源码不可读、跨应用噪声巨大，并引入 XSS、危险 URL/CSS 和旧文档激活风险。

### 只保留纯文本

否决。丢失标题、列表、链接、代码、表格等用户明确复制的语义，不符合 Typora 式体验。

### 迁移到 ProseMirror/富文本文档模型

否决。oh-my-md 的核心是 Markdown 源码、CodeMirror 大文档性能和 Source/Live 往返；为粘贴重写编辑器会扩大风险且失去源码保真优势。

### 构建全局万能 Semantic AST

否决。会重复 Lezer tree、增加大文档内存和增量同步成本，并把输出策略耦合到一个 God Object。共享层保持 lazy、局部和事实型。

### 无界解析重试

否决。逐转义/逐节点试探会造成二次复杂度和不可预测卡顿。生产最多两次局部 parse。

## 文档维护

实施完成时必须同步：

- `packages/engine/AGENTS.md`：新增 semantic adapters、Safe HTML 和 source-preservation invariant；
- `apps/desktop/AGENTS.md`：两条 paste 通道、Smart Paste 资产 host contract；
- `docs/memory/known-gotchas.md` 与 `gotchas-engine/desktop/rust.md`：验证上下文、Safe HTML、异步 paste bookmark 和资产清理陷阱；
- `docs/manual-qa.md`：浏览器/Office/Docs/Sheets/代码/安全/大粘贴矩阵；
- `docs/guides/`：Paste 与 Paste as Plain Text 的用户行为；
- 原 HTML paste spec：标记为被本设计替代。

README 和 CHANGELOG 在功能实际发布时更新，不在 spec-only 提交中提前宣称可用。
