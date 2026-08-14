use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use super::{
    compare_expected, fingerprint, probe_disk, resolve_path_key, validate_requested, DiskProbe,
    DocumentCoordinator, DocumentError, DocumentVersion, ExistingDiskSnapshot,
    ExpectedDocumentVersion, SaveDocumentResult, SaveDurability, VersionCheck,
};

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
    let path_buf = validate_requested(path)?;
    let path_key = resolve_path_key(&path_buf)?;
    let lock = coordinator.lock_for(&path_key);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let first_probe = probe_disk(&path_buf)?;
    if let VersionCheck::Conflict(result) = compare_expected(expected, &first_probe, path) {
        return Ok(result);
    }

    match first_probe {
        DiskProbe::Missing => create_missing(&path_buf, path, contents, expected, hook),
        DiskProbe::Existing { snapshot, .. } => {
            replace_existing(&path_buf, path, &snapshot, contents, expected, hook)
        }
        DiskProbe::DanglingSymlink => Err(DocumentError::Internal(
            "unexpected dangling symlink after a matching compare".into(),
        )),
    }
}

pub(crate) fn copy_metadata(_source: &Path, _dest: &Path) -> Result<(), DocumentError> {
    Ok(())
}

pub(crate) fn sync_parent(parent: &Path) -> SaveDurability {
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

    temp.persist(&resolved_target)
        .map_err(|error| map_write_io_error(requested_path, error.error))?;

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
