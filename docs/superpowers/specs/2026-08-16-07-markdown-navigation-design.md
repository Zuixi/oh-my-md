# 07 Markdown Navigation

**日期：** 2026-08-16  
**状态：** 已确认  
**差距分析：** `docs/superpowers/specs/2026-08-16-industry-gap-analysis.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

让脚注与本地 Markdown 链接可导航：

1. 单击 `[^id]` 跳到对应定义；单击定义标记跳回最近一次引用来源。
2. 单击相对路径 `.md` / `.markdown` 链接时，由桌面打开（或聚焦）该文件标签。
3. 保留现有 `#` 标题锚点与 `http(s)` 外链行为。

## 非目标

- 不实现双链 `[[wiki]]`。
- 不解析脚注跨空行多段定义（现有 footnotes 限制保留）。
- 不做返回栈 UI；只记本次跳转到定义前的光标。
- 不在引擎里打开文件或调用 Tauri。

## 当前证据

- `packages/engine/src/links.ts`：`linkAt`、`headingPositionForAnchor`。
- `apps/desktop/src/Editor.ts` `activateLink`：`#` 滚到标题，其它 `window.open`。
- `packages/engine/src/parse/footnotes.ts` 已解析 `FootnoteReference` / `FootnoteDefinition`。
- 相对 `.md` 链接目前当外链 `window.open`，桌面里无效。

## 用户流程

1. Live Preview 下单击脚注引用：选区移到定义行首并 `scrollIntoView`。
2. 单击该定义的 `[^id]:` 标记：若本次会话刚从引用跳来，回到该引用；否则留在定义。
3. 单击 `notes/a.md` 或 `./a.md`：宿主打开该路径；缺失文件时报错，不创建文件。
4. `https://` 与 `mailto:` 仍用系统打开。

## 接口

引擎新增（`links.ts` 或 `footnotes.ts` 导出）：

```ts
export interface FootnoteTarget {
  readonly id: string
  readonly kind: "reference" | "definition"
  readonly from: number
  readonly to: number
}

export function footnoteAt(state: EditorState, pos: number): FootnoteTarget | null
export function footnoteDefinitionPosition(state: EditorState, id: string): number | null
export function footnoteReferencePosition(state: EditorState, id: string): number | null

export type ResolvedLink =
  | { readonly kind: "heading"; readonly pos: number }
  | { readonly kind: "external"; readonly href: string }
  | { readonly kind: "markdown"; readonly href: string }
  | { readonly kind: "other"; readonly href: string }

export function classifyLink(href: string): Exclude<ResolvedLink, { kind: "heading" }>
```

`classifyLink`：`http(s):` / `mailto:` → `external`；以 `.md` / `.markdown` 结尾（可带 `#anchor`）→ `markdown`；其余相对路径 → `other`（图片等，单击不打开）。

桌面 `activateLink`：

- heading：现有滚动。
- external：`window.open`。
- markdown：回调 `onOpenMarkdownHref(href)`；App 相对当前文档目录解析，走现有 `openFile`。
- footnote：引擎跳转；定义返回用 Editor 模块级 last-jump 位置。

## 错误处理

- 找不到脚注定义：不跳转，不报错。
- 本地文件不存在：`services.reportError`，当前文档不变。

## 测试

引擎：`footnoteAt`、定义查找大小写不敏感、缺失 id 返回 null、`classifyLink` 各分支。

桌面：`activateLink` 对 `.md` 调用宿主回调而不是 `window.open`；外链仍 `window.open`。

## 文档

`docs/manual-qa.md` 增加脚注跳转与本地 md 打开条目。
