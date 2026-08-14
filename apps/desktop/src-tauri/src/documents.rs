use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Component, Path, PathBuf};

const FINGERPRINT_PREFIX: &str = "v1:";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentVersion {
    pub resolved_path: String,
    pub fingerprint: String,
}

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
        }),
    }
}

pub(crate) fn read_document_version_blocking(
    path: &str,
) -> Result<ExpectedDocumentVersion, DocumentError> {
    let path_buf = validate_requested(path)?;
    match probe_disk_raw(&path_buf)? {
        RawDiskProbe::Missing => Ok(ExpectedDocumentVersion::Missing),
        RawDiskProbe::DanglingSymlink => Err(read_failed("symbolic link target is missing")),
        RawDiskProbe::Existing {
            resolved_path,
            bytes,
            ..
        } => Ok(ExpectedDocumentVersion::Existing {
            version: DocumentVersion {
                resolved_path,
                fingerprint: fingerprint(&bytes),
            },
        }),
    }
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
pub async fn read_document_version(path: String) -> Result<ExpectedDocumentVersion, DocumentError> {
    spawn_blocking_document(move || read_document_version_blocking(&path)).await
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
