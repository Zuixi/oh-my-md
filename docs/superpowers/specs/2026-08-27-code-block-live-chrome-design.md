# Code Block Live Chrome（Typora 对齐）

**Date:** 2026-08-27  
**Status:** Approved for implementation  
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
| **Idle** | 光标在块外 | ✓ | ✓ | 隐藏 | 否 |
| **Keyboard-active** | ↑/↓ 进入块内 | ✓（debounce 重渲） | ✓ | **隐藏**（除非同时 hover） | ✓（widget 内编辑写回 `CodeText`） |
| **Pointer-over** | 鼠标 enter/hover 块 | ✓ | ✓ | **显示** | 可选（点击 body 可聚焦编辑） |

**顶栏显示规则（用户确认）：**

> 只有鼠标进入或 hover 代码块时，才显示 fence info 可选区域（标签输入、语言下拉、copy）。  
> 纯键盘 ↑/↓ 进入编辑时，不自动弹出顶栏；鼠标移入后才显示。

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

有语言的 `FencedCode` 在 Live 模式下 **始终** emit `CodeWidget`，**不再**因 `blockSelected` 退回行样式。

```text
styleFencedCode (lang set, not mermaid, not in quote)
  → CodeWidget(src, meta, embed, editing=blockSelected(...))
  → 始终 block replace，子树 CodeMark/CodeInfo 仍 fold（围栏不可见）
```

### 编辑写回

参考 `TableWidget`：`contenteditable`（或 textarea）+ `dispatch` 替换 `CodeText` 区间；`readOnly` 禁用编辑与顶栏 mutators。

Shiki：编辑中 `input` 写回 doc → widget `eq` 因 `src` 变化重建/debounce `renderInto`；150ms debounce 保留。

### 行号

**必须显示。** 实现：Shiki 输出 `.line` + CSS `counter` 伪元素，`user-select: none`。Copy 按钮与 programmatic copy 仅用 `src` 纯文本，不含行号。

### 顶栏 DOM

```text
.omd-code
  .omd-code-header     ← hover 时可见
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

1. Idle：灰底容器 + Shiki + 行号，无顶栏
2. Hover：顶栏出现，可选语言/改标签，copy 得纯代码
3. ↑/↓ 进入：可编辑、Shiki 保持（允许 debounce 闪烁），顶栏不出现直至 hover
4. Source 模式：完整 `` ``` ``
5. fence info 持久化到 `CodeInfo` 行
