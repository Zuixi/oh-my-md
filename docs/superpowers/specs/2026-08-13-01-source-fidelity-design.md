# 有序列表自动规范化安全设计

**日期：** 2026-08-13  
**状态：** 待用户审核  
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

保留 Live Preview 自动规范化有序列表编号的现有产品行为，同时确保由“打开文档”或“进入 Live Preview”触发的源码改动：

1. 对用户可见。
2. 会让文档进入 dirty 状态。
3. 不会未经确认被自动保存到原文件。
4. 可以在不丢失后续编辑的前提下拒绝。
5. 用户拒绝后，本次打开期间不再自动规范化该文档。

## 已批准的产品决策

- Live Preview 继续把 `1. / 3. / 7.` 自动规范化为 `1. / 2. / 3.`。
- 由用户编辑列表直接引发的后续编号规范化属于该次编辑的一部分，继续参与普通自动保存，不显示额外提示。
- 仅在加载文档、重置 EditorState 或从 Source 进入 Live Preview 时发生的规范化进入“待确认”状态。
- 待确认状态标记 dirty，并暂停该文档的自动保存。
- UI 使用非模态提示条，不抢走编辑器焦点。
- 提示条提供“保存规范化”和“保留原编号”两个操作。
- “保留原编号”只对当前文档本次打开有效；关闭并重新打开后恢复自动规范化策略。
- Pending 与“本次打开不再规范化”的 suppression 状态跨 Source/Live 模式切换保留。
- Pending 存在时切到 Source，提示条继续显示；回到 Live 后新增的 preview-entry 变换合并到原 pending。
- 自动规范化设置暂不做持久化偏好。

## 非目标

- 不改变连续编号算法、起始编号或 `.` / `)` 分隔符规则。
- 不实现磁盘 fingerprint、CAS 保存或三方冲突处理；这些属于 02 Conflict-Safe Save。
- 不重做恢复目录与恢复中心；这些属于 03 Recovery and Shutdown。
- 不为用户增加全局“关闭自动规范化”设置。
- 不把有序列表解析或变换逻辑移到 Desktop 或 Rust。
- 不拆分完整的 `App.tsx` 文档 controller；只提取本规格直接需要的纯状态逻辑。

## 当前行为与证据

### Engine

`packages/engine/src/lists/ordered.ts` 当前：

- `orderedRenumberChanges` 遍历 Lezer `OrderedList`，根据首项编号生成连续 marker。
- `orderedRenumber` 在 ViewPlugin 构造后排入 microtask，因此打开 Live Preview 文档会立即改写源码。
- 更新 transaction 带私有 `orderedRenumberAnn`，并使用 `Transaction.addToHistory.of(false)`。
- 插件不会向 Desktop 暴露“本次 doc change 是自动规范化”或“用户尚未确认”的状态。

### Desktop

`apps/desktop/src/Editor.ts` 当前只把变更后的完整字符串传给：

```ts
onDocChanged: (doc: string) => void
```

`apps/desktop/src/App.tsx` 对所有文档变更执行相同逻辑：

- 更新 React/doc refs。
- 立即写恢复稿。
- 只要文档有路径且 dirty，约 1.5 秒后自动保存。

因此，打开含跳号列表的文件会变 dirty，并可能在用户没有主动编辑或确认时自动落盘。

### 已有测试

`packages/engine/test/ordered-renumber.test.ts` 已覆盖：

- 从首项开始连续编号。
- 嵌套列表独立编号。
- 保留 `)` 分隔符。
- Live Preview 写回源码。
- Source 模式不改写。

这些行为继续保留；本规格补充来源、确认、拒绝和自动保存边界。

## 用户流程

### 流程 A：打开含跳号列表的文件

1. Rust/desktop 读取原文并建立 saved baseline。
2. Desktop 用原文创建新的 EditorState。
3. Live Preview 插件检测需要规范化的 marker，并改写编辑器文档。
4. Engine 建立一条 pending normalization 记录。
5. Desktop 收到文档和 pending 状态，显示 dirty。
6. Desktop 继续写 recovery，但不启动该文档的 autosave timer。
7. 编辑器保持焦点；界面显示非模态提示条：
   - 主文案：`Ordered list numbers were normalized.`
   - 操作：`Save normalization`
   - 操作：`Keep original numbers`

### 流程 B：保存规范化

1. 用户点击 `Save normalization`，或在 pending 状态按 `Cmd+S`。
2. Desktop 捕获当前文档快照并调用现有保存队列。
3. 保存成功后：
   - Engine 清除对应 pending 记录。
   - saved baseline 更新为实际写入的快照。
   - 若保存期间没有继续编辑，dirty 变为 false。
   - 若保存期间继续编辑，dirty 保持 true，后续普通 autosave 可恢复。
   - 提示条消失。
4. 保存失败或 Save As 取消时：
   - pending 记录保留。
   - dirty 保留。
   - autosave 继续暂停。
   - 提示条恢复可操作状态。

### 流程 C：保留原编号

1. 用户点击 `Keep original numbers`。
2. Engine 只恢复仍保持自动规范化结果的 marker。
3. 如果用户已经手动修改某个受影响 marker，该 marker 不被覆盖，并计入 skipped 数量。
4. 普通正文、选择和点击提示前发生的后续编辑全部保留。
5. Engine 清除 pending 记录，并禁止当前 EditorState 生命周期继续自动规范化。
6. 如果拒绝后文档等于 saved baseline，dirty 变为 false。
7. 如果还有其他用户编辑，dirty 保持 true，并恢复普通 autosave。
8. 如果存在 skipped marker，Desktop 显示友好通知：
   - `Original numbers were restored where they were unchanged.`

### 流程 D：用户主动编辑列表

1. 用户在已打开的 Live Preview 文档中新增、删除或修改列表项。
2. 插件按照现有规则自动规范化编号。
3. 该规范化不创建 pending 提示，因为它由用户 doc transaction 触发。
4. 文档按普通 dirty、recovery 和 autosave 规则处理。

### 流程 E：进入 Source 模式再返回

1. Source 模式不执行规范化。
2. 已存在 pending 时切到 Source，pending 与提示条继续保留。
3. 返回 Live Preview 后，如果当前源码产生新的 preview-entry 规范化，新 marker 合并到原 pending，id 保持不变。
4. 如果用户此前已选择保留原编号，suppression 跨模式切换保留；返回 Live 后不规范化、不创建 pending。
5. 没有 pending 或 suppression 时返回 Live，如果源码需要规范化，则创建新的 pending。

## Engine 设计

### Pending 状态

引擎新增私有 StateField，记录当前 EditorState 生命周期中的规范化确认状态和是否已被用户拒绝。

该 StateField 必须挂载在 `editorExtensions()` 顶层、位于 Live Preview compartment 之外：

- Source 模式只卸载 ordered-renumber ViewPlugin 和 preview decorations。
- Pending、可逆 marker 和 suppression 跨 Source/Live 切换保留。
- 所有内部读取使用 `state.field(field, false)`，字段缺失时安全返回无 pending。

对 Desktop 暴露以下只读类型与命令：

```ts
declare const normalizationIdBrand: unique symbol

export type NormalizationId = number & {
  readonly [normalizationIdBrand]: "NormalizationId"
}

export interface OrderedListNormalizationNotice {
  readonly id: NormalizationId
  readonly markerCount: number
}

export type OrderedListNormalizationAcceptResult =
  | {
      readonly kind: "accepted"
      readonly transaction: TransactionSpec
    }
  | {
      readonly kind: "stale"
    }

export type OrderedListNormalizationRejectResult =
  | {
      readonly kind: "reverted"
      readonly transaction: TransactionSpec
      readonly restoredMarkers: number
      readonly skippedMarkers: number
    }
  | {
      readonly kind: "stale"
    }

export function getPendingOrderedListNormalization(
  state: EditorState,
): OrderedListNormalizationNotice | null

export function acceptOrderedListNormalization(
  state: EditorState,
  id: NormalizationId,
): OrderedListNormalizationAcceptResult

export function rejectOrderedListNormalization(
  state: EditorState,
  id: NormalizationId,
): OrderedListNormalizationRejectResult
```

接口约束：

- `id` 是不透明类型，只在当前 EditorState 生命周期内有效。
- accept/reject 返回纯 `TransactionSpec`，由 Desktop 对目标 EditorView dispatch；函数自身不持有或调用 EditorView。
- `accepted` transaction 只清除匹配 id 的 pending 状态，不写磁盘。
- `reverted` transaction 在一次 dispatch 中恢复 marker、清除 pending 并启用 session-local suppression。
- stale id 返回 `{ kind: "stale" }`，不得修改文档。
- Desktop 收到 stale 后立即以 `getPendingOrderedListNormalization(view.state)` 重新同步该标签的 UI 投影，不能让 banner 卡死。
- 对每次成功 reject，运行时必须保证：

```ts
restoredMarkers + skippedMarkers === notice.markerCount
```

- Desktop 不读取私有 annotation、StateEffect 或 marker ranges。

### Pending 合并规则

同一个 EditorState 在用户确认前可能因 Lezer 增量解析产生多批 preview-entry 规范化。所有批次合并到一条 pending：

- 第一批创建新的 `NormalizationId`。
- 后续批次保留该 id。
- 新 marker 追加到可逆记录。
- 同一已映射 marker 被再次改写时，保留第一次记录的 `original`，把 `normalized` 更新为最后一次写入值，且不重复增加 `markerCount`。
- `markerCount` 是当前可逆记录总数，不是最后一批数量。
- Banner 不因增量解析生成新 id 或闪烁。
- accept/reject 始终解决该 id 下的全部批次。

如果 pending 已存在，用户在 Source 模式手动改回跳号后返回 Live，由此产生的新变换也按上述规则并入同一 pending。

### 自动变换分类

ViewPlugin 维护 `hasUserDocChange`：

- 插件构造后、第一条非规范化 doc transaction 之前执行的变换属于 preview-entry。
- `applyToggle` 从 Source 重新挂载 Live Preview 扩展时，新插件实例的第一次变换同样属于 preview-entry。
- 第一条用户或宿主 doc transaction 之后执行的变换属于 user-followup。
- 只有 preview-entry 创建或扩展 pending 状态。
- 规范化自身 transaction 不得把 `hasUserDocChange` 设为 true。
- StateField 已 suppression 时，`apply()` 必须在遍历 Lezer tree 前立即返回。
- `view.composing` 时继续跳过规范化，避免破坏 IME。

### 可逆 marker 记录

Pending StateField 为每个被改写 marker 保存：

```ts
interface ReversibleOrderedMarker {
  readonly from: number
  readonly to: number
  readonly original: string
  readonly normalized: string
}
```

StateField 必须：

- 规范化 annotation 保存旧文档坐标中的 `original` 与 `normalized`。
- StateField 处理规范化 transaction 时，通过 `tr.changes.iterChanges` 的 `fromB/toB` 取得新文档坐标；不能假定 replacement 前后长度相同。
- 通过每个后续 transaction 的 `ChangeDesc` 映射已有 marker 范围。
- 多批规范化时先映射已有记录，再把本批 `fromB/toB` 记录合并进去。
- 在拒绝时仅当映射后范围内容仍等于 `normalized` 才恢复 `original`。
- 内容已被用户修改时跳过该 marker，绝不覆盖用户输入。
- 普通编辑不能清空 pending；只有 accept、reject 或新的 EditorState 生命周期可以清空。
- reject 后设置 session-local suppression；该 StateField 生命周期内不再生成编号变换。
- 新建或重置 EditorState 会清除 suppression，恢复默认自动规范化。

### History 规则

- 自动规范化继续不进入 undo history。
- reject 产生的 marker 恢复也不进入 undo history。
- 用户在提示出现前后的普通编辑继续进入正常 undo history。
- reject 不得通过反复执行 `undo` 实现，因为这会误撤销用户编辑。

## Desktop 设计

### Editor 更新接口

`CreateEditorOptions` 将：

```ts
onDocChanged: (doc: string) => void
```

替换为：

```ts
export interface EditorDocumentUpdate {
  readonly tabId: number
  readonly documentId: number
  readonly doc: string
  readonly docChanged: boolean
  readonly pendingNormalization: OrderedListNormalizationNotice | null
}

onDocumentUpdate: (update: EditorDocumentUpdate) => void
```

`editorOptions(contents, tabId, documentId)` 必须把 `tabId` 与明确传入的 `documentId` 绑定到 EditorView callback。后台 EditorView 不得通过 `sessionRef.current` 猜测自己的标签或文档身份。

所有 reset 路径使用统一顺序：

1. 先从目标 tab 计算 documentId 已递增的新 session。
2. 通过按 tab 更新函数提交新 session。
3. 清除目标 tab 的旧 normalization UI 投影。
4. 使用新 documentId 构造 `editorOptions`。
5. 调用 `resetEditorDocument`。
6. 同步新文档内容。

不得沿用当前“先 reset、后 `openSession` 递增 documentId”的顺序，否则 preview-entry microtask 会被误判为 stale。

`session.ts` 为不改变 path/saved baseline 的恢复场景提供：

```ts
export function advanceDocumentIdentity(session: EditorSession): EditorSession
```

该纯函数只返回 `{ ...session, documentId: session.documentId + 1 }`。打开文件与外部重载继续使用 `openSession`；恢复草稿先使用 `advanceDocumentIdentity` 再 reset。

`EditorView.updateListener` 在以下任一条件成立时调用：

- `update.docChanged`。
- pending notice 的 id 在 start/end state 之间发生变化。
- 同一 pending id 的 `markerCount` 发生变化。

所有 desktop 测试 mock 必须同步新签名。

处理 callback 时：

- `docChanged === true` 才同步 doc、dirty 和 recovery。
- `docChanged === false` 的纯 pending 更新只刷新 UI 投影，不重复写 recovery。

### 每标签 UI 投影

Engine StateField 是 pending 的唯一事实来源。Desktop 只维护用于 React 渲染和调度的瞬态、按标签投影，不把 pending id 混入可持久化的 `EditorSession`。

```ts
export type NormalizationAction = "idle" | "saving" | "reverting"

export interface TabNormalizationState {
  readonly notice: OrderedListNormalizationNotice
  readonly action: NormalizationAction
}

export type NormalizationByTab = Readonly<
  Record<number, TabNormalizationState | undefined>
>

export function projectNormalizationNotice(
  state: NormalizationByTab,
  tabId: number,
  notice: OrderedListNormalizationNotice | null,
): NormalizationByTab

export function setNormalizationAction(
  state: NormalizationByTab,
  tabId: number,
  expectedId: NormalizationId,
  action: Exclude<NormalizationAction, "idle">,
): NormalizationByTab

export function resyncNormalizationIdle(
  state: NormalizationByTab,
  tabId: number,
  freshNotice: OrderedListNormalizationNotice | null,
): NormalizationByTab

export function clearTabNormalization(
  state: NormalizationByTab,
  tabId: number,
): NormalizationByTab
```

要求：

- 新增 `apps/desktop/src/normalizationState.ts`，用纯函数新增、更新和移除标签投影。
- App 不得直接 spread 或 mutate `NormalizationByTab`；所有转换必须经过上述纯函数。
- `projectNormalizationNotice` 更新 notice 时保留当前 action；notice 为 null 时删除该 tab。
- `setNormalizationAction` 只有在 tab/id 匹配且当前 action 为 idle 时才转换，否则返回原 state。
- `resyncNormalizationIdle` 必须同时写入 fresh notice 与 idle；fresh notice 为 null 时删除该 tab，不能保留过期 markerCount。
- `onDocumentUpdate` 只更新 `update.tabId` 对应项，不调用只面向活动标签的 `commitSession` / `replaceActive`。
- `update.documentId` 与 workspace 中该 tab 当前 documentId 不匹配时忽略整个 update。
- pending 变为 `null` 时删除对应 tab 投影。
- 关闭标签时删除对应投影。
- 后台标签不显示 banner；切回该标签时显示其 pending banner，并一直暂停该标签 autosave。
- 每次调用 `resetEditorDocument` 前清理目标 tab 的 UI 投影；`openPath`、`checkExternal` 和 `restoreDraft` 都必须通过同一 reset helper。
- reset 后的新 EditorState 可以通过后续 `onDocumentUpdate` 建立新的 pending，不沿用旧 id。

`workspace.ts` 新增按标签替换 session、但不改变 activeId 的纯函数：

```ts
export function replaceTabSession(
  workspace: Workspace,
  session: EditorSession,
): Workspace
```

目标 tab 不存在时返回原 workspace。`replaceActive` 继续只服务明确针对活动标签的同步操作。

### Autosave

保存入口显式区分来源：

```ts
export type SaveTrigger = "autosave" | "explicit"

function saveFile(tabId: number, trigger: SaveTrigger): Promise<void>
```

规则：

- pending 时继续写 recovery，因为 recovery 不覆盖源文件。
- `trigger === "autosave"` 且该 tab 有 pending 时，在保存入口直接返回，不进入 save queue。
- autosave effect 的依赖包含活动 tab 的 pending id；pending 在 timer 建立后出现时必须清除旧 timer。
- `Cmd+S` 和提示条的保存按钮仍可显式保存。
- 显式保存捕获 `tabId`、`documentId`、目标 EditorView、pending id 和文档快照。
- 显式保存成功后，只有目标 tab 仍存在，且捕获的 documentId、EditorView 和 pending id 仍匹配时才 dispatch accept transaction。
- 保存成功后的 session baseline 必须按 `tabId` 更新；不得依赖当前活动标签或 `viewRef.current === savedView`。
- 保存失败、取消、切换文档或 stale completion 不得清除 pending。
- 切换标签不取消已经开始的磁盘写入；completion 只更新原 tab/documentId。

02 Conflict-Safe Save 将复用 `SaveTrigger` 与“按 tab/documentId 更新 completion”的规则，并在此基础上加入 fingerprint/CAS。

异步规范化操作统一捕获：

```ts
interface NormalizationOperationCapture {
  readonly tabId: number
  readonly documentId: number
  readonly view: EditorView
  readonly normalizationId: NormalizationId
}
```

accept/reject 生成的 `TransactionSpec` 只能 dispatch 到 `capture.view`。dispatch 前必须确认：

- workspace 中仍存在 `capture.tabId`。
- 该 tab 当前 documentId 等于 capture 值。
- `viewsRef.get(capture.tabId) === capture.view`。
- Engine 当前 pending id 等于 capture.normalizationId。

任一条件不满足时不 dispatch，并用目标 tab 当前 EditorView（若仍存在）重新同步 UI 投影。

### 提示组件

新增独立 `NormalizationBanner`：

```ts
export interface NormalizationBannerProps {
  readonly markerCount: number
  readonly busy: boolean
  readonly onSave: () => void
  readonly onKeepOriginal: () => void
}
```

要求：

- 只为当前活动标签的 pending notice 渲染。
- 非模态，不在出现时移动焦点。
- 使用原生 `<button type="button">`。
- `busy` 时禁用两个动作，避免保存与拒绝并发。
- 容器使用 `role="status"`，文案包含受影响 marker 数量。
- 键盘 Tab 可到达两个按钮，焦点样式清晰。
- 保存成功或拒绝完成后，焦点回到 EditorView。
- 关闭或切换标签时不把焦点落到隐藏元素。

`busy` 来自当前 tab 的 `TabNormalizationState.action`：

- 初始为 `idle`。
- 显式保存入队前设为 `saving`。
- reject transaction dispatch 前设为 `reverting`。
- 保存失败、Save As 取消或 stale 后恢复为 `idle` 并重新同步 Engine notice。
- accept/reject 成功且 Engine pending 变为 `null` 后删除整个 tab 投影。

### 状态栏

`StatusBar` 新增：

```ts
normalizationReviewRequired: boolean
```

为 true 时渲染独立 `<span>Normalization review required</span>`。现有 path 与 dirty `•` 必须继续位于同一 text node，不能破坏 session 测试与 VoiceOver 的文件状态朗读。

### 并发规则

- 同一 pending id 的保存和拒绝操作必须串行。
- 保存 Promise 进行中时，`Keep original numbers` 禁用。
- reject 开始后，不再允许同一 id 发起保存。
- 切换标签不会取消磁盘保存，但 completion 只能更新原 tab/documentId。
- 如果保存期间用户继续编辑，保存成功只更新 captured snapshot baseline；后续编辑保持 dirty。
- Engine accept/reject 的 transaction 只能 dispatch 到捕获的目标 EditorView。
- 非活动 EditorView 的 microtask update 只能更新自身 tab；不得改写 active session。

### Reset、恢复与外部变化

- `openPath`、外部磁盘重载和 crash draft restore 每次重置 EditorState 前都清除目标 tab 的 UI 投影。
- Pending 期间检测到外部磁盘变化时沿用当前 dirty 冲突提示：
  - 用户选择加载磁盘版本：reset EditorState，清除旧 pending，由新磁盘内容决定是否创建新 pending。
  - 用户选择保留内存版本：保留 pending，继续暂停 autosave。
- 仅由 normalization 造成 dirty 时关闭标签，继续使用普通未保存确认；不静默放弃。
- 当前 recovery 记录只保存正文，不保存 pending 元数据；恢复草稿会进入无路径的 untitled 会话，必须通过显式 Save As 才能写盘。
- 03 Recovery and Shutdown 若恢复原路径，必须同时持久化“需要 normalization review”状态，或恢复后继续阻止该路径自动保存。

## 错误处理

- Engine accept/reject 收到 stale id：不显示错误；Desktop 从目标 EditorView 重新读取 notice 并修复该 tab 的 UI 投影。
- reject 返回 `skippedMarkers > 0`：使用非阻塞通知说明只恢复了未被继续编辑的 marker。
- Engine transaction 抛错：通过现有 `onError` 报告，保留当前文档和 pending 状态。
- 保存失败：沿用用户友好的 `Save failed` 消息，日志保留底层错误；提示条不消失。
- Save As 取消：属于正常取消，不报错、不清 pending。
- 不允许用 `catch {}` 吞掉规范化处理错误。

## 安全与数据完整性

- 本规格不允许任何自动规范化绕过 dirty baseline。
- recovery 可以包含规范化后的内存文档，但源文件自动保存必须暂停。
- 当前无路径 recovery restore 不携带 pending 元数据，必须经过显式 Save As；03 在恢复原路径前必须补齐 review 元数据。
- reject 只修改有 engine 记录且仍匹配 normalized 文本的 marker。
- 不以全文 saved baseline 覆盖 EditorView 来实现 reject。
- 不允许拒绝操作丢失提示出现后的正文编辑、选择或 undo history。

## 无障碍要求

- 提示条出现时通过 `role="status"` 宣读一次，不使用打断性 `alert`。
- 两个动作具有完整可访问名称，不能只显示图标。
- 操作顺序为说明文本、保存、保留原编号。
- pending 状态除视觉 banner 外，也在状态栏保存状态中体现为 `Normalization review required`。
- 明暗主题均需清晰区分提示区域，正文和按钮文字满足 WCAG 2.2 AA 对比度。

## 性能约束

- 连续列表计算继续使用现有 Lezer tree，不引入第二套 Markdown parser。
- pending marker 映射只处理本次自动规范化影响的 marker。
- 普通无序列表、连续有序列表和 Source 模式不得创建 pending 数据。
- Desktop 不因读取 pending 状态额外执行全文 parse。

## 预期文件变更

### Engine

- Modify: `packages/engine/src/lists/ordered.ts`
- Modify: `packages/engine/src/index.ts`
- Modify: `packages/engine/test/ordered-renumber.test.ts`
- Modify: `packages/engine/test/view.test.ts`

### Desktop

- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/src/session.ts`
- Modify: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/NormalizationBanner.tsx`
- Create: `apps/desktop/src/normalizationState.ts`
- Modify: `apps/desktop/src/workspace.ts`
- Modify: `apps/desktop/src/StatusBar.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/Editor.test.ts`
- Create: `apps/desktop/test/NormalizationBanner.test.tsx`
- Create: `apps/desktop/test/normalizationState.test.ts`
- Modify: `apps/desktop/test/session.test.ts`
- Modify: `apps/desktop/test/workspace.test.ts`

### Documentation

- Modify: `apps/desktop/AGENTS.md`
- Modify: `packages/engine/AGENTS.md`
- Modify: `docs/manual-qa.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 自动化测试矩阵

### Engine 单元与 EditorView 测试

1. preview-entry 规范化创建 pending notice，并报告正确 markerCount。
2. 连续编号不创建 pending notice。
3. Source 模式不改文档、不创建 pending。
4. 已有 pending 切到 Source 时 notice 与 id 保留。
5. Source 返回 Live 后的新 preview-entry 变换合并到原 id。
6. 两批增量解析产生的 marker 共用一个 id，reject 能全部还原。
7. 同一 marker 在第二批被再次改写时保留首次 original、更新最新 normalized，reject 回到用户最初源码。
8. 用户 doc transaction 后触发的规范化不创建 pending。
9. accept 匹配 id 时返回可 dispatch transaction，清 pending 且不改文档。
10. accept/reject stale id 返回 discriminated stale 结果且不修改状态。
11. reject 恢复所有未变化 marker，并保留普通正文编辑。
12. reject 跳过已被用户再次修改的 marker。
13. reject 后跨 Source/Live 切换仍保持 suppression。
14. 新 EditorState 恢复默认自动规范化。
15. pending ranges 经前置、内部和后置插入后仍能正确映射。
16. `10.` 变成更短 marker 时使用新文档坐标，reject 不破坏相邻文本。
17. reject 后 undo 不会恢复自动规范化结果，也不丢用户编辑。
18. reject 后源码保留跳号，但预览 marker 仍显示连续编号。
19. composing 期间不规范化。
20. 真实 EditorView exception sink 保持为空。

### Desktop 状态测试

1. pending update 使已打开文档显示 dirty 和提示条。
2. callback 携带创建时绑定的 tabId/documentId，而不是当前活动标签。
3. reset helper 先递增并提交 documentId，再用新 id reset；打开文件的 preview-entry update 不会被误判 stale。
4. 后台 EditorView 的 microtask update 只更新自己的 tab。
5. `advanceDocumentIdentity` 只递增 documentId，不改变 path 或 savedContents。
6. `replaceTabSession` 更新指定 tab baseline 且不改变 activeId。
7. `normalizationState` 纯函数拒绝 stale id/action，并在 resync 时原子更新 notice 与 idle。
8. `docChanged === false` 的纯 pending update 不调用 `writeRecovery`。
9. pending 时 fake timer 前进不会调用 `writeFile`。
10. timer 建立后收到 pending 会取消该 timer。
11. pending 文档发生真实 doc change 时仍调用 `writeRecovery`。
12. 点击保存调用现有保存队列；成功后提示消失。
13. `Cmd+S` 与提示保存使用同一显式保存语义。
14. 保存期间切换标签不会取消磁盘写入，completion 只更新原 tab。
15. accept/reject transaction 只 dispatch 到捕获并重新验证过的目标 view。
16. 保存失败后提示、dirty 和 autosave pause 保留。
17. Save As 取消不清 pending。
18. 点击保留原编号调用 engine reject transaction，并在完成后聚焦编辑器。
19. reject 后若只存在规范化改动，dirty 变 clean。
20. reject 后若存在其他编辑，dirty 保持且 autosave 恢复。
21. 两个标签的 pending 状态互不覆盖。
22. 同 id markerCount 增加时 banner 更新但 action 保持正确。
23. 保存过程中两个 banner 按钮禁用；失败后用 fresh notice 恢复 idle。
24. stale accept/reject 会从 Engine 重新同步，不留下卡死 banner。
25. stale 保存 completion 不清除另一个文档或标签的 pending。
26. openPath、外部重载和 restoreDraft reset 都先清除旧 tab 投影。
27. pending 时外部变化选择“加载磁盘”会清旧 pending，选择“保留我的”会保留 pending。
28. pending-only dirty 关闭标签仍触发未保存确认。
29. StatusBar 的 review 文案独立于 path + dirty text node。
30. 所有 Editor mock 使用 `onDocumentUpdate` 新签名。

## 验证命令

```sh
pnpm --filter @omd/engine test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
git diff --check
```

本规格不修改 Rust，不要求 Cargo 测试。

## 手动 QA

在 `docs/manual-qa.md` 增加并执行：

1. 打开 `1. / 3. / 7.` 文档后显示规范化内容、dirty 和提示条。
2. 等待超过 autosave 时长，原文件仍保持跳号。
3. 点击保存规范化后，磁盘变为连续编号且提示消失。
4. 点击保留原编号后，磁盘和编辑器恢复跳号。
5. 提示出现后先编辑正文，再保留原编号；正文编辑不丢。
6. 提示出现后修改一个编号，再保留原编号；手动编号不被覆盖。
7. 保留原编号后继续编辑当前文件，并来回切换 Source/Live，均不再自动规范化。
8. 关闭重开后自动规范化策略恢复。
9. Pending 时切到 Source，提示仍在；返回 Live 后 id 不变，新 marker 合并。
10. 没有 pending 时从 Source 返回 Live，若发生规范化则出现待确认提示。
11. Pending 时外部修改文件，分别验证“加载磁盘”和“保留我的”。
12. 仅规范化造成 dirty 时关闭标签，仍会得到未保存确认。
13. 中文输入法合成期间不触发编号改写。
14. 多标签切换后提示属于正确标签；后台 pending 标签切回时显示提示。
15. 仅键盘可完成保存/保留操作，VoiceOver 能朗读状态与按钮。

## 文档更新

- `packages/engine/AGENTS.md`：记录 pending normalization 公共接口和 session-local suppression。
- `apps/desktop/AGENTS.md`：记录 pending 时 autosave 暂停、显式保存接受规范化。
- `docs/memory/known-gotchas.md`：替换“打开会直接自动保存”的旧假设，记录待确认流程。
- `docs/manual-qa.md`：更新有序列表行为和新增提示条验收项。
- 父设计文档的数据流补充“自动源码规范化确认”分支，保留自动编号产品决策。

## 对后续规格提供的稳定接口

02 Conflict-Safe Save 可以依赖：

- pending 时禁止 autosave、显式保存成功后 accept 的规则。
- `EditorDocumentUpdate` 中稳定的 tabId/documentId。
- `NormalizationByTab` 与 `SaveTrigger`。
- `getPendingOrderedListNormalization`、`acceptOrderedListNormalization` 和 `rejectOrderedListNormalization`。
- 保存失败不得清除 pending 的不变量。

03 Recovery and Shutdown 可以依赖：

- recovery 在 pending 状态仍持续保存内存文档。
- 关闭/退出时 pending 文档按普通 dirty 文档处理，不允许静默放弃。

12 Accessibility 可以依赖：

- `NormalizationBanner` 使用原生按钮、`role="status"` 和稳定焦点恢复行为。

## 完成定义

本规格实现只有在以下条件全部满足时才完成：

- 自动化测试矩阵中的行为均有测试并通过。
- Engine、desktop test 和 desktop build 通过。
- pending 状态不会触发源文件 autosave。
- accept/reject 不会覆盖保存期间或提示期间的后续编辑。
- 多标签状态隔离通过自动化与手动验证。
- 键盘和 VoiceOver 手动 QA 通过。
- 所列 AGENTS、known-gotchas、manual QA 和父设计文档同步更新。
