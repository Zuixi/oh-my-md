use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

mod coordinator;
mod save;

pub(crate) use coordinator::resolve_path_key;
pub use coordinator::DocumentCoordinator;
pub(crate) use save::guarded_save;
#[cfg(test)]
pub(crate) use save::{copy_metadata, guarded_save_with_hook, sync_parent};

const FINGERPRINT_PREFIX: &str = "v1:";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub resolved_path: String,
    pub fingerprint: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFileStats {
    pub byte_length: u64,
    pub line_count: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiskSnapshot {
    #[serde(rename_all = "camelCase")]
    Missing { requested_path: String },
    #[serde(rename_all = "camelCase")]
    Existing {
        requested_path: String,
        contents: String,
        version: DocumentVersion,
        stats: DocumentFileStats,
    },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExistingDiskSnapshot {
    pub requested_path: String,
    pub contents: String,
    pub version: DocumentVersion,
    pub stats: DocumentFileStats,
}

/// Metadata-only probe (Spec 05b): lets the frontend tier its open policy
/// (confirm / safe mode / read-only) before paying the full read + IPC.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentStat {
    #[serde(rename_all = "camelCase")]
    Missing { requested_path: String },
    #[serde(rename_all = "camelCase")]
    Existing {
        requested_path: String,
        size_bytes: u64,
    },
}

/// Spec 05b LARGE 档流式打开：内容按块经 Channel 推送，invoke 只回元数据。
/// 单块大小是 Rust→前端负载整形参数，不与 TS 侧共享契约。
pub const OPEN_CHUNK_BYTES: usize = 512 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenStreamEvent {
    #[serde(rename_all = "camelCase")]
    Progress { bytes_read: u64, byte_length: u64 },
    #[serde(rename_all = "camelCase")]
    Chunk { index: u64, text: String },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocumentOpenStream {
    #[serde(rename_all = "camelCase")]
    Missing { requested_path: String },
    #[serde(rename_all = "camelCase")]
    Existing {
        requested_path: String,
        version: DocumentVersion,
        stats: DocumentFileStats,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExpectedDocumentVersion {
    Missing,
    Existing { version: DocumentVersion },
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SaveDurability {
    Durable,
    DirectorySyncFailed,
}

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
    #[serde(rename_all = "camelCase")]
    DeletedConflict {
        requested_path: String,
    },
    CreatedConflict {
        disk: ExistingDiskSnapshot,
    },
    #[serde(rename_all = "camelCase")]
    PathChangedConflict {
        requested_path: String,
    },
    #[serde(rename_all = "camelCase")]
    UnexpectedSymlinkConflict {
        requested_path: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum VersionCheck {
    Match,
    Conflict(SaveDocumentResult),
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum DocumentError {
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    NotUtf8(String),
    #[error("{0}")]
    ReadFailed(String),
    #[error("{0}")]
    WriteFailed(String),
    #[error("{0}")]
    PermissionDenied(String),
    #[error("{0}")]
    MetadataFailed(String),
    #[error("{0}")]
    Internal(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DiskProbe {
    Missing,
    Existing {
        snapshot: ExistingDiskSnapshot,
        node_is_symlink: bool,
    },
    DanglingSymlink,
}

enum RawDiskProbe {
    Missing,
    DanglingSymlink,
    Existing {
        requested_path: String,
        resolved_path: String,
        bytes: Vec<u8>,
        node_is_symlink: bool,
    },
}

pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    format!("{FINGERPRINT_PREFIX}{}", blake3::hash(bytes).to_hex())
}

/// Line separator count matching CM's `DefaultSplit` (`/\r\n?|\n/`): every `\n`
/// is a separator and so is a lone `\r` (not followed by `\n`). `pending_cr`
/// carries a chunk-trailing `\r` across streaming chunk boundaries.
fn count_line_separators(bytes: &[u8], pending_cr: bool) -> (u64, bool) {
    let mut separators = 0u64;
    let mut pending_cr = pending_cr;
    for &byte in bytes {
        match byte {
            b'\r' => {
                separators += 1;
                pending_cr = true;
            }
            b'\n' if pending_cr => pending_cr = false,
            b'\n' => separators += 1,
            _ => pending_cr = false,
        }
    }
    (separators, pending_cr)
}

/// Line count with the same convention as CM's `doc.lines` (empty text = 1).
/// Same pass as the fingerprint read, so stats add no IO.
pub(crate) fn count_lines(bytes: &[u8]) -> u64 {
    count_line_separators(bytes, false).0 + 1
}

pub(crate) fn validate_requested(path: &str) -> Result<PathBuf, DocumentError> {
    let path_buf = PathBuf::from(path);
    if !path_buf.is_absolute() {
        return Err(invalid_path("document path must be absolute"));
    }
    if path_buf
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(invalid_path(
            "document path must not contain traversal components",
        ));
    }
    Ok(path_buf)
}

pub(crate) fn compare_expected(
    expected: &ExpectedDocumentVersion,
    probe: &DiskProbe,
    requested_path: &str,
) -> VersionCheck {
    match (expected, probe) {
        (ExpectedDocumentVersion::Missing, DiskProbe::Missing) => VersionCheck::Match,
        (
            ExpectedDocumentVersion::Missing,
            DiskProbe::Existing {
                snapshot,
                node_is_symlink: false,
            },
        ) => VersionCheck::Conflict(SaveDocumentResult::CreatedConflict {
            disk: snapshot.clone(),
        }),
        (ExpectedDocumentVersion::Missing, DiskProbe::Existing { .. })
        | (ExpectedDocumentVersion::Missing, DiskProbe::DanglingSymlink) => {
            VersionCheck::Conflict(SaveDocumentResult::UnexpectedSymlinkConflict {
                requested_path: requested_path.to_owned(),
            })
        }
        (ExpectedDocumentVersion::Existing { .. }, DiskProbe::Missing) => {
            VersionCheck::Conflict(SaveDocumentResult::DeletedConflict {
                requested_path: requested_path.to_owned(),
            })
        }
        (ExpectedDocumentVersion::Existing { .. }, DiskProbe::DanglingSymlink) => {
            VersionCheck::Conflict(SaveDocumentResult::PathChangedConflict {
                requested_path: requested_path.to_owned(),
            })
        }
        (ExpectedDocumentVersion::Existing { version }, DiskProbe::Existing { snapshot, .. }) => {
            if version.resolved_path != snapshot.version.resolved_path {
                VersionCheck::Conflict(SaveDocumentResult::PathChangedConflict {
                    requested_path: requested_path.to_owned(),
                })
            } else if version.fingerprint != snapshot.version.fingerprint {
                VersionCheck::Conflict(SaveDocumentResult::ContentConflict {
                    disk: snapshot.clone(),
                })
            } else {
                VersionCheck::Match
            }
        }
    }
}

pub(crate) fn probe_disk(path: &Path) -> Result<DiskProbe, DocumentError> {
    match probe_disk_raw(path)? {
        RawDiskProbe::Missing => Ok(DiskProbe::Missing),
        RawDiskProbe::DanglingSymlink => Ok(DiskProbe::DanglingSymlink),
        RawDiskProbe::Existing {
            requested_path,
            resolved_path,
            bytes,
            node_is_symlink,
        } => {
            let fingerprint_value = fingerprint(&bytes);
            let stats = DocumentFileStats {
                byte_length: bytes.len() as u64,
                line_count: count_lines(&bytes),
            };
            let contents = String::from_utf8(bytes)
                .map_err(|_| not_utf8("document bytes are not valid UTF-8"))?;
            Ok(DiskProbe::Existing {
                snapshot: ExistingDiskSnapshot {
                    requested_path,
                    contents,
                    version: DocumentVersion {
                        resolved_path,
                        fingerprint: fingerprint_value,
                    },
                    stats,
                },
                node_is_symlink,
            })
        }
    }
}

pub(crate) fn read_document_blocking(path: &str) -> Result<DiskSnapshot, DocumentError> {
    let requested_path = path.to_owned();
    let path_buf = validate_requested(path)?;
    match probe_disk(&path_buf)? {
        DiskProbe::Missing => Ok(DiskSnapshot::Missing { requested_path }),
        DiskProbe::DanglingSymlink => Err(read_failed("symbolic link target is missing")),
        DiskProbe::Existing { snapshot, .. } => Ok(DiskSnapshot::Existing {
            requested_path: snapshot.requested_path,
            contents: snapshot.contents,
            version: snapshot.version,
            stats: snapshot.stats,
        }),
    }
}

fn stat_document_blocking(path: &str) -> Result<DocumentStat, DocumentError> {
    let requested_path = path.to_owned();
    let path_buf = validate_requested(path)?;
    // Parity with probe_disk_raw: a missing node is a normal answer, not an
    // error; dangling symlinks report Missing because opening them will fail
    // the versioned read anyway.
    let node_metadata = match std::fs::symlink_metadata(&path_buf) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DocumentStat::Missing { requested_path })
        }
        Err(error) => return Err(map_read_io_error(&path_buf, error)),
    };
    let target = if node_metadata.file_type().is_symlink() {
        match std::fs::canonicalize(&path_buf) {
            Ok(resolved) => resolved,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(DocumentStat::Missing { requested_path })
            }
            Err(error) => return Err(map_read_io_error(&path_buf, error)),
        }
    } else {
        path_buf
    };
    let metadata = std::fs::metadata(&target).map_err(|error| map_read_io_error(&target, error))?;
    Ok(DocumentStat::Existing {
        requested_path,
        size_bytes: metadata.len(),
    })
}

/// stat 优先版本探测缓存（Spec 05b §14.9 后续项）：后台 poll / watcher 每
/// 轮都会探测每个打开的 tab，若每次都整读 + blake3，50MB 文件会持续产生
/// IO 与分配压力。缓存按「请求路径 → (mtime_ns, size, version)」记录上次
/// 探测结果：stat 的 (mtime_ns, size) 与缓存一致 → 直接返回缓存的
/// DocumentVersion（不读文件）；不一致 → 现行整读 + blake3 后回填。
/// 没有 TTL / 显式失效——stat 一致性即契约。已接受的残余风险：粗 mtime
/// 粒度的文件系统（如 HFS+ 的 1s）上，同一时间戳内的同尺寸外部写入会漏检，
/// 直到下一次 stat 变化才可见（APFS/ext4/NTFS 均为纳秒/100ns 粒度）；
/// 同理，符号链接改指到 (mtime_ns, size) 恰好完全相同的另一文件也会漏检。
#[derive(Clone, Default)]
pub struct DocumentVersionCache {
    entries: Arc<Mutex<HashMap<PathBuf, CachedVersionStat>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CachedVersionStat {
    mtime_ns: u64,
    size: u64,
    version: DocumentVersion,
}

/// 从目标元数据提取缓存判定键 (mtime_ns, size)。`modified()` 不可用的平台
/// 返回 None：缓存旁路，退回整读。
fn stat_cache_key(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    let mtime_ns = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        // 早于 UNIX_EPOCH 的怪异时间戳按 0 处理：两个不同的 pre-epoch mtime
        // 会塌缩成同一键，size 再相等时将误命中缓存（拿到旧版本）而非多读。
        .unwrap_or(0);
    Some((mtime_ns, metadata.len()))
}

/// 纯判定：磁盘 stat 与缓存条目是否一致（mtime_ns 与 size 都相等）。
fn version_stat_matches(entry: &CachedVersionStat, mtime_ns: u64, size: u64) -> bool {
    entry.mtime_ns == mtime_ns && entry.size == size
}

fn evict_cached_version(cache: &DocumentVersionCache, path: &Path) {
    let mut entries = cache
        .entries
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.remove(path);
}

pub(crate) fn read_document_version_cached(
    cache: &DocumentVersionCache,
    path: &str,
) -> Result<ExpectedDocumentVersion, DocumentError> {
    let path_buf = validate_requested(path)?;
    // 存在性/符号链接判定与 probe_disk_raw 一致；额外要求先取目标元数据
    // 做 stat 命中判断。文件缺失是正常答案，同时清掉缓存条目（文件删了
    // 条目就该走，避免跨大量文件无界增长）。
    let node_metadata = match std::fs::symlink_metadata(&path_buf) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            evict_cached_version(cache, &path_buf);
            return Ok(ExpectedDocumentVersion::Missing);
        }
        Err(error) => return Err(map_read_io_error(&path_buf, error)),
    };
    let node_is_symlink = node_metadata.file_type().is_symlink();
    let resolved = match std::fs::canonicalize(&path_buf) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound && node_is_symlink => {
            evict_cached_version(cache, &path_buf);
            return Err(read_failed("symbolic link target is missing"));
        }
        Err(error) => return Err(map_read_io_error(&path_buf, error)),
    };
    let resolved_path = path_to_string(&resolved)?;
    let metadata =
        std::fs::metadata(&resolved).map_err(|error| map_read_io_error(&path_buf, error))?;
    let Some((mtime_ns, size)) = stat_cache_key(&metadata) else {
        // 拿不到可靠 mtime：不查缓存也不回填，退化为现行整读。
        let version = probe_version_uncached(&resolved, &resolved_path, &path_buf)?;
        return Ok(ExpectedDocumentVersion::Existing { version });
    };

    // 命中路径：锁内只查表 + 克隆，不做任何 IO。stat 之后文件才被改写的
    // 窗口由下一轮探测的 stat 不匹配兜底。
    {
        let entries = cache
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = entries.get(&path_buf) {
            if version_stat_matches(entry, mtime_ns, size) {
                return Ok(ExpectedDocumentVersion::Existing {
                    version: entry.version.clone(),
                });
            }
        }
    }

    // 未命中：整读 + blake3。两个并发探测可能同时走到这里——重复读是幂等
    // 的，各自回填经自身 stat 校验的配对，无害。
    let version = probe_version_uncached(&resolved, &resolved_path, &path_buf)?;
    // 读后 re-stat（double-check）：只有读前读后 stat 一致才回填。读到一半
    // 被外部改写时 (stat → version) 配对不可信，宁可下次多读一次也不缓存
    // 错配条目（错配只可能导致多余 miss，不会导致错误 hit）。
    if let Ok(after) = std::fs::metadata(&resolved) {
        if let Some((mtime_ns_after, size_after)) = stat_cache_key(&after) {
            if mtime_ns_after == mtime_ns && size_after == size {
                let mut entries = cache
                    .entries
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                entries.insert(
                    path_buf,
                    CachedVersionStat {
                        mtime_ns,
                        size,
                        version: version.clone(),
                    },
                );
            }
        }
    }
    Ok(ExpectedDocumentVersion::Existing { version })
}

fn probe_version_uncached(
    resolved: &Path,
    resolved_path: &str,
    error_path: &Path,
) -> Result<DocumentVersion, DocumentError> {
    let bytes = std::fs::read(resolved).map_err(|error| map_read_io_error(error_path, error))?;
    Ok(DocumentVersion {
        resolved_path: resolved_path.to_owned(),
        fingerprint: fingerprint(&bytes),
    })
}

pub(crate) async fn spawn_blocking_document<T, F>(task: F) -> Result<T, DocumentError>
where
    F: FnOnce() -> Result<T, DocumentError> + Send + 'static,
    T: Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(result) => result,
        Err(error) => {
            eprintln!("[documents] blocking task failed: {error}");
            Err(DocumentError::Internal(
                "the document task did not finish".into(),
            ))
        }
    }
}

#[tauri::command]
pub async fn read_document(path: String) -> Result<DiskSnapshot, DocumentError> {
    spawn_blocking_document(move || read_document_blocking(&path)).await
}

#[tauri::command]
pub async fn stat_document(path: String) -> Result<DocumentStat, DocumentError> {
    spawn_blocking_document(move || stat_document_blocking(&path)).await
}

/// Streaming read for the LARGE open tier: content is pushed in UTF-8-safe
/// chunks with byte progress; the invoke resolves with version + stats so the
/// frontend can reuse the existing snapshot pipeline once assembly finishes.
#[tauri::command]
pub async fn read_document_streaming(
    path: String,
    on_chunk: tauri::ipc::Channel<OpenStreamEvent>,
) -> Result<DocumentOpenStream, DocumentError> {
    spawn_blocking_document(move || {
        read_document_streaming_blocking(&path, OPEN_CHUNK_BYTES, &|event| {
            let _ = on_chunk.send(event);
        })
    })
    .await
}

pub(crate) fn read_document_streaming_blocking(
    path: &str,
    chunk_size: usize,
    on_event: &dyn Fn(OpenStreamEvent),
) -> Result<DocumentOpenStream, DocumentError> {
    let requested_path = path.to_owned();
    let path_buf = validate_requested(path)?;
    let metadata = match std::fs::symlink_metadata(&path_buf) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DocumentOpenStream::Missing { requested_path })
        }
        Err(error) => return Err(map_read_io_error(&path_buf, error)),
    };
    let node_is_symlink = metadata.file_type().is_symlink();
    let resolved = match std::fs::canonicalize(&path_buf) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound && node_is_symlink => {
            return Err(read_failed("symbolic link target is missing"))
        }
        Err(error) => return Err(map_read_io_error(&path_buf, error)),
    };
    let resolved_path = path_to_string(&resolved)?;
    let mut file =
        std::fs::File::open(&resolved).map_err(|error| map_read_io_error(&path_buf, error))?;
    let byte_length = file
        .metadata()
        .map_err(|error| map_read_io_error(&path_buf, error))?
        .len();

    let mut hasher = blake3::Hasher::new();
    let mut newline_count: u64 = 0;
    // Chunk-trailing `\r` whose separator decision (lone vs `\r\n`) belongs to
    // the next chunk's first byte.
    let mut cr_pending = false;
    let mut bytes_read: u64 = 0;
    let mut carry: Vec<u8> = Vec::new();
    let mut index: u64 = 0;
    let mut buf = vec![0u8; chunk_size.max(1)];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|error| map_read_io_error(&path_buf, error))?;
        if read == 0 {
            break;
        }
        let bytes = &buf[..read];
        hasher.update(bytes);
        let (separators, pending) = count_line_separators(bytes, cr_pending);
        newline_count += separators;
        cr_pending = pending;
        bytes_read += read as u64;
        carry.extend_from_slice(bytes);
        // 回退到 UTF-8 字符边界：块尾落在多字节序列中间时把残缺序列留给
        // 下一块。先跳过尾部 continuation 字节；若随后停在前导字节上，它的
        // continuation 已被排除，前导也必须一并扣留（宁可多留一字节到下块）。
        let mut send_len = carry.len();
        while send_len > 0 && carry[send_len - 1] & 0b1100_0000 == 0b1000_0000 {
            send_len -= 1;
        }
        if send_len > 0 && carry[send_len - 1] & 0b1100_0000 == 0b1100_0000 {
            send_len -= 1;
        }
        if send_len == 0 {
            continue;
        }
        let text = match std::str::from_utf8(&carry[..send_len]) {
            Ok(text) => text.to_owned(),
            Err(_) => return Err(not_utf8("document bytes are not valid UTF-8")),
        };
        carry.drain(..send_len);
        on_event(OpenStreamEvent::Chunk { index, text });
        index += 1;
        on_event(OpenStreamEvent::Progress {
            bytes_read,
            byte_length,
        });
    }
    if !carry.is_empty() {
        let text = match std::str::from_utf8(&carry) {
            Ok(text) => text.to_owned(),
            Err(_) => return Err(not_utf8("document bytes are not valid UTF-8")),
        };
        on_event(OpenStreamEvent::Chunk { index, text });
    }
    let version = DocumentVersion {
        resolved_path,
        fingerprint: format!("{FINGERPRINT_PREFIX}{}", hasher.finalize().to_hex()),
    };
    let stats = DocumentFileStats {
        byte_length: bytes_read,
        line_count: newline_count + 1,
    };
    Ok(DocumentOpenStream::Existing {
        requested_path,
        version,
        stats,
    })
}

#[tauri::command]
pub async fn read_document_version(
    version_cache: tauri::State<'_, DocumentVersionCache>,
    path: String,
) -> Result<ExpectedDocumentVersion, DocumentError> {
    let version_cache = version_cache.inner().clone();
    spawn_blocking_document(move || read_document_version_cached(&version_cache, &path)).await
}

#[tauri::command]
pub async fn save_document(
    coordinator: tauri::State<'_, DocumentCoordinator>,
    path: String,
    contents: String,
    expected: ExpectedDocumentVersion,
) -> Result<SaveDocumentResult, DocumentError> {
    let coordinator = coordinator.inner().clone();
    spawn_blocking_document(move || guarded_save(&coordinator, &path, &contents, &expected)).await
}

fn probe_disk_raw(path: &Path) -> Result<RawDiskProbe, DocumentError> {
    let requested_path = path_to_string(path)?;
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RawDiskProbe::Missing);
        }
        Err(error) => return Err(map_read_io_error(path, error)),
    };
    let node_is_symlink = metadata.file_type().is_symlink();
    let resolved = match std::fs::canonicalize(path) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound && node_is_symlink => {
            return Ok(RawDiskProbe::DanglingSymlink);
        }
        Err(error) => return Err(map_read_io_error(path, error)),
    };
    let resolved_path = path_to_string(&resolved)?;
    let bytes = std::fs::read(&resolved).map_err(|error| map_read_io_error(path, error))?;
    Ok(RawDiskProbe::Existing {
        requested_path,
        resolved_path,
        bytes,
        node_is_symlink,
    })
}

fn path_to_string(path: &Path) -> Result<String, DocumentError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid_path("document path is not valid UTF-8"))
}

fn invalid_path(message: &str) -> DocumentError {
    DocumentError::InvalidPath(message.into())
}

fn not_utf8(message: &str) -> DocumentError {
    DocumentError::NotUtf8(message.into())
}

fn read_failed(message: &str) -> DocumentError {
    DocumentError::ReadFailed(message.into())
}

fn map_read_io_error(path: &Path, error: io::Error) -> DocumentError {
    eprintln!("[documents] read io error: path={path:?} error={error}");
    if error.kind() == io::ErrorKind::PermissionDenied {
        DocumentError::PermissionDenied(error.to_string())
    } else {
        DocumentError::ReadFailed(error.to_string())
    }
}

#[cfg(test)]
mod tests;
