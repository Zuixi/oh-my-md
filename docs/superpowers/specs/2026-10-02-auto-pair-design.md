# 自动配对（Auto Pair）设计

**日期：** 2026-10-02（v3：并入 review 的 5 项审计结论）
**状态：** 已确认（D1/D2 已签署；D3 改为无状态启发式；D7 押后；D8–D11 为 review 后的新增决策）
**父设计：** [`2026-08-10-oh-my-md-design.md`](./2026-08-10-oh-my-md-design.md)
**相关：** [`2026-08-16-06-core-writing-experience-design.md`](./2026-08-16-06-core-writing-experience-design.md)、[`2026-08-16-industry-gap-analysis.md`](./2026-08-16-industry-gap-analysis.md)

## 摘要

omd 目前**完全没有输入层配对能力**：`editorExtensions()`（`packages/engine/src/index.ts:106`）里没有任何 `inputHandler`，也没有 `closeBrackets`；三处 `AGENTS.md` 明文禁止开启 `closeBrackets`（根 `AGENTS.md:96`、`packages/engine/AGENTS.md:113`、`apps/desktop/AGENTS.md:71`）。结果是写 `(`、`[`、`"`、`` ` ``、`*` 全都要手动闭合，代码块里尤其难受。

差距分析（`2026-08-16-industry-gap-analysis.md`）从未把 auto-pair 列入缺口表 —— 它把「Smart Punctuation」判为后置，又把 auto-pair 与「禁止 `closeBrackets`」这条渲染约束混为一谈。**这是一整类被误伤的能力，不是一个小功能。**

结论：不启用 `closeBrackets`，改为在**引擎内**实现一个 Markdown 感知、可配置、与 Live Preview 折叠/atomic 约束一致的配对扩展，语义对齐 Typora（三个开关：括号 / 引号 / Markdown 语法，D1）、工程语义对齐 CodeMirror 6 `closeBrackets`（**含它的多选区语义**，D10），但不复制它的 `StateField` —— 跳越用无状态启发式即可（§4.3 有等价性论证）。

## 1. 业内实现（证据）

### 1.1 Typora（首要对标）

Typora 官方文档 [`support.typora.io/Auto-Pair/`](https://support.typora.io/Auto-Pair/)（2017-08-23 发布，2026-09-06 更新）：

> Open preference panel, and enable **"Auto pair brackets and quotes"** (item 1 in image above) to turn on normal auto pair, which has the **same behavior as most code editors**.
>
> If **"Auto pair common markdown syntax"** is enabled, the auto pair behavior will also be extended to markdown symbols, like `*`, `~`, `` ` ``, or `_`, if "highlight", "inline math", "superscript" is enabled, then auto pair for `=`, `$` and `^` will also be turned on.
>
> Please note that, for `~`, `=` and `^`, **the ending pair will not be inserted automatically**, but when you select a word, and input characters like `=`, then the word will be surrounded by `=` automatically.

| 维度 | Typora 语义 |
|---|---|
| 开关粒度 | 2 个：括号+引号 / Markdown 语法（不是 MarkText 的 3 个） |
| 括号引号档 | 与「大多数代码编辑器」一致：插对、跳越、成对删、选区包裹；**在代码块里同样生效** |
| Markdown 语法档 | `*` `` ` `` `_` `$` → **自动插闭合**；`~` `=` `^` → **不插闭合**，只做选区包裹 |
| 条件依赖 | `=` / `$` / `^` 依赖 highlight / inline math / superscript 开关 |

omd 的差异：`==高亮==`、`$数学$`、`~~删除线~~` 是**常开**语法，`^上标^` 未支持（`2026-08-16-industry-gap-analysis.md:61` 列为后置）。Typora 的「条件依赖」因此退化为「`$`/`=` 恒可用，`^` 不实现」。

**omd 决策（D1）：开关粒度采纳 MarkText 的三项拆分（括号 / 引号 / Markdown 语法），而不是 Typora 的两项。** 中文写作里引号最容易被误配（`don't` → `don't'`、直引号与直角引号混用、粘贴文本已带引号），把引号从括号上解绑后可以单独关掉；MarkText 独立的 `autoPairQuote` 项也验证了这个拆分的真实需求。

### 1.2 MarkText / muya（开源对照，本机可复现）

`/Applications/MarkText.app`（v0.17.x，2022-03-08）对应上游 `marktext/muya`（`git clone --depth 1 https://github.com/marktext/muya.git`）：

- 实现：`packages/core/src/block/base/content.ts` → `Content.autoPair()`（第 280–416 行）
- 配对表：`packages/core/src/config/index.ts:276` `BRACKET_HASH` / `BACK_HASH`
- 默认全开：`config/index.ts:308-310`
- 行为固定测试：`e2e/tests/options/autopair.spec.ts`、`packages/core/src/block/base/__tests__/autoPair.spec.ts`（含 #2960 / #1423 / #715 / #2843 bug 号）

踩过坑的结论（比文档可信）：

1. **插入门控**（#2960）：只有 `postIsNotTouching = !/\S/.test(postInputChar)`（行尾或后接空白）才插闭合，否则 `"|foo` → `""|foo`。覆盖 `"`、`(`、`[`、`{`。
2. `'` 额外要求前一字符不是字母数字（避免 `don't` → `don't'`）。
3. 前一字符是 `\` 时不做任何配对。
4. **Markdown 标记抑制**：`* $ ` ~ _` 仅在非行内数学、非行内代码（#715 / #1423），且前一字符不是 `[a-z0-9]`（#2843）时配对。
5. **跳越（type-over）**、**双向成对删除**（不区分来源）。
6. **组合输入**期间直接 return（#1117 中文）。
7. `**` 中间打空格生成 bullet list 时删掉多余的 `*` —— 即「`*` 在空行会补出 `* *` 被识别成列表项」这个坑，muya 专门加了特例。本设计把它提前到插入门控里解决（规则 2b）。

### 1.3 VS Code（「大多数代码编辑器」的基线）

[`extensions/markdown-basics/language-configuration.json`](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/markdown-basics/language-configuration.json)：

- `autoClosingPairs`（输入即插闭合）只有 `{` `[` `(` `<`（`<` 带 `notIn: ["string"]`）
- `surroundingPairs`（仅包裹）才含 `` ` `` `_` `*` `'` `"` `~` `$`

即 **VS Code 对 Markdown 标记选择「不自动闭合、只做包裹」**，与 Typora/MarkText 直接冲突。这一层没有唯一正确答案，必须由我们显式决策并写进测试（D2）。

### 1.4 CodeMirror 6 `closeBrackets`（我们的运行时里已有的实现）

`@codemirror/autocomplete@6.20.3`（`dist/index.js:1830` 起）：

- 扩展体：`[inputHandler, bracketState]` —— `inputHandler` + 记录「自动插入的闭合符位置」的 `StateField`。
- inputHandler 守卫：`view.composing` / `compositionStarted`、`state.readOnly`、多字符输入、`from/to` 必须等于**主选区**。
- `handleOpen` 门控：`!next || /\s/.test(next) || before.indexOf(next) > -1`，`before = ")]}:;>"`。
- `handleClose`：后接字符就是闭合符**且由本扩展插入**时跳越。
- `deleteBracketPair`（绑 Backspace）：**不查 `bracketState`**，光标夹在配对中间就删两个。
- **多选区**：`handleOpen` 用 `state.changeByRange(...)`，所以每个光标各自插一对；**任一 range 不满足条件就整体放弃**（返回 null，交回默认插入）。这是 `@codemirror/view` 的硬约束：`applyDOMChangeInner` 只调用一次 inputHandler（`facet(...).some(...)`），DOM diff 的 `from/to` 永远是**聚焦（主）range**；返回 true 就 `preventDefault`，被放弃的 range 一个字符都收不到。所以拦截者必须自己用 `changeByRange` 覆盖全部 range。

**我们只要它的语义，不要它的 `bracketState`**：位置跟踪是为了处理 `"""` / `stringPrefixes` 这类字符串前缀；我们的配对表全是单字符、无前缀，跳越用「后接字符相同 + 其后不是词字符」即可等价（§4.3 规则 3 附等价性论证）。它的 `nodeStart` / `probablyInString` 是给编程语言语法树写的启发式，对 Markdown 树不成立。

### 1.5 三家交集与分歧

| 行为 | Typora | muya | VS Code (md) | CM6 closeBrackets |
|---|---|---|---|---|
| `(`/`[`/`{` 插闭合 | ✅ | ✅ | ✅ | ✅ |
| `"`/`'` 插闭合 | ✅ | ✅ | ❌ 仅包裹 | ✅ |
| `*` `` ` `` `_` 插闭合 | ✅ | ✅ | ❌ 仅包裹 | ❌ 无此 token |
| `$` | ✅ | ✅ | ❌ | ❌ |
| `~` `=` | ❌ 只包裹 | ✅ 插闭合 | ❌ 只包裹 | ❌ |
| 跳越 | ✅ | ✅ | ✅ | ✅（仅自己插入的） |
| 成对 Backspace | ✅ | ✅ | ✅ | ✅ |
| 多选区各插一对 | 未知 | 未知 | ✅ | ✅（`changeByRange`） |
| 代码/数学内抑制标记 | 推断 ✅ | ✅ | n/a | n/a |

**交集**：括号/引号插对 + 跳越 + 成对删，全行业一致，omd 必须有。
**分歧**：Markdown 标记是否自动插闭合（`~`/`=` 尤其）→ D2 跟 Typora。

## 2. 为什么不能直接开 `closeBrackets`

1. **token 表不对**：默认表没有 Markdown 标记；加进去会走 `handleSame` 的编程语言逻辑（`nodeStart`、`probablyInString`、`stringPrefixes`）。
2. **上下文模型不对**：我们要的是「`FencedCode`/`InlineCode`/`InlineMath`/`MathBlock`/`FrontMatter` 里抑制 Markdown 标记」，而 CM6 是「猜字符串」；`languageDataAt("closeBrackets")` 等于把 Markdown 语义塞进 language 包，违反「引擎拥有 Markdown 语义」。
3. **与 Live Preview 的 atomic 约束交叠**：Route A 下成对强调标记**无条件折叠**，Backspace 在折叠边界要整原子删除（`skipAtomic`）；`closeBracketsKeymap` 是默认优先级，会和引擎的删除语义抢键。
4. **不可配置粒度**：要按 Typora 暴露开关并热切换（Compartment），它只有一个整体开关。

## 3. 现有代码盘点

| 需要的东西 | 现状 | 位置 |
|---|---|---|
| 扩展装配点 | ✅ 单一入口 | `packages/engine/src/index.ts:106` |
| 输入拦截 | ❌ 引擎内零 `inputHandler` | 新增 |
| 「纯 spec + dispatch 包装」范式 | ✅ | `format/commands.ts` `dispatchSpec()` |
| 树驱动判定先例 | ✅ | `format/blockPrefix.ts`（树不全时放行，不猜结构） |
| 代码节点判定先例 | ✅ | `parse/emojiComplete.ts` `CODE_NODES` + `inCode()` |
| 输入层扩展（守卫/优先级）先例 | ✅ | `parse/emojiComplete.ts` |
| 设置热切换 | ✅ | `Editor.ts:179-187` `spellcheckCompartment` + `setEditorSpellcheck`；`App.tsx:1265-1269` `applySpellcheck` |
| 设置持久化 | ✅ 不透明 JSON，**无需改 Rust** | `apps/desktop/src/settings.ts`；`src-tauri/src/workspace.rs:305-317` |
| i18n | ✅ | `apps/desktop/src/i18n/messages/{en,zh}.ts` |
| 明确禁止项 | ⚠️ 三处 AGENTS 需同步修订 | 根 `AGENTS.md:96`、`packages/engine/AGENTS.md:113`、`apps/desktop/AGENTS.md:71` |

**不复用**：`parse/chars.ts` 的具名常量是给手写 Lezer 解析器判 `cx.char(...)` 数字码用的；配对判定全程是**字符串比较**（`text === "("`），不加常量、不引入仪式。

## 4. 行为规格

### 4.1 三个开关（D1）

```
autoPairBrackets: boolean        // 默认 true   —— () [] {}，含代码块/行内代码/数学/前导元数据内
autoPairQuotes: boolean          // 默认 true   —— " 与 '（' 另有前一字符门控）
autoPairMarkdownSyntax: boolean  // 默认 true   —— * _ ` $（~ = 见 §4.2）
```

三者互相独立：关掉 `quotes` 后 `(` 仍补、`"` 不补。

### 4.2 配对表

| 层 | 输入 | 行为 | 上下文 |
|---|---|---|---|
| **T1 括号**（`brackets`） | `(` `[` `{` | 插闭合，光标居中 | 全部上下文（含代码块/行内代码/数学/前导元数据） |
| **T1 引号**（`quotes`） | `"` | 同上 | 同上 |
| | `'` | 同上；要求前一字符非字母数字 | 同上 |
| **T2 Markdown 标记**（`markdownSyntax`） | `*` `_` `` ` `` `$` | 插闭合，光标居中 | **仅正文**（§4.4） |
| | `~` `=` | **不参与配对**（v1）；D2 的「选区包裹」随 §5 押后项一起上 | — |

`^` 不实现（上标语法未支持）；`<` `>` 不配对（自动链接/HTML 歧义）。

`~`/`=` 不进任何表，意味着手打 `~~删除~~`、`==高亮==` 完全不受本功能影响 —— 这是有意的安全性选择。

### 4.3 四条规则

**规则 1 — 插入（T1/T2 共用）**：光标折叠，且

- 后接字符为空（行尾）/ 空白 / ∈ `CLOSE_BEFORE`；**且**
- 前一字符不是 `\`（转义）；**且**
- `'` 的前一字符不是 `[A-Za-z0-9]`；**且**
- DOM diff 的 `from/to` 等于主选区（`state.selection.main`）

→ 插入 `open+close`，光标落在两者之间，`userEvent: "input.type"`。

`CLOSE_BEFORE`（D8）= CM6 的 `)]}:;>` **加上 CJK 句读与闭符号** `，。、；：！？）】》”’`。理由：omd 是中文优先的编辑器，「在已有句读前插入括号/引号」是日常操作（`这是测试|，` 打 `(` 应得到 `这是测试()，`），而 CM6 的集合是纯 ASCII 的。这是**有意的超集**，必须作为具名常量维护。

**规则 2 — T2 专属抑制**（`*` `_` `` ` `` `$` 的额外门控，T1 不受影响）：

- **2a 前一字符是同一标记 → 不配对。** 与规则 3 配合，让手打的多标记序列收敛：

  | 场景 | 键入 | 没有 2a | 有 2a |
  |---|---|---|---|
  | 手打 `**bold**`（假定**光标前已有正文**：空行行首的第一个 `*` 先被规则 2b 抑制，轨迹随之改变，但结论「2a 不是收敛的原因」不变） | `*` | `*\|*`（规则 1 补对） | 同 |
  | | `*` | 规则 3 跳越 → `**\|` | 同 |
  | | `bold` | `**bold\|` | 同 |
  | | `*` | 规则 1 补对 → `**bold*\|*` | 同 |
  | | `*` | 规则 3 跳越 → `**bold**\|` ✓ | 同 |
  | 连续标记（后面已无自动闭合符） | `*` | `*\|*`（规则 1 补对） | `*\|*` |
  | | `*` | 规则 3 跳越 → `**\|` | 同 |
  | | `*` | 规则 1 **又补一对** → `****` 光标 3 ✗ | 单插 → `***\|` ✓ |

  `**bold**` 一路其实靠规则 3 就能收敛；2a 不可替代的是下面那组：光标后面不再有自动插入的闭合符（行尾/空白前）时，同一个标记的第 n 次输入不能再触发配对，否则 `*` 会不断膨胀。`***` 开头的围栏/粗斜体因此也走得通。

  注：T1 不能套这条 —— `((` 是要嵌套的；引号的重复输入由规则 3 的跳越处理。所以 2a **只对自配对 Markdown 标记生效**。规则 3 只覆盖光标夹在已闭合 `""` 中间、后接 `"` 的形态；光标在已闭合对**之后**（`""|`）时后接为空，规则 1 照常补对，得到四个引号 —— 插入门控的固有结果，2a 不适用，行为不变。

- **2b 光标所在行在光标之前为空（空行行首）→ 不配对，但只对 `*` 与 `$` 生效（D11）。** 这两个是**会破坏块结构**的：
  - `*` 在空行 → 补出 `*|*`，再打空格成 `* *` → Lezer 识别为**无序列表项**（muya 为它专写特例，见 §1.2 第 7 条）；
  - `$` 在空行 → 补出 `$$` → `parse/math.ts` 的 `rest.startsWith("$$")` 命中 **MathBlock**，未闭合时**吞到 EOF**（katex 错误 widget + 原文）。这不是手感问题，是文档被吃掉。

  `` ` `` 与 `_` **不拦**：行首单个反引号无结构风险（三个才成围栏，而连打三个本来就意味着用户要开围栏），`_` 行首也没有块级语义。拦它们会误伤最高频的行首行内代码（`` `npm run build` ``）与行首斜体，收益为负。代价：被抑制的 `*`/`$` 在行首变成「手动闭合」（首字符单插，收尾时仍会按规则 1 补对，可能留下一个多余闭合符，用户删一个即可）—— 记为已知限制，不做标记奇偶配对（那是另一个功能）。

**规则 3 — 跳越（无状态，type-over）**：本次输入字符属于**当前启用**的闭合符集合（按三个开关求并集：`)` `]` `}` `"` `'` + 启用时的 `*` `_` `` ` `` `$`），且后接字符与输入字符相同，且**后接字符的下一个**不是词字符（用 CM6 的 `state.charCategorizer` 判定，其默认正则是 `[\p{Alphabetic}\p{Number}_]`，CJK 正确；不自造字符集）→ 光标右移一格，不插入。

- 为什么不需要 CM6 的位置 StateField：状态法唯一多处理的场景是「用户手打的闭合符紧邻行尾/空白，用户其实想再打一个」，例如 `foo)` 末尾再打 `)`。跳过在这种场景也是用户想要的；会产生差异的场景（后接字符后还有词字符）两种做法结果相同。等价性由 Task 1 的用例固定下来。
- **顺序**：跳过判定**必须先于**插入判定，否则 `*bold*` 的收尾会变成 `*bold**`。
- **候选集合与插入同源（D12）**：逐 range 求候选集时，`isMarker && inVerbatim(state, range.from)` 的标记**不参与跳越**（T1 不受影响）。否则会出现模型不一致：代码块内 `` `x` `` 的光标停在收尾反引号前，用户敲 `` ` `` 会被静默吞掉（光标右移、什么都没插入）—— 而插入路径在同样位置明明把标记当普通字符。跳越与插入必须用同一套「这个字符在当前上下文是不是配对符」的判断。
- **多选区**：同规则 1，用 `changeByRange`，任一 range 不满足即整体放弃（D10）。

**规则 4 — 成对删除**：Backspace，光标折叠且夹在启用表中的一对之间 → 一次删两个，`userEvent: "delete.backward"`；不区分来源（对齐 CM6/muya）。只绑 Backspace（CM6 也没有正向版本）；不适用时返回 false 让位（见 §4.5）。多选区同样走 `changeByRange` + 整体放弃（D10）—— 否则一个不满足条件的光标会让其他光标连普通删除都收不到。

**成对删除刻意不按上下文过滤**（与规则 3 的 D12 不对称，理由明确）：删除是用户主动按键、意图就是「删」，多删一个符合代码编辑器预期（CM6 的 `deleteBracketPair` 同样不看上下文）；而跳越是**吞掉用户输入**，代价方向相反。若删成了非预期结果，一次 Undo 即可回退。

换行两侧不可能撮合出配对：光标在行首时 `head-1` 是 `\n`，在行尾时 `head` 是 `\n`，而 `\n` 永不在配对表中。因此**不需要**额外的「同一行」检查（review 第 5 条的担忧在数据上不成立）；真正需要防的是多选区，已由 D10 覆盖。

### 4.4 抑制集：一个布尔

`inVerbatim(state, pos): boolean`：

1. 若 `!syntaxTreeAvailable(state, pos + 1)`（树还没解析到这里）→ **返回 true**（D9，fail-safe）。
2. 否则沿 `syntaxTree().resolveInner(pos, -1)` 向上，任一祖先是 `InlineCode` / `FencedCode` / `CodeBlock` / `InlineMath` / `MathBlock` / `FrontMatter` → true。

| 结果 | T1 括号/引号 | T2 Markdown 标记 |
|---|---|---|
| false（正文，含表格单元格/引用/列表） | ✅ | ✅ |
| true（代码/数学/前导元数据**或树未就绪**） | ✅ | ❌ |

一句话：**代码型上下文保留括号引号、关掉 Markdown 标记。**

D9 的方向选择：树未就绪时**抑制标记**（而不是放行）—— 少配对只是少个便利，误配对会在代码块里插入用户没要的字符。这也与 `format/blockPrefix.ts` 的既有先例一致（树不全时不猜结构）。**拒绝** review 建议的「行内反引号/缩进行扫描兜底」：那是第二条会与树判定分叉的启发式，且 `syntaxTreeAvailable` 本身是 O(1) 且不触发解析。

`inVerbatim` **只在标记分支被调用**，所以 T1（`(`、`"`）逐键零树查询；`syntaxTreeAvailable` 也不强制解析（`context.isDone`），不违反「禁止 `forceParsing` / `ensureSyntaxTree`」。

### 4.5 守卫

- **IME**：`view.composing || view.compositionStarted` → 直接不配对。
- **readOnly**：inputHandler 不会被调用（CM 层拦截），但 **Backspace 命令必须自查 `state.readOnly`**（`packages/engine/test/readonly-guards.test.ts` 守护）。
- **多字符输入**：`text.length !== 1` → 不配对（粘贴不配对）。
- **多选区（D10）**：插入/跳越/删除三条路径都用 `state.changeByRange`，**任一 range 不满足条件即整体返回 null**。理由见 §1.4：`@codemirror/view` 只调用一次 inputHandler，返回 true 就 `preventDefault`，被放弃的 range 会连普通字符都收不到 —— 那比「退化成单字符」更糟。守卫用 `state.selection.main`（DOM diff 只对应聚焦 range，CM6 自身也这么比）。
- **键位优先级**：Backspace 用 `Prec.high`（否则被 `defaultKeymap` 的 `deleteCharBackward` 吃掉）；不适用时必须 `return false`，让 `skipAtomic` 的折叠标记整原子删除继续工作。
- **undo 分组**：插入 `userEvent: "input.type"`，删除 `"delete.backward"`；必须有一条测试断言「输入 `(` → 一次 Undo 清空」（`()` 是一个事务，不是两个 undo 步）。
- **纯函数契约（多选区安全的前提）**：`autoPairSpec` / `autoPairTypeOverSpec` / `deletePairSpec` 只**返回** `TransactionSpec | null`，绝不 dispatch、不碰 `EditorView`；唯一的 dispatcher 是 `autoPairExtension` 里的适配层。因此「整体放弃」路径在物理上不可能产生局部修改：返回 null → 适配层 `return false` → CM6 默认输入管线为**所有**光标插入裸字符。这一条要有专门用例（断言放弃时 `view.state` 引用恒等未变、`insert` 回调未被调用）。
- **性能**：单次判定 = O(1) 字符检查 + 每个 range 一次 `syntaxTreeAvailable` + 最多一次 `resolveInner` 向上遍历；无全文档扫描，无状态映射。

### 4.6 决策记录

| ID | 决策 | 结论 |
|---|---|---|
| **D1** | 开关粒度 | ✅ 已签署：**三项独立**（`brackets` / `quotes` / `markdownSyntax`，均默认 true） |
| **D2** | `~` / `=` 是否自动插闭合 | ✅ 已签署：**不插**；包裹延后（见 D7） |
| **D3** | 跳越是否跟踪「是否自己插入的」 | ✅ **无状态启发式**（规则 3）。原推荐 CM6 位置 StateField 作废：唯一消费者是跳越，而无状态版在会产生差异的场景下结果相同 |
| D4 | `'` 门控 | 前一字符非字母数字才配对 |
| D5 | 代码块内保留 T1 | ✅ 保留（用户诉求核心） |
| **D7** | v1 是否做选区包裹 | **押后**（块 widget 风险随之押后）。后果：`~`/`=` 在 v1 完全 no-op |
| **D8** | `CLOSE_BEFORE` 是否加 CJK 标点 | ✅ **加**（CM6 集 + `，。、；：！？）】》”’`），中文优先编辑器的日常路径 |
| **D9** | 树未就绪时标记档的默认 | ✅ **抑制**（fail-safe），用 `syntaxTreeAvailable`；拒绝行扫描兜底 |
| **D10** | 多选区语义 | ✅ 三条路径统一 `changeByRange` + **任一 range 不满足即整体放弃**（对齐 CM6 `handleOpen`；否则其他光标丢字符） |
| **D11** | 规则 2b 的适用范围 | ✅ **收窄到 `*` 与 `$`**（有块结构风险的只有这两个）；`` ` `` 与 `_` 行首照常配对 |
| **D12** | 跳越的候选集合是否按上下文过滤 | ✅ **过滤**：`isMarker && inVerbatim` 的标记既不插入也不跳越（与插入同源）。否则代码块内敲 `` ` `` 会被静默吞掉。成对删除**不过滤**（用户主动删除，见规则 4） |

## 5. 非目标 / 押后

- **押后（Task 4，可选）**：选区包裹（含 `~`/`=` 的 wrap-only 语义）、块级 widget 覆盖选区的行为验证。
- 不启用 `indentOnInput`、stock `closeBrackets`、通用 `autocompletion`（三处 AGENTS 禁令不变，只把「引擎自研 Markdown 感知配对」写成例外条款，与 `:` emoji completion 同类）。
- 不做 Smart Punctuation（改写用户字符，与「Preserve source text」冲突）。
- 不做标记奇偶配对（行首被 2b 抑制后收尾可能留一个多余闭合符，属已知限制）。
- 不做 Delete 正向成对删除、`^` 上标、`<>`、`«»`、全角括号配对。
- 不改已排序列表归一化、不改 Enter/Tab 归属。
- 不改 Rust（settings 是不透明 JSON）。

## 6. 验收标准

1. `packages/engine/test/autoPair.test.ts` 覆盖 §4.2–§4.5：配对表逐字符 × 门控（转义 / `'` / 2a / 2b）× 上下文（正文 / 代码 / 数学 / 前导元数据 / **树未就绪**）× 跳越（含启用集合随开关变化 × **上下文过滤 D12**）× 成对删除 × 守卫（IME / readOnly / 多字符 / from-to）。
2. **多选区**：两个光标同时输入 `(` → 两处各得 `()`；其中一个光标位于被 2b 抑制的位置时 → 两处都按普通字符插入（整体放弃），**不出现「一处配对、一处丢字符」**。
3. **整体放弃无副作用**：放弃路径下 `view.state` 引用恒等未变（没有任何局部 dispatch）、`insert` 回调未被调用，裸字符由 CM6 默认管线写给**所有**光标。
4. **代码块内的标记是普通字符（D12）**：在 ``` 围栏内、光标停在收尾反引号前敲 `` ` `` → **正常插入**（不被跳越吞掉）；`$` 同理；同一位置敲 `)` 仍按 T1 跳越。
5. **CJK**：`这是测试|，` 处输入 `(` → `这是测试()，`。
6. **行首**：空行首 `` ` `` 照常配对（行首行内代码可用）；空行首 `*` 与 `$` 不配对，且不会产生列表项 / 不会进入 MathBlock。
7. **undo**：输入 `(` 后一次 Undo → 文档为空。
8. 端到端用例：在围栏代码块里敲 `foo({a: "b"})` 全程零手补。
9. `pnpm test`、`pnpm --filter @omd/desktop test`、`pnpm --filter @omd/desktop build` 全绿。
10. 手工验收（写入 `docs/manual-qa.md`）：正文 `**bold**`、`*italic*`、`` `code` ``、`[链接](url)`、`$x$`、`==高亮==`、`~~删除~~`；空行首 `*`/`$` 不破坏结构；中文 IME 不产生多余闭合符；`(` 后接已有文字不插闭合；Backspace 在空对中删两个；三个开关各自独立；多光标同时输入配对符两处一致 **押后（R6/R11）**：v1 刻意不启用 `EditorState.allowMultipleSelections`，多光标只做防御性覆盖（引擎侧 `changeByRange` + `autoPairView.test.ts`，见 D10/§4.5），宿主开启多选区的当天再恢复该手工项。
11. 折叠回归：`*x*` 输入过程中光标始终可见、继续输入落点正确；折叠标记边界 Backspace 仍整原子删除。
12. 大文档：LARGE/HUGE 档输入无额外卡顿（`@omd/engine bench` typing 项不退化）。

## 7. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **多选区丢字符** | 拦截者返回 true 就 `preventDefault`，未覆盖的 range 收不到任何字符 | D10：`changeByRange` + 整体放弃 + 专门用例 |
| 抢键导致原子删除失效 | `Prec.high` Backspace 不适配时未让位 | 显式 `return false` + 专用回归用例 |
| 空行 `*` / `$` | 列表项、MathBlock 吞到 EOF | 规则 2b（收窄到这两个）+ e2e 断言 |
| 行首被抑制后的多余闭合符 | `$E=mc^2$` 收尾时按规则 1 补出一对 | 已知限制（§5），用户删一个字符 |
| 跳越启发式的假跳过 | 手打闭合符紧邻行尾/空白时被跳过 | 可接受（§4.3 规则 3）；出现真实抱怨再升级为位置 StateField |
| **跳越吞掉代码内的标记输入** | 候选集合若不带上下文过滤，代码块内 `` `x` `` 前敲 `` ` `` 会被静默右移 | D12：跳越与插入共用「这个字符在当前上下文是不是配对符」的判断 + 专用用例 |
| 树未就绪 | 大文档刚打开/刚粘贴时上下文不可知 | D9 fail-safe 抑制 + `syntaxTreeAvailable` 用例 |
| 与 emoji `:` completion | `:` 不在配对表内 | 各来一条测试 |
| 表格单元格内联编辑器 | `TableWidget` 内联编辑器是**独立 view**，不走外层 inputHandler | 记录为已知限制（本轮不做） |
| 设置默认值从无到有 | 老 `settings.json` 无 `autoPair` 字段 | `sanitizeSettings` 必须显式给三键 `true` |

## 8. 文档影响（实现时同批完成）

- 根 `AGENTS.md`、`packages/engine/AGENTS.md`、`apps/desktop/AGENTS.md`：禁止项改为「不得启用 **stock** `closeBrackets`；Markdown 感知配对是引擎自研例外（`format/autoPair.ts`），不得在 `createEditor` 侧另加一套」。
- `docs/memory/gotchas-engine.md` + `docs/memory/known-gotchas.md` 索引：① 跳越必须先于插入判定；② 配对 Backspace 不适配时必须让位 `skipAtomic`；③ 空行首 `*`/`$` 会变列表项/MathBlock（规则 2b）；④ **`EditorView.inputHandler` 一旦拦截就 `preventDefault`，必须用 `changeByRange` 覆盖全部选区，否则多光标丢字符**；⑤ 树未就绪时 `resolveInner` 会返回错误的祖先节点（D9）。
- `docs/manual-qa.md`：自动配对验收块（正文/代码块/数学/前导元数据/空行 `*`&`$`/CJK 标点前/多光标（押后 R6/R11，见验收 10）/IME/三个开关独立/undo）。
- README 与 `docs/guides/`：**不在本计划内** —— README 按仓库规矩是发版时更新，自动配对也不是快捷键。
