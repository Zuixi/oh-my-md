# 06 Core Writing Experience

**日期：** 2026-08-16  
**状态：** 已确认（用户要求按差距分析落地并实现）  
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md`  
**差距分析：** `docs/superpowers/specs/2026-08-16-industry-gap-analysis.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

补齐日常写作四件事，使文档内查找、中文统计、拼写检查和列表续写达到 Typora 级可用：

1. 当前文档查找与替换（`⌘F` / `⌘H`）。
2. 中文友好的字/词/字符统计，状态栏同步显示。
3. Settings 里的 Spellcheck 真正作用于编辑器。
4. 列表专用 Enter 续项与 Tab 缩进，不开启通用 `indentOnInput`。

## 非目标

- 不实现正则查找、多文件替换、大小写智能替换之外的复杂搜索方言。
- 不把文件夹搜索做成文档查找；两者并存。
- 不开启 `indentOnInput`、`closeBrackets` 或通用 `autocompletion`。
- 不改有序列表规范化算法或确认条。
- 不做 YAML、Smart Punctuation、软换行策略开关。

## 当前证据

- `apps/desktop/src/FileTree.tsx` 搜索按钮标注 `⌘F`，打开的是 `SearchPanel`（文件夹字符串扫描）。
- `apps/desktop/src/desktopServices.ts`：`wordCount` 为 `text.trim().split(/\s+/).length`。
- `apps/desktop/src/settings.ts` 有 `spellcheck: boolean`；`App.tsx` / `Editor.ts` 未读取该字段设置 DOM。
- `packages/engine/src/format/commands.ts` 有切换列表命令，无 Enter 续写。
- 桌面未依赖 `@codemirror/search`。

## 用户流程

### 查找 / 替换

1. `⌘F` 打开当前文档查找条（焦点进查询框，不抢文档 dirty 状态）。
2. Enter / `⌘G` 下一个，`⇧Enter` / `⇧⌘G` 上一个；Escape 关闭并焦点回编辑器。
3. `⌘H` 展开替换框。Replace 改当前匹配；Replace all 一次 transaction 改完全部。
4. 区分大小写可选；默认字面匹配，不做正则。
5. `⇧⌘F` 打开现有文件夹搜索。FileTree 按钮文案改为 `⇧⌘F`。

### 统计

状态栏显示：`{words} words · {chars} chars`。

- `chars`：去掉首尾空白后的码元数（`text.trim().length`）。
- `words`：拉丁/数字连续片段算 1 词；每个汉字/假名/韩文音节算 1 词；空白与纯标点不算。

### 拼写检查

`settings.spellcheck === true` 时，`.cm-content` 带 `spellcheck="true"`。关闭则 `spellcheck="false"`。改设置立即作用于当前与后续 EditorView。使用 WebView 原生拼写，不引入第三方词典。

### 列表续写

在列表项正文按 Enter：

- 非空项：下一行插入同类型 marker（无序保留 `-`/`*`/`+`；有序为下一项编号；任务列表为 `- [ ] `），光标停在 marker 后。
- 空项（只有 marker）：去掉该行 marker，退出列表。
- 引用内的列表：续行保留当前引用前缀。

Tab / Shift-Tab 仅当选区落在列表项时缩进/反缩进 2 个空格（与现有悬挂缩进约定一致）。非列表行不拦截 Tab。

## 架构

```
@omd/engine
  documentStats(text) -> { words, chars }
  continueList / indentList / outdentList  (纯 TransactionSpec)
  listKeymap  (Enter / Tab / Shift-Tab)

apps/desktop
  FindReplaceBar.tsx + findReplace.ts   文档查找状态
  Editor.ts   contentAttributes.spellcheck；挂 listKeymap（已在 editorExtensions）
  StatusBar   使用 documentStats
  App.tsx     ⌘F 文档查找；⇧⌘F 文件夹搜索
```

引擎拥有 Markdown 列表语义。桌面拥有查找 UI 与拼写属性。查找用文档字符串 + CodeMirror selection，不引入第二套 Markdown 解析。

## 接口

```ts
export interface DocumentStats {
  readonly words: number
  readonly chars: number
}

export function documentStats(text: string): DocumentStats

export function continueList(state: EditorState): TransactionSpec | null
export function indentList(state: EditorState): TransactionSpec | null
export function outdentList(state: EditorState): TransactionSpec | null
```

查找状态（桌面）：

```ts
export interface FindReplaceState {
  readonly query: string
  readonly replacement: string
  readonly caseSensitive: boolean
  readonly replaceOpen: boolean
  readonly open: boolean
  readonly matchCount: number
  readonly activeIndex: number
}

export function collectMatches(doc: string, query: string, caseSensitive: boolean): readonly { from: number; to: number }[]
export function nextIndex(count: number, current: number): number
export function prevIndex(count: number, current: number): number
```

`replaceAll` 从后往前改，一次 `view.dispatch`。

## 快捷键

| 键 | 动作 |
|---|---|
| ⌘F | 打开文档查找 |
| ⌘H | 打开查找并展开替换 |
| ⌘G / Enter（查找框） | 下一个 |
| ⇧⌘G / ⇧Enter | 上一个 |
| Escape | 关闭查找 |
| ⇧⌘F | 文件夹搜索 |
| Enter（编辑器，列表项） | 续项或退出空项 |
| Tab / Shift-Tab（列表项） | 缩进 / 反缩进 |

## 错误处理

- 空查询：0 个匹配，不改选区。
- Replace all 0 匹配：no-op。
- 列表续写失败（非列表）：Enter 走 CodeMirror 默认换行。

## 测试

引擎：`documentStats`（纯英文、纯中文、中英混排、空白）；`continueList` 无序/有序/任务/空项退出/引用内列表；indent/outdent 边界。

桌面：`collectMatches` 大小写；`FindReplaceBar` 开关；spellcheck 属性随设置变化；`⌘F` 不再打开文件夹搜索。

## 文档

更新 `docs/guides/keyboard-shortcuts.md`、`docs/manual-qa.md`。
