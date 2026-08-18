# 20 查找替换增强（正则 / 全字匹配）设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**路线图关联：** 日常体验长尾（2026-08-18 产品化差距收敛计划 Phase 2.2）；06 Core Writing 的查找替换只做了纯文本子串，本规格补齐主流编辑器标配

## 目标

文档内查找/替换（⌘F/⌘H）支持正则模式与全字匹配：

1. `.*` 开关：按 JS RegExp 解释查询串；替换串支持 `$1` 捕获组引用。
2. 全字开关（仅文本模式可用）：匹配必须是完整单词。
3. 无效正则在查找条内即时提示（`role="alert"`），不弹窗、不抛错。

## 非目标

- 跨文件替换、多光标选区替换（06 明确后置）。
- 正则模式下的全字匹配（`a|b`、锚点等包 `\b` 会改变语义，禁用该组合：正则开启时全字开关 disabled）。
- 查找历史。

## 接口（`apps/desktop/src/findReplace.ts`，纯函数）

```ts
interface FindQuery { query: string; caseSensitive: boolean; regex: boolean; wholeWord: boolean }
function validateFindPattern(q: FindQuery): string | null   // 无效正则的报错文案，仅 regex 模式
function collectMatches(doc: string, q: FindQuery): readonly Match[]
function replaceAll(doc: string, q: FindQuery, replacement: string): string
```

语义要点：

- 文本模式：字面转义后构造 RegExp；替换为字面语义（`$&` 不解释，用函数替换）。
- 正则模式：原样构造（`g` + 可选 `i`）；替换走原生 `$n` 语义。
- 全字 `\b` 只加在查询首尾是 ASCII 词字符的边上——CJK 不构成 `\b`，否则中文查询会全军覆没。
- 空查询/无效正则 → 0 匹配（不抛）；零宽匹配跳过不收集。

## UI

FindReplaceBar 在 Case 开关后加 `.*`（正则）与「全字」两个 checkbox（复用 `.find-replace-case` 样式与 label 结构）；正则开启时全字 checkbox `disabled`。无效正则在状态位旁渲染 `find-replace-error`（role="alert"）。i18n 键：`find.label.regex` / `find.label.wholeWord` / `find.invalidRegex`。

## 测试矩阵

- `findReplace.test.ts`：文本大小写、正则捕获替换、全字（ASCII 与 CJK 边界）、无效正则 0 匹配 + 报错、`$&` 字面替换。
- `FindReplaceBar.test.tsx`：开关回调、正则时全字禁用、错误提示渲染。
- App 集成：现有 meta+f 流程回归（App.test.tsx 既有用例）。

## 手动 QA

manual-qa.md 查找条目补：`.*` 开关正则命中与 `$1` 替换；全字不命中子串；坏正则显示提示且 Enter 不跳转。

## 对后续规格提供的接口

`FindQuery` 对象成为查找功能的稳定入参形状；跨文件搜索（workspace.rs）不在此列。
