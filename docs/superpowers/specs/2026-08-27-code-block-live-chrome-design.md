# Code Block Live Chrome（Typora 对齐）

**Date:** 2026-08-27  
**Status:** Superseded in part — keyboard edit is native CodeMirror source (`blockSelected` unmounts `CodeWidget`), not in-widget `contenteditable`. Hover chrome + fence info remain.  
**Related:** M2 block widgets, `CodeWidget`, fence info

## 问题

Live 模式下代码块应像 Typora：有明确块级容器、Shiki 高亮、行号、围栏始终隐藏；Source 模式才显示完整 `` ``` ``。当前实现：

- 单击已保持 widget（2548f2c），但容器视觉弱、无顶栏、无行号
- ↑/↓ 进入块内会卸载 widget，失去 Shiki
- 无 fence info 标签/语言 UI

## 目标交互

### 三种可见性状态

| 状态 | 触发 | Shiki | 行号 | 顶栏（标签/语言/copy） | 可编辑 |
|------|------|-------|------|------------------------|--------|
| **Idle** | 光标在块外 | ✓ | ✓ | **显示** | 否 |
| **Keyboard-active** | ↑/↓ 进入块内 | 卸载 widget | 源码行样式 | 无（widget 已卸） | ✓（CodeMirror 源码，光标在对应行） |
| **Pointer-over** | 鼠标 enter/hover 块 | ✓ | ✓ | **显示** | 可选（点击 body 可聚焦编辑） |

**顶栏显示规则（用户确认）：**

> 预览态（widget 挂载）时 fence info 顶栏默认显示（标签输入、语言下拉、copy），避免 hover 才出现造成误导。  
> 纯键盘 ↑/↓ 进入编辑时 widget 卸载，顶栏随 widget 消失。

Source 模式（⌘E / Ctrl+E）：完整 Markdown 源码，含围栏行。

### 数据：fence info 行

标签与语言均写入 opening fence 的 info 字符串（`CodeInfo` 节点范围）：

```markdown
```cpp Code block
int main() {}
```
```

- **第一 token**：语言 id（`resolveCodeLanguage` 可解析）
- **剩余文本**（trim）：块标签/标题；UI 空时 placeholder「Code block」，写入时去掉 placeholder
- 改语言/标签 → 单 transaction 替换 `CodeInfo` 范围，不改 `CodeText`

## 非目标（本阶段）

- 无语言围栏块、blockquote 内围栏：仍 `line:omd-codeblock`（known-gotchas 坐标约束）
- 块内 AI / 执行代码
- 导出 PDF 顶栏 chrome（导出仍投影 HTML）

## 架构

### 渲染策略

有语言的 `FencedCode` 在 Live 模式下：caret **在块外** emit `CodeWidget`；`blockSelected` 时退回 `styleCodeblockLines`，由 CodeMirror 原生编辑源码。

```text
styleFencedCode (lang set, not mermaid, not in quote)
  → blockSelected? styleCodeblockLines
  → else CodeWidget(src, lang, title, embed)
```

### 编辑写回

不要在 widget 内 `contenteditable`。语言/标签通过 `replaceFenceInfo(state, liveRange.from, lang, title)` 替换当前 `CodeInfo`。Copy 用 `this.src` + 图标，成功后短暂 Copied。

### 行号

**必须显示。** 实现：Shiki 输出 `.line` + CSS `counter` 伪元素，`user-select: none`。Copy 按钮与 programmatic copy 仅用 `src` 纯文本，不含行号。

### 顶栏 DOM

```text
.omd-code
  .omd-code-header     ← 预览态默认可见
    input.omd-code-title
    select.omd-code-lang
    button.omd-code-copy
  .omd-code-body.omd-code-lines
    pre/code (Shiki)
```

移除代码块上通用 `✎`（`CodeWidget` 覆盖 `toDOM` 或 `showEditButton=false`）。

### 视觉

- 块容器：`--omd-code-block-bg`（light ≈ `#f8f8f8`），`1px` border，`border-radius: 6px`
- Shiki `pre` 背景透明，避免双层色块
- 暗色主题独立 token

## 边界

- Engine 拥有 chrome 语义与 fence info 解析；desktop `styles.css` 负责视觉 token
- i18n：copy 按钮 aria-label、placeholder 由 desktop 注入 Facet（与 `imageBrokenLabel` 同模式）或 engine 默认英文 + desktop 覆盖

## 验收

1. Idle：灰底容器 + Shiki + 行号 + 顶栏（语言/标签/copy）
2. ↑/↓ 进入：卸载 widget，源码可编辑，顶栏随 widget 消失
4. Source 模式：完整 `` ``` ``
5. fence info 持久化到 `CodeInfo` 行

### 补充（2026-08-28）：``` + Enter 成块

正在输入的未闭合围栏行（FencedCode 仅覆盖 opening 行、光标在其上）不产生任何块样式（纯文本，避免“``` 还没按 Enter 就渲染”的观感）。在该行行尾按 Enter，`continueFenceSpec`（`format/fences.ts`）自动补全闭合围栏并让光标落在内容行——成块后走常规分支：光标在内 → 源码行样式（含 caret 行保灰底），光标离开 → widget。引用/列表内不劫持 Enter。
