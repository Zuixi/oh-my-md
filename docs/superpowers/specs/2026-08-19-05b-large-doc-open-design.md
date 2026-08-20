rge Document Open 设计

**日期：** 2026-08-19  
**状态：** 已落地（P0 止血 + P1 分档/lazy + P2 流式/只读；实现偏差见 §14）  
**父设计：** [`2026-08-13-05-large-document-performance-design.md`](./2026-08-13-05-large-document-performance-design.md)（§10 05a 覆盖逐键路径；本规格覆盖**冷打开**路径）  
**路线图：** [`2026-08-13-00-product-roadmap-design.md`](./2026-08-13-00-product-roadmap-design.md) Phase A-05 增补  
**触发：** 实测 50MB 级 Markdown 打开长时间无响应；05/05a 基准与优化均未覆盖「打开-可输入」预算

---

## 1. 目标与非目标

### 目标

1. 为**冷打开**建立可复现基准与预算（与 05 的逐键预算并列），覆盖 10MB / 20MB / 50MB 三档 UTF-8 样本。
2. 消除打开路径上的 **O(doc) 主线程同步工作** 与 **不必要的字符串副本**（与 05a「CM Text 为编辑真相源」对齐，扩展到打开阶段）。
3. 打开过程**可感知、可取消**：用户始终看到进度或 loading，不出现「假死」。
4. 超大文件（字节或行数超阈）进入**可预测的降级策略**（安全模式、确认框、硬上限），与现有 `SAFE_MODE_LINES` 语义一致并补**字节维度**。
5. 会话恢复与多标签：**非激活标签 lazy 加载**，避免启动时 N×大文件 IPC 风暴。

### 非目标

- Web Worker 解析 / 装饰（同 05 §1；打开阶段也不引入）。
-  mmap / 共享内存 / 零拷贝 IPC（记录为 Phase 3 研究方向，本规格不承诺）。
- 巨型单段（minified 粘进一段）的 lezer 块级悬崖修复（见 05 §10.1 gotcha；打开与编辑均只降级，不改 parser）。
- 文件夹级「虚拟文档」或分段编辑（Obsidian 式 vault 索引超出单文件编辑器范围）。

---

## 2. 问题陈述（用户可见）

| 现象 | 典型条件 |
|------|----------|
| 选文件后窗口长时间无响应 | ≥20MB，Windows WebView2 尤甚 |
| 偶发打开后仍卡顿数秒 | 50MB + Live Preview 初始装饰 + GC |
| 重启应用极慢 | 上次会话保留多个大文件标签 |
| 与文档矛盾 | README/05 写「10MB 逐键 1.5ms」，但**打开**仍像坏掉 |

**根因归类：** 05a 优化了**稳态编辑**，**冷打开**仍走「整文件字符串 × 多次复制 × JSON IPC × 主线程全量扫描」架构，50MB 超出当前规格 envelope。

---

## 3. 诊断：打开路径全链路

### 3.1 数据流（当前实现）

```text
用户 openPath / 会话恢复 / 拖放 / Open With
    │
    ▼
await services.readDocument(path)          ← 单 IPC 往返，阻塞至完成
    │
    ▼
Rust documents::read_document_blocking
    ├─ validate_requested
    ├─ fs::read → Vec<u8>                  [A] 整文件读入内存
    ├─ blake3::hash(bytes)                 [B] 全文件 CPU 哈希（指纹）
    ├─ String::from_utf8(bytes)            [C] Rust 侧 String
    └─ serde JSON 序列化 contents          [D] IPC  payload
    │
    ▼
WebView 反序列化 → JS string               [E] 第 1 份 JS 字符串
    │
    ▼
App.tsx openPath / resetTabDocument
    ├─ docsRef.set(tabId, contents)         [F] 第 2 份（Map）
    ├─ syncDoc → setDoc(contents)          [G] React state 第 3 份 + 重渲染
    ├─ contents.split("\n").length         [H] 主线程 O(n) 行数扫描
    └─ resetEditorDocument
           └─ EditorState.create({ doc })  [I] CM Text（第 4 份实质内容）
    │
    ▼
useEffect(workspace.tabs) → ensureViews → createEditor
    ├─ livePreviewField.create → buildLiveDecorations(0..doc.length)
    └─ refreshChrome → collectOutline
```

**代码锚点：**

| 步骤 | 位置 |
|------|------|
| 整文件 IPC | `apps/desktop/src-tauri/src/documents.rs` → `read_document_blocking` / `probe_disk` |
| 无大小上限 | 对比 `workspace.rs` `MAX_FILE_BYTES = 5MB`（仅 search/quick-open） |
| React 大 state | `apps/desktop/src/App.tsx` → `syncDoc` / `openPath` / `resetTabDocument` |
| 行数 split | `resetTabDocument` L633；`activeLines` useMemo L1735 |
| 会话 N 次读 | `restoreSavedSession` L935–956 串行 `readDocument` |
| 切 tab 展平 | `activateTab` L1150 `doc.toString()` |
| 无打开 UI | `openingRef` 存在但无 loading 组件 |

### 3.2 成本分解（定性 + 05/05a 已有定量）

| # | 环节 | 50MB 量级影响 | 证据 |
|---|------|---------------|------|
| D+E | **JSON IPC 传整文档** | 数秒～十几秒（平台相关）；JSON 转义可能膨胀 | Tauri invoke 默认 serde_json；Win WebView2 慢于 M 系 dev 机 |
| B | blake3 全文件 | ~50–200ms 量级 | 与读盘同 pass，但仍 O(bytes) |
| F+G | **React 持有整文档** | 堆上 2–3 份 × 50MB；Major GC 假死 | 05a 已从逐键路径移除，**打开仍 syncDoc 全量** |
| H | `split("\n")` ×2 | 每遍 ~100–400ms（主线程） | 打开时一次 + `deferredDoc` 后再一次 |
| I | `EditorState.create` | 一次性 rope 构建；可接受但排在 IPC 之后 | CM 设计目标；非首因 |
| — | **引擎冷解析** | 视口 ~3k 字符同步解析；**不是打开主因** | 05 §10.1：`InitViewport`；steady 打开不需全树 |
| — | **05a 已修项** | 逐键 recovery 防抖、update 无 doc | 不改善冷打开 |

### 3.3 与 05/05a 的边界

```text
Spec 05  (§1–9)  → 逐键预算、安全模式、bench 10k/50k 行
Spec 05a (§10)   → 10/20MB 逐键 O(doc) 清除；生产禁全树解析
Spec 05b (本文)  → 10/20/50MB 冷打开；IPC/副本/会话 lazy；打开 UX
```

**不变量（继承 05a，打开路径不得破坏）：**

- 生产代码禁止 `forceParsing` / `ensureSyntaxTree` 推进到 `doc.length`。
- 保存/导出/关闭前 `flushPendingDocs()` 拿到 view 最新内容。
- `pendingNormalization` 立即传播，不防抖。

### 3.4 规格 envelope 对照

| 来源 | 覆盖 | 50MB |
|------|------|------|
| 产品定位（oh-my-md-design） | 万行级流畅 | 混合 MD ≈ 数十万行，超 envelope |
| 05 bench | 10k/50k **行**、10/20MB **逐键** | 无打开指标 |
| manual-qa | ~1500 行 | 未覆盖 |
| 用户实测 | 50MB 打开 | **本规格目标档** |

### 3.5 已知悬崖（打开时同样适用）

- **巨型单段**：lezer-markdown 块粒度 O(块)；26MB 单段 1.2–2.6s/键（05 §10.1）。打开后若未进 Source，首屏装饰也可能极慢。
- **字节大但行数少**：当前仅 `SAFE_MODE_LINES`（50k **行**），50MB 长段落可能**不触发**安全模式 → Live Preview 更重。本规格增加 **字节阈值** 并行判定。

---

## 4. 业内最佳实践对照

| 产品 / 技术 | 打开大文件策略 | 对 oh-my-md 的启示 |
|-------------|----------------|-------------------|
| **VS Code** | `TextBuffer` 单副本；大文件提示；语法高亮/语义可延迟；打开异步不阻塞 UI | **编辑器内只保留一份 buffer**；React 不镜像全文；进度 + 降级 |
| **Typora / MarkText** | 原生读盘 → 单进程内字符串/Chromium 编辑区；无 JSON IPC 传 50MB | **避免 WebView JSON 承载全文** 是桌面编辑器常见做法 |
| **Obsidian** | Vault 索引与文件分离开；打开单 note 仍整文件读，但 lazy 插件 | **会话恢复不应 eager 读所有路径** |
| **CodeMirror 6** | `Text` rope；`EditorState.create({ doc })` 接受 string 但后续编辑不应再 toString 传播 | 打开可一次性 `create`；**之后真相源只能是 view.state.doc** |
| **Tauri 社区** | 大 payload 用 `spawn_blocking` + **事件分片** 或 **fs plugin 直连**；避免单次 invoke 巨型 JSON | 分阶段 IPC 或前端 fs 读 + Rust 仅 fingerprint |
| **Electron 大文件** | 常采用 `readFile` 在 main + `Buffer`/`string` 一次进 renderer；仍贵但无 JSON 双重序列化 | Tauri 的 invoke JSON 是额外税 |

**提炼的设计原则（本规格采纳）：**

1. **Single buffer truth** — 打开完成后，CM `Text` 为唯一全文副本；React/docsRef 仅持物化快照或空，按需拉取。
2. **Progressive open** — 元数据 → 可读 → 增强（outline/stats/live 装饰），分阶段可交互。
3. **Size policy explicit** — 与 search 5MB  cap 一样，编辑器侧必须有**命名常量 + drift 测试**，不能 silent 读无限大。
4. **Lazy by default** — 非激活标签、会话恢复、outline/stats 均延迟到需要时。
5. **Measure open TTIE** — Time-To-Interactive-Editing，与 05 的 typing p95 并列发布。

---

## 5. 用户流程与状态机

### 5.1 正常打开（≤ 警告阈）

```text
用户选择 path
  → UI: OpeningOverlay（立即，非模态）
  → Rust: read（spawn_blocking，可报告 progress 事件）
  → IPC 完成
  → 主线程: resetEditorDocument（不 setDoc 全量）
  → requestAnimationFrame: 隐藏 overlay，focus 编辑器
  → 下一 idle: outline / stats 按需
```

### 5.2 大文件（> OPEN_WARN_BYTES）

```text
read 前 probe（或 read 返回 stats）
  → ConfirmDialog: 「文件较大 (XX MB)，打开可能较慢」[打开] [取消]
  → 若 > OPEN_SOFT_MAX_BYTES：默认勾选「以源码模式打开」（可取消）
  → 继续 5.1 + 强制安全模式档位（与 SAFE_MODE_LINES 逻辑 OR）
```

### 5.3 硬拒绝（> OPEN_HARD_MAX_BYTES）

```text
probe 后拒绝打开，友好错误 + 建议外部拆分 / 源码编辑器
（不提供「仍要打开」除非设置中显式开启 expert 开关 — 非目标 v1 可省略）
```

### 5.4 会话恢复（lazy）

```text
getSessionState → openPaths[]
  → 仅对 activePath（或第一个 path）调用 readDocument
  → 其余 tab：占位 session { path, loaded: false, contents: "" }
  → 用户 activateTab(path) → 若 !loaded 则 readDocument + resetTabDocument
```

### 5.5 取消

```text
OpeningOverlay [取消] → increment openRequestRef / AbortController
  → Rust 侧无法中断已启动 read（v1 接受：取消仅忽略 late IPC 结果）
  → 后续规格可加 read 任务 id + 协作式取消
```

---

## 6. 方案：分阶段交付

> 原则：**先 UX + 去副本 + lazy（P0）**，再 **IPC 形状优化（P1）**，最后 **零拷贝研究（P2）**。  
> 每阶段独立可测、可发布，不依赖下一阶段。

### 6.1 P0 — 打开路径去 O(doc) 与可感知（推荐首 ship）

**P0-A：打开时不灌 React 大 state**

```text
openPath / resetTabDocument:
  - docsRef 写入 "" 或省略（dirty 基线仍用 session.baseline 机制）
  - 不调用 syncDoc(contents) 全量；仅 setDocVersion++ 或 setOpenGeneration++
  - createEditor / resetEditorDocument 仍用 contents 建 CM state（不可避免的一次 ingest）
  - dirty 判定、save：继续走 getContents() → flushPendingDocs → view.state.doc.toString()
```

**P0-B：行数 / 字节元数据来自 Rust，去掉 split**

- `Existing` snapshot 增字段（见 §7）：

```ts
interface DocumentFileStats {
  byteLength: number
  lineCount: number
}
```

- `resetTabDocument` 用 `snapshot.stats.lineCount` 判定安全模式；删除 `contents.split("\n")`。
- `activeLines` 改用 `docLineCountRef`（打开/切换时更新），**禁止**对 `deferredDoc` 做 split。

**P0-C：OpeningOverlay**

- `openingRef` + `useState(openingPath | null)` 驱动全屏轻量 overlay（role="status" + spinner）。
- `runOpen` / `openPath` / lazy tab load 全程显示；`finally` 清除。
- i18n：`open.loading`、`open.cancel`（取消可选 P0.5）。

**P0-D：字节 + 行数双阈安全模式**

| 常量 | 值 | 行为 |
|------|-----|------|
| `OPEN_WARN_BYTES` | 10 MiB | 打开前 confirm（可记忆「本会话不再提示」） |
| `OPEN_SOFT_MAX_BYTES` | 30 MiB | confirm 文案加强 + **默认 Source** |
| 既有 `SAFE_MODE_LINES` | 50000 | 不变 |
| 安全模式触发 | `lines > SAFE_MODE_LINES \|\| bytes > OPEN_SOFT_MAX_BYTES` | OR |

常量：`apps/desktop/src/constants.ts` + engine 仅行数；字节阈 desktop 独有 + `crossLayerConstants.test.ts` 与 Rust 对齐（若 Rust 也做 hard cap）。

**P0-E：会话 lazy load**

- `restoreSavedSession`：只对 `activePath ?? openPaths[0]` 调 `readDocument`。
- 其他 path：tab 带 `diskPath` 但 `contentLoaded: false`；`ensureViews` 为未加载 tab 显示 placeholder 或空 doc + path 标题。
- `activateTab`：若 `!contentLoaded` 则走 `openPath` 等价加载。

**P0-F：打开基准（advisory）**

- `packages/engine/bench/open.bench.ts` 或扩展现有 bench：度量 `EditorState.create + EditorView mount`（无 IPC，纯 CM）。
- `scripts/perf-smoke.mjs` 增 10MB/50MB 样本生成 + 人工 TTIE 步骤。
- 预算（初始建议，CI advisory）：

| 档位 | TTIE 目标（M 系 dev, Source） | 说明 |
|------|------------------------------|------|
| 10MB | < 2s | 含 mock IPC（bench 不含真实 Tauri） |
| 20MB | < 4s | |
| 50MB | < 8s | Win 允许 ×1.5 人工记录 |

### 6.2 P1 — IPC 与内存形状优化

**P1-A：Rust 单次 read 附带 stats（零额外 IO）**

在 `probe_disk` 读 bytes 时同步统计：

```rust
fn count_lines(bytes: &[u8]) -> u64 {
    bytes.iter().filter(|&&b| b == b'\n').count() as u64 + 1 // 空文件 = 1
}
```

写入 `ExistingDiskSnapshot.stats`。**不二次读盘。**

**P1-B：分片事件 IPC（progress + 主线程 yield）**

新命令（或 `read_document` 选项 `{ streaming: true }`）：

```text
invoke read_document_streaming { path }
  ← 立即返回 { requestId }

event document-open-progress { requestId, bytesRead, byteLength }
event document-open-chunk     { requestId, chunkIndex, text }  // 建议 1–2MB/chunk
event document-open-complete  { requestId, snapshot: ExistingDiskSnapshotMeta }
event document-open-error     { requestId, code, message }
```

前端 `StringBuilder` 拼接 → **仍是一份 JS string**，但：

- 进度条可更新；
- chunk 间 `await scheduler.yield()` / `requestAnimationFrame` 避免长时间 block；
- 降低「假死」体感。

**P1-C：Rust 硬上限**

```rust
const OPEN_HARD_MAX_BYTES: u64 = 64 * 1024 * 1024;
```

超过则 `DocumentError::TooLarge`（新 code）→ 前端友好提示。与 TS `OPEN_HARD_MAX_BYTES` drift 测试。

**P1-D：activateTab 去掉 eager toString**

```text
activateTab:
  - 若 pendingDocTabs.has(currentTab): materializePendingDocs()  // 已有
  - 否则 docsRef 可不更新（CM 已有真相源）
  - 禁止无条件 current.state.doc.toString()  // 50MB tab 切换悬崖
```

### 6.3 P2 — 研究方向（本规格只记录，不阻塞 P0/P1）

| 方向 | 说明 |
|------|------|
| WebView `@tauri-apps/plugin-fs` 直读 | Rust 只返回 `{ path, fingerprint }`；前端 fs.readTextFile；需评估权限与 Win 路径 |
| 二进制 IPC / SharedArrayBuffer | Tauri 2 自定义 serializer；安全策略复杂 |
| 磁盘临时 mmap | Rust 侧 mmap + 分块 emit |
| 只读首屏 + 后台续读 | 需 CM 支持 partial doc 替换（ChangeSet 整文档替换仍 O(n)） |

---

## 7. TypeScript / Rust 接口

### 7.1 扩展 DiskSnapshot（P0/P1）

```rust
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFileStats {
    pub byte_length: u64,
    pub line_count: u64,
}

// Existing variant 增：
Existing {
    requested_path: String,
    contents: String,
    version: DocumentVersion,
    stats: DocumentFileStats,  // 新增
}
```

TypeScript `desktopServices.ts` 镜像；**Rust 测试** `disk_snapshot_serializes_stats_as_camel_case`（IPC casing 铁律）。

### 7.2 新错误码

```rust
DocumentError::TooLarge { byte_length: u64, limit: u64 }
```

→ TS `DocumentCommandError` code `"tooLarge"` + i18n `error.fileTooLarge`。

### 7.3 可选：probe 命令（P1，打开前仅元数据）

```rust
#[tauri::command]
pub async fn probe_document(path: String) -> Result<DocumentProbe, DocumentError>

pub enum DocumentProbe {
    Missing { requested_path: String },
    Existing {
        requested_path: String,
        stats: DocumentFileStats,
        version: DocumentVersion,  // fingerprint 需读 bytes；与 read 同成本，probe 不省 IO
    },
}
```

**注：** probe 若仍 `fs::read` 全文件，则**不能**省时间，只用于 hard cap 拒绝与 confirm 文案。真正省 IO 的 probe 需 `metadata().len()` + 采样（指纹则仍需全读）。**v1 推荐：read 一次返回 stats，不做独立 probe。**

### 7.4 常量（desktop `constants.ts`）

```ts
export const OPEN_WARN_BYTES = 10 * 1024 * 1024
export const OPEN_SOFT_MAX_BYTES = 30 * 1024 * 1024
export const OPEN_HARD_MAX_BYTES = 64 * 1024 * 1024
```

Rust `documents.rs` / `lib.rs` 镜像 `OPEN_HARD_MAX_BYTES`（硬 cap 侧）；`crossLayerConstants.test.ts` 断言。

### 7.5 会话状态扩展（P0-E）

> **落地偏差（见 §14.10）：** 未采用 `EditorSession.contentLoaded` 布尔字段，
> 而是给 `SessionPersistence` 增加了 `lazyFile` 变体（`session.ts`）——只有路径、
> 内容首次激活时经 `openSession` 读取。判别式联合让「未装载」在类型层面不可
> 误读（`sessionDirty` 恒 false、`sessionPath` 仍可用），优于可遗忘的布尔位。

```ts
interface EditorSession {
  // 既有字段…
  readonly contentLoaded: boolean  // default true 兼容旧 session；false = lazy
}
```

`extractSessionState` / `parseSessionState` 向后兼容：缺字段视为 `true`。

---

## 8. 性能、安全与迁移约束

- **打开 TTIE bench CI advisory**（同 05），回归 >50% warning，不阻断。
- **OpeningOverlay** 必须带 live region，满足 a11y（继承 05 §5）。
- **硬 cap** 用户可见说明；不得 silent truncate 文件内容。
- **迁移：** 旧 session JSON 无 `contentLoaded` → 视为已加载；无 `stats` 的旧 IPC 测试 mock 补默认值。
- **Windows 优先验证：** 50MB 样本在 Win WebView2 上人工 QA 为发布门禁（27 规格 P2 交叉）。
- **内存：** P0 目标是将打开峰值从 ~3–4× 降至 ~1.5–2× 文件大小（CM rope + 一次 ingest 字符串，无 React 镜像）。

---

## 9. 自动化测试矩阵

| 用例 | 断言 | 位置 |
|------|------|------|
| snapshot 含 stats camelCase | JSON 字段 `byteLength`/`lineCount` | Rust `documents/tests.rs` |
| OPEN_* 常量 drift | TS ↔ Rust | `crossLayerConstants.test.ts` |
| 打开不 setDoc 全量 | open 后 React doc state 空或短占位；CM 有全文 | `App.largeDocOpen.test.tsx` |
| 安全模式字节 OR 行数 | 30MB+ 少行文档仍 Source | 同上 |
| OPEN_WARN confirm | mock confirm 取消 → 不 read | 同上 |
| lazy session restore | 2 paths，仅 1 次 readDocument | `App.sessionLazy.test.tsx` |
| activateTab 不 toString 大 doc | spy doc.toString 调用次数 | `App.largeDocOpen.test.tsx` |
| TooLarge 错误 | >hard cap → 友好错误 | Rust + TS |
| 05a 不变量 | 无 forceParsing 生产路径 | `crossLayerNoFullTree.test.ts` 不回归 |
| flush 仍有效 | 打开后立即 save 落盘正确 | `App.test.tsx` 增例 |

---

## 10. 手动 QA

在 `docs/manual-qa.md` 性能节追加：

- [ ] 生成/打开 10MB sample：2s 内可输入（Source），有 loading
- [ ] 打开 50MB sample：可完成或清晰 hard cap；全程非假死
- [ ] Win WebView2：同上（记录 TTIE 秒数进发布说明）
- [ ] 会话恢复 3 标签仅 1 个大文件：启动时仅 active 加载
- [ ] 取消打开（P1 流式）：progress 可见
- [ ] >10MB confirm 文案正确（中/英）

---

## 11. 文档更新

- [ ] 本 spec 状态块 → 实现中 / 已落地
- [ ] `2026-08-13-05-large-document-performance-design.md` 增 §11 指向 05b
- [ ] `packages/engine/AGENTS.md` / `apps/desktop/AGENTS.md`：打开路径规则（lazy、不 mirror React）
- [ ] `docs/memory/known-gotchas.md`：JSON IPC 大 payload、打开 split 反模式（验证后）
- [ ] README 性能表：补 TTIE 10/20/50MB（与 typing p95 并列）

---

## 12. 对后续规格提供的稳定接口

- `DocumentFileStats` / `DiskSnapshot.stats` — 导出、AI 上下文窗口提示可复用字节/行数。
- `OPEN_*_BYTES` — 与 future「附件扫描」「导出警告」共用。
- `read_document_streaming` + 事件名 — 版本历史、recovery 列表若需读大 snapshot 可复用分片模式。
- `lazyFile` session 变体（原设计的 `contentLoaded` 字段，见 §7.5 偏差注） — 多标签统一 lazy 加载模型。

---

## 13. 实现计划入口

落地时使用独立 plan：`docs/superpowers/plans/2026-08-19-05b-large-doc-open.md`（按 P0 → P1 分 task，每 task 可 PR）。

**推荐 PR 顺序：**

1. `feat: document stats on read for open path` — Rust stats + TS 类型 + drift  
2. `feat: opening overlay and byte thresholds` — UX + 安全模式 OR  
3. `refactor: stop mirroring full doc in react on open` — P0-A + tests  
4. `feat: lazy session restore for large tabs` — P0-E  
5. `perf: streaming read events for progress` — P1-B（可选）

---

## 附录 A：50MB 无法「及时打开」的一句话根因

**整文件 JSON IPC + React 三副本 + 主线程 split，在 05a 修完逐键路径后，打开仍是 O(doc) 同步架构；50MB 超出 05 envelope 且无任何打开预算。**

## 附录 B：与 search 5MB cap 的关系

| 能力 | 上限 | 理由 |
|------|------|------|
| `search_markdown` | 5MB | 并行扫描内存风险 |
| **编辑器打开** | 64MB hard / 30MB soft | 用户明确意图编辑；需渐进加载而非拒绝 |
| 图片粘贴 | 10MB | 既有 |

编辑器不应简单套用 5MB，但必须**显式政策 + 测试**，避免 silent 崩溃。

---

## 14. 实现偏差记录（2026-08-19 落地时）

落地实现与本文的偏差，均以代码与测试为准：

1. **P0-A（React 去全文镜像）未实施，降级为可选项。** §3.1 把 `docsRef.set`/`setDoc` 计为第 2/3 份副本是错的——JS 字符串按引用共享，三处是同一引用。真实副本是 JSON 瞬时文本、CM 行结构、250ms 物化快照与 watcher 磁盘副本；且文中「session.baseline 机制」并不存在（`sessionDirty` 依赖 React 持全文）。P2 完成后若仍有 GC 压力再评估。
2. **同步命令主线程占用是本文未覆盖的根因，已另行修复。** `allow_document_assets`（openPath 在 readDocument 之后 await 它）与 `write_recovery`（50MB 同步写）等原为非 async 命令，在 Rust 主线程串行排队——这是「关闭后重开永不显示」的直接机制。已 async + spawn_blocking 化（`set_recent_files` 除外：Windows/Linux 为 no-op，菜单操作须留主线程）。
3. **安全模式入口统一到 `applyDocumentScalePolicy`**（resetTabDocument + ensureViews），本文 P0-D 只加了阈值却未指出 inNewTab/会话恢复路径完全绕过判定；恢复路径还发现既有的「活动 tab 空 view」bug，已由 resetTabDocument 修复。
4. **probe 采用 `stat_document`（仅 `metadata().len()`）**，不读内容不算指纹（§7.3 的自注成立，§5.2 时序相应修正：确认发生在整读之前）。
5. **分片传输用 `tauri::ipc::Channel` 而非 `emit` 事件**（§P1-B）：事件负载同样走 JSON 且为全局广播需要 requestId 过滤；Channel 每次 invoke 独立有序。chunk 边界回退 UTF-8 字符边界（块大小 512KiB，Rust 侧整形参数，无 TS drift）。Channel 消息天然与渲染交错，无需 requestIdleCallback 分帧；最终 `join` + `EditorState.create` 是一次有界阻塞（overlay 提示）。
6. **>50MB 采用「确认后只读纯文本」而非 §5.3 的 64MB 硬拒**（用户分档方案）：`EditorState.readOnly` + engine `plainText` 选项（不挂语言/补全，livePreviewCompartment 保留）。
7. **阈值三档**：NORMAL <10MiB（现状）/ LARGE 10–50MiB（确认一次可会话记忆 + 流式 + 源码安全模式，`SAFE_MODE_BYTES` 与档界对齐补长行盲区）/ HUGE ≥50MiB（每次确认只读）。未做 §7.4 的 64MB hard cap 与用户可配置阈值（留 v1.x `UserSettings`）。
8. **runOpen 保存队列等待加 3s 超时**（`OPEN_SAVE_QUEUE_TIMEOUT_MS`）+ 关闭清理 tabSaveQueues/pendingDocTabs/docBytes 残留 + pollFileTabs in-flight 去重——均为 Windows 重开卡死的确定性机制，本文未覆盖。
9. **Windows watcher 路径包含 bug**（`startsWith(folder + "/")` 对 `\` 恒 false → 双重 watch）已修（`pathWithinDir`）；「大文档外部变更不自动整读」记为后续项（`externalChanged` divergence 类型需扩展才能不带磁盘全文）。
10. **会话 lazy 恢复**（§P0-E）落地为 `lazyFile` session 变体：不算 dirty、saveFile 在装载前拒绝执行（防空内容覆盖磁盘）、pollFileTabs 跳过。

## 实现变更附录（2026-08-20）

渐进渲染落地（见 [2026-08-20 计划](../plans/2026-08-20-large-file-live-render-and-fast-switch.md)）后，本规格的两处模式决策被用户决策推翻，其余（分档、流式、确认、只读、按需字数、预算）不变：

1. **LARGE 档（10–50MiB）开箱即 Live。** 原设计「确认后默认源码模式」的原因是整文档装饰构建会冻结 UI；该原因已消除——live 装饰现按光标周边播种（toggle p95 0.32ms@10MB，bench 实测）、idle 分片排空、over-scale 文档窗口化（只构建/保留视口附近，滚动按需重建）。`applyDocumentScalePolicy` 不再 dispatch `setLivePreview(false)`，安全模式语义变为「渐进渲染（视口优先）+ 块渲染预算 + 按需字数」，与用户模式选择正交（`safeModeChoiceRef` 保留为用户偏好记录，暂不驱动行为）。
2. **HUGE 档（≥50MiB）只读 Live（用户决策，含内存权衡）。** `EditorState.readOnly` 保留挡编辑，但引擎挂回 Markdown 语言与实时预览——engine `plainText` 选项已删除（`EngineOptions` 与 desktop `CreateEditorOptions` 同步移除），第 14 节第 6 条的「只读纯文本」不再成立。代价：滚动浏览时解析树增长约为文件的 2–4 倍内存，用户已接受，横幅文案明示。
3. 依据：产品负责人 2026-08-20 决策——(a) HUGE 档允许实时预览（解析器挂载 + readOnly，接受内存权衡，横幅须提及）；(b) LARGE 档直接以 Live 打开（不再强制源码）。
