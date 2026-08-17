# Conflict-Safe Guarded Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每次 Markdown 保存都携带 Rust 校验的磁盘版本，冲突时不覆盖磁盘、不丢失编辑，并提供可比较、可重载、可显式覆盖的非模态处理流程。

**Architecture:** Rust 新建 `documents` 模块，持有 fingerprint、canonical path key、按路径串行锁和双重版本比较的原子写入；Desktop 把 session baseline 收敛为 `SessionPersistence` 判别联合，用按 tab 的 `DocumentSaveState`（lifecycle × divergence × ioGeneration）驱动 banner、只读 unified diff 和冲突操作。所有阻塞 IO 在 `spawn_blocking` 中执行，watcher 只做提前通知，保存正确性以 Rust 最终比较为准。

**Tech Stack:** Rust 2021, Tauri 2, blake3, thiserror, xattr, tempfile；TypeScript 5.8, React 19, CodeMirror 6, Vitest 3, Testing Library, happy-dom, CSS。

**Spec:** `docs/superpowers/specs/2026-08-13-02-conflict-safe-save-design.md`

**Test Appendix:** `docs/superpowers/plans/2026-08-13-02-conflict-safe-save-test-appendix.md`

**Prerequisite:** `docs/superpowers/plans/2026-08-13-01-source-fidelity.md` 全部完成并合并。本计划直接消费 01 的 `EditorDocumentUpdate`（含 tabId/documentId/docChanged）、统一 reset helper、`NormalizationByTab`、`SaveTrigger`、`normalizationCoordinator.ts` 与 `apps/desktop/test/appHarness.ts`。

## Global Constraints

- Markdown 文档流只能走 `readDocument` / `readDocumentVersion` / `saveDocument`；`read_file` / `write_file` 仅保留给自定义 CSS 与 HTML export。
- 每次 `save_document` 都执行两次版本比较；不提供任何绕过 expected version 的 force API。
- 同一 canonical resolved path 的 `save_document` 严格串行；不同路径允许并发。
- 只有 OS `NotFound` 映射 Missing；permission、IO、metadata 错误不得伪装成 Missing/Recreate。
- `PathChangedConflict` 与 `UnexpectedSymlinkConflict` 不读取、不返回、不渲染新目标内容，且禁用 Compare 与 Overwrite。
- Persist 成功后父目录 sync 失败返回 `Saved` + `DirectorySyncFailed`，不得返回 `WriteFailed`。
- 保存失败与冲突不更新 session baseline/version，不清 recovery，不清 normalization pending。
- fingerprint 格式固定 `v1:<lowercase-blake3-hex>`，对原始文件 bytes 计算；Desktop 视其为 opaque token。
- 阻塞 IO 一律在 `tauri::async_runtime::spawn_blocking` 内执行；JoinError 映射 `Internal`。
- 用户可见文案不含 raw OS error；路径与 source chain 只进日志。diff 只用文本节点，禁止 `dangerouslySetInnerHTML`。
- 状态更新不可 mutation；函数 <50 行；文件 <800 行；嵌套 <4 层；命名常量代替魔法数字。
- 不启用 `indentOnInput`、`closeBrackets` 或通用 `autocompletion`。
- Commit 命令只是建议边界；没有用户授权不得执行。

---

## File Map

```text
src-tauri/src/documents.rs              类型、错误、path key、probe、比较、命令入口
src-tauri/src/documents/coordinator.rs  PathKey 锁注册表
src-tauri/src/documents/save.rs         guarded save、临时文件发布、metadata 复制
src-tauri/src/documents/tests.rs        Rust 测试矩阵
src-tauri/src/lib.rs                    async 命令注册与 managed state
apps/desktop/src/desktopServices.ts     IPC 类型、typed error 归一
apps/desktop/src/session.ts             SessionPersistence 与原子 baseline
apps/desktop/src/workspace.ts           按 sessionPath 查找标签
apps/desktop/src/documentSaveState.ts   lifecycle × divergence × ioGeneration reducer
apps/desktop/src/documentSaveCoordinator.ts  autosave 闸门、capture、watcher 判定、banner 模型
apps/desktop/src/documentDiff.ts        只读 unified diff
apps/desktop/src/SaveConflictBanner.tsx 非模态冲突条
apps/desktop/src/DocumentDiffPanel.tsx  只读 diff 面板
apps/desktop/src/conflictActions.ts     冲突操作编排（副作用集中，App 只做绑定）
apps/desktop/src/App.tsx                open/save/watcher/冲突编排
apps/desktop/src/{StatusBar,TabBar}.tsx 保存状态与冲突 badge
apps/desktop/src/styles.css             banner/diff/badge 样式
apps/desktop/test/*                     单元、组件与集成测试
docs/{manual-qa.md,memory/known-gotchas.md,superpowers/specs/2026-08-10-oh-my-md-design.md}
```

规格文件清单之外新增两个文件：Rust 侧 `documents/` 子模块与 Desktop 侧 `conflictActions.ts`。两者都只为满足 800 行/50 行约束而拆分，不引入新协议。

---

### Task 1: Rust 文档类型、fingerprint 与读取命令

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/documents.rs`
- Create: `apps/desktop/src-tauri/src/documents/tests.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `DocumentVersion`、`ExistingDiskSnapshot`、`DiskSnapshot`、`ExpectedDocumentVersion`、`SaveDurability`、`DocumentError`
- Produces: `fingerprint(&[u8]) -> String`、`validate_requested(&str) -> Result<PathBuf, DocumentError>`、`probe_disk(&Path) -> Result<DiskProbe, DocumentError>`、`spawn_blocking_document`
- Produces: `read_document`、`read_document_version` 命令
- Consumed by: Tasks 2–5

- [ ] **Step 1: 添加 crates**

```toml
blake3 = "1"
thiserror = "2"

[target.'cfg(unix)'.dependencies]
xattr = "1"
```

`blake3` 与 `thiserror` 进 `[dependencies]`；`xattr` 只进 unix target 段。

- [ ] **Step 2: 写失败的读取测试**

在 `documents.rs` 末尾加 `#[cfg(test)] mod tests;`，并在 `documents/tests.rs` 写入 Test Appendix 的 “Rust helpers” 与前六个用例：

```rust
#[test]
fn fingerprint_is_stable_and_prefixed() {
    assert_eq!(fingerprint(b"abc"), fingerprint(b"abc"));
    assert_ne!(fingerprint(b"abc"), fingerprint(b"abd"));
    assert!(fingerprint(b"abc").starts_with("v1:"));
    assert_eq!(fingerprint(b"abc"), fingerprint(b"abc").to_lowercase());
}

#[test]
fn read_existing_returns_canonical_path_contents_and_version() {
    let file = write_temp("read-existing", "文档 body\n");
    let snapshot = read_document_blocking(&path_string_for(&file)).unwrap();
    match snapshot {
        DiskSnapshot::Existing { contents, version, .. } => {
            assert_eq!(contents, "文档 body\n");
            assert_eq!(version.fingerprint, fingerprint("文档 body\n".as_bytes()));
            assert_eq!(version.resolved_path, canonical_string(&file));
        }
        other => panic!("unexpected snapshot: {other:?}"),
    }
}
```

其余四个用例（missing、非 UTF-8、relative/traversal InvalidPath、Unicode 路径 roundtrip）代码在 Test Appendix。

- [ ] **Step 3: 验证红**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml documents::`
Expected: FAIL，`documents` 模块与函数不存在。

- [ ] **Step 4: 实现类型与错误**

按规格逐字实现 `DocumentVersion`、`ExistingDiskSnapshot`、`DiskSnapshot`、`ExpectedDocumentVersion`、`SaveDurability` 与 `DocumentError`（含 `PermissionDenied` 与 `Internal`）。`DocumentError` 同时 derive `thiserror::Error`，每个变体 `#[error("{0}")]`，Display 只进日志。

```rust
const FINGERPRINT_PREFIX: &str = "v1:";

pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    format!("{FINGERPRINT_PREFIX}{}", blake3::hash(bytes).to_hex())
}
```

- [ ] **Step 5: 实现 probe 与路径校验**

`DiskProbe` 是模块内部类型，额外携带节点是否 symlink，供 Task 2 区分 `CreatedConflict` 与 `UnexpectedSymlinkConflict`：

```rust
pub(crate) enum DiskProbe {
    Missing,
    Existing { snapshot: ExistingDiskSnapshot, node_is_symlink: bool },
    DanglingSymlink,
}
```

`probe_disk` 顺序：`symlink_metadata` → `NotFound` 返回 `Missing` → `canonicalize`（symlink 且 `NotFound` 返回 `DanglingSymlink`）→ 读 bytes → `String::from_utf8` 失败返回 `NotUtf8` → 组装 snapshot。`validate_requested` 拒绝相对路径与 `.`/`..` component，非 UTF-8 路径返回 `InvalidPath`。IO 错误经统一映射：`PermissionDenied` → `DocumentError::PermissionDenied`，其余 → `ReadFailed`；日志记录 code、路径与 error，正文与 hash 前镜像不入日志。

- [ ] **Step 6: 实现两个读取入口**

`read_document_blocking` 把 `DiskProbe` 转成 `DiskSnapshot`，`DanglingSymlink` 返回 `ReadFailed`（不得当成 Missing）。`read_document_version_blocking` 只 hash 原始 bytes、不做 UTF-8 校验也不返回内容，用于 watcher。

```rust
pub(crate) async fn spawn_blocking_document<T, F>(task: F) -> Result<T, DocumentError>
where
    F: FnOnce() -> Result<T, DocumentError> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(result) => result,
        Err(error) => {
            eprintln!("[documents] blocking task failed: {error}");
            Err(DocumentError::Internal("the document task did not finish".into()))
        }
    }
}
```

- [ ] **Step 7: 注册 async 命令**

`lib.rs` 加 `mod documents;`，两个命令都是 `async fn` 且只调用 `spawn_blocking_document`，并加入 `generate_handler!`。保留 `read_file` / `write_file` 不变。

- [ ] **Step 8: 验证绿**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: 新增用例与现有 Rust 测试全部 PASS。

- [ ] **Step 9: Suggested commit**

```sh
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/documents.rs apps/desktop/src-tauri/src/documents/tests.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(tauri): read documents with content fingerprints"
```

---

### Task 2: Rust 穷尽版本比较

**Files:**
- Modify: `apps/desktop/src-tauri/src/documents.rs`
- Modify: `apps/desktop/src-tauri/src/documents/tests.rs`

**Interfaces:**
- Consumes: Task 1 `DiskProbe`、`ExpectedDocumentVersion`
- Produces: `SaveDocumentResult`、`VersionCheck`、`compare_expected`
- Consumed by: Tasks 4–5

- [ ] **Step 1: 写失败的比较表测试**

用 Test Appendix 的 `compare_table_returns_typed_variant_for_every_pair`，逐条覆盖规格的六条规则加 dangling symlink：

```rust
#[test]
fn expected_missing_and_new_symlink_returns_unexpected_symlink() {
    let probe = DiskProbe::Existing {
        snapshot: sample_snapshot("/tmp/a.md", "body"),
        node_is_symlink: true,
    };
    match compare_expected(&ExpectedDocumentVersion::Missing, &probe, "/tmp/a.md") {
        VersionCheck::Conflict(SaveDocumentResult::UnexpectedSymlinkConflict { requested_path }) => {
            assert_eq!(requested_path, "/tmp/a.md");
        }
        other => panic!("unexpected check: {other:?}"),
    }
}
```

- [ ] **Step 2: 验证红**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml documents::tests::compare`
Expected: FAIL，`compare_expected` 不存在。

- [ ] **Step 3: 实现 SaveDocumentResult 与比较**

`SaveDocumentResult` 按规格实现六个变体。`compare_expected` 是纯函数，match 覆盖全部组合，顺序即优先级：

1. `Missing` + `Missing` → `Match`
2. `Missing` + `Existing { node_is_symlink: false }` → `CreatedConflict`
3. `Missing` + 其余（symlink 或 dangling）→ `UnexpectedSymlinkConflict`
4. `Existing` + `Missing` → `DeletedConflict`
5. `Existing` + `DanglingSymlink` → `PathChangedConflict`
6. `Existing` + resolved path 不同 → `PathChangedConflict`
7. `Existing` + fingerprint 不同 → `ContentConflict`
8. 其余 → `Match`

`VersionCheck` 只有 `Match` 与 `Conflict(SaveDocumentResult)` 两个变体，禁止“既匹配又冲突”。

- [ ] **Step 4: 验证绿**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml documents::`
Expected: PASS。

- [ ] **Step 5: Suggested commit**

```sh
git add apps/desktop/src-tauri/src/documents.rs apps/desktop/src-tauri/src/documents/tests.rs
git commit -m "feat(tauri): classify document version conflicts"
```

---

### Task 3: Rust path key 与串行锁

**Files:**
- Create: `apps/desktop/src-tauri/src/documents/coordinator.rs`
- Modify: `apps/desktop/src-tauri/src/documents.rs`
- Modify: `apps/desktop/src-tauri/src/documents/tests.rs`

**Interfaces:**
- Produces: `PathKey`、`resolve_path_key`、`DocumentCoordinator::lock_for`、`DocumentCoordinator::tracked_paths`
- Consumed by: Tasks 4–5

- [ ] **Step 1: 写失败的锁与 key 测试**

```rust
#[test]
fn same_resolved_path_serializes_and_lock_table_stays_bounded() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("lock-serialize", "body");
    let key = resolve_path_key(&file).unwrap();
    let first = coordinator.lock_for(&key);
    let second = coordinator.lock_for(&key);
    assert!(Arc::ptr_eq(&first, &second));
    drop(first);
    drop(second);
    let other = write_temp("lock-other", "body");
    coordinator.lock_for(&resolve_path_key(&other).unwrap());
    assert_eq!(coordinator.tracked_paths(), 1);
}
```

再加 Test Appendix 的 `missing_path_key_uses_canonical_parent`、`missing_parent_is_invalid_path` 与 `different_paths_do_not_share_a_lock`。

- [ ] **Step 2: 验证红**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml documents::tests::lock`
Expected: FAIL，coordinator 不存在。

- [ ] **Step 3: 实现 key 解析**

`resolve_path_key` 先尝试 `canonicalize(requested)`；失败则 `canonicalize(parent)` 拼 file name，parent 不存在返回 `InvalidPath`（本阶段不隐式建目录）。key 解析不依赖 probe，因此可以在加锁前完成。

- [ ] **Step 4: 实现锁注册表**

```rust
#[derive(Clone, Default)]
pub struct DocumentCoordinator {
    locks: Arc<Mutex<HashMap<PathKey, Weak<Mutex<()>>>>>,
}
```

`lock_for` 在持有 registry mutex 时先 `retain(|_, weak| weak.strong_count() > 0)`，再 upgrade-or-insert。调用方用 `lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())` 取 guard，避免一次 panic 永久锁死该路径。`tracked_paths` 计数前也先 sweep，只用于测试断言表容量。

`documents.rs` 加 `mod coordinator;` 并 `pub(crate) use coordinator::{resolve_path_key, DocumentCoordinator, PathKey};`，`DocumentCoordinator` 对外 `pub`（Tauri managed state 需要），这样 `tests.rs` 的 `use super::*;` 能直接看到三者。

- [ ] **Step 5: 验证绿**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml documents::`
Expected: PASS。

- [ ] **Step 6: Suggested commit**

```sh
git add apps/desktop/src-tauri/src/documents.rs apps/desktop/src-tauri/src/documents/coordinator.rs apps/desktop/src-tauri/src/documents/tests.rs
git commit -m "feat(tauri): serialize saves per resolved path"
```

---

### Task 4: Rust guarded save 与原子发布

**Files:**
- Create: `apps/desktop/src-tauri/src/documents/save.rs`
- Modify: `apps/desktop/src-tauri/src/documents.rs`
- Modify: `apps/desktop/src-tauri/src/documents/tests.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Tasks 1–3
- Produces: `guarded_save`、`guarded_save_with_hook`、`save_document` 命令、managed `DocumentCoordinator`

- [ ] **Step 1: 写失败的保存测试**

用 Test Appendix 的 “Guarded save” 组：匹配保存成功、first compare 冲突不改目标、hook 注入的 second-compare 冲突、外部删除/新建、symlink 改指不写任一目标、写失败保留原文件且无残留、parent sync 失败仍 `Saved`、missing 创建 no-clobber。核心一条：

```rust
#[test]
fn external_write_during_temp_phase_is_caught_by_second_compare() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("second-compare", "original");
    let expected = existing_expected(&file);
    let target = file.clone();
    let result = guarded_save_with_hook(
        &coordinator,
        &path_string_for(&file),
        "mine",
        &expected,
        &move || fs::write(&target, "theirs").unwrap(),
    )
    .unwrap();
    assert!(matches!(result, SaveDocumentResult::ContentConflict { .. }));
    assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
    assert_eq!(temp_siblings(&file), 0);
}
```

- [ ] **Step 2: 验证红**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml documents::tests::guarded`
Expected: FAIL，`guarded_save_with_hook` 不存在。

- [ ] **Step 3: 实现临界区骨架**

`guarded_save` 委托 `guarded_save_with_hook(..., &|| {})`。`guarded_save_with_hook` 顺序固定：校验路径 → `resolve_path_key` → `lock_for` 取 guard → first `probe_disk` → `compare_expected` 冲突立即返回 → 按 first probe 分派 `replace_existing` 或 `create_missing`。hook 类型是 `&(dyn Fn() + Sync)`，生产传 no-op。

`documents.rs` 加 `mod save;` 并 `pub(crate) use save::{copy_metadata, guarded_save, guarded_save_with_hook, sync_parent};`，让 `tests.rs` 的 `use super::*;` 可直接调用四者。

- [ ] **Step 4: 实现 existing 替换**

`replace_existing` 在 **canonical resolved target 的父目录** 建 `NamedTempFile`，写 bytes → 复制 metadata（Task 5 的 `copy_metadata`，此时先留 `Ok(())` 占位实现同名函数）→ `flush` → `sync_all` → 调 hook → 再 `probe_disk(requested)` → `compare_expected` 冲突则直接 return（`NamedTempFile` drop 删除临时文件）→ `persist(resolved_target)` 保留 symlink 节点 → `sync_parent` → 返回 `Saved { version, durability }`，version 的 fingerprint 基于刚写入的 bytes。

- [ ] **Step 5: 实现 missing 创建**

`create_missing` 不用 `NamedTempFile` 的固定 0600：自建 `.omd-save-<pid>-<nanos>.tmp`，unix 下 `OpenOptions::new().write(true).create_new(true).mode(0o666)` 让内核套用 umask，非 unix 用 `create_new(true)`。写入并 `sync_all` → hook → second compare → `fs::hard_link(temp, target)` 原子发布；`AlreadyExists` 时重新 probe 并按比较表返回 typed conflict（比较仍 `Match` 属异常，返回 `WriteFailed`）→ `canonicalize(target)` 得最终 resolved path → `sync_parent`。临时文件由 `TempPath` 的 `Drop` 删除，成功路径也在 drop 时移除 temp link。

```rust
fn sync_parent(parent: &Path) -> SaveDurability {
    match std::fs::File::open(parent).and_then(|dir| dir.sync_all()) {
        Ok(()) => SaveDurability::Durable,
        Err(error) => {
            eprintln!("[documents] parent sync failed for {}: {error}", parent.display());
            SaveDurability::DirectorySyncFailed
        }
    }
}
```

- [ ] **Step 6: 注册命令与 managed state**

```rust
#[tauri::command]
async fn save_document(
    coordinator: tauri::State<'_, documents::DocumentCoordinator>,
    path: String,
    contents: String,
    expected: documents::ExpectedDocumentVersion,
) -> Result<documents::SaveDocumentResult, documents::DocumentError> {
    let coordinator = coordinator.inner().clone();
    documents::spawn_blocking_document(move || {
        documents::guarded_save(&coordinator, &path, &contents, &expected)
    })
    .await
}
```

`run()` 里 `.manage(documents::DocumentCoordinator::default())` 并把 `save_document` 加入 handler。

- [ ] **Step 7: 验证绿**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS，且 `temp_siblings` 断言证明冲突/失败路径无孤儿临时文件。

- [ ] **Step 8: Suggested commit**

```sh
git add apps/desktop/src-tauri/src/documents.rs apps/desktop/src-tauri/src/documents/save.rs apps/desktop/src-tauri/src/documents/tests.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(tauri): guard document saves with double version compare"
```

---

### Task 5: Rust metadata 保留与并发验证

**Files:**
- Modify: `apps/desktop/src-tauri/src/documents/save.rs`
- Modify: `apps/desktop/src-tauri/src/documents/tests.rs`

**Interfaces:**
- Consumes: Task 4 `replace_existing`
- Produces: `copy_metadata`

- [ ] **Step 1: 写失败的 metadata 与并发测试**

用 Test Appendix 的 “Metadata and concurrency” 组：permission bits 不变、两个必需 macOS xattr 不变、必需 xattr 复制失败不替换目标、其他 xattr 失败不阻断、只读目录返回 `PermissionDenied` 且保留原文件、missing 创建权限遵循 umask、不同路径通过命令层实际并发。

```rust
#[cfg(unix)]
#[test]
fn existing_permission_bits_survive_a_guarded_save() {
    let coordinator = DocumentCoordinator::default();
    let file = write_temp("permission-bits", "original");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    let expected = existing_expected(&file);
    guarded_save(&coordinator, &path_string_for(&file), "mine", &expected).unwrap();
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o640);
}
```

- [ ] **Step 2: 验证红**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml documents::tests::metadata`
Expected: FAIL，占位 `copy_metadata` 未复制权限。

- [ ] **Step 3: 实现权限与 xattr 复制**

```rust
#[cfg(target_os = "macos")]
const REQUIRED_XATTRS: [&str; 2] = [
    "com.apple.FinderInfo",
    "com.apple.metadata:_kMDItemUserTags",
];
const SKIPPED_XATTRS: [&str; 2] = ["com.apple.quarantine", "com.apple.provenance"];
```

`copy_metadata(source, temp)`：读 source metadata → `set_permissions(temp, ...)` → 复制 extended attributes。必需 xattr 存在但读写失败返回 `MetadataFailed`（临时文件随即 drop，目标不变）；其余 xattr best-effort，失败只记日志。ACL、BSD flags、birthtime、quarantine、provenance 明确不复制。非 unix 平台只复制 permissions。

- [ ] **Step 4: 实现错误分级**

写入路径统一映射：`PermissionDenied` → `DocumentError::PermissionDenied`，其余 IO → `WriteFailed`；不以 owner readonly bit 代替真实 OS 写权限判断。

- [ ] **Step 5: 验证绿**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: PASS。macOS 上 xattr 用例实际执行；非 macOS 用 `#[cfg]` 跳过。

- [ ] **Step 6: Suggested commit**

```sh
git add apps/desktop/src-tauri/src/documents/save.rs apps/desktop/src-tauri/src/documents/tests.rs
git commit -m "feat(tauri): preserve permissions and user metadata on save"
```

---

### Task 6: Desktop IPC 类型与 typed error

**Files:**
- Modify: `apps/desktop/src/desktopServices.ts`
- Create: `apps/desktop/test/desktopServices.test.ts`

**Interfaces:**
- Produces: `DocumentVersion`、`ExistingDiskSnapshot`、`DiskSnapshot`、`ExpectedDocumentVersion`、`SaveDocumentResult`、`DocumentErrorCode`、`DocumentCommandError`、`toDocumentCommandError`
- Produces: `DesktopServices.readDocument` / `readDocumentVersion` / `saveDocument` / `revealInFinder?`
- Consumed by: Tasks 7–13

- [ ] **Step 1: 写失败的归一化测试**

```ts
it("normalizes a typed rust rejection", () => {
  expect(toDocumentCommandError({ code: "permissionDenied", message: "cannot write" }))
    .toEqual({ code: "permissionDenied", message: "cannot write" })
})

it("falls back to internal for unknown rejections", () => {
  expect(toDocumentCommandError(new Error("boom")))
    .toEqual({ code: "internal", message: "boom" })
  expect(toDocumentCommandError({ code: "notARealCode" }).code).toBe("internal")
})
```

- [ ] **Step 2: 验证红**

Run: `pnpm --filter @omd/desktop test -- desktopServices.test.ts`
Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现类型**

按规格逐字写入 IPC 类型，包含 `unexpectedSymlinkConflict` 状态与 `permissionDenied` / `internal` 错误码。导出常量数组供归一化校验：

```ts
export const DOCUMENT_ERROR_CODES = [
  "invalidPath", "notUtf8", "readFailed", "writeFailed",
  "permissionDenied", "metadataFailed", "internal",
] as const satisfies readonly DocumentErrorCode[]
```

- [ ] **Step 4: 实现服务方法**

`readDocument` / `readDocumentVersion` / `saveDocument` 调用同名 Tauri 命令，`invoke` rejection 统一经 `toDocumentCommandError` 转换后抛出。`revealInFinder` 可选，默认实现 `invoke("plugin:opener|reveal_item_in_dir", { path })`，不新增 npm 依赖。

- [ ] **Step 5: 验证绿**

Run: `pnpm --filter @omd/desktop test -- desktopServices.test.ts`
Expected: PASS。

- [ ] **Step 6: Suggested commit**

```sh
git add apps/desktop/src/desktopServices.ts apps/desktop/test/desktopServices.test.ts
git commit -m "feat(desktop): add typed document IPC contracts"
```

---

### Task 7: Desktop session baseline 收敛

**Files:**
- Modify: `apps/desktop/src/session.ts`
- Modify: `apps/desktop/src/workspace.ts`
- Modify: `apps/desktop/test/session.test.ts`
- Modify: `apps/desktop/test/workspace.test.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/TabBar.tsx`
- Modify: `apps/desktop/test/appHarness.ts`

**Interfaces:**
- Produces: `SessionPersistence`、`createFileSession`、`sessionPath`、`sessionSavedContents`、`sessionVersion`
- Changes: `openSession(session, snapshot)`、`markSaved(session, requestedPath, snapshot, version)`
- Consumed by: Tasks 9、12、13

- [ ] **Step 1: 写失败的原子 baseline 测试**

```ts
const version = { resolvedPath: "/notes/a.md", fingerprint: "v1:aa" }

it("keeps path, baseline, and version in one atomic transition", () => {
  const saved = markSaved(createSession(1), "/notes/a.md", "body", version)
  expect(sessionPath(saved)).toBe("/notes/a.md")
  expect(sessionSavedContents(saved)).toBe("body")
  expect(sessionVersion(saved)).toEqual(version)
  expect(sessionDirty(saved, "body")).toBe(false)
})

it("opens from an existing snapshot and bumps identity", () => {
  const opened = openSession(createSession(1), {
    requestedPath: "/notes/a.md", contents: "disk", version,
  })
  expect(opened.documentId).toBe(2)
  expect(sessionVersion(opened)).toEqual(version)
})
```

再加 Test Appendix 的 `untitled sessions expose no version` 与 `advanceDocumentIdentity preserves persistence`。

- [ ] **Step 2: 验证红**

Run: `pnpm --filter @omd/desktop test -- session.test.ts`
Expected: FAIL，`persistence` 与 accessor 不存在。

- [ ] **Step 3: 实现判别联合与 accessor**

按规格实现 `SessionPersistence` 与 `EditorSession`。`createSession(id)` 只造 untitled；文件会话用 `createFileSession(id, requestedPath, savedContents, version)`。`sessionDirty`、`sessionLabel`、`recoveryKey` 全部改用 accessor，禁止读裸字段。conflict / IO failure / Save copy 一律返回原 session。

- [ ] **Step 4: 迁移调用方**

`workspace.findTabByPath` 用 `sessionPath` 比较；`TabBar` 与 `App` 的 `session.path` / `session.savedContents` 全部换成 accessor；`appHarness` 与既有测试改用新构造函数。

`markSaved` 现在要求 version，因此本任务给旧保存路径加一处**临时桥接**：`writeFile` 成功后调用 `services.readDocumentVersion(path)`，`existing` 时用其 version 调 `markSaved`，其他结果按保存失败处理并保留 dirty。桥接只为让 Task 7 独立通过测试，Task 12 用 `saveDocument` 的返回 version 取代它，且必须在同一 green step 内删除。打开路径同理：`readFile` 之后补一次 `readDocumentVersion`。

- [ ] **Step 5: 验证绿**

Run: `pnpm --filter @omd/desktop test -- session.test.ts workspace.test.ts App.test.tsx`
Expected: PASS（保存仍走旧 `writeFile` 路径）。

- [ ] **Step 6: Suggested commit**

```sh
git add apps/desktop/src/session.ts apps/desktop/src/workspace.ts apps/desktop/src/App.tsx apps/desktop/src/TabBar.tsx apps/desktop/test/session.test.ts apps/desktop/test/workspace.test.ts apps/desktop/test/appHarness.ts
git commit -m "refactor(desktop): bind session path, baseline, and version"
```

---

### Task 8: Desktop 保存状态 reducer

**Files:**
- Create: `apps/desktop/src/documentSaveState.ts`
- Create: `apps/desktop/test/documentSaveState.test.ts`

**Interfaces:**
- Produces: `SaveLifecycle`、`DiskDivergence`、`DocumentSaveState`、`SaveStateByTab`
- Produces: `initialSaveState`、`tabSaveState`、`updateTabSaveState`、`removeTabSaveState`、`beginSave`、`completeSave`、`failSave`、`applyDivergence`、`clearDivergence`、`isFreshObservation`
- Consumed by: Tasks 9、12、13

- [ ] **Step 1: 写失败的状态机测试**

```ts
it("advances io generation on every save boundary", () => {
  const saving = beginSave(initialSaveState(), 1, "snapshot")
  expect(saving.lifecycle).toEqual({ kind: "saving", operationId: 1, snapshot: "snapshot" })
  const done = completeSave(saving, 1)
  expect(done.lifecycle.kind).toBe("idle")
  expect(done.ioGeneration).toBe(saving.ioGeneration + 1)
})

it("ignores completions from a stale operation", () => {
  const saving = beginSave(initialSaveState(), 2, "snapshot")
  expect(completeSave(saving, 1)).toBe(saving)
  expect(failSave(saving, 1, "disk full")).toBe(saving)
})

it("keeps lifecycle and divergence orthogonal", () => {
  const conflicted = applyDivergence(beginSave(initialSaveState(), 1, "mine"), {
    kind: "contentConflict", localSnapshot: "mine", disk: diskSnapshot,
  })
  expect(conflicted.lifecycle.kind).toBe("saving")
  expect(conflicted.divergence.kind).toBe("contentConflict")
})
```

其余用例（`saveFailed` 保留 divergence、`clearDivergence` 只清 divergence、`isFreshObservation` 按 generation 丢弃、按 tab 增删）见 Test Appendix。

- [ ] **Step 2: 验证红**

Run: `pnpm --filter @omd/desktop test -- documentSaveState.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯 reducer**

按规格实现三类型；`DiskDivergence` 的 `externalChanged` 不带 `localSnapshot`（clean 时本地内容等于 baseline），`contentConflict` / `deletedExternally` / `createdAtMissingTarget` / `pathChanged` / `unexpectedSymlinkAtTarget` 各自独立变体。所有函数返回新对象；`completeSave` / `failSave` 遇到不匹配的 `operationId` 返回同一引用。`ioGeneration` 在 `beginSave`、`completeSave`、`failSave`、`applyDivergence` 各自 +1。

```ts
export function isFreshObservation(state: DocumentSaveState, generation: number): boolean {
  return state.lifecycle.kind !== "saving" && state.ioGeneration === generation
}
```

- [ ] **Step 4: 验证绿**

Run: `pnpm --filter @omd/desktop test -- documentSaveState.test.ts`
Expected: PASS。

- [ ] **Step 5: Suggested commit**

```sh
git add apps/desktop/src/documentSaveState.ts apps/desktop/test/documentSaveState.test.ts
git commit -m "feat(desktop): model per-tab save lifecycle and divergence"
```

---

### Task 9: Desktop 保存协调纯函数

**Files:**
- Create: `apps/desktop/src/documentSaveCoordinator.ts`
- Create: `apps/desktop/test/documentSaveCoordinator.test.ts`

**Interfaces:**
- Consumes: Tasks 6–8、01 的 `NormalizationByTab`
- Produces: `ConflictActionId`、`SaveOperationCapture`、`canAutosave`、`isCurrentSaveTarget`、`expectedVersionFor`、`watcherIntent`、`divergenceFromSnapshot`、`divergenceFromSaveResult`、`conflictBannerModel`、`topBanner`、`CONFLICT_ACTION_LABELS`
- Consumed by: Tasks 11–13

- [ ] **Step 1: 写失败的闸门与模型测试**

```ts
it("blocks autosave for normalization, failure, saving, and divergence", () => {
  const base = { tabId: 1, dirty: true, hasPath: true, normalization: {}, saveState: initialSaveState() }
  expect(canAutosave(base)).toBe(true)
  expect(canAutosave({ ...base, dirty: false })).toBe(false)
  expect(canAutosave({ ...base, hasPath: false })).toBe(false)
  expect(canAutosave({ ...base, normalization: projectNormalizationNotice({}, 1, notice) })).toBe(false)
  expect(canAutosave({ ...base, saveState: beginSave(initialSaveState(), 1, "x") })).toBe(false)
  expect(canAutosave({ ...base, saveState: failSave(beginSave(initialSaveState(), 1, "x"), 1, "io") })).toBe(false)
  expect(canAutosave({ ...base, saveState: applyDivergence(initialSaveState(), pathChanged) })).toBe(false)
})

it("offers no compare or overwrite for symlink divergence", () => {
  expect(conflictBannerModel(applyDivergence(initialSaveState(), pathChanged))?.actions)
    .toEqual(["saveCopy", "reopenPrevious", "closeDiscard"])
  expect(conflictBannerModel(applyDivergence(initialSaveState(), unexpectedSymlink))?.actions)
    .toEqual(["chooseAnotherPath", "cancel"])
})
```

`isCurrentSaveTarget`、`watcherIntent`、`divergenceFromSaveResult`、`topBanner` 的用例见 Test Appendix。

- [ ] **Step 2: 验证红**

Run: `pnpm --filter @omd/desktop test -- documentSaveCoordinator.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 capture 与闸门**

```ts
export interface SaveOperationCapture {
  readonly tabId: number
  readonly documentId: number
  readonly view: EditorView
  readonly operationId: number
  readonly normalizationId: NormalizationId | null
}
```

`canAutosave` 是唯一的 autosave 判定入口：dirty、有 path、无 normalization pending、lifecycle 为 `idle`、divergence 为 `none` 才返回 `true`；其中 normalization 判定复用 01 的 `canAutosaveTab`，不重复实现。`isCurrentSaveTarget` 同时校验 tab 存在、`documentId` 相同、`views.get(tabId) === capture.view`。`expectedVersionFor` 对 untitled 返回 `{ kind: "missing" }`，对 file 返回 `{ kind: "existing", version }`。

- [ ] **Step 4: 实现 watcher 判定与 divergence 映射**

`watcherIntent(session, probe)` 返回 `ignore` / `pathChanged` / `deleted` / `fetchContents`：probe 为 missing → `deleted`；resolved path 与 session version 不同 → `pathChanged`（不再取内容）；fingerprint 相同 → `ignore`；否则 `fetchContents`。`divergenceFromSnapshot(disk, dirty, localSnapshot)` 在 dirty 时给 `contentConflict`，clean 时给 `externalChanged`。`divergenceFromSaveResult` 把五个 typed conflict 映射到对应 divergence，`saved` 返回 `null`。

- [ ] **Step 5: 实现 banner 模型与优先级**

```ts
export type ConflictActionId =
  | "compare" | "saveCopy" | "reloadDisk" | "overwriteDisk" | "keepCurrent"
  | "recreateFile" | "closeDiscard" | "reopenPrevious" | "chooseAnotherPath"
  | "retry" | "revealInFinder" | "cancel"
```

`conflictBannerModel` 返回 `{ message, actions }`：content conflict 给 `["compare","saveCopy","reloadDisk","overwriteDisk"]`；external clean 给 `["compare","reloadDisk","keepCurrent"]`；deleted 给 `["recreateFile","saveCopy","closeDiscard"]`；created-at-target 给 `["compare","chooseAnotherPath"]`；pathChanged 给 `["saveCopy","reopenPrevious","closeDiscard"]`；unexpected symlink 给 `["chooseAnotherPath","cancel"]`；`saveFailed` 给 `["retry","saveCopy"]`，`permissionDenied` 追加 `"revealInFinder"`。`topBanner` 实现单一宣读优先级：deleted / pathChanged / unexpectedSymlink > content conflict > saveFailed > normalization review > 无。`CONFLICT_ACTION_LABELS` 提供每个 action 的可访问名称。

- [ ] **Step 6: 验证绿**

Run: `pnpm --filter @omd/desktop test -- documentSaveCoordinator.test.ts`
Expected: PASS。

- [ ] **Step 7: Suggested commit**

```sh
git add apps/desktop/src/documentSaveCoordinator.ts apps/desktop/test/documentSaveCoordinator.test.ts
git commit -m "feat(desktop): decide autosave, watcher, and conflict actions purely"
```

---

### Task 10: 只读 unified diff

**Files:**
- Create: `apps/desktop/src/documentDiff.ts`
- Create: `apps/desktop/test/documentDiff.test.ts`

**Interfaces:**
- Produces: `DiffLine`、`DiffHunk`、`unifiedDiff`
- Consumed by: Tasks 11、13

- [ ] **Step 1: 写失败的 diff 测试**

```ts
it("produces one hunk with context and line numbers", () => {
  const hunks = unifiedDiff("a\nmine\nc\n", "a\ntheirs\nc\n")
  expect(hunks).toHaveLength(1)
  expect(hunks[0].lines.map(line => [line.kind, line.text])).toEqual([
    ["context", "a"],
    ["removed", "theirs"],
    ["added", "mine"],
    ["context", "c"],
  ])
  expect(hunks[0].lines.find(line => line.kind === "added")?.localLine).toBe(2)
})

it("marks a deleted file as fully added", () => {
  const hunks = unifiedDiff("only mine\n", "")
  expect(hunks[0].lines.every(line => line.kind === "added")).toBe(true)
})

it("returns no hunk for identical documents", () => {
  expect(unifiedDiff("same\n", "same\n")).toEqual([])
})
```

大文档回退与多 hunk 用例见 Test Appendix。

- [ ] **Step 2: 验证红**

Run: `pnpm --filter @omd/desktop test -- documentDiff.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现按行 diff**

约定：`removed` 是仅存在于磁盘的行，`added` 是仅存在于本地 EditorView 的行。先剥离公共前后缀，再对中段做 LCS。命名常量：

```ts
const DIFF_CONTEXT_LINES = 3
const MAX_DIFF_MATRIX_LINES = 2000
```

中段任一侧超过 `MAX_DIFF_MATRIX_LINES` 时退化为单个整体替换 hunk，避免超大文档同步计算爆内存；精细阈值留给第 05 份规格。每个 `DiffLine` 带 `localLine` / `diskLine`（不存在的一侧为 `null`），供面板跳转使用。

- [ ] **Step 4: 验证绿**

Run: `pnpm --filter @omd/desktop test -- documentDiff.test.ts`
Expected: PASS。

- [ ] **Step 5: Suggested commit**

```sh
git add apps/desktop/src/documentDiff.ts apps/desktop/test/documentDiff.test.ts
git commit -m "feat(desktop): compute read-only unified document diff"
```

---

### Task 11: 冲突 UI 组件与状态提示

**Files:**
- Create: `apps/desktop/src/SaveConflictBanner.tsx`
- Create: `apps/desktop/src/DocumentDiffPanel.tsx`
- Create: `apps/desktop/test/SaveConflictBanner.test.tsx`
- Create: `apps/desktop/test/DocumentDiffPanel.test.tsx`
- Modify: `apps/desktop/src/StatusBar.tsx`
- Modify: `apps/desktop/src/TabBar.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: Tasks 9–10
- Produces: `SaveConflictBannerProps`、`DocumentDiffPanelProps`
- Changes: `StatusBar` 增 `saveStatus`，`TabBar` 增 `conflictIds`

- [ ] **Step 1: 写失败的组件测试**

```tsx
it("announces the conflict and exposes every action in order", () => {
  const onSelect = vi.fn()
  render(<SaveConflictBanner
    message="This file changed on disk."
    actions={[{ id: "compare", label: "Compare" }, { id: "reloadDisk", label: "Reload disk" }]}
    busy={false} focusToken={0} onSelect={onSelect} />)
  expect(screen.getByRole("status").textContent).toContain("This file changed on disk.")
  const buttons = screen.getAllByRole("button")
  expect(buttons.map(button => button.textContent)).toEqual(["Compare", "Reload disk"])
  fireEvent.click(buttons[1])
  expect(onSelect).toHaveBeenCalledWith("reloadDisk")
})

it("focuses the first action when the focus token changes", () => {
  const view = render(<SaveConflictBanner {...props} focusToken={0} />)
  view.rerender(<SaveConflictBanner {...props} focusToken={1} />)
  expect(document.activeElement?.textContent).toBe("Compare")
})
```

diff 面板与 TabBar/StatusBar 断言见 Test Appendix。

- [ ] **Step 2: 验证红**

Run: `pnpm --filter @omd/desktop test -- SaveConflictBanner.test.tsx DocumentDiffPanel.test.tsx`
Expected: FAIL，组件不存在。

- [ ] **Step 3: 实现 banner**

非模态 `role="status"`，挂载时不抢 editor focus；只有 `focusToken` 变化才把焦点移到第一个操作（供冲突时 `Cmd+S` 使用）。按钮是原生 `button`，名称来自 `CONFLICT_ACTION_LABELS`，`busy` 时全部 disabled。

- [ ] **Step 4: 实现 diff 面板**

只读渲染 hunk 头与行号，全部用文本节点。每个 hunk 有一个具名按钮跳到本地行（`onJump(localLine)`）；磁盘缺失时显示“文件已删除”说明；`refreshed` 为真时显示明确的刷新标记。`PathChanged` 与 unexpected symlink 不传 snapshot，面板不渲染。

- [ ] **Step 5: 扩展 StatusBar 与 TabBar**

`StatusBar` 保留 path + dirty 同一文本节点，新增独立 `saveStatus` span（`saving` / `save failed` / `conflict`），本任务默认 `"idle"` 且 App 传常量。`TabBar` 新增 `conflictIds`，为冲突标签渲染带可访问名称的 badge（如 `aria-label="Conflict"`）。

- [ ] **Step 6: 补样式**

只用既有 CSS 变量；`:focus-visible` 清晰、命中区 ≥24×24、窄宽度换行、AA 对比度、不用纯色/透明度单独表达状态。

- [ ] **Step 7: 验证绿**

```sh
pnpm --filter @omd/desktop test -- SaveConflictBanner.test.tsx DocumentDiffPanel.test.tsx App.test.tsx
pnpm --filter @omd/desktop build
```

Expected: PASS。

- [ ] **Step 8: Suggested commit**

```sh
git add apps/desktop/src/SaveConflictBanner.tsx apps/desktop/src/DocumentDiffPanel.tsx apps/desktop/src/StatusBar.tsx apps/desktop/src/TabBar.tsx apps/desktop/src/styles.css apps/desktop/src/App.tsx apps/desktop/test/SaveConflictBanner.test.tsx apps/desktop/test/DocumentDiffPanel.test.tsx
git commit -m "feat(desktop): add accessible save conflict UI"
```

---

### Task 12: App 打开、保存与 watcher 迁移

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/appHarness.ts`
- Modify: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- Consumes: Tasks 6–11
- Produces: `saveFile(tabId, trigger, mode)`、`saveCopy(tabId)`、按 tab 保存状态与 watcher

- [ ] **Step 1: 扩展测试 harness**

按 Test Appendix 的 “Harness additions” 给 `appHarness.ts` 加 `readDocument` / `readDocumentVersion` / `saveDocument` 默认 mock、`diskFor(path)` 夹具、`runWatcher()` 与 `saveActive()`；`writeFile` 仅保留给 export 断言。

- [ ] **Step 2: 写失败的保存/打开集成测试**

用 Test Appendix “Task 12: 打开、保存与 watcher 集成” 的十个可执行用例，测试名保持一致：

- `opens a document through readDocument and saves the exact expected version`
- `sends expected missing for an untitled document`
- `uses the check-time version for an existing Save As target`
- `keeps content and recovery and pauses retries when autosave conflicts`
- `focuses the conflict banner instead of overwriting on Cmd+S`
- `polls every file tab and fetches contents only after a version change`
- `does not report an external change for the app's own save`
- `records a durability warning without failing the save`
- `completes two tabs in either order without polluting the active tab`
- `shows a clean external update without reloading automatically`

- [ ] **Step 3: 验证红**

Run: `pnpm --filter @omd/desktop test -- App.test.tsx`
Expected: FAIL，App 仍调用 `readFile` / `writeFile`。

- [ ] **Step 4: 迁移打开路径**

`openPath` 改调 `services.readDocument`：`missing` 报友好错误且不建立会话，`existing` 走 01 的统一 reset helper（先提交 bumped identity、再 reset、失败回滚），并用 `openSession(session, snapshot)` 保存 version。删除 `lastDiskRef` 与 Task 7 的临时 `readDocumentVersion` 桥接，磁盘真相只存在 session version 与 divergence 中。

- [ ] **Step 5: 实现按 tab 保存**

```ts
type SaveMode =
  | { readonly kind: "current" }
  | { readonly kind: "saveAs" }
  | { readonly kind: "overwrite"; readonly expected: ExpectedDocumentVersion }
  | { readonly kind: "recreate" }

async function saveFile(tabId: number, trigger: SaveTrigger, mode: SaveMode = { kind: "current" }): Promise<void>
```

用按 tab 的 promise 串行取代全局 `saveQueueRef`；不同 tab 可并发。`operationId` 由 App 持有的单调计数器 ref 分配（`operationSeqRef.current += 1`），不复用 documentId。流程：`canAutosave` 或显式触发 → `beginSave(operationId)` → 取 expected version（`overwrite` 用冲突 snapshot 的 version，`recreate` 用 `{ kind: "missing" }`）→ `saveDocument` → 完成时先 `isCurrentSaveTarget` 校验，再按结果 `completeSave` + `markSaved`（用 `replaceTabSession`）或 `applyDivergence`，`DocumentCommandError` 走 `failSave`。stale completion 允许磁盘副作用，但不得改 UI/baseline。`saveCopy(tabId)` 单独实现：`pickSavePath` → `readDocument` 查目标 → `saveDocument`，成功只发非阻塞状态消息（含“相对 assets 引用可能在新目录失效”提示），不动原 session/divergence/recents/asset scope/recovery，目标 resolved path 等于原文件时拒绝并提示改选。

`durability === "directorySyncFailed"` 仍按成功处理：更新 baseline/version，只追加一条非阻塞状态消息，不得进入 `saveFailed`。

错误分级也在此实现：`invalidPath` 与 `notUtf8` 不进入保存/打开的状态更新（前者提示路径无效，后者不建立 EditorState 并提示仅支持 UTF-8 Markdown），`readFailed` 只记日志并保留现状，其余错误进 `failSave`。冲突一律不调用 `reportError`。

- [ ] **Step 6: 迁移 watcher**

用一个定时器遍历所有 file tab：捕获该 tab 当前 `ioGeneration` → `readDocumentVersion` → `watcherIntent` → 需要内容时才 `readDocument` → 回写前用 `isFreshObservation` 复核 generation，过期直接丢弃。`readFailed` 只记日志不改状态，`Cmd+S` 在 divergence 非 `none` 时只递增 banner 的 `focusToken`。

- [ ] **Step 7: 接线状态与 UI**

`saveStateByTab` 用 ref+state 双写（与 01 的 projection 同一模式）。autosave effect 唯一判定入口是 `canAutosave`。`StatusBar.saveStatus`、`TabBar.conflictIds` 与 banner 均由 `topBanner` 决定，共享区一次只宣读一条。

- [ ] **Step 8: 强制 App 体积检查点**

把保存/watcher 的副作用编排移入 `documentSaveCoordinator.ts` 与 Task 13 的 `conflictActions.ts`，确认 `App.tsx` 仍低于 750 行，为 Task 13 留出空间。

- [ ] **Step 9: 验证绿**

Run: `pnpm --filter @omd/desktop test -- App.test.tsx`
Expected: PASS，包含既有 serialization、stale open、Save As 复用与失败 baseline 用例。

- [ ] **Step 10: Suggested commit**

```sh
git add apps/desktop/src/App.tsx apps/desktop/test/appHarness.ts apps/desktop/test/App.test.tsx
git commit -m "feat(desktop): save documents through guarded versioned writes"
```

---

### Task 13: 冲突操作与 01 互操作

**Files:**
- Create: `apps/desktop/src/conflictActions.ts`
- Create: `apps/desktop/test/conflictActions.test.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/test/App.test.tsx`

**Interfaces:**
- Consumes: Tasks 9–12
- Produces: `ConflictActionDeps`、`makeConflictActions`

- [ ] **Step 1: 写失败的冲突操作测试**

用 Test Appendix “Task 13: 冲突操作” 的十六个可执行用例，测试名保持一致：

- `compare opens the diff panel without touching disk or state`
- `save copy keeps the original path, version, and conflict`
- `save copy refuses the original resolved path`
- `reload re-reads on click and asks before discarding local edits`
- `reload cancellation keeps the conflict and the local text`
- `overwrite uses the conflict version and replaces it when disk changes again`
- `recreate uses expected missing and stays in conflict when the path reappears`
- `close and discard confirms, clears recovery, and cancels safely`
- `path changed reopens only the previous resolved path after confirmation`
- `unexpected symlink offers only another path and never resets the editor`
- `permission denied offers retry, save copy, and reveal in Finder`
- `shows a background conflict as a tab badge and reveals the banner after switching`
- `accepts normalization only after a successful guarded save`
- `recomputes the local diff after a debounce instead of on every keystroke`
- `refreshes the diff when the watcher sees a newer disk snapshot`
- `save copy does not accept normalization and reload clears stale pending`

- [ ] **Step 2: 验证红**

Run: `pnpm --filter @omd/desktop test -- conflictActions.test.ts App.test.tsx`
Expected: FAIL，`makeConflictActions` 不存在。

- [ ] **Step 3: 实现操作编排**

```ts
export interface ConflictActionDeps {
  readonly services: DesktopServices
  readonly getSession: (tabId: number) => EditorSession | null
  readonly getContents: (tabId: number) => string
  readonly isDirty: (tabId: number) => boolean
  readonly saveFile: (tabId: number, trigger: SaveTrigger, mode: SaveMode) => Promise<void>
  readonly saveCopy: (tabId: number) => Promise<void>
  readonly resetFromSnapshot: (tabId: number, snapshot: ExistingDiskSnapshot) => void
  readonly setDivergence: (tabId: number, divergence: DiskDivergence) => void
  readonly clearDivergence: (tabId: number) => void
  readonly openDiff: (tabId: number) => void
  readonly closeTab: (tabId: number) => void
  readonly reportStatus: (message: string) => void
}

export function makeConflictActions(deps: ConflictActionDeps): Record<ConflictActionId, (tabId: number) => void | Promise<void>>
```

要点：`reloadDisk` 点击时重新 `readDocument`（不用可能过期的 snapshot），dirty 需 discard 确认，missing 转 deleted conflict，确认后复用 01 的 reset 顺序并清 recovery 与旧 pending；`overwriteDisk` 用冲突 snapshot 的 version 作 expected，再变化就用新 typed result 原子替换 divergence；`keepCurrent` 在本地 clean 时把 `externalChanged` 转成 `contentConflict` 并保持 autosave 暂停；`reopenPrevious` 只用 session version 里的旧 resolved path，dirty 先确认，绝不采纳新 symlink identity；`chooseAnotherPath` 只改目标不 reset EditorState；`closeDiscard` 二次确认后关闭并清该 tab recovery。

- [ ] **Step 4: 接线 diff 面板刷新**

diff 的 local 一侧随编辑重算，但必须 debounce（常量 `DIFF_RECOMPUTE_MS = 150`），不得每次 keystroke 同步重算。watcher 在面板打开期间取到更新的 disk snapshot 时，替换 divergence 里的 snapshot 并把面板的 `refreshed` 置真；`pathChanged` 与 unexpected symlink 没有 snapshot，面板不打开也不刷新。

- [ ] **Step 5: 实现 normalization 互操作**

Overwrite/Recreate/普通保存成功后才 accept pending normalization（沿用 01 的 capture 与 `isCurrentNormalizationTarget`）；Save copy 不 accept；Reload/Discard 清旧 pending 并允许新 EditorState 重新检测；conflict 与 failed 一律保留 pending。`canAutosave` 已经统一判定，禁止在 effect 中另加分散判断。

- [ ] **Step 6: 复核 App 体积与限制**

```sh
python3 -c 'from pathlib import Path; bad=[(str(p), sum(1 for _ in p.open())) for p in Path("apps/desktop/src").rglob("*") if p.is_file() and sum(1 for _ in p.open()) >= 800]; assert not bad, bad'
```

Expected: 退出码 0。若 `App.tsx` 逼近上限，把剩余编排移入 `conflictActions.ts`，不要放宽约束。

- [ ] **Step 7: 验证绿**

```sh
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: 全部 PASS。

- [ ] **Step 8: Suggested commit**

```sh
git add apps/desktop/src/conflictActions.ts apps/desktop/src/App.tsx apps/desktop/test/conflictActions.test.ts apps/desktop/test/App.test.tsx
git commit -m "feat(desktop): resolve save conflicts without silent overwrite"
```

---

### Task 14: 文档与最终验证

**Files:**
- Modify: `apps/desktop/AGENTS.md`
- Modify: `docs/memory/known-gotchas.md`
- Modify: `docs/manual-qa.md`
- Modify: `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

**Interfaces:**
- Consumes: Tasks 1–13 的最终行为
- Produces: 永久约束与验收门

- [ ] **Step 1: 更新域指南**

`apps/desktop/AGENTS.md` 记录：Markdown 文档 IO 只能走 `readDocument` / `readDocumentVersion` / `saveDocument`；watcher 只是提前通知、不是真相边界；session baseline 只能原子更新；autosave 判定只有 `canAutosave` 一个入口。

- [ ] **Step 2: 记录永久 gotcha**

`docs/memory/known-gotchas.md` 补：guarded-save 是双比较 + 原子替换，不是严格 CAS，最后一次比较与 persist 之间存在 residual race；expected version 绑定 resolved path，symlink 改指返回 PathChanged 而非覆盖；missing 发布用同文件系统 hard-link，崩溃可能遗留一个临时 link；父目录 fsync 失败只是 durability warning。

- [ ] **Step 3: 补手动 QA**

把规格的 18 条手动 QA 全部写入 `docs/manual-qa.md`，含 symlink、Finder tags、权限、双标签、Cmd+S 聚焦、VoiceOver 与中文/IME。

- [ ] **Step 4: 更新父设计数据流**

```text
open → readDocument(version) → edit → save_document(expected)
  ├─ Saved      → 原子更新 baseline/version
  └─ Conflict   → 非模态 banner
        ├─ Compare / Save copy（不改原 tab）
        └─ Reload / Overwrite / Recreate（重新比较版本）
```

- [ ] **Step 5: 扫描计划与 diff**

```sh
rg -n "T[B]D|T[O]DO|implement later|适当处理|待补充" docs/superpowers/plans/2026-08-13-02-conflict-safe-save*.md
git diff --check
```

Expected: 无匹配；diff check 退出码 0。

- [ ] **Step 6: 跑完整自动化验证**

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm test
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: 四条命令全部退出码 0。逐条对照规格三张测试矩阵与实际测试名，确认没有遗漏项再宣布覆盖完成。

- [ ] **Step 7: 执行目标手动 QA**

`pnpm dev` 后实际执行新增手动用例（含外部编辑器、删除、symlink、Finder tags、VoiceOver、IME），记录真实结果。未实际运行的项不得标记通过。

- [ ] **Step 8: 复核最终 diff**

确认：没有无条件覆盖 API；冲突/失败不更新 baseline 也不清 recovery；无 mutation；无未处理的保存/recovery rejection；无错误 view dispatch；所有控件有文本可访问名称；函数与文件仍在限制内。

- [ ] **Step 9: Suggested commit**

```sh
git add apps/desktop/AGENTS.md docs/memory/known-gotchas.md docs/manual-qa.md docs/superpowers/specs/2026-08-10-oh-my-md-design.md
git commit -m "docs: document conflict-safe guarded save"
```

---

## Execution Handoff

按 Task 1–14 顺序执行；Rust（1–5）可与 Desktop 纯函数（6–10）并行审阅，但 Task 12 之前必须先完成 6–11。推荐 `superpowers:subagent-driven-development`，每个 Task 一个新 subagent，完成后做规格一致性与代码质量两段复核。
