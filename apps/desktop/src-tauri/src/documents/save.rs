use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::{
    compare_expected, fingerprint, probe_disk, resolve_path_key, validate_requested, DiskProbe,
    DocumentCoordinator, DocumentError, DocumentVersion, ExistingDiskSnapshot,
    ExpectedDocumentVersion, SaveDocumentResult, SaveDurability, VersionCheck,
};
use crate::logging::path_field;

pub(crate) fn guarded_save(
    coordinator: &DocumentCoordinator,
    path: &str,
    contents: &str,
    expected: &ExpectedDocumentVersion,
) -> Result<SaveDocumentResult, DocumentError> {
    guarded_save_with_hook(coordinator, path, contents, expected, &|| {})
}

pub(crate) fn guarded_save_with_hook(
    coordinator: &DocumentCoordinator,
    path: &str,
    contents: &str,
    expected: &ExpectedDocumentVersion,
    hook: &(dyn Fn() + Sync),
) -> Result<SaveDocumentResult, DocumentError> {
    // Rendered once from the requested string, so one helper escapes every
    // boundary line — the begin, both terminal successes, and the failure.
    // `validate_requested` does not normalize, so this is byte-identical to the
    // parsed buffer's field and is available even when parsing fails.
    let field = path_field(Path::new(path));

    // Every document write, from every route, passes through here. The whole
    // fallible body — validation, path resolution, the probes, metadata copy,
    // and the writes — sits in one block so *every* `Err` leaves a terminal
    // line. A pre-write failure used to leave nothing at all (validation and
    // `resolve_path_key`) or a dangling `save begin` (`probe_disk`: a document
    // changed externally to non-UTF-8 never reaches the write), and the user
    // sees only the save-failed banner.
    let result = 'save: {
        let path_buf = match validate_requested(path) {
            Ok(path_buf) => path_buf,
            Err(error) => break 'save Err(error),
        };
        let path_key = match resolve_path_key(&path_buf) {
            Ok(path_key) => path_key,
            Err(error) => break 'save Err(error),
        };
        let lock = coordinator.lock_for(&path_key);
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        // Written after the per-path lock, so the begin line orders the attempt
        // rather than the queueing.
        log::info!("save begin {field}");

        let probe = match probe_disk(&path_buf) {
            Ok(probe) => probe,
            Err(error) => break 'save Err(error),
        };
        if let VersionCheck::Conflict(result) = compare_expected(expected, &probe, path) {
            // A conflict is a user-visible state transition, not a failure: the
            // guarded write declined to overwrite and nothing was written.
            log::info!("save conflict {field}");
            break 'save Ok(result);
        }

        match probe {
            DiskProbe::Missing => create_missing(&path_buf, path, contents, expected, hook),
            DiskProbe::Existing { snapshot, .. } => {
                replace_existing(&path_buf, path, &snapshot, contents, expected, hook)
            }
            DiskProbe::DanglingSymlink => Err(DocumentError::Internal(
                "unexpected dangling symlink after a matching compare".into(),
            )),
        }
    };

    match result {
        Ok(SaveDocumentResult::Saved { .. }) => {
            log::info!("save ok {field} bytes={}", contents.len());
            result
        }
        // The second compare inside the write can still find a conflict; the
        // write is abandoned with nothing published, so this is not a failure.
        Ok(result) => {
            log::info!("save conflict {field}");
            Ok(result)
        }
        // One arm for every failure, and the only `error` line this module
        // writes: an `Err` must never leave the log silent or a bare begin.
        Err(error) => {
            log::error!("save failed {field} error={error}");
            Err(error)
        }
    }
}

/// The log target this module's boundary lines carry, exposed so a test can
/// filter the facade capture by it. `env!("CARGO_PKG_NAME")` is the bin name
/// (`omd`), not the lib name (`omd_lib`) `module_path!()` reports.
#[cfg(test)]
pub(crate) fn log_target() -> &'static str {
    module_path!()
}

#[cfg(target_os = "macos")]
const REQUIRED_XATTRS: [&str; 2] = [
    "com.apple.FinderInfo",
    "com.apple.metadata:_kMDItemUserTags",
];

#[cfg(target_os = "macos")]
const SKIPPED_XATTRS: [&str; 2] = ["com.apple.quarantine", "com.apple.provenance"];

pub(crate) fn copy_metadata(source: &Path, dest: &Path) -> Result<(), DocumentError> {
    let metadata = fs::metadata(source).map_err(|error| map_metadata_error(source, error))?;
    fs::set_permissions(dest, metadata.permissions())
        .map_err(|error| map_metadata_error(dest, error))?;

    #[cfg(unix)]
    copy_xattrs(source, dest)?;

    Ok(())
}

#[cfg(unix)]
fn copy_xattrs(source: &Path, dest: &Path) -> Result<(), DocumentError> {
    let names = match xattr::list(source) {
        Ok(names) => names.collect::<Vec<_>>(),
        Err(error) => {
            eprintln!(
                "[documents] xattr list failed for {}: {error}",
                source.display()
            );
            Vec::new()
        }
    };

    for name in names {
        let name_str = name.to_string_lossy();

        #[cfg(target_os = "macos")]
        if SKIPPED_XATTRS
            .iter()
            .any(|skipped| *skipped == name_str.as_ref())
        {
            continue;
        }

        let value = match xattr::get(source, &name) {
            Ok(Some(value)) => value,
            Ok(None) => continue,
            Err(error) => {
                #[cfg(target_os = "macos")]
                if is_required_xattr(&name_str) {
                    return Err(metadata_failed(format!(
                        "failed to read required xattr {name_str} on {}: {error}",
                        source.display()
                    )));
                }
                eprintln!("[documents] xattr read failed: name={name_str} error={error}");
                continue;
            }
        };

        if let Err(error) = xattr::set(dest, &name, &value) {
            #[cfg(target_os = "macos")]
            if is_required_xattr(&name_str) {
                return Err(metadata_failed(format!(
                    "failed to write required xattr {name_str} on {}: {error}",
                    dest.display()
                )));
            }
            eprintln!("[documents] xattr write failed: name={name_str} error={error}");
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn is_required_xattr(name: &str) -> bool {
    REQUIRED_XATTRS.iter().any(|required| *required == name)
}

#[cfg(target_os = "macos")]
fn metadata_failed(message: impl Into<String>) -> DocumentError {
    DocumentError::MetadataFailed(message.into())
}

fn map_metadata_error(path: &Path, error: io::Error) -> DocumentError {
    eprintln!("[documents] metadata error: path={path:?} error={error}");
    if error.kind() == io::ErrorKind::PermissionDenied {
        DocumentError::PermissionDenied(error.to_string())
    } else {
        DocumentError::MetadataFailed(error.to_string())
    }
}

pub(crate) fn sync_parent(parent: &Path) -> SaveDurability {
    // On Windows, FlushFileBuffers (called by sync_all) requires write access
    // to the handle, but directories cannot be opened with write access, so a
    // real directory sync is not available. NTFS already provides strong
    // durability guarantees, so a present directory is treated as durable.
    // A missing directory still downgrades: durability cannot be guaranteed if
    // the parent does not exist.
    #[cfg(windows)]
    {
        if !parent.is_dir() {
            eprintln!("[documents] parent sync failed for {}", parent.display());
            return SaveDurability::DirectorySyncFailed;
        }
        SaveDurability::Durable
    }
    #[cfg(not(windows))]
    match File::open(parent).and_then(|dir| dir.sync_all()) {
        Ok(()) => SaveDurability::Durable,
        Err(error) => {
            eprintln!(
                "[documents] parent sync failed for {}: {error}",
                parent.display()
            );
            SaveDurability::DirectorySyncFailed
        }
    }
}

fn replace_existing(
    requested_path: &Path,
    requested_path_str: &str,
    snapshot: &ExistingDiskSnapshot,
    contents: &str,
    expected: &ExpectedDocumentVersion,
    hook: &(dyn Fn() + Sync),
) -> Result<SaveDocumentResult, DocumentError> {
    let resolved_target = PathBuf::from(&snapshot.version.resolved_path);
    let parent = resolved_target
        .parent()
        .ok_or_else(|| invalid_path("resolved target has no parent directory"))?;

    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| map_write_io_error(requested_path, error))?;
    temp.write_all(contents.as_bytes())
        .map_err(|error| map_write_io_error(requested_path, error))?;
    copy_metadata(&resolved_target, temp.path())?;
    temp.flush()
        .map_err(|error| map_write_io_error(requested_path, error))?;
    temp.as_file()
        .sync_all()
        .map_err(|error| map_write_io_error(requested_path, error))?;

    hook();

    let second_probe = probe_disk(requested_path)?;
    if let VersionCheck::Conflict(result) =
        compare_expected(expected, &second_probe, requested_path_str)
    {
        return Ok(result);
    }

    // The shared helper returns io::Error (including the Windows backup-rename
    // fallback), so map_write_io_error can still classify PermissionDenied for
    // the recovery UI; it also logs the requested path alongside the error.
    crate::replace_existing(temp, &resolved_target)
        .map_err(|error| map_write_io_error(requested_path, error))?;

    let resolved_path = path_to_string(&resolved_target)?;
    let durability = sync_parent(parent);
    Ok(SaveDocumentResult::Saved {
        version: saved_version(&resolved_path, contents),
        durability,
    })
}

fn create_missing(
    requested_path: &Path,
    requested_path_str: &str,
    contents: &str,
    expected: &ExpectedDocumentVersion,
    hook: &(dyn Fn() + Sync),
) -> Result<SaveDocumentResult, DocumentError> {
    let parent = requested_path
        .parent()
        .ok_or_else(|| invalid_path("document path has no parent directory"))?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_name = format!(".omd-save-{}-{}.tmp", std::process::id(), nanos);
    let temp_path = parent.join(temp_name);
    let _temp_guard = TempPath::new(temp_path.clone());

    let mut file = open_create_temp(&temp_path, requested_path)?;
    file.write_all(contents.as_bytes())
        .map_err(|error| map_write_io_error(requested_path, error))?;
    file.sync_all()
        .map_err(|error| map_write_io_error(requested_path, error))?;

    hook();

    let second_probe = probe_disk(requested_path)?;
    if let VersionCheck::Conflict(result) =
        compare_expected(expected, &second_probe, requested_path_str)
    {
        return Ok(result);
    }

    match fs::hard_link(&temp_path, requested_path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let probe = probe_disk(requested_path)?;
            return match compare_expected(expected, &probe, requested_path_str) {
                VersionCheck::Conflict(result) => Ok(result),
                VersionCheck::Match => Err(DocumentError::WriteFailed(
                    "target appeared with matching version during publish".into(),
                )),
            };
        }
        Err(error) => return Err(map_write_io_error(requested_path, error)),
    }

    let resolved = fs::canonicalize(requested_path)
        .map_err(|error| map_write_io_error(requested_path, error))?;
    let resolved_path = path_to_string(&resolved)?;
    let durability = sync_parent(parent);
    Ok(SaveDocumentResult::Saved {
        version: saved_version(&resolved_path, contents),
        durability,
    })
}

fn open_create_temp(temp_path: &Path, requested_path: &Path) -> Result<File, DocumentError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(temp_path)
            .map_err(|error| map_write_io_error(requested_path, error))
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp_path)
            .map_err(|error| map_write_io_error(requested_path, error))
    }
}

fn saved_version(resolved_path: &str, contents: &str) -> DocumentVersion {
    DocumentVersion {
        resolved_path: resolved_path.to_owned(),
        fingerprint: fingerprint(contents.as_bytes()),
    }
}

struct TempPath {
    path: PathBuf,
}

impl TempPath {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn path_to_string(path: &Path) -> Result<String, DocumentError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| invalid_path("document path is not valid UTF-8"))
}

fn invalid_path(message: &str) -> DocumentError {
    DocumentError::InvalidPath(message.into())
}

fn map_write_io_error(path: &Path, error: io::Error) -> DocumentError {
    eprintln!("[documents] write io error: path={path:?} error={error}");
    if error.kind() == io::ErrorKind::PermissionDenied {
        DocumentError::PermissionDenied(error.to_string())
    } else {
        DocumentError::WriteFailed(error.to_string())
    }
}
