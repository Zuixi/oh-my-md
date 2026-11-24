//! Narrow file commands for the two paths the frontend legitimately moves
//! outside the document pipeline: custom CSS in, exported HTML out.
//!
//! The previous `read_file`/`write_file` pair accepted any absolute path, so a
//! compromised webview could read (`~/.ssh/id_rsa`) or atomically replace any
//! file the user could write. Each command now pins the extension, the shape,
//! and the size cap of the one file kind it serves.

use std::io::Read;
use std::path::{Component, Path};

/// Custom CSS is a stylesheet, not a data channel: 1 MiB is far beyond any
/// hand-written theme and small enough to keep the parse synchronous-ish.
pub const MAX_CUSTOM_CSS_BYTES: u64 = 1024 * 1024;

const CSS_EXTENSION: &str = "css";
const HTML_EXTENSIONS: [&str; 2] = ["html", "htm"];

#[tauri::command]
pub async fn read_custom_css(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_custom_css_impl(&path))
        .await
        .map_err(|error| format!("read task failed: {error}"))?
}

/// Opens `path` only if it is a regular file, without blocking on POSIX FIFOs.
///
/// A plain `File::open` on a writerless named pipe (`mkfifo`) blocks forever
/// inside `open(2)` before `file.metadata()` can run, whereas checking
/// `fs::metadata` before `File::open` has a swap window. Opening with
/// `O_NONBLOCK` on Unix returns immediately, `fstat` validates the open fd, and
/// `fcntl` clears `O_NONBLOCK` before returning the handle to callers.
pub(crate) fn open_regular_file(
    path: &Path,
) -> std::io::Result<(std::fs::File, std::fs::Metadata)> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;

        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path is not a regular file",
            ));
        }
        // Clear O_NONBLOCK on the verified regular-file descriptor.
        let fd = file.as_raw_fd();
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags >= 0 {
            let _ = unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
        }
        Ok((file, metadata))
    }
    #[cfg(not(unix))]
    {
        let pre = std::fs::metadata(path)?;
        if !pre.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path is not a regular file",
            ));
        }
        let file = std::fs::File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "path is not a regular file",
            ));
        }
        Ok((file, metadata))
    }
}

fn read_custom_css_impl(path: &str) -> Result<String, String> {
    let target = Path::new(path);
    validate_target(target)?;
    if !has_extension(target, &[CSS_EXTENSION]) {
        return Err("custom CSS must use a .css extension".into());
    }
    // `theme.css` can be a symlink to any file on disk (`~/.ssh/id_rsa`), so the
    // name proves nothing. Resolve first, apply every check — extension,
    // regular file, size cap — to the resolved path, and read through the open
    // handle so a swap between validation and open cannot win the race.
    let canonical = std::fs::canonicalize(target).map_err(|e| e.to_string())?;
    if !has_extension(&canonical, &[CSS_EXTENSION]) {
        return Err("custom CSS target must use a .css extension".into());
    }
    let (file, metadata) = open_regular_file(&canonical).map_err(|e| {
        if e.kind() == std::io::ErrorKind::InvalidInput {
            "custom CSS path is not a regular file".to_string()
        } else {
            e.to_string()
        }
    })?;
    if metadata.len() > MAX_CUSTOM_CSS_BYTES {
        return Err(format!(
            "custom CSS exceeds the {} byte size limit",
            MAX_CUSTOM_CSS_BYTES
        ));
    }
    let mut contents = String::new();
    file.take(MAX_CUSTOM_CSS_BYTES + 1)
        .read_to_string(&mut contents)
        .map_err(|e| e.to_string())?;
    if contents.len() as u64 > MAX_CUSTOM_CSS_BYTES {
        return Err(format!(
            "custom CSS exceeds the {} byte size limit",
            MAX_CUSTOM_CSS_BYTES
        ));
    }
    Ok(contents)
}

#[tauri::command]
pub async fn write_exported_html(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_exported_html_impl(&path, contents))
        .await
        .map_err(|error| format!("write task failed: {error}"))?
}

fn write_exported_html_impl(path: &str, contents: String) -> Result<(), String> {
    let target = Path::new(path);
    validate_target(target)?;
    if !has_extension(target, &HTML_EXTENSIONS) {
        // Never guess an extension: a stray extension would make the file open
        // in an unrelated handler on every platform.
        return Err("exported HTML must use a .html or .htm extension".into());
    }
    // `atomic_write` renames onto the target, so a pre-existing symlink would
    // overwrite whatever it points at instead of creating the export. An export
    // target is always a fresh file, never a link.
    if let Ok(existing) = std::fs::symlink_metadata(target) {
        if existing.file_type().is_symlink() {
            return Err("exported HTML path must not be a symlink".into());
        }
        if existing.is_dir() {
            return Err("exported HTML path is a directory".into());
        }
    }
    if contents.len() > crate::export::MAX_EXPORT_HTML_BYTES {
        return Err(format!(
            "export HTML exceeds the {} byte size limit",
            crate::export::MAX_EXPORT_HTML_BYTES
        ));
    }
    // `atomic_write` stages its temp file inside the parent, so a missing
    // directory must fail before anything is created.
    if !target.parent().is_some_and(Path::is_dir) {
        return Err("exported HTML directory does not exist".into());
    }
    crate::atomic_write(target, contents.as_bytes())
}

/// Absolute path with no `.`/`..` components. The save dialog already returns
/// such a path, so anything else is a caller bug or an injection attempt.
pub(crate) fn validate_target(target: &Path) -> Result<(), String> {
    if !target.is_absolute() {
        return Err("path must be absolute".into());
    }
    if target
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("path must not contain traversal".into());
    }
    Ok(())
}

pub(crate) fn has_extension(target: &Path, allowed: &[&str]) -> bool {
    target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            allowed
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("omd-scoped-{}-{name}", std::process::id()));
        fs::remove_dir_all(&dir).ok();
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn custom_css_round_trips_and_accepts_uppercase_extensions() {
        let dir = tmp("css");
        let css = dir.join("theme.CSS");
        fs::write(&css, ":root{--a:1}").unwrap();

        assert_eq!(
            read_custom_css_impl(&path_string(&css)).unwrap(),
            ":root{--a:1}"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn custom_css_rejects_traversal_wrong_extension_directories_and_oversize() {
        let dir = tmp("css-bad");
        let css = dir.join("theme.css");
        fs::write(&css, "a{}").unwrap();

        assert!(read_custom_css_impl("/tmp/../etc/passwd").is_err());
        assert!(read_custom_css_impl(&path_string(&dir.join("theme.txt"))).is_err());
        assert!(read_custom_css_impl(&path_string(&dir)).is_err());
        assert!(read_custom_css_impl("relative/theme.css").is_err());

        let huge = dir.join("huge.css");
        let file = fs::File::create(&huge).unwrap();
        file.set_len(MAX_CUSTOM_CSS_BYTES + 1).unwrap();
        let error = read_custom_css_impl(&path_string(&huge)).unwrap_err();
        assert!(error.contains("size limit"), "unexpected error: {error}");

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn exported_html_is_written_atomically_with_unicode_paths() {
        let dir = tmp("导出-目录");
        let target = dir.join("文档-🦀.html");

        write_exported_html_impl(&path_string(&target), "<p>hi</p>".into()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "<p>hi</p>");

        // A second export replaces the file and leaves no staging sibling.
        write_exported_html_impl(&path_string(&target), "<p>bye</p>".into()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "<p>bye</p>");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn exported_html_accepts_htm_and_rejects_guessed_or_missing_extensions() {
        let dir = tmp("html-ext");
        for name in ["doc.html", "doc.HTM"] {
            assert!(write_exported_html_impl(&path_string(&dir.join(name)), "x".into()).is_ok());
        }
        for name in ["doc", "doc.txt", "doc.pdf", "doc.html.exe"] {
            assert!(
                write_exported_html_impl(&path_string(&dir.join(name)), "x".into()).is_err(),
                "{name} must be refused"
            );
        }
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn exported_html_rejects_a_directory_target_and_traversal() {
        let dir = tmp("html-dir");
        let as_directory = dir.join("folder.html");
        fs::create_dir(&as_directory).unwrap();

        assert!(write_exported_html_impl(&path_string(&as_directory), "x".into()).is_err());
        assert!(write_exported_html_impl(
            &path_string(&dir.join("..").join("escape.html")),
            "x".into()
        )
        .is_err());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn exported_html_respects_the_shared_export_size_cap() {
        let dir = tmp("html-cap");
        let oversized = "a".repeat(crate::export::MAX_EXPORT_HTML_BYTES + 1);
        let error =
            write_exported_html_impl(&path_string(&dir.join("huge.html")), oversized).unwrap_err();

        assert!(error.contains("size limit"), "unexpected error: {error}");
        assert!(!dir.join("huge.html").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn exported_html_fails_before_staging_when_its_directory_is_absent() {
        let dir = tmp("html-parent");
        let missing = dir.join("absent").join("doc.html");

        let error = write_exported_html_impl(&path_string(&missing), "x".into()).unwrap_err();

        assert!(error.contains("directory"), "unexpected error: {error}");
        assert!(!dir.join("absent").exists(), "no directory may be created");
        fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn custom_css_rejects_a_symlink_whose_resolved_target_is_not_css() {
        use std::os::unix::fs::symlink;

        let dir = tmp("css-symlink");
        let secret = dir.join("secret.txt");
        fs::write(&secret, "private key material").unwrap();
        let evil = dir.join("evil.css");
        symlink(&secret, &evil).unwrap();

        let error = read_custom_css_impl(&path_string(&evil)).unwrap_err();
        assert!(error.contains("extension"), "unexpected error: {error}");

        // A symlink that resolves to a real stylesheet stays legitimate.
        let real = dir.join("real-theme.css");
        fs::write(&real, ":root{--a:1}").unwrap();
        let linked = dir.join("linked.css");
        symlink(&real, &linked).unwrap();
        assert_eq!(
            read_custom_css_impl(&path_string(&linked)).unwrap(),
            ":root{--a:1}"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn exported_html_refuses_to_write_through_a_preexisting_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tmp("html-symlink");
        let victim = dir.join("target.txt");
        fs::write(&victim, "precious").unwrap();
        let evil = dir.join("evil.html");
        symlink(&victim, &evil).unwrap();

        let error = write_exported_html_impl(&path_string(&evil), "<p>x</p>".into()).unwrap_err();

        assert!(error.contains("symlink"), "unexpected error: {error}");
        assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
        fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn custom_css_rejects_writerless_fifo_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let dir = tmp("css-fifo");
        let fifo = dir.join("pipe.css");
        let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);

        let error = read_custom_css_impl(&path_string(&fifo)).unwrap_err();
        assert!(error.contains("regular file"), "unexpected error: {error}");
        fs::remove_dir_all(dir).ok();
    }
}
