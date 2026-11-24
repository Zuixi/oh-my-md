use crate::auth_scope::AccessMode;
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

mod coordinator;
mod save;
mod version_cache;

pub(crate) use coordinator::resolve_path_key;
pub use coordinator::DocumentCoordinator;
pub(crate) use save::guarded_save;
#[cfg(test)]
pub(crate) use save::{guarded_save_with_hook, sync_parent};
pub(crate) use version_cache::read_document_version_cached;
pub use version_cache::DocumentVersionCache;
// `documents/tests.rs` exercises the keying rule directly, so the pure pieces
// stay reachable through this module exactly as they were before the split.
#[cfg(test)]
pub(crate) use version_cache::{stat_cache_key, version_stat_matches, CachedVersionStat};

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

/// Files at or above this UTF-8 byte size open read-only; must match
/// `OPEN_READONLY_THRESHOLD_BYTES` in `apps/desktop/src/constants.ts`.
pub const OPEN_READONLY_THRESHOLD_BYTES: u64 = 50 * 1024 * 1024;

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

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
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

/// Whether `path` is a Markdown document (the only kind this app opens).
pub(crate) fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("md")
                || ext.eq_ignore_ascii_case("markdown")
                || ext.eq_ignore_ascii_case("mdx")
        })
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
    require_regular_file(&metadata, &target)?;
    Ok(DocumentStat::Existing {
        requested_path,
        size_bytes: metadata.len(),
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

/// A successful read/save extends the calling window's version-history scope to
/// that exact document file. Standalone files (opened outside any workspace
/// folder) then get snapshots too, while arbitrary paths stay unauthorized.
fn authorize_opened_document(window_label: &str, requested: &str, resolved: &str) {
    for path in [requested, resolved] {
        if let Err(error) =
            crate::auth_scope::authorize_document_file(window_label, Path::new(path))
        {
            log::warn!("document authorization failed: {error}");
        }
    }
}

/// Authorization gate every document command runs before touching the disk.
///
/// Reads and writes both take this path: without it a compromised webview could
/// read `~/.ssh/id_rsa` or atomically replace any file the user can write, which
/// is exactly what the per-window scope exists to prevent.
pub(crate) fn authorize_document_ipc(window_label: &str, path: &str) -> Result<(), DocumentError> {
    let path_buf = validate_requested(path)?;
    crate::auth_scope::assert_file_or_workspace_authorized(Some(window_label), &path_buf)
        .map_err(DocumentError::PermissionDenied)?;
    Ok(())
}

/// Write gate: the read authorization plus the host's own read-only verdict.
///
/// Saves go through this instead of `authorize_document_ipc`, so the read-only
/// tier is enforced where the bytes land and not only in `view.state.readOnly`.
pub(crate) fn authorize_document_write_ipc(
    window_label: &str,
    path: &str,
) -> Result<(), DocumentError> {
    let path_buf = validate_requested(path)?;
    crate::auth_scope::assert_file_writable(Some(window_label), &path_buf)
        .map_err(DocumentError::PermissionDenied)?;
    Ok(())
}

/// Mirrors the host's own size verdict into the window's write gate.
///
/// Called after every stat/read, so a document's access mode always reflects
/// the bytes the host just measured; a webview that skips the frontend open
/// policy therefore still cannot write a huge document.
fn sync_read_only_mode(
    window_label: &str,
    requested: &str,
    resolved: Option<&str>,
    size_bytes: u64,
) {
    let mode = if size_bytes >= OPEN_READONLY_THRESHOLD_BYTES {
        AccessMode::ReadOnly
    } else {
        AccessMode::ReadWrite
    };
    for path in std::iter::once(requested).chain(resolved) {
        crate::auth_scope::set_document_access_mode(window_label, Path::new(path), mode);
    }
}

#[tauri::command]
pub async fn read_document(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<DiskSnapshot, DocumentError> {
    authorize_document_ipc(window.label(), &path)?;
    let requested = path.clone();
    let snapshot = spawn_blocking_document(move || read_document_blocking(&path)).await?;
    if let DiskSnapshot::Existing { version, stats, .. } = &snapshot {
        sync_read_only_mode(
            window.label(),
            &requested,
            Some(&version.resolved_path),
            stats.byte_length,
        );
        authorize_opened_document(window.label(), &requested, &version.resolved_path);
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn stat_document(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<DocumentStat, DocumentError> {
    authorize_document_ipc(window.label(), &path)?;
    let stat = spawn_blocking_document(move || stat_document_blocking(&path)).await?;
    if let DocumentStat::Existing {
        requested_path,
        size_bytes,
    } = &stat
    {
        sync_read_only_mode(window.label(), requested_path, None, *size_bytes);
    }
    Ok(stat)
}

/// Streaming read for the LARGE open tier: content is pushed in UTF-8-safe
/// chunks with byte progress; the invoke resolves with version + stats so the
/// frontend can reuse the existing snapshot pipeline once assembly finishes.
#[tauri::command]
pub async fn read_document_streaming(
    window: tauri::WebviewWindow,
    path: String,
    on_chunk: tauri::ipc::Channel<OpenStreamEvent>,
) -> Result<DocumentOpenStream, DocumentError> {
    authorize_document_ipc(window.label(), &path)?;
    let requested = path.clone();
    let opened = spawn_blocking_document(move || {
        read_document_streaming_blocking(&path, OPEN_CHUNK_BYTES, &|event| {
            let _ = on_chunk.send(event);
        })
    })
    .await?;
    if let DocumentOpenStream::Existing { version, stats, .. } = &opened {
        sync_read_only_mode(
            window.label(),
            &requested,
            Some(&version.resolved_path),
            stats.byte_length,
        );
        authorize_opened_document(window.label(), &requested, &version.resolved_path);
    }
    Ok(opened)
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
    let (mut file, file_metadata) = open_regular_document(&resolved, &path_buf)?;
    let byte_length = file_metadata.len();

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
    window: tauri::WebviewWindow,
    path: String,
) -> Result<ExpectedDocumentVersion, DocumentError> {
    authorize_document_ipc(window.label(), &path)?;
    let version_cache = version_cache.inner().clone();
    spawn_blocking_document(move || read_document_version_cached(&version_cache, &path)).await
}

#[tauri::command]
pub async fn save_document(
    coordinator: tauri::State<'_, DocumentCoordinator>,
    window: tauri::WebviewWindow,
    path: String,
    contents: String,
    expected: ExpectedDocumentVersion,
) -> Result<SaveDocumentResult, DocumentError> {
    authorize_document_write_ipc(window.label(), &path)?;
    let coordinator = coordinator.inner().clone();
    let requested = path.clone();
    let saved =
        spawn_blocking_document(move || guarded_save(&coordinator, &path, &contents, &expected))
            .await?;
    if let SaveDocumentResult::Saved { version, .. } = &saved {
        authorize_opened_document(window.label(), &requested, &version.resolved_path);
    }
    Ok(saved)
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
    let (mut file, _metadata) = open_regular_document(&resolved, path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| map_read_io_error(path, error))?;
    Ok(RawDiskProbe::Existing {
        requested_path,
        resolved_path,
        bytes,
        node_is_symlink,
    })
}

fn require_regular_file(metadata: &std::fs::Metadata, path: &Path) -> Result<(), DocumentError> {
    if metadata.is_file() {
        return Ok(());
    }
    eprintln!("[documents] rejected non-regular file: path={path:?}");
    Err(read_failed("document path is not a regular file"))
}

/// Opens a regular document file without blocking on POSIX FIFOs or racing a
/// separate `metadata` + `read`. Character devices (`/dev/zero`), FIFOs,
/// sockets, and directories are rejected before any buffering starts.
fn open_regular_document(
    resolved: &Path,
    error_path: &Path,
) -> Result<(std::fs::File, std::fs::Metadata), DocumentError> {
    crate::scoped_io::open_regular_file(resolved).map_err(|error| {
        if error.kind() == io::ErrorKind::InvalidInput {
            eprintln!("[documents] rejected non-regular file: path={error_path:?}");
            read_failed("document path is not a regular file")
        } else {
            map_read_io_error(error_path, error)
        }
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
#[cfg(test)]
#[path = "documents/tests_auth.rs"]
mod tests_auth;
#[cfg(test)]
#[path = "documents/tests_regular_file.rs"]
mod tests_regular_file;

#[cfg(test)]
#[path = "documents/save_logging_tests.rs"]
mod save_logging_tests;
