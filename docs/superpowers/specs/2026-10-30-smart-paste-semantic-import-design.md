# Smart Paste 语义导入与统一投影设计

**日期：** 2026-10-30

**状态：** review 修订版，待确认

**父设计：** [oh-my-md 设计文档](./2026-08-10-oh-my-md-design.md)

**替代：** [24 HTML 富文本粘贴 → Markdown 设计](./2026-08-18-24-html-paste-design.md)

**影响域：** `packages/engine`、`apps/desktop`；内嵌图片资产写入时涉及 `apps/desktop/src-tauri`

## 摘要

oh-my-md 采用 Typora 式 Smart Paste：普通粘贴保留外部内容的结构和有意义格式；`Cmd/Ctrl+Shift+V` 明确执行逐字节纯文本粘贴。Markdown 能准确表达的内容写成干净、确定的 Markdown；只有 Markdown 确实无法表达的少数语义使用封闭、类型化的 HTML 逃生舱。网页主题色、背景色、字号和无意义 `span` 永不进入源码。

本设计不继续修补 Turndown。当前 Turndown 管线在文本层全局转义 Markdown 标点，已经造成 `access_token` → `access\_token` 等可见错误；Live Preview、同步导出、富导出和 table cell 又分别解释 Lezer 节点，使 `Escape`、`HardBreak`、Image alt 和表格 cell 语义继续漂移。

替代架构只有三个核心层次：

1. 临时 `Paste AST`：读取剪贴板 HTML 的语义意图，不进入 EditorState 或保存格式。
2. 确定性 Markdown 序列化器：使用同一份方言触发策略进行上下文感知转义；每条生产路径最多做一次局部 Lezer 验证，失败时整段进入保守模式。
3. Lazy Semantic Accessors：从 Lezer 节点按需提取 Image、Escape、HardBreak、table cell 等共享事实，供 Live Preview 和两种导出共同消费，不构建全局第二 AST。

本修订明确删除以下设计：

- Paste AST 节点 ID 和 output source map；
- 两棵异构树的规范化语义签名；
- “定位最小不一致节点 → 单节点分层降级 → 再 parse”的重试状态机；
- 通用 `SafeHtmlNode`、外部 CSS 保真和任意 inline HTML 配对栈；
- `<details>` 等通用 HTML block widget。

持久化后的唯一真相仍是 Markdown 源码，Lezer 仍是持久化文档唯一的 Markdown parser。DOM parser 只读取不可信剪贴板 HTML；Paste AST 只存在于一次导入任务中；Live Preview 只隐藏或投影语法，绝不改写源码。

## 已确认的问题

### 全局转义导致源码和预览污染

当前 `packages/engine/src/paste/htmlPaste.ts` 使用 Turndown + GFM 插件。Turndown 不知道 oh-my-md 方言、插入点上下文或 CommonMark flanking 规则，对普通文本中的 `_`、`*`、`[`、反引号、反斜杠和行首标记做全局转义。现有“纯文本等价”判断只做空白压缩比较，因此：

```text
HTML 可见文字       access_token
Turndown 输出        access\_token
text/plain          access_token
空白比较             不相等
写入源码             access\_token
```

Lezer 正确把 `\_` 解析成 `Escape`，但 Live Preview 没有统一投影 `Escape`，最终把反斜杠显示给用户。相同风险覆盖：

- 普通文本中的 CommonMark 标点；
- 行首 heading、list、quote、thematic break、fence 和 indented code 触发器；
- `$`、`==`、`~`、`^`、`:emoji:`、footnote、task list、table 等项目扩展；
- HTML tag、entity、autolink 和 link destination 边界；
- code、math、front matter 等必须逐字节处理的区域。

`access_token` 不是一个 `_` 特例，而是“字符串转换器代替 parser 语义”的症状。

### 共享投影已经发生真实漂移

当前 `packages/engine/src/export/html.ts` 有两个已经确认的裂痕：

1. 同步 `exportHtml` 的 table cell 会提取 source、处理 `\|` 并调用 `parseCell`；异步 `exportRichHtml` 却直接遍历 Lezer `TableCell` 子节点。结果是富 HTML/PDF/PNG 导出会泄漏反斜杠，并丢失 `parseCell` 支持的 `<br>` 和 cell 内结构。
2. `exportHtml` 和 `exportRichHtml` 都把 Image alt 硬编码成空字符串；Live Preview 和 `parseCell` 则各自手写一次 `](` 查找。

这两个缺陷必须在 Smart Paste 主链路切换前修复。否则新 importer 即使生成正确 Markdown，用户仍会在预览与导出之间看到不一致。

### 现有宿主入口并不等价

- 键盘粘贴产生 DOM `ClipboardEvent`，可以读取 `text/html`。
- macOS 原生 Edit → Paste 使用 WebKit 原生 paste selector，也会产生 DOM `paste` event。
- 命令面板和 Windows/Linux 应用内菜单的普通 Paste 当前调用 `pastePlainText()`，只执行 `navigator.clipboard.readText()`。
- macOS 右键粘贴为了绕过 WKWebView selection corruption，在 `imagePaste.ts` 中提前消费事件并强制插入 `text/plain`，使后续 HTML Smart Paste 永远无法运行。

因此“入口统一”必须从 clipboard payload 获取层解决，不能只改 engine 的 HTML converter。

### CommonMark HTMLBlock 不能支撑通用 block widget

CommonMark 0.31.2 的 [HTML block 规则](https://spec.commonmark.org/0.31.2/#html-blocks)把 `<details>`、`<summary>`、`<table>` 等归入 Type 6，遇到空行就结束 block。实际 Lezer 行为是：

```text
<details> ... blank line ... </details>
→ Document(HTMLBlock, Paragraph, HTMLBlock)

<table> ... blank line ... </table>
→ Document(HTMLBlock, HTMLBlock)
```

单个 `HTMLBlock` widget 无法安全拥有这种跨节点结构；跨兄弟节点扫描并拼回 HTML 又会在 engine 中制造第二套 block parser。本设计因此不支持通用 HTML block widget。

## 产品契约

### 普通粘贴

普通 `Cmd/Ctrl+V` 表达“把外部内容按可见语义导入当前 Markdown 文档”：

1. 剪贴板含真实图片 item 时，图片资产通道优先。
2. 含 `text/html` 时执行 Smart Paste。
3. 无 HTML 时插入 `text/plain`。
4. 光标或选择位于 code、math、front matter 等 verbatim 区域时，始终插入 `text/plain`，不做富文本转换。
5. 转换失败时保留可见文字，不允许整次粘贴消失。
6. 多 selection/range 不启动异步结构导入，交还 CodeMirror 的 `text/plain` 多光标粘贴语义。

普通粘贴保留 heading、list、blockquote、link、code、table 和粗体等语义，但不承诺复制来源应用的主题、字体、字号、正文字色、背景色或页面布局。

### 粘贴为纯文本 / Markdown 源码

`Cmd/Ctrl+Shift+V`、菜单和命令面板中的“粘贴为纯文本”具有同一语义：

- 只读取 `text/plain`；
- 逐字节插入，不分析 HTML、不转义、不规范化 block boundary、不写图片资产；
- 插入后由 Markdown parser 自然解释，例如 `# title` 会成为 heading；
- 整次操作是一个 CodeMirror undo transaction。

### 预期示例

| 输入语义 | Smart Paste 源码 |
| --- | --- |
| 普通文字 `access_token` | `access_token` |
| 普通文字 `# title` | `\# title` |
| 真正的一级标题 | `# title` |
| 普通文字 `$x$` | `\$x\$` |
| 普通文字 `**bold**` | `\*\*bold\*\*` |
| 真正的粗体 | `**bold**` |
| 外部黑色 15px 正文 | 只保留正文文字 |
| 外部 CSS `font-weight: 700` | `**text**` |
| 合并单元格表格 | 规范化复杂 table HTML |
| 危险标签包裹的文字 | 删除标签，保留可见文字 |

“与 Typora 一样的体验”指这些用户可观察契约，不要求逐字节复制 Typora 未公开的内部输出。

## 目标与非目标

### 目标

- 消除 Smart Paste 产生的无意义转义和 Preview 可见反斜杠。
- 对完整 CommonMark + oh-my-md 方言做上下文感知序列化。
- 让 keyboard、native menu、app menu、command palette 和 context menu 共享同一普通粘贴语义。
- 让 Live Preview、同步导出、富导出和 table cell 共享关键 Markdown 事实。
- 保持生成源码干净、确定、可读，不导入外部主题 CSS。
- 对极少数 HTML 逃生舱建立封闭、可审计、失败关闭的类型边界。
- 保持 source-first、undo、selection、readOnly、大文档窗口化和图片资产规则。

### 非目标

- 不实现 Word/Pages/网页的像素级排版复制。
- 不保存 color、background-color、font-size、font-family、line-height、margin、padding、position 或 Office 私有 CSS。
- 不引入 ProseMirror、contenteditable 文档模型或新的持久化格式。
- 不构建 Paste AST ↔ Lezer tree 节点对应关系。
- 不实现通用安全 HTML renderer、通用 inline tag stack 或通用 HTMLBlock stitcher。
- 不让 Smart Paste 自动激活 iframe、video、audio、form 或脚本能力。
- 不让复杂 HTML table 进入现有 Markdown TableWidget 的直接编辑协议。
- 不在生产 Live Preview 中强制完整解析大文档。
- 不长期保留新旧两套 paste 实现或用户可见 feature flag。

## 总体架构

```text
DOM ClipboardEvent                     navigator.clipboard.read()
keyboard / native menu / context menu  app menu / command palette
              │                                      │
              └──────── desktop ClipboardPayload ────┘
                                      │
                          normal paste│plain paste
                                      │
                      ┌───────────────┴───────────────┐
                      │                               │
            image asset pipeline             exact text/plain
                      │
                      ▼
               engine import planner
                      │
          ┌───────────┼────────────────┐
          │           │                │
      verbatim    no HTML        text/html reader
          │           │                │
       plain text  plain text       Paste AST
                                       │
                            context-aware serializer
                                       │
                           one bounded local parse
                                       │
                       pass ────────────┴──── fail
                        │                    │
                     accept       whole-fragment strict mode
                        │                    │
                        └──── mapped target + one CM transaction

Persisted Markdown source
          │
          ▼
       Lezer tree  ──► Lazy Semantic Accessors
                        ├─ Live Preview
                        ├─ exportHtml
                        ├─ exportRichHtml / PDF / PNG
                        └─ table-cell DOM/export
```

关键约束：fast path 和结构化 path 是互斥分支；每次生产转换最多进行一次新的局部 Markdown parse。验证失败后不做第二次 parse，也不尝试定位某个 Paste AST 节点。

## 所有权与模块边界

### Engine

`packages/engine` 拥有：

- HTML → Paste AST 的语义读取；
- Markdown 方言触发策略、序列化器和局部结构验证；
- verbatim predicate；
- Lazy Semantic Accessors；
- Escape、HardBreak、Kbd、复杂 table 的 Markdown 语义和 Preview 投影；
- 纯函数式 `planSmartPaste(payload, context)` API。

Engine 不访问 React、Tauri、系统剪贴板或文件系统，也不决定 host 菜单行为。

### Desktop

`apps/desktop` 拥有：

- 从 DOM `ClipboardEvent` 和 `navigator.clipboard.read()` 读取统一 `ClipboardPayload`；
- image flavor 优先级、本地资产写入和 image drop；
- keyboard/menu/context menu 的目标修正、队列、identity guard 和最终 dispatch；
- Paste / Paste as Plain Text 快捷键和菜单一致性；
- 失败与降级的本地化非模态反馈。

Desktop 不复制 Markdown 转义、HTML normalization 或 Lezer 节点判断。

### Rust

`apps/desktop/src-tauri` 只为 `data:`/File 图片提供窄的批量资产写入和失败清理命令。Rust 不解析 HTML 或 Markdown。任何新增多词 IPC 字段必须有 Rust serialized-JSON contract test。

## 统一 ClipboardPayload 与入口

Desktop 先把所有普通粘贴入口归一为同一种输入：

```ts
interface ClipboardPayload {
  plainText: string
  html?: string
  images: readonly ClipboardImage[]
  source: "dom-event" | "async-clipboard"
}
```

真实实现可以使用 host-private File/ClipboardItem 类型，但 engine 只能看到稳定、可测试的数据和 asset request，不接触 Clipboard API。

### DOM event 路径

- keyboard、macOS native menu 和 context menu 从 `event.clipboardData` 构造 payload。
- desktop 的单一 paste controller 负责 image/html/plain priority；不再由 `imagePasteHandler` 和 engine `htmlPaste()` 竞争同一个事件。
- 普通、无图片、无 HTML 的 keyboard paste 可以继续交给 CodeMirror 内建 plain-text handler，以保留多 selection 语义。
- readOnly 必须消费事件但不转换、不写资产、不 dispatch。

### macOS 右键目标修复

`contextmenu` 仍记录 `contextMenuTarget`，但非图片 paste 不再直接插入 `text/plain`。在 DOM paste handler 开始时：

1. 校验 target 仍对应当前 view/document；
2. 把 CodeMirror selection 恢复到保存的 target；
3. 清除一次性 target；
4. 让统一 paste controller 使用同一个 ClipboardPayload 继续 image/html/plain 路由。

这保留 WKWebView selection corruption workaround，同时不牺牲 Smart Paste。现有断言“macOS 右键富文本必须变纯文本”的测试需要改成“在保存目标执行同样的 Smart Paste”。

### 无 ClipboardEvent 的应用命令

Command Palette 和 Windows/Linux AppMenu 的普通 Paste 使用 `navigator.clipboard.read()`，按每个 `ClipboardItem` 收集 `image/*`、`text/html` 和 `text/plain`，然后进入同一 controller。若 `read()` 不可用或权限拒绝，可回退 `readText()` 并明确成为 plain-only 降级；不能把这个降级伪装成完整 Smart Paste。

Desktop 通过 `SystemClipboardReader` host interface 隔离具体 API。Phase 4 先在 macOS WKWebView、Windows WebView2 和 Linux WebKitGTK 做 capability spike；若任一受支持平台不能稳定读取 HTML/image MIME，该平台必须通过窄 Tauri/Rust clipboard adapter 补齐后才通过发布门禁。plain-only fallback 只用于权限拒绝或运行时故障，不算“入口一致性”验收通过。平台分支只允许落在 `platform.ts` 或 Rust `cfg!(target_os = …)`。

Paste as Plain Text 始终只调用 `readText()`。`Mod+Shift+V` 在 `shortcuts.ts`、命令面板显示、应用菜单和 macOS native menu accelerator 中必须是同一 binding，并加入现有 shortcut drift tests。

## Paste AST

Paste AST 是一次导入任务内的最小不可变语义树：

```text
Document / Paragraph / Heading / Blockquote
List / ListItem / TaskItem
Table / TableRow / TableCell(rowspan, colspan, header, align)
Text / Strong / Emphasis / Strike / Highlight / Underline / Kbd
Subscript / Superscript / InlineCode / CodeBlock
Link / Image / HardBreak / HorizontalRule
```

它只携带序列化需要的语义属性，例如 href、alt、rowspan、colspan。它不携带：

- node ID；
- DOM path 或伪造的 HTML byte range；
- output range source map；
- Lezer node；
- browser DOM node；
- 用于节点级重试的 provenance 状态。

诊断只记录本次任务的聚合结果，例如“丢弃 12 个 presentation-only style”或“进入 strict fallback”，不建立节点跟踪系统。

## HTML 读取与规范化

### 输入边界

剪贴板 HTML 永远是不可信输入。使用 detached/inert document 读取，绝不挂载原始节点，绝不执行 script、事件属性、active resource 或 CSS。Normalizer 输出 Paste AST，而不是“清洗后的 HTML string”。

### 结构归一

- `strong` / `b` / inline `font-weight: bold|600..900` → Strong；
- `em` / `i` / inline `font-style: italic|oblique` → Emphasis；
- `del` / `s` / inline `text-decoration-line: line-through` → Strike；
- inline underline → Underline；
- `<mark>` → Highlight；
- `<sub>` / `<sup>` → Subscript / Superscript；
- `<kbd>` → Kbd；
- `h1`…`h6`、list、blockquote、pre/code、table、br、a、img → 对应结构节点。

CSS 只作为上述少数输入语义的识别线索，不会原样序列化。以下内容一律丢弃：

- `color`、`background`、`background-color`、`font-size`、`font-family`；
- line-height、letter-spacing、margin、padding、border、position、display、animation；
- class、Office 属性、`data-*`、CSS variables 和浏览器私有属性；
- 仅承载被丢弃样式的 `span`。

`white-space` 只可帮助 normalizer 理解输入文本折叠；它必须归一成 Text/HardBreak/CodeBlock，不能作为 style 写进 Markdown。字号不能推断 heading，背景色不能推断 highlight；只有明确结构或上述强语义才转换。

相邻相同语义合并，重复嵌套折叠。未知或危险标签删除标签但递归保留可见子内容。

### 空白模型

Normalizer 明确区分 HTML 可折叠空白、`&nbsp;`、`<br>`、block boundary、table cell boundary 和 `pre` 中逐字节文本。Paste AST 的 Text 保存完成 HTML 空白语义后的可见文本；serializer 不再次猜 DOM layout，也不使用全局 `trim()`/squeeze heuristic。

## 确定性 Markdown 序列化

### 唯一方言触发策略

新增一份 engine-owned `MarkdownTriggerPolicy`，与 `markdownLanguageSupport()` 同域维护。它覆盖：

- CommonMark block/inline 触发器、flanking、entity、autolink 和 raw HTML 边界；
- GFM table/task/strikethrough；
- oh-my-md math、highlight、sub/sup、emoji、footnote、underline/front matter 等扩展；
- line start、delimiter adjacency、link label/destination、table cell 和 host block context。

Policy 是 serializer 和测试的唯一转义规则来源。新增 parser extension 必须同时更新 policy fixture；drift test 列举 `markdownLanguageSupport` 的扩展注册和对应 trigger policy，防止“parser 新增语法、paste 忘记转义”。

Policy 不是第二个 Markdown parser：它不能给任意已有源码判定语法树，也不能被 Preview/export 调用来解释节点；它只回答 serializer 在一个已知输出位置能否安全发射 literal text。持久化源码的语义判断仍只来自 Lezer。

Text 节点只在当前字符序列确实会触发语义时转义。`access_token` 中的 `_` 不满足 emphasis flanking，必须原样输出；段首普通文字 `# title` 会触发 heading，必须输出 `\# title`。

### 序列化上下文

至少区分：

- paragraph text 与 physical line start；
- emphasis/strong/highlight/sub/sup 内部；
- link label、destination、title；
- Markdown table cell；
- inline code / fenced code；
- canonical complex-table HTML text/attribute；
- 相邻 delimiter；
- 当前 list、blockquote、paragraph 和 block boundary。

结构节点产生结构 marker，Text 负责 literal safety。inline code delimiter 和 fenced code marker 宽度根据内容最大连续 run 计算。输出固定采用项目规范：ATX heading、`-` bullet、fenced code 和 GFM table。

### 纯文本 fast path

当 HTML normalizer 得到的只是普通 Text/Paragraph/HardBreak，且 `text/plain` 与其可见文本严格一致时，优先尝试逐字节复用 `text/plain`。比较前只允许把剪贴板 transport 的 CRLF/CR 统一成 editor 的 LF；不得压缩空格、空行或 NBSP：

1. 取插入点前后稳定 block boundary 内的真实上下文；
2. 把 plain text 合成到上下文并执行一次局部 parse；
3. 检查 Paragraph/HardBreak boundary 与 normalized AST 一致，插入范围没有产生 heading/list/math/link/emphasis/table/HTML 等意外语义，也没有吞并或改写两侧稳定宿主结构；
4. 通过则直接采用原始 `text/plain`，不经过 serializer。

因此 `access_token` 直通；HTML 普通段落对应的 `# title`、`$x$` 或 `**bold**` 因会触发语义而拒绝 fast path，转入 context-aware serializer。

fast path 不做 squeeze whitespace，不比较异构树，不生成 source map。

## 一次局部验证与保守 fallback

### 验证窗口

窗口从插入点前一个稳定顶层 block boundary 扩展到后一个稳定 boundary，包含真实 prefix、待插入片段和 suffix。它必须覆盖 paragraph/list/quote/table 的边界影响，但不得调用 `ensureSyntaxTree(state, state.doc.length)` 或推进完整编辑器 syntax tree。

### 验证内容

结构化序列化结果只 parse 一次，并检查少量明确不变量：

- 片段预期的顶层 block kind 和顺序仍成立；
- Strong/Emphasis/Link/Image/Code/HardBreak 等关键语义的数量符合 Paste AST 的粗粒度预期；
- Text 节点没有引入未预期的关键语法；
- prefix/suffix 的稳定语义没有被片段 delimiter 吞并；
- canonical complex table 仍是一个完整、闭合的 block。

这些是整体结构断言，不是 Paste AST 与 Lezer tree 的同构语义签名。实现只知道整个插入范围，不把 Lezer node range 反向归因给某个 Paste AST 节点。

### 失败策略

任一不变量失败时，不做节点级诊断或第二次 parse，直接对整个片段使用 strict serializer：

- Text 节点中的全部 CommonMark 可转义 ASCII punctuation 和项目扩展 opener 采用保守转义；
- literal backslash 成对编码；line-start indentation、tab、NBSP 和空行由 trigger policy 显式处理，不能意外形成 indented code 或新的 block；
- block 结构使用明确空行、非紧凑形式和足够宽的 fence；
- link destination、table cell、HTML attribute 使用各自专用编码；
- 当前宿主上下文无法安全承载某个 block 时，整个片段降级为 visible text 的 strict literal serialization。

strict serializer 必须由构造规则保证安全；生产不再 parse 它。其正确性由独立 fixture、property test 和真实浏览器 E2E 证明，不能靠 serializer 与 projector 自证。

每次普通粘贴最多一次新的局部 parse：plain fast path 或 structured validation 二选一。不存在解析重试循环。

## 封闭 HTML 逃生舱

Smart Paste 不提供通用 Safe HTML。允许写入 Markdown 源码的 HTML 只有：

| 语义 | 规范输出 | Parser/Preview |
| --- | --- | --- |
| Underline | `<u>text</u>` | 复用现有固定 `parseHtmlPair` → `Underline` |
| Keyboard key | `<kbd>text</kbd>` | 新增固定 `Kbd` inline extension |
| table cell hard break | `<br>` | 只由 table-cell parser 识别 |
| rowspan/colspan table | canonical `<table>…</table>` | typed complex-table block adapter |

Highlight 输出 `==text==`；Strike 输出 `~~text~~`；Subscript/Superscript 输出项目方言；Strong/Emphasis 输出 Markdown。普通段落 hard break 输出 CommonMark hard break，不输出 `<br>`。

这里没有任意 `span`、style attribute、ruby、details/summary、media、iframe 或“必要的语义容器”。也不新增通用 inline HTMLTag 配对栈：`u` 和 `kbd` 都是 parser 中显式注册、独立测试的固定语法。

不引入 DOMPurify 作为“通用清洗后继续渲染”的许可。复杂 table 使用 inert DOM parse → 封闭 typed model → DOM API/export encoder；未通过 typed parser 的源码失败关闭，显示源码而不是尝试修复或执行。

旧文档中已有的未知 HTML 不会因为本功能突然变成活动内容。现有 `<a id>`、`<u>`、`<mark>` 兼容行为保持；任何扩展都必须另立 spec，而不是扩大本 allowlist。

## Lazy Semantic Accessors

共享层回答局部、事实型问题，不产生全局 Semantic AST：

- `escapeValue(node, source)`：被转义字符和 marker range；
- `hardBreakKind(node, source)`：backslash/two-space break 及 marker range；
- `imageParts(node, state/source)`：alt、resolved destination、可选 title，覆盖 inline/reference image、escape、entity 和嵌套 inline label；
- `linkParts(node, state/source)`：覆盖 inline/reference link 和 autolink；
- `tableCellModel(cellNode, source)`：正确处理 `\|`、inline Markdown、`<br>` 和 cell 内受支持结构；
- `complexTableModel(htmlBlockSource)`：封闭 table typed model；
- Entity、code、math 的可见值/range。

Accessor 不决定 CSS、CodeMirror Decoration 或 HTML template。Live Preview 只在当前 decoration 遍历范围调用；export 可对导出快照完整遍历；table cell 只解析自己的小片段。不得缓存完整文档第二棵树。

### Phase 1 必须消除的导出分叉

1. `exportHtml` 和 `exportRichHtml` 都必须通过 `imageParts` 输出 alt，删除两处 `alt=""` 硬编码和 Preview/cell 中的手写 `head.indexOf("](")`。
2. 同步与富 table export 都必须先取得同一 `tableCellModel`。富导出在这个 model 上异步渲染 math、image resolver 等能力，不能再调用 `richChildren(TableCell)` 绕过 `parseCell`。
3. `\|` 的解释属于 table-cell semantic accessor，只处理真正的 escaped pipe；exporter 不再各自做字符串级 `.replace(/\\\|/g, "|")`。
4. Preview DOM、同步 HTML 和富 HTML 对 cell 的 Text/Break/Image/Link/List/Code 节点使用同一 model 和不同 renderer。

Phase 1 的回归样本至少包含：普通/引用式 image、含 escape/entity/inline formatting 的 alt、空 alt、可选 title、cell `\|`、偶数/奇数反斜杠后的 pipe、cell `<br>`、cell list、cell image alt，以及同步/富 export parity。

## Live Preview 与源码不变性

- Live Preview 通过 replace/mark/widget 隐藏或投影语法，不改源码。
- Escape 只隐藏语法反斜杠，保留被转义字符；Source Mode 显示原始 `\`。
- HardBreak 隐藏反斜杠或行尾空格，保留真实换行。
- `<u>`/`<kbd>` 只隐藏固定 tag marker；内容继续由 Lezer inline parser 解释。
- canonical complex table 使用 block widget；未知/无效 HTML 保持源码可见。
- selection、atomic range、IME 和 Source/Live toggle 不得改变文档字节。

现有“进入 Live Preview 自动改写有序列表编号”的例外将移除：预览只通过 decoration 显示连续编号；源码规范化必须是用户显式执行、可撤销的命令。该迁移单独实施，不混入 Smart Paste serializer。

## 表格设计

### Markdown table

- 无 rowspan/colspan、cell 内容在现有能力内时序列化成 GFM table。
- 继续使用现有 TableWidget、source toolbar 和 Lezer-range edits。
- cell Preview、同步 export、富 export 共享 `tableCellModel`。

### Complex table

只有 rowspan/colspan 等 Markdown 确实无法表达的表格进入 complex path。输入 DOM 先归一为封闭 typed model，再输出 deterministic canonical HTML：

- 只允许 `table/thead/tbody/tfoot/tr/th/td` 和封闭 cell inline 子集；
- rowspan/colspan 是有上限的正整数；header/scope/align 是枚举；
- 不输出 class、id、style、事件属性或外部主题信息；
- URL 经过共享 URL policy；
- unsupported nested block 展平为文字/line break，不保留任意 HTML；
- canonical source 可以多行，但标签之间不得出现空白物理行。

“无空白行”是 CommonMark Type 6 的持久化合同，使 serializer 生成的整个 table 成为一个 `HTMLBlock`。Engine 只在单个节点完整覆盖 `<table>…</table>` 且 typed parser 成功时挂载 widget。用户后来加入空白行、破坏闭合或加入未知结构时，widget 立即失败关闭并显示源码；不得跨 `HTMLBlock`/Paragraph 兄弟节点扫描拼接。

Complex table widget 只提供整块 source entry，不显示 Markdown table 行列 toolbar，不调用 `tables/edit.ts`，也不把 HTML table 自动改写成 Markdown table。

### BlockWidget 强制合同

Complex table 是新的 `block: true` widget，实施时必须同时接入：

1. `decorations/build.ts` 的 selection-range 重建机制（`SELECTION_BLOCKS` 或等价的 typed registry），确保光标进出时装饰重建；
2. `decorations/widgetHeights.ts` 的内容规模感知 `estimatedHeight`，并更新 `widgetHeights.test.ts` 全类型门禁；
3. `navigation/blockEntry.ts` 的 `blockEntryPosition`，覆盖 ArrowUp/ArrowDown 从上下进入源码；
4. `blockSelectionOverlay.ts` 的完整选区覆盖态，验证 `omd-block-covered` 和相同内容多实例不会串 range；
5. 现有 `BlockWidget` 生命周期、embed、render budget、click-to-source 和 readOnly contract。

不能只“渲染出一个 div”就宣称完成。选择边界、虚拟滚动、键盘导航和全选都属于功能正确性。

## 内嵌图片资产

### 分类

- `http:` / `https:`：保留 URL，不自动下载。
- `data:image/...`：通过 desktop host adapter 写入当前文档 `assets/`，改写为相对路径。
- `blob:`：优先匹配 Clipboard image item；无法解析时保留 alt 并报告降级。
- `file:`：只有 host 明确取得可读 File 时进入资产管线；不把不可移植绝对路径写入 Markdown。
- 不支持或超限 MIME：保留 alt，周围内容继续成功。

### 批量写入与事务

多图先由 desktop/Rust 完成受限资产写入，paste bookmark 随中间 transaction 映射。完成后重新验证 tab、document、view、readOnly identity，再在一个 `input.paste` transaction 中插入 Markdown。

view 失效、identity 改变或 dispatch 失败时，只清理由本次任务创建且尚未被引用的明确路径。Undo 不自动删除已写资产，与现有图片策略一致。未保存文档无法取得 assets 目录时，图片降级为 alt 并汇总提示；文字和格式仍粘贴。

## 并发、选择与 undo

- 每个 EditorView 的异步 Smart Paste 串行化，不能交叉提交。
- paste bookmark 是 StateField/StateEffect 管理的映射范围，不捕获永久绝对 offset。
- collapsed caret 可随不相交编辑映射；原非空选择被中间 transaction 交叠修改时取消该 paste。
- document identity 改变、view 销毁或进入 readOnly 后取消提交。
- 一次 paste 最终只 dispatch 一个 `input.paste` transaction，形成一个 undo step。
- 多 selection 使用 CodeMirror plain-text 语义，不定义异步富结构复制到多个 range。

## 错误处理

| 情况 | 行为 |
| --- | --- |
| HTML parse/normalize 失败 | visible text 的 strict literal serialization |
| 一次结构验证失败 | 整段 strict serializer；不重试 parse |
| strict serializer 无法安全承载结构 | 整段 visible text strict literal |
| 单张图片失败 | alt 降级，其他内容继续，汇总提示 |
| view/document 失效 | 取消插入，清理本次未引用资产 |
| readOnly | 消费事件，无转换/资产/dispatch |
| complex table 不满足 typed contract | 不挂 widget，显示源码 |
| 危险/未知 HTML | 删除标签并保留可见子内容 |

不为每个被丢弃的 span/CSS 属性弹 toast。只有资源失败、整段严重降级或 clipboard 权限使普通 Paste 退成 plain-only 时显示一次必要反馈；详细原因进入开发诊断。

## 性能

- 正常复杂度为 O(HTML 节点数 + 输出长度 + 局部 parse 长度)。
- 每次生产转换最多一次新的局部 Markdown parse。
- 不维护 source map，不做异构树 diff，不克隆 AST 替换单节点，不做 parse retry。
- 不扫描整个打开文档，不强制完成 editor syntax tree。
- 同步 DOM parse 不能谎称可取消；若基准显示主线程不可接受，迁移到 worker-capable HTML reader。
- 实施计划记录典型、100 KiB、1 MiB、5 MiB clipboard HTML 的 parse/normalize/serialize/validate 基线，再把测量结果固化为命名 benchmark budget。
- 大粘贴显示非模态转换状态；不能仅因体积静默丢失格式。

## 安全模型

```text
untrusted clipboard bytes
  → inert HTML parse
  → Paste AST normalization
  → Markdown serializer / closed complex-table model
  → DOM API or escaped HTML exporter
```

安全要求：

- raw clipboard HTML 永不直接进入 `innerHTML`。
- Mermaid/Shiki/KaTeX 的受控输出许可不扩展到 clipboard HTML。
- Link/Image URL policy 是 engine 单一来源，覆盖大小写、entity、控制字符和编码混淆。
- 外部 style string 不通过 sanitizer 后保存；只读取少数语义属性并丢弃原值。
- complex table renderer 从 typed model 创建 DOM，不复用原 DOM node，不回放未知 attribute。
- 旧 Markdown 文档与 clipboard 输入同样不可信；本功能不自动激活旧 raw HTML。
- 固定攻击语料覆盖 script/event、SVG/MathML、危险 URL、malformed table 和超大 span 值。

## 可访问性

- Image alt 通过共享 accessor 保留；缺失时用空 alt，不猜文件名。
- Link、Kbd 和 table header 保留语义；`th`/`scope`、rowspan/colspan 正确输出。
- complex table source entry 可聚焦且有可访问名称。
- decoration 隐藏 marker 后不能让屏幕阅读器重复朗读源码和投影。
- 删除未知标签时保留可见子内容。
- 外部颜色/背景不被保留，因此不会制造 dark mode 黑底黑字或“只靠颜色表达”的新内容。

## 测试与验收

### Fixture corpus

提交最小、可审查、无版权问题的 `text/html` + `text/plain` fixture，覆盖 Chrome/Safari/Firefox、Word/Pages/Google Docs、Excel/Sheets、VS Code、Typora/其他 Markdown 编辑器、邮件/聊天、CJK/RTL/emoji/entity/NBSP、嵌套列表/引用/table/code、全部 ASCII punctuation 和攻击 HTML。

每个 fixture 明确记录：输入 payload、插入上下文、预期源码、预期 Preview/HTML 语义、是否走 fast/normal/strict path。不能用 serializer 自己生成 expected output。

### Engine

- DOM → Paste AST normalization；
- color/background/font-size/span 被丢弃，bold/italic/decoration 被语义化；
- `MarkdownTriggerPolicy` 每个上下文与 parser-extension drift gate；
- plain fast path 的允许/拒绝矩阵；
- structured validation 只有一次 parse；失败整段 strict fallback；
- strict serializer property/fuzz：literal text 不产生意外语义；
- Escape/HardBreak/Image/table-cell accessor parity；
- `exportHtml`/`exportRichHtml` image alt 和 table cell parity；
- canonical complex table 单 `HTMLBlock`、空白行/破损闭合失败关闭；
- Kbd/Underline marker、Source/Live 字节不变；
- arbitrary DOM/property fuzz 不抛异常、不执行活动内容。

### Desktop/Rust

- keyboard/native menu/AppMenu/command palette/context menu 的普通 Paste 结果一致；
- macOS 右键目标修复后 HTML 仍走 Smart Paste；
- `navigator.clipboard.read()` 收集 image/html/plain 和 permission fallback；
- Paste as Plain Text 在所有入口逐字节一致，`Mod+Shift+V` 无 double-fire；
- image flavor priority、多图部分失败、取消和失效清理；
- mapped bookmark、tab/document identity、readOnly 零副作用；
- 一次 undo 撤销整次文档插入；
- IPC serialized-JSON casing contract。

### Browser E2E 与 BlockWidget

- Preview 不显示多余反斜杠；两种 CommonMark HardBreak 正确；
- Safari/WebKit context-menu paste 不吞行、不降成 plain；
- complex table 光标进入/退出、ArrowUp/Down、Cmd+A covered overlay、滚动估高和 source entry；
- 同内容多个 table widget range 不串联；
- dark mode 粘贴浅色网页后没有固定外部 text/background color；
- XSS 样本无执行路径；paste 后 caret、scroll 和 IME 稳定。

### 验收不变量

1. Paste as Plain Text 对 `text/plain` 逐字节一致。
2. `access_token` 等 ordinary text 不产生无意义反斜杠。
3. 同一 payload 和上下文产生确定性源码。
4. Live Preview、同步 export、富 export 和 table cell 对共享语义一致。
5. Image alt 在 Preview 和两种 export 一致。
6. Live/Source 往返和仅移动光标不修改源码。
7. 外部 color/background/font-size/style span 不进入 Markdown。
8. keyboard/menu/context menu 的普通 Paste 语义一致。
9. 不可信 HTML/URL 攻击语料无活动执行路径。
10. 一次 paste 是一个 undo step，异步完成不写入陈旧位置。
11. 生产不完整解析大文档，每次转换最多一次新局部 parse。
12. 所有 `block: true` widget 满足 selection、height、navigation、overlay 合同。

## 迁移顺序

本 spec 是跨层合同，不要求一个巨型 PR。后续实施计划按以下阶段拆分；任何阶段若要改变产品契约，先回到 spec review。

### Phase 1：Semantic Accessors 与现有投影修复

- 固定当前失败 fixture；
- 实现 Escape、HardBreak、Image 和 table-cell accessors；
- 修复 `exportRichHtml` 绕过 `parseCell`；
- 统一同步/富 export 的 Image alt；
- 迁移 Preview、两种 export 和 table cell，删除重复解析；
- 不改变 Smart Paste 主链路。

### Phase 2：封闭 HTML 逃生舱

- 新增固定 Kbd inline extension；复用 Underline；
- 实现 typed complex-table parser/renderer/exporter；
- 接齐 BlockWidget 五项合同和攻击语料；
- 验证 CommonMark 空白行失败关闭；
- 不建立通用 Safe HTML 系统。

### Phase 3：语义 importer

- 实现最小 Paste AST、normalizer、trigger policy 和 serializer；
- 实现 plain fast path、一次局部验证和整段 strict fallback；
- 在测试中与旧 converter 并行产出，人工审核 fixture 差异；
- 不把 source map、semantic signature 或 retry state machine 带回实现。

### Phase 4：统一 clipboard host 与资产

- 用 desktop 单一 paste controller 接管 DOM event 和 async Clipboard API；
- 修复 macOS context-menu target 后继续 Smart Paste；
- 接通多图 host adapter、bookmark、队列和 identity guard；
- 注册/测试 `Mod+Shift+V` 和所有菜单入口。

### Phase 5：切换与删除

- fixture、E2E、性能和 manual QA 达标后原子切换主链路；
- 删除 Turndown、GFM plugin、converter cache 和 whitespace heuristic；
- 删除旧 engine `htmlPaste()` 事件竞争层和 image paste 中的 plain-text 右键分支；
- 更新 AGENTS、known gotchas、manual QA 和用户指南。

### Phase 6：严格源码投影

- 移除 Live Preview 自动改写有序列表编号；
- 保留纯显示连续编号；
- 提供显式、可撤销的规范化命令；
- 单独验证保存、恢复、冲突和大文档行为。

每个 Phase 必须保持可发布。Phase 3 不在 Phase 1/2 合同完成前接管生产 paste；Phase 4 不允许通过另加一个 paste handler 形成新的入口竞争。

## 删除、保留与明确否决

### 最终删除

- `turndown`、`turndown-plugin-gfm` 和类型声明；
- `squeezeWhitespace` 等字符串启发式；
- converter lazy import/cache；
- Preview/export/table 中重复的 Escape/HardBreak/Image/table-cell 解释；
- macOS 右键非图片强制 plain-text 分支；
- 应用普通 Paste 对 `pastePlainText()` 的复用。

### 保留

- CodeMirror + Lezer source-first 架构；
- `normalizeBlockPaste` 的 block-boundary 责任，但由新 serializer 合同重新测试；
- verbatim predicate 单一来源；
- 图片 item 优先和资产路径规则；
- Markdown TableWidget 的双状态模型；
- safe-mode windowed decoration、BlockWidget 基础设施和 render budget；
- rich export 的 KaTeX/Shiki/Mermaid 专用 renderer。

### 明确否决

- **继续修补 Turndown：** 它不了解项目方言和插入上下文。
- **全局删除反斜杠：** 会把 literal text 重新解释为结构。
- **节点级 source map + semantic diff + retry：** 宿主上下文导致的树边界漂移无法可靠归因，成本与收益失衡。
- **保存原始 clipboard HTML/CSS：** 污染源码、破坏 dark mode，并扩大攻击面。
- **通用 Safe HTML renderer：** 当前需求只需要四种封闭输出；通用系统没有产品收益。
- **跨 Lezer sibling 拼 HTMLBlock：** 等价于维护第二套不完整 block parser。
- **只保留纯文本：** 丢失用户明确复制的 heading/list/link/table 等语义。
- **全局 Semantic AST：** 重复 Lezer tree，增加大文档内存和同步成本。
- **迁移到 ProseMirror：** 破坏本项目 source-first 和大文档架构。

## 文档维护

实施完成时同步：

- `packages/engine/AGENTS.md`：trigger policy、semantic accessors、closed HTML 和 source-preservation invariant；
- `apps/desktop/AGENTS.md`：统一 ClipboardPayload、右键 target、两条 paste 通道和 asset contract；
- `docs/memory/known-gotchas.md` 与对应 gotcha：table-cell rich export、HTMLBlock 空行、paste handler 竞争、BlockWidget 五项合同；
- `docs/manual-qa.md`：浏览器/Office/Docs/Sheets/代码/dark mode/安全/大粘贴矩阵；
- `docs/guides/`：Paste 与 Paste as Plain Text 的用户行为；
- 原 HTML paste spec：保持“被本设计替代”标记。

README 和 CHANGELOG 只在功能实际发布时更新，spec-only 提交不提前宣称可用。
