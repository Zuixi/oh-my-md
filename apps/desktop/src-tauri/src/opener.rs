//! The two OS actions the webview used to reach through `opener:default`.
//!
//! That capability let any renderer script open an arbitrary URL or reveal an
//! arbitrary path through the plugin's own commands. The same two user-facing
//! actions stay available, but the payload is re-checked here: a URL must use a
//! browser or mail scheme, and a revealed path must already be authorized for
//! the calling window. The plugin stays registered for Rust-side callers such as
//! `logging::open_log_dir`; only the webview grant is gone.

use std::path::{Path, PathBuf};

/// Schemes handed to the OS default handler. Anything else (`file:`,
/// `javascript:`, `data:`, a bare path, or a custom scheme) stays in the app.
const MAILTO_SCHEME: &str = "mailto:";
const WEB_SCHEMES: [&str; 2] = ["https://", "http://"];

#[tauri::command]
pub(crate) async fn open_external_url(url: String) -> Result<(), String> {
    validate_external_url(&url)?;
    crate::blocked("open url", move || {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn reveal_in_finder(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<(), String> {
    let label = window.label().to_string();
    crate::blocked("reveal in finder", move || {
        let target = authorize_reveal_path(Some(&label), Path::new(&path))?;
        tauri_plugin_opener::reveal_item_in_dir(target).map_err(|error| error.to_string())
    })
    .await
}

/// Resolves the one path a reveal may touch inside this window's grants.
///
/// Revealing reads the target's directory and asks Finder/Explorer to select it,
/// so a path this window never received must not reach the plugin. A workspace
/// directory and a granted file (or a Markdown file inside a granted root) are
/// both acceptable; the file branch canonicalizes, so only an existing entry is
/// ever revealed.
fn authorize_reveal_path(window_label: Option<&str>, path: &Path) -> Result<PathBuf, String> {
    crate::auth_scope::reject_traversal(path)?;
    if let Ok(directory) = crate::auth_scope::assert_dir_authorized(window_label, path) {
        return Ok(directory);
    }
    if crate::auth_scope::assert_file_or_workspace_authorized(window_label, path).is_ok() {
        return std::fs::canonicalize(path)
            .map_err(|error| format!("failed to resolve reveal target: {error}"));
    }
    Err("path is not authorized for this window".into())
}

/// Accepts only a normalized URL with a browser or mail scheme and a target.
///
/// Padding and control characters would let one payload ride two parsers (the
/// webview's and the OS handler's), and a scheme like `file:` or `smb:` turns a
/// "link" into a filesystem or network action, so both are refused here rather
/// than in the frontend.
fn validate_external_url(url: &str) -> Result<&str, String> {
    if url.is_empty() || url.chars().any(char::is_whitespace) || url.chars().any(char::is_control) {
        return Err("URL must be non-empty with no whitespace or control characters".into());
    }
    let lower = url.to_ascii_lowercase();
    let target = lower.strip_prefix(MAILTO_SCHEME).or_else(|| {
        WEB_SCHEMES
            .iter()
            .find_map(|scheme| lower.strip_prefix(scheme))
    });
    match target {
        // A host or recipient is required: `https://` alone describes nothing,
        // and `https:///etc/passwd` or `https://\\host` is a path/UNC, not a URL.
        Some(rest) if !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('\\') => {
            Ok(url)
        }
        Some(_) => Err("URL is missing a host or mail recipient".into()),
        None => Err("URL scheme must be http, https, or mailto".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_browser_and_mail_schemes_case_insensitively() {
        for url in [
            "https://example.com",
            "HTTPS://EXAMPLE.COM/path?q=1#frag",
            "http://localhost:3000/x",
            "mailto:someone@example.com",
        ] {
            assert_eq!(validate_external_url(url), Ok(url), "{url}");
        }
    }

    #[test]
    fn rejects_filesystem_script_and_custom_schemes() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox",
            "smb://host/share",
            "ssh://host",
            "/etc/passwd",
            "C:\\Windows\\System32\\calc.exe",
            "https://",
            "http:///etc/passwd",
            "https://\\attacker\\share",
            "mailto:",
        ] {
            assert!(validate_external_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn rejects_empty_padded_and_control_character_urls() {
        for url in [
            "",
            " https://example.com",
            "https://example.com ",
            "https://example.com/a b",
            "https://exa\nmple.com",
            "https://example.com\0",
            "https://example.com\r",
        ] {
            assert!(validate_external_url(url).is_err(), "{url:?}");
        }
    }

    #[test]
    fn reveal_requires_an_authorized_target() {
        let directory = tempfile::tempdir().unwrap();
        let document = directory.path().join("note.md");
        std::fs::write(&document, "# note").unwrap();
        crate::auth_scope::authorize_document_file("reveal-test", &document).unwrap();

        let expected = std::fs::canonicalize(&document).unwrap();
        assert_eq!(
            authorize_reveal_path(Some("reveal-test"), &document).unwrap(),
            expected
        );

        // A file nobody granted, a traversal, and a path from another window's
        // scope are all refused.
        let stranger = directory.path().join("stranger.md");
        std::fs::write(&stranger, "# stranger").unwrap();
        assert!(authorize_reveal_path(Some("reveal-test"), &stranger).is_err());
        assert!(authorize_reveal_path(None, &stranger).is_err());
        let traversal = directory.path().join("..").join("escape.md");
        assert!(authorize_reveal_path(Some("reveal-test"), &traversal).is_err());
        // A granted path that no longer exists cannot be revealed either.
        std::fs::remove_file(&document).unwrap();
        assert!(authorize_reveal_path(Some("reveal-test"), &document).is_err());
    }
}
