# Conflict-Safe Guarded Save Design

**日期：** 2026-08-13  
**状态：** 待用户审核  
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md`  
**依赖规格：** `docs/superpowers/specs/2026-08-13-01-source-fidelity-design.md`

## 目标

建立由 Rust 维护磁盘版本事实的 guarded-save 协议，确保 oh-my-md 在保存前发现已完成的外部修改，不静默覆盖磁盘内容，并为用户提供可比较、可恢复、可再次验证的冲突处理流程。

具体目标：

1. 打开文件时同时获得内容和 opaque fingerprint。
2. 保存时提交预期版本，Rust 在原子替换前执行两次版本比较。
3. 所有 `save_document` 同一路径写入严格串行，不同路径允许并发。
4. 版本不匹配返回 typed conflict，不写目标文件。
5. 冲突时继续允许编辑和 recovery，但暂停该标签 autosave。
6. 提供只读 unified diff、保存副本、重新载入和明确覆盖。
7. 处理外部删除、symlink 目标变化、写入失败和 stale completion。
8. 保留现有原子写入的 crash-safety，并保留文件权限与 macOS extended attributes。

## 已批准的产品决策

- 使用跨平台 hash guarded-save + 原子替换；本阶段不接入 NSFileCoordinator。
- 不宣称对任意外部进程提供严格原子 compare-and-swap。
- watcher/轮询只负责提前通知，保存正确性以 Rust 最终版本比较为准。
- 冲突使用非模态 banner；冲突期间编辑器继续可用。
- 冲突操作为：`Compare`、`Save copy`、`Reload disk`、`Overwrite disk`。
- 比较界面是应用内只读 unified diff，不提供三方合并或逐块选择。
- `Save copy` 写出当前内存内容，但当前标签继续指向原文件并保留冲突。
- 干净文档发生外部变化时显示非模态提示，不自动 reload。
- 外部删除进入专用冲突：`Recreate file`、`Save copy`、`Close and discard`。

## 非目标

- 不实现自动三方合并或冲突编辑器。
- 不实现无条件 force write；每次 overwrite/recreate 都重新比较版本。
- 不保证与不协作外部进程之间的严格原子 CAS。
- 不在本阶段接入 macOS NSFileCoordinator 或 advisory file lock。
- 不实现第 04 份规格的完整授权 capability、工作区 sandbox 或远程资源策略。
- 不改变 CRLF、非 UTF-8 编码或 Unicode normalization 策略。
- 不重做第 03 份规格的 recovery 存储格式与退出 flush。
- 不处理文件被外部 rename 后的自动跟踪；原路径消失按删除处理。

## 当前行为与证据

### Rust

`apps/desktop/src-tauri/src/lib.rs` 当前：

- `read_file(path)` 只返回 UTF-8 字符串。
- `write_file(path, contents)` 直接调用 `atomic_write`。
- `atomic_write` 在目标目录创建临时文件，执行 write、flush、sync_all、persist。
- 写入没有预期版本、内容 hash 或 conflict result。
- 临时文件替换不会显式复制现有权限与 macOS extended attributes。

### Desktop

`apps/desktop/src/App.tsx` 当前：

- `EditorSession.savedContents` 是唯一保存 baseline。
- `lastDiskRef` 保存上次读到的全文字符串。
- 全局 `saveQueueRef` 串行所有标签保存。
- 保存前只校验当前 documentId 与 active EditorView，没有再次读取磁盘版本。
- watcher 轮询读全文；发现变化时更新 `lastDiskRef`，再询问是否 reload。
- watcher 检查和写入之间存在竞态，关闭 watcher 时保存完全不检查外部变化。

## 保证级别与威胁模型

### 本规格保证

- 所有通过 `save_document` 发起的同一路径写入按 canonical resolved path 串行；export/image/recovery 使用不同命令和目标，不在该保证内。
- 如果外部变化在任一次 Rust 比较前完成，保存返回 conflict 且不覆盖。
- 临时文件写入期间发生的外部变化会被第二次比较发现。
- 写入失败保留原目标文件和内存 dirty 状态。
- Desktop stale operation 不更新错误标签、错误 baseline 或错误 EditorView。

### 本规格不保证

标准跨平台文件 API 不能把“比较任意外部进程写入”与“rename 替换”合并成一个不可分割操作。外部程序仍可能在最后一次比较与 persist 之间写入。该窗口必须在文档与日志中称为 residual race，不能把 guarded-save 描述为严格 CAS。

后续可单独评估 macOS File Coordination，以降低与 iCloud/Cocoa 文档应用之间的协作式竞态。

原子替换保证以 macOS/Unix 为发布边界；Windows replace、hardlink aliases、APFS 路径等价与 Missing hard-link 发布后崩溃遗留 temp link 属已记录 residual risk。

## Rust 数据模型

新建 `apps/desktop/src-tauri/src/documents.rs`。

### Fingerprint 与版本

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub resolved_path: String,
    pub fingerprint: String,
}
```

- `resolved_path` 是 existing file canonicalize 后的绝对路径。
- `fingerprint` 格式为 `v1:<lowercase-blake3-hex>`，对原始文件 bytes 计算。
- fingerprint 不包含 mtime；同内容替换不制造无意义 conflict。
- Desktop 把版本当 opaque token，不解析 hash。

### Snapshot

```rust
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiskSnapshot {
    Missing {
        requested_path: String,
    },
    Existing {
        requested_path: String,
        contents: String,
        version: DocumentVersion,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExistingDiskSnapshot {
    pub requested_path: String,
    pub contents: String,
    pub version: DocumentVersion,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveDurability {
    Durable,
    DirectorySyncFailed,
}
```

`read_document` 对不存在返回 `Missing`，对非法 UTF-8 返回 typed error。

### Expected version

```rust
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExpectedDocumentVersion {
    Missing,
    Existing { version: DocumentVersion },
}
```

- 打开的 existing 文件保存时必须携带 exact version。
- 新目标只有在 `ExpectedDocumentVersion::Missing` 且两次检查都 missing 时才允许创建。
- Save As 选择 existing 目标后，Desktop 先读取 snapshot，并使用其 version；系统保存对话框的覆盖确认不替代 guarded-save。

### Save result

```rust
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveDocumentResult {
    Saved {
        version: DocumentVersion,
        durability: SaveDurability,
    },
    ContentConflict {
        disk: ExistingDiskSnapshot,
    },
    DeletedConflict {
        requested_path: String,
    },
    CreatedConflict {
        disk: ExistingDiskSnapshot,
    },
    PathChangedConflict {
        requested_path: String,
    },
    UnexpectedSymlinkConflict {
        requested_path: String,
    },
}
```

`ExistingDiskSnapshot` 只包含 existing snapshot 的字段。判别联合从类型上禁止 `Deleted + Existing` 等非法组合。

`PathChangedConflict`（expected existing）与 `UnexpectedSymlinkConflict`（expected missing）都不返回新 symlink 目标信息；前者可重开旧 resolved file，后者只能 Choose another path / Cancel，二者都禁用 Compare/Overwrite。

`SaveDurability` 为 `Durable` 或 `DirectorySyncFailed`。Persist 成功后的 parent-directory sync 失败仍返回 Saved 和新 version，Desktop 更新 baseline，同时记录非阻塞 durability warning；不得返回 WriteFailed。

### Typed command error

```rust
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum DocumentError {
    InvalidPath(String),
    NotUtf8(String),
    ReadFailed(String),
    WriteFailed(String),
    PermissionDenied(String),
    MetadataFailed(String),
    Internal(String),
}
```

用户 UI 显示友好 copy；详细路径和 OS error 只进入日志/诊断，不直接暴露到通用提示。

## Rust 命令

```rust
#[tauri::command]
async fn read_document(path: String) -> Result<DiskSnapshot, DocumentError>

#[tauri::command]
async fn read_document_version(
    path: String,
) -> Result<ExpectedDocumentVersion, DocumentError>

#[tauri::command]
async fn save_document(
    coordinator: tauri::State<DocumentCoordinator>,
    path: String,
    contents: String,
    expected: ExpectedDocumentVersion,
) -> Result<SaveDocumentResult, DocumentError>
```

三个命令都使用 `tauri::async_runtime::spawn_blocking` 执行读取、hash、metadata、fsync 和 rename；不得在 Tauri 主线程执行阻塞 IO。`DocumentCoordinator` clone 必须移入 blocking closure，整个 guarded-save 临界区都在该 closure 内；blocking task 的 JoinError 映射为 Internal 并记录 source。

现有 `read_file` / `write_file` 暂时保留给自定义 CSS、HTML export 等非文档用途；Markdown 文档流不得再调用它们。

## Path 与应用内协调

### Path key

- 输入必须是绝对路径，不允许 `.` 或 `..` component。
- 每次 probe 先用 `symlink_metadata` 检查 requested node，再决定是否 canonicalize；Expected Missing 后新出现 symlink 一律视为 UnexpectedSymlinkConflict。
- Existing 路径以 canonical resolved path 作为协调 key。
- Missing 路径 canonicalize parent，再拼接 file name 作为 key。
- Missing parent 返回 InvalidPath；本规格不隐式创建目录。
- Expected existing version 的 `resolved_path` 必须等于当前 canonical result；symlink 改指其他目标返回 `PathChanged`。
- Existing symlink 的临时文件创建在 canonical resolved target 的父目录，并 persist 到 resolved target；不得 rename 到 symlink 节点本身。
- PathChanged 不读取新 target 内容，且只允许 Save copy、Reload/重新打开或关闭。
- 非 UTF-8 path 不做 lossy conversion，返回 InvalidPath。
- macOS 大小写/Unicode 等价但字符串不同的 missing path，以及同 inode hardlink aliases，不在本阶段提供单 key 保证；创建成功后必须重新 canonicalize 返回最终 resolved path。
- 第 04 份规格会在该 key 之上增加授权范围验证。

### DocumentCoordinator

`DocumentCoordinator` 是 Tauri managed state：

```rust
#[derive(Clone)]
struct DocumentCoordinator {
    locks: Arc<Mutex<HashMap<PathKey, Weak<Mutex<()>>>>>,
}
```

`lock_for` 在持有 registry mutex 时先 `retain` 可 upgrade 的 weak entry，再 upgrade-or-insert 新 `Arc<Mutex<()>>`。IO closure 持有返回的 Arc 和 path mutex guard；最后一个 Arc drop 后，dead weak 最迟在下一次 `lock_for` sweep 删除，因此锁表不会随历史路径无界增长。

- Guarded-save 内部第一次读取、双比较与 persist 位于同一应用内临界区。
- 不同路径不共享全局锁。
- Desktop 不持有或传递 Rust lock handle。

## Guarded Save 算法

版本比较是穷尽纯函数，优先级固定：

1. Expected Missing + disk Missing：匹配。
2. Expected Missing + disk Existing regular file：CreatedConflict；新出现 symlink：UnexpectedSymlinkConflict，不跟随或读取。
3. Expected Existing + disk Missing：DeletedConflict。
4. Expected Existing + resolved path 不同：PathChangedConflict，不读取新目标内容。
5. Expected Existing + 同 path、fingerprint 不同：ContentConflict。
6. Expected Existing + path/fingerprint 相同：匹配。

只有 OS `NotFound` 映射 Missing；permission、IO 和 metadata 错误不能伪装成 Missing/Recreate。

对每次 `save_document`：

1. 验证并解析 path key。
2. 获取该 key 的应用内锁。
3. 读取 first `DiskSnapshot`。
4. 将 first snapshot 与 expected 比较；不匹配立即返回 conflict。
5. 在目标目录创建临时文件。
6. 写入 UTF-8 bytes，再设置 metadata，flush 并 `sync_all`。
7. 再读取 second `DiskSnapshot`。
8. 将 second snapshot 与 expected 比较；不匹配则删除临时文件并返回最新 conflict。
9. Existing persist 到原 version 的 resolved path，保留 symlink 节点；Missing 的 temp 以 `0666` 受 umask 创建并 sync，再用同文件系统 hard-link 原子发布；EEXIST 时重新 probe 并按比较表返回 typed conflict，最后移除 temp link。
10. 尽可能 sync parent directory；persist 后失败返回 Saved + DirectorySyncFailed，不回滚 baseline。
11. 返回基于写入 bytes 和最终 resolved path 的新 `DocumentVersion`。

所有比较函数必须是纯函数。临时文件生命周期由 RAII 管理，conflict/error 不留下孤儿临时文件。

内部 `guarded_save_with_hook` 在 temp sync 与 second compare 之间接受默认 no-op closure；生产传 no-op，Rust 测试传外部写入 closure，以确定性验证 second-compare race。

## Metadata Preservation

- Existing 文件的 permission bits 必须复制。
- macOS 必须复制 `com.apple.FinderInfo` 与 `com.apple.metadata:_kMDItemUserTags`；这些用户元数据失败时返回 MetadataFailed。
- `com.apple.quarantine`、`com.apple.provenance`、ACL、BSD flags 与 birthtime 不复制，并记录为明确非目标；其他 xattr best-effort，ENOTSUP/EPERM 记录日志但不阻断。
- PermissionDenied（含 immutable/目录权限）保留原文件并提供 Save copy；不以 owner readonly bit 代替真实 OS 写入权限。
- Missing temp 使用 create mode `0666` 并让 OS umask 生效，不沿用 NamedTempFile 的固定 0600。
- owner/group 不主动修改；应用以当前用户身份创建临时文件。
- 非 macOS 平台保留 permissions；extended attributes 仅在平台支持时启用。

## Desktop IPC 类型

`apps/desktop/src/desktopServices.ts` 新增与 Rust serde 一致的严格类型：

```ts
export interface DocumentVersion {
  readonly resolvedPath: string
  readonly fingerprint: string
}

export interface ExistingDiskSnapshot {
  readonly requestedPath: string
  readonly contents: string
  readonly version: DocumentVersion
}

export type DiskSnapshot =
  | { readonly kind: "missing"; readonly requestedPath: string }
  | ({ readonly kind: "existing" } & ExistingDiskSnapshot)

export type ExpectedDocumentVersion =
  | { readonly kind: "missing" }
  | { readonly kind: "existing"; readonly version: DocumentVersion }

export type SaveDocumentResult =
  | {
      readonly status: "saved"
      readonly version: DocumentVersion
      readonly durability: "durable" | "directorySyncFailed"
    }
  | {
      readonly status: "contentConflict" | "createdConflict"
      readonly disk: ExistingDiskSnapshot
    }
  | { readonly status: "deletedConflict"; readonly requestedPath: string }
  | { readonly status: "pathChangedConflict"; readonly requestedPath: string }
  | { readonly status: "unexpectedSymlinkConflict"; readonly requestedPath: string }

export type DocumentErrorCode =
  | "invalidPath"
  | "notUtf8"
  | "readFailed"
  | "writeFailed"
  | "permissionDenied"
  | "metadataFailed"
  | "internal"

export interface DocumentCommandError {
  readonly code: DocumentErrorCode
  readonly message: string
}
```

`DesktopServices` 新增：

```ts
readDocument: (path: string) => Promise<DiskSnapshot>
readDocumentVersion: (path: string) => Promise<ExpectedDocumentVersion>
saveDocument: (
  path: string,
  contents: string,
  expected: ExpectedDocumentVersion,
) => Promise<SaveDocumentResult>
```

Default services normalize Tauri rejection into `DocumentCommandError`; App switches on `code`. `message` 是 Rust 生成的安全摘要，不包含 raw OS source chain；详细错误只在 Rust 日志中记录。

## Desktop Session 与保存状态

### Session baseline

`EditorSession` 不再并列保存可漂移的 `path / savedContents / diskVersion`，改为：

```ts
export type SessionPersistence =
  | {
      readonly kind: "untitled"
      readonly savedContents: string
    }
  | {
      readonly kind: "file"
      readonly requestedPath: string
      readonly savedContents: string
      readonly version: DocumentVersion
    }

export interface EditorSession {
  readonly id: number
  readonly documentId: number
  readonly persistence: SessionPersistence
}
```

- `sessionPath` / `sessionSavedContents` accessor 取代直接字段访问。
- `openSession(session, snapshot)` 只接受 Existing snapshot。
- `markSaved(session, requestedPath, snapshot, version)` 在一次纯转换中更新 path/baseline/version。
- `advanceDocumentIdentity` 保留整个 persistence。
- Conflict、IO failure 和 Save copy 返回原 session，不允许只更新其中一个字段。

### 每标签状态

新建 `apps/desktop/src/documentSaveState.ts`：

```ts
export type SaveLifecycle =
  | { readonly kind: "idle" }
  | {
      readonly kind: "saving"
      readonly operationId: number
      readonly snapshot: string
    }
  | { readonly kind: "saveFailed"; readonly message: string }

export type DiskDivergence =
  | { readonly kind: "none" }
  | {
      readonly kind: "externalChanged"
      readonly disk: ExistingDiskSnapshot
    }
  | {
      readonly kind: "contentConflict"
      readonly localSnapshot: string
      readonly disk: ExistingDiskSnapshot
    }
  | { readonly kind: "deletedExternally"; readonly localSnapshot: string }
  | {
      readonly kind: "createdAtMissingTarget"
      readonly localSnapshot: string
      readonly disk: ExistingDiskSnapshot
    }
  | { readonly kind: "pathChanged"; readonly localSnapshot: string }
  | { readonly kind: "unexpectedSymlinkAtTarget"; readonly localSnapshot: string }

export interface DocumentSaveState {
  readonly lifecycle: SaveLifecycle
  readonly divergence: DiskDivergence
  readonly ioGeneration: number
}
```

状态按 tabId 存储，并通过 pure reducer/transition 函数更新，不混入可持久化 session。Clean/dirty 始终由 EditorView 内容与 session baseline 推导，不在 save state 中重复保存。

## 保存状态机

### 普通保存

- `dirty + autosave/Cmd+S → lifecycle.saving(operationId, snapshot)`
- `saving + Saved`：
  - 原子更新 session baseline/version；lifecycle 回 idle。
  - 当前 doc 是否 dirty 继续由 baseline 比较决定。
- `saving + DocumentError → lifecycle.saveFailed`，保留 divergence、dirty 和 recovery；失败后不定时重试，直到用户再次编辑或显式保存。
- Save result conflict 更新对应 divergence，lifecycle 回 idle。
- Overwrite/Recreate 再次 conflict 以新 typed result 原子替换旧 divergence。
- Watcher 在 saving 期间只缓存 observation；Rust completion 优先，之后仅处理 generation 仍有效的 observation。
- ExternalChanged + Keep current：若本地 clean，转 contentConflict 并以当前内容作为 localSnapshot；保持 autosave 暂停，直到 Reload/Overwrite/Save copy 后另行决策。

### 第 01 份规格互操作

- 01 Source Fidelity 必须先完成；02 继承其 tab/document-bound callback、统一 reset helper、per-tab projection 和 operation capture。
- Pending ordered-list normalization 优先阻止 autosave。
- 显式接受 normalization 的保存也必须走 `save_document` guarded-save。
- 保存 conflict/failed 时不得清除 normalization pending。
- Save copy 不 accept normalization；Overwrite 成功后 accept；Reload/Discard 清除旧 pending，并允许新 EditorState 重新检测。
- Conflict 与 normalization pending 同时存在时，conflict 操作优先；Cmd+S 不保存、不 accept，只定位 conflict UI。
- `canAutosave(tab)` 统一检查 normalization pending、lifecycle、divergence 和 dirty，不允许在多个 effect 中分散判断。
- Save capture 统一包含 tabId、documentId、view、operationId，以及可选 normalizationId；两份规格不得维护两套 stale 判定。
- Reload/Recreate 复用 01 的“先提交 bumped identity、再 reset、失败回滚”顺序。
- 共享状态区只宣读一个最高优先级消息：deleted/pathChanged/unexpectedSymlink > content conflict > normalization review > informational notice。

### 并发

- Desktop 使用按 tab 的 save promise/operationId，不再用单一全局 queue 阻塞所有标签。
- 同一 tab 同时只有一个 saving operation；新的请求在其后串行。
- 不同 tab 可并发；Rust 再按 resolved path 串行。
- Completion 必须验证 tabId、documentId、operationId 和目标 EditorView。
- Stale completion 可以完成磁盘副作用，但不得改写当前 UI/baseline。

## Watcher 与外部变化

Watcher 对所有打开的 file session 调用 `readDocumentVersion`，只在版本变化后调用 `readDocument` 取冲突内容；不再每轮跨 IPC 传全文，也不只监视活动标签。

- 版本未变：无操作。
- 本地 clean，磁盘 existing 变化：进入 `externalChanged`，显示 Compare/Reload。
- 本地 dirty 时检测变化：进入 contentConflict。
- Saving 期间 watcher 结果不立即改 UI；每次 watcher 捕获起始 `ioGeneration`，generation 在读取期间变化或 saving completion 后过期则丢弃，避免把应用自身刚保存的 fingerprint 误报为 conflict。
- 磁盘 missing：进入 deleted conflict。
- Version probe 的 resolved path 与 session version 不同：直接进入 pathChanged，不再调用 readDocument 读取新 target。
- 不在用户决定前更新 baseline/version。
- 用户选择保留当前内容时，保持 conflict 并暂停 autosave。

## Conflict UI

新增：

- `apps/desktop/src/SaveConflictBanner.tsx`
- `apps/desktop/src/DocumentDiffPanel.tsx`
- `apps/desktop/src/documentDiff.ts`

### Banner

- 非模态 `role="status"`，出现时不抢 editor focus。
- Existing conflict：Compare / Save copy / Reload disk / Overwrite disk。
- External clean update：Compare / Reload disk / Keep current。
- Deleted conflict：Recreate file / Save copy / Close and discard。
- PathChanged：Save copy / Reopen previous resolved file / Close；禁用 Compare 与 Overwrite。Reopen 使用 session 中旧 resolved path，dirty 时先 discard confirmation，绝不静默采纳新 symlink identity。
- Unexpected symlink at missing target：Choose another path / Cancel；不得 reset EditorState。
- Created-at-missing target：Compare / Choose another path；不得覆盖新创建文件。
- Conflict 时 `Cmd+S` 聚焦 banner 的第一个操作，不执行 overwrite。
- PermissionDenied/saveFailed 提供 Retry / Save copy / Reveal in Finder；MetadataFailed 提供 Retry / Save copy，详细病因只写日志。
- 后台 tab 通过 tab badge 表示 conflict；切回后显示 banner。

### Unified diff

- 输入是当前 EditorView 文本与 conflict snapshot disk contents。
- 磁盘 missing 显示整篇本地内容为 added，并标注文件已删除。
- 只读、按行 unified diff，显示上下文和行号。
- 支持点击 hunk 跳到本地 EditorView 对应行。
- 本地继续编辑时重新计算 local side。
- 如果 watcher 获得更新的 disk snapshot，diff 使用最新 snapshot 并明确刷新标记。
- PathChanged 不含 disk contents，diff panel 不打开。
- 大文件 diff 性能阈值在第 05 份规格定义；本阶段避免每次 keystroke 同步重算，使用 debounce。

## Conflict Actions

### Compare

只打开/聚焦 diff panel，不改变状态、baseline 或 disk。

### Save copy

1. 选择另一路径。
2. 调用 `readDocument` 检查目标是 missing 或 existing。
3. 以当前内存 snapshot 和目标 expected version 调用 `saveDocument`。
4. 成功后显示副本路径；原 tab path/version/conflict 保持不变。
5. 副本目标再次 conflict 时显示友好错误并允许重选，不覆盖原 conflict snapshot。
6. 目标 resolved path 不得等于原文件；副本不加入当前 tab recents、不改变 asset scope、不清 recovery，并提示相对 assets 引用可能在新目录失效。

### Reload disk

1. 点击时重新调用 `readDocument`，不使用可能过期的 conflict snapshot。
2. Existing 且本地 dirty 时显示明确 discard confirmation；clean external update 可直接 reload。
3. 确认后 reset EditorState，更新 savedContents/version，清 conflict 与 recovery。
4. Missing 时不能 reload，转入 deleted conflict。

### Overwrite disk

- 使用 conflict disk existing version 作为 expected，再保存当前 EditorView snapshot。
- 如果 disk 再变，使用新 conflict result 替换旧 snapshot。
- 成功后更新 baseline/version；若期间继续编辑则回 dirty。
- 不提供绕过 expected version 的 force API。

### Recreate file

- 仅 disk missing 时出现。
- 使用 `ExpectedDocumentVersion::Missing` 保存当前 snapshot。
- 如果路径被重新创建，返回 `Created` conflict。

### Close and discard

- 明确二次确认后关闭 tab，并清该 tab recovery。
- 取消保持 deleted conflict 与编辑内容。

## Error Handling

- `InvalidPath`：不进入保存队列，提示路径无效。
- `NotUtf8`：不载入 EditorState，提示当前版本仅支持 UTF-8 Markdown。
- `ReadFailed`：保留当前内存与已有状态，不把失败当 missing。
- `WriteFailed` / `MetadataFailed` / `Internal`：进入 saveFailed，保留 dirty、version 和 recovery，并提供 Retry/Save copy。
- `PermissionDenied`：同样保留状态，并额外提供 Reveal in Finder。
- Conflict 不调用 generic error alert。
- Save copy 成功是非阻塞状态消息。
- 用户可见 copy 不包含 raw OS error；日志保留 error code、path key 和 source chain。

## Security 与数据完整性

- Rust 重新计算 fingerprint，不信任 Desktop 自报 hash。
- Expected version 必须绑定 resolved path，防止 symlink 换目标后误写。
- 所有 path 在 Rust 边界验证 absolute/traversal。
- Conflict response 只返回用户已选择路径的内容。
- Diff 将内容作为文本节点渲染，不使用 `dangerouslySetInnerHTML`。
- 不记录文档正文、diff 内容或 hash 前镜像到日志。
- Metadata 复制失败不降级为静默成功。

## 预期文件变更

### Rust

- Create: `apps/desktop/src-tauri/src/documents.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`

新增 crates：

- `blake3`：版本化内容 fingerprint。
- `thiserror`：内部 source-chain error；对外仍序列化安全 DocumentError。
- `xattr`：只在 macOS/Unix target dependency 中启用，复制受支持 attributes。

### Desktop

- Modify: `apps/desktop/src/desktopServices.ts`
- Modify: `apps/desktop/src/Editor.ts`
- Modify: `apps/desktop/src/session.ts`
- Modify: `apps/desktop/src/workspace.ts`
- Modify: `apps/desktop/src/normalizationState.ts`
- Modify: `apps/desktop/src/normalizationCoordinator.ts`
- Create: `apps/desktop/src/documentSaveState.ts`
- Create: `apps/desktop/src/documentSaveCoordinator.ts`
- Create: `apps/desktop/src/documentDiff.ts`
- Create: `apps/desktop/src/SaveConflictBanner.tsx`
- Create: `apps/desktop/src/DocumentDiffPanel.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/StatusBar.tsx`
- Modify: `apps/desktop/src/TabBar.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/test/App.test.tsx`
- Modify: `apps/desktop/test/appHarness.ts`
- Modify: `apps/desktop/test/session.test.ts`
- Modify: `apps/desktop/test/workspace.test.ts`
- Create: `apps/desktop/test/documentSaveState.test.ts`
- Create: `apps/desktop/test/documentSaveCoordinator.test.ts`
- Create: `apps/desktop/test/documentDiff.test.ts`
- Create: `apps/desktop/test/SaveConflictBanner.test.tsx`
- Create: `apps/desktop/test/DocumentDiffPanel.test.tsx`

### Documentation

- Modify: `apps/desktop/AGENTS.md`
- Modify: `docs/manual-qa.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 自动化测试矩阵

### Rust

1. Fingerprint 对相同 bytes 稳定，对不同 bytes 改变。
2. read existing 返回 canonical path、内容与 version。
3. read missing 返回 Missing；read non-UTF-8 返回 NotUtf8。
4. Expected existing 匹配时保存成功并返回新 version。
5. Expected missing 仅在路径两次检查均 missing 时创建。
6. First compare 不匹配返回 conflict，目标未改变。
7. Temp 写入期间外部变化由 second compare 发现，目标外部内容保留。
8. 同一 resolved path 的应用内写入严格串行，不同路径不共享锁。
9. Symlink 改指其他目标返回 PathChanged，不写任一目标。
10. External delete 返回 Deleted；external create 返回 Created。
11. 写入失败保留原文件且无临时残留。
12. Existing permission bits 保存后不变。
13. macOS 两个必需用户 xattrs 保存后不变且复制失败不替换目标；其他 xattr 失败不阻断。
14. Conflict/error 不留下 lock table 永久增长。
15. Unicode 路径和内容 roundtrip。
16. Expected × disk 穷尽表返回正确 typed variant。
17. PathChanged 不读取/返回新 target 内容，symlink 节点保存后仍是 symlink。
18. Parent sync 失败返回 Saved warning，新 version 不产生自冲突。
19. Missing create 使用 no-clobber 且权限遵循 umask。
20. Async command 层不同路径可实际并发，不只测试 coordinator helper。
21. `guarded_save_with_hook` 可确定性触发 second-compare conflict。
22. Expected Missing 后出现 symlink 不读取目标并返回 UnexpectedSymlink；JoinError 映射 Internal。

### Desktop state/coordinator

1. clean/edit/saving/saved 状态转移。
2. 保存中继续编辑，成功后回 dirty。
3. IO failure 进入 saveFailed 且可重试。
4. Conflict 保存 attempted/disk snapshot 并阻止 autosave。
5. Stale operationId/documentId/view completion 被忽略。
6. 不同 tab 保存 promise 可并发，同 tab 串行。
7. Normalization pending 与 save conflict 独立保留。
8. Save copy 成功不改变原 session path/version/state。
9. Session path/baseline/version 只能原子更新。
10. Lifecycle 与 divergence 可组合，saving watcher observation 按 generation 丢弃或应用。
11. `canAutosave` 同时处理 normalization、failed、saving 与 divergence。

### App/UI

1. 打开文档使用 readDocument 并保存 version。
2. 普通手动保存传 exact expected version。
3. Autosave conflict 显示 banner、保持内容并暂停重试。
4. `Cmd+S` 在 conflict 时聚焦 banner，不调用 saveDocument。
5. Compare 打开 unified diff；本地继续编辑后 diff 更新。
6. Overwrite 使用 conflict version；二次变化更新 conflict。
7. Reload 点击时重新读取；确认后 reset/baseline/version/recovery 正确。
8. Reload 取消保持 conflict。
9. Save copy 成功后原 tab 保持 conflict。
10. Recreate 使用 expected missing；路径重新出现时保持 conflict。
11. Close and discard 取消/确认分支。
12. 干净外部变化显示 externalChanged，不自动 reload。
13. Dirty/saving 外部变化进入 conflict。
14. 后台 conflict tab badge 与切回 banner。
15. Failed/conflict/deleted 状态继续 recovery。
16. 多标签完成顺序不会污染 active tab。
17. Source Fidelity normalization 只在 guarded-save 成功后 accept。
18. 所有 banner/diff controls 键盘可达并有可访问名称。
19. Save As existing target 使用检查时 version，竞态变化返回 conflict。
20. Watcher 覆盖所有 file tabs，只在 version 变化后拉取全文。
21. 应用自身保存与 watcher 重叠不会产生虚假 externalChanged。
22. PathChanged 禁用 Compare/Overwrite，Created-at-target 不覆盖新文件。
23. Save copy 不 accept normalization；Overwrite 成功 accept；Reload 清旧 pending。
24. PathChanged reopen 只用旧 resolved path 且 dirty 需确认；PermissionDenied 提供 Save copy。
25. UnexpectedSymlink 只允许换路径/取消且不 reset；全部 Rust error code 与 TS union 同步。

## 验证命令

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
git diff --check
```

Engine Markdown 语义不变；实现期若未触及 engine 文件，不要求新增 engine 测试，但最终 `pnpm test` 仍作为跨工作区回归门。

## 手动 QA

1. 打开文件，在外部编辑器修改后保存，oh-my-md 不覆盖外部内容。
2. 在 temp 写入阶段模拟第二次外部改动，确认 conflict。
3. Autosave conflict 后继续输入，内容与 recovery 保留。
4. Compare 显示 current/disk 正确 hunk，点击可跳转。
5. Overwrite 前再次外部修改，确认出现新 conflict。
6. Reload 取消不改变内容；确认后加载点击时最新版本。
7. Save copy 写出当前内容，原标签 path/conflict 不变。
8. 外部删除 dirty 文件，验证 recreate/save copy/close 三条路径。
9. 外部删除后同名文件重新出现，recreate 不覆盖新文件。
10. 修改 symlink 目标后保存，两个目标都不被误写。
11. Finder tags 与 permission bits 保存前后保持。
12. 两标签同时保存，完成顺序不影响 active tab。
13. Conflict 时 Cmd+S 聚焦 banner，不覆盖。
14. 键盘与 VoiceOver 可操作 banner 和 diff panel。
15. 中文路径、中文正文与 IME 编辑后保存正常。
16. PathChanged 仅重开旧 resolved file，dirty 取消后内容不变。
17. Save As missing 目标竞态出现 symlink 时只允许换路径/取消。
18. PermissionDenied 可 Retry、Save copy 和 Reveal in Finder。

## 文档更新

- `apps/desktop/AGENTS.md`：记录文档 IO 必须使用 readDocument/saveDocument，watcher 不是真相边界。
- `docs/memory/known-gotchas.md`：记录 guarded-save residual race、双比较、symlink/version 绑定与 xattr。
- `docs/manual-qa.md`：加入外部修改、删除、二次 conflict、多标签和 metadata 验收。
- 父设计文档：把保存数据流改为 Rust versioned guarded-save + typed conflict。

## 对后续规格提供的稳定接口

03 Recovery and Shutdown 可以依赖：

- `DocumentVersion`、每标签 save state、conflict/deleted 状态。
- 只有 Saved/Reload/Discard 清 recovery 的规则。
- 退出前可查询 saving/conflict/dirty 标签。

04 Filesystem Security 可以依赖：

- canonical path key 与 Rust documents 模块。
- 所有文档 IO 已集中到 readDocument/saveDocument。
- Expected version 绑定 resolved path。

05 Large Document Performance 可以依赖：

- fingerprint 在 Rust bytes 上计算。
- diff debounce 与每标签 operationId。
- 不同标签允许并发、同路径串行。

## 完成定义

本规格实现只有在以下条件全部满足时完成：

- Rust、desktop test、desktop build 和 workspace 回归通过。
- Conflict 路径没有任何无条件覆盖 API。
- 双阶段比较、应用内 path serialization 和 atomic write 均有测试。
- 保存失败/conflict 不更新 baseline/version，不清 recovery。
- 多标签与 stale completion 自动化测试通过。
- metadata preservation 在 macOS 手动验证通过。
- unified diff 不执行 Markdown/HTML。
- GUI、键盘、VoiceOver 和外部编辑器手动 QA 已实际执行并记录。
- AGENTS、known-gotchas、manual QA 和父设计同步更新。
