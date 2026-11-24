use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const ASSETS_DIR_NAME: &str = "assets";
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4;
const TERMINAL_BATCH_LIMIT: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasteAssetWrite {
    key: String,
    mime: String,
    base64: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasteAssetResult {
    key: String,
    relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasteAssetFailure {
    key: String,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasteAssetBatch {
    batch_id: Option<String>,
    items: Vec<PasteAssetResult>,
    failures: Vec<PasteAssetFailure>,
}

#[derive(Clone, Copy, PartialEq)]
enum TerminalAction {
    Commit,
    Discard,
}

#[derive(Default)]
struct PasteAssetStateInner {
    pending: HashMap<String, PendingBatch>,
    terminal: VecDeque<(String, TerminalAction)>,
}

struct PendingBatch {
    window_label: String,
    document_path: PathBuf,
    paths: Vec<PathBuf>,
}

#[derive(Default)]
pub(crate) struct PasteAssetState(Mutex<PasteAssetStateInner>);

#[tauri::command]
pub(crate) async fn write_paste_assets(
    app: tauri::AppHandle,
    state: tauri::State<'_, PasteAssetState>,
    window: tauri::WebviewWindow,
    document_path: String,
    assets: Vec<PasteAssetWrite>,
) -> Result<PasteAssetBatch, String> {
    // Pasted bytes land in `assets/` next to the document, so the document must
    // be a file this window already opened or saved — a pasted image must never
    // become a way to create files next to an arbitrary path, or to write beside
    // a document the host opened read-only.
    crate::auth_scope::assert_file_writable(
        Some(window.label()),
        std::path::Path::new(&document_path),
    )?;
    let registered_document_path = PathBuf::from(&document_path);
    let (batch, written_paths, canonical_assets_dir) =
        tauri::async_runtime::spawn_blocking(move || {
            write_paste_assets_impl(Path::new(&document_path), assets)
        })
        .await
        .map_err(|error| format!("paste asset task failed: {error}"))??;
    // A standalone document reaches this command before `assets/` exists, so the
    // validated canonical directory is registered before serving it back.
    if let Some(assets_dir) = canonical_assets_dir {
        let scope = app.asset_protocol_scope();
        if let Err(error) = scope.allow_directory(&assets_dir, true) {
            for path in &written_paths {
                let _ = std::fs::remove_file(path);
            }
            return Err(format!("failed to allow image assets directory: {error}"));
        }
    }
    if let Some(batch_id) = &batch.batch_id {
        state
            .0
            .lock()
            .map_err(|_| "paste asset state lock poisoned".to_string())?
            .pending
            .insert(
                batch_id.clone(),
                PendingBatch {
                    window_label: window.label().to_string(),
                    document_path: registered_document_path,
                    paths: written_paths,
                },
            );
    }
    Ok(batch)
}

#[tauri::command]
pub(crate) async fn commit_paste_assets(
    state: tauri::State<'_, PasteAssetState>,
    window: tauri::WebviewWindow,
    batch_id: String,
) -> Result<(), String> {
    let label = window.label();
    finish_batch(&state, label, &batch_id, TerminalAction::Commit, false)
}

#[tauri::command]
pub(crate) async fn discard_paste_assets(
    state: tauri::State<'_, PasteAssetState>,
    window: tauri::WebviewWindow,
    batch_id: String,
) -> Result<(), String> {
    let label = window.label();
    finish_batch(&state, label, &batch_id, TerminalAction::Discard, true)
}

fn finish_batch(
    state: &PasteAssetState,
    window_label: &str,
    batch_id: &str,
    action: TerminalAction,
    remove_files: bool,
) -> Result<(), String> {
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "paste asset state lock poisoned".to_string())?;
    if let Some((_, previous)) = inner.terminal.iter().find(|(id, _)| id == batch_id) {
        return if *previous == action {
            Ok(())
        } else {
            Err("paste asset batch was already finalized differently".into())
        };
    }
    let batch = inner
        .pending
        .get(batch_id)
        .ok_or_else(|| "unknown paste asset batch".to_string())?;
    // A batch belongs to the window that wrote it: a second window's webview must
    // not commit or discard these files, even with a guessed batch id.
    if batch.window_label != window_label {
        return Err("paste asset batch belongs to another window".into());
    }
    if remove_files {
        let assets_dir = batch
            .document_path
            .parent()
            .ok_or_else(|| "document path must have a parent directory".to_string())?
            .join(ASSETS_DIR_NAME);
        reject_symlink_directory(&assets_dir)?;
        validate_assets_directory(&assets_dir, &batch.document_path)?;
        if batch
            .paths
            .iter()
            .any(|path| path.parent() != Some(assets_dir.as_path()))
        {
            return Err("registered paste asset escaped its assets directory".into());
        }
    }
    let batch = inner
        .pending
        .remove(batch_id)
        .ok_or_else(|| "unknown paste asset batch".to_string())?;
    if remove_files {
        for (index, path) in batch.paths.iter().enumerate() {
            if let Err(error) = std::fs::remove_file(path) {
                inner.pending.insert(
                    batch_id.to_string(),
                    PendingBatch {
                        window_label: batch.window_label,
                        document_path: batch.document_path,
                        paths: batch.paths[index..].to_vec(),
                    },
                );
                return Err(format!("failed to discard paste asset: {error}"));
            }
        }
    }
    inner.terminal.push_back((batch_id.to_string(), action));
    trim_terminal(&mut inner.terminal);
    Ok(())
}

/// Keeps the finalized-id ring bounded; ids only exist for idempotent repeats.
fn trim_terminal(terminal: &mut VecDeque<(String, TerminalAction)>) {
    while terminal.len() > TERMINAL_BATCH_LIMIT {
        terminal.pop_front();
    }
}

/// Drains one window's pending batches, recording them as discarded so a late
/// commit from the same (now gone) webview cannot resurrect them.
fn take_window_batches(state: &PasteAssetState, window_label: &str) -> Vec<PendingBatch> {
    let Ok(mut inner) = state.0.lock() else {
        log::warn!("paste asset state lock poisoned during window cleanup");
        return Vec::new();
    };
    let PasteAssetStateInner { pending, terminal } = &mut *inner;
    let mut drained = Vec::new();
    for (batch_id, batch) in std::mem::take(pending) {
        if batch.window_label == window_label {
            terminal.push_back((batch_id, TerminalAction::Discard));
            drained.push(batch);
        } else {
            pending.insert(batch_id, batch);
        }
    }
    trim_terminal(terminal);
    drained
}

/// Deletes drained batches, refusing an `assets/` swapped for a symlink.
fn remove_batch_files(batches: &[PendingBatch]) {
    for batch in batches {
        let dir = batch.document_path.parent().unwrap_or(Path::new(""));
        if reject_symlink_directory(&dir.join(ASSETS_DIR_NAME)).is_err() {
            log::warn!("skipping paste asset cleanup: assets directory is gone or a symlink");
            continue;
        }
        for path in &batch.paths {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => log::warn!("failed to remove discarded paste asset: {error}"),
            }
        }
    }
}

/// Called from `WindowEvent::Destroyed`; the unlink runs on the blocking pool so
/// a window destroyed mid-paste never stalls the main thread on disk IO.
pub(crate) fn discard_window_batches(state: &PasteAssetState, window_label: &str) {
    let batches = take_window_batches(state, window_label);
    if batches.is_empty() {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || remove_batch_files(&batches));
}

fn write_paste_assets_impl(
    document_path: &Path,
    assets: Vec<PasteAssetWrite>,
) -> Result<(PasteAssetBatch, Vec<PathBuf>, Option<PathBuf>), String> {
    validate_document_path(document_path)?;
    let mut seen = std::collections::HashSet::new();
    if assets
        .iter()
        .any(|asset| asset.key.is_empty() || !seen.insert(asset.key.clone()))
    {
        return Err("paste asset keys must be non-empty and unique".into());
    }

    let mut valid = Vec::new();
    let mut failures = Vec::new();
    for asset in assets {
        match decode_asset(&asset) {
            Ok((extension, bytes)) => valid.push((asset.key, extension, bytes)),
            Err(kind) => failures.push(PasteAssetFailure {
                key: asset.key,
                kind,
            }),
        }
    }
    if valid.is_empty() {
        // Nothing was written, so no directory was created and nothing needs an
        // asset-scope grant.
        return Ok((
            PasteAssetBatch {
                batch_id: None,
                items: Vec::new(),
                failures,
            },
            Vec::new(),
            None,
        ));
    }

    let assets_dir = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?
        .join(ASSETS_DIR_NAME);
    std::fs::create_dir_all(&assets_dir)
        .map_err(|error| format!("failed to create image assets directory: {error}"))?;
    reject_symlink_directory(&assets_dir)?;
    let canonical_assets_dir = validate_assets_directory(&assets_dir, document_path)?;

    let mut paths = Vec::new();
    let mut items = Vec::new();
    for (key, extension, bytes) in valid {
        let result = tempfile::Builder::new()
            .prefix("pasted-")
            .suffix(&format!(".{extension}"))
            .tempfile_in(&assets_dir)
            .and_then(|mut file| {
                use std::io::Write;
                file.write_all(&bytes)?;
                file.as_file().sync_all()?;
                file.into_temp_path().keep().map_err(|error| error.error)
            });
        match result {
            Ok(path) => {
                let file_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "paste asset filename was not UTF-8".to_string())?;
                items.push(PasteAssetResult {
                    key,
                    relative_path: format!("{ASSETS_DIR_NAME}/{file_name}"),
                });
                paths.push(path);
            }
            Err(error) => {
                for path in &paths {
                    let _ = std::fs::remove_file(path);
                }
                return Err(format!("failed to write paste asset: {error}"));
            }
        }
    }
    let batch_id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    Ok((
        PasteAssetBatch {
            batch_id: Some(batch_id),
            items,
            failures,
        },
        paths,
        Some(canonical_assets_dir),
    ))
}

fn decode_asset(asset: &PasteAssetWrite) -> Result<(&'static str, Vec<u8>), &'static str> {
    let extension = match asset.mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err("unsupportedMime"),
    };
    if asset.base64.len() > MAX_ENCODED_IMAGE_BYTES {
        return Err("tooLarge");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&asset.base64)
        .map_err(|_| "invalidData")?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("tooLarge");
    }
    let valid = match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !valid {
        return Err("invalidData");
    }
    Ok((extension, bytes))
}

fn validate_document_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("document path must be absolute and contain no traversal".into());
    }
    path.parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?;
    Ok(())
}

fn reject_symlink_directory(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect image assets directory: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("image assets directory must not be a symbolic link".into());
    }
    Ok(())
}

/// Validates `<doc_dir>/assets` and returns its canonical form, so callers never
/// register an unvalidated (symlinked or escaping) path with the asset protocol.
fn validate_assets_directory(assets_dir: &Path, document_path: &Path) -> Result<PathBuf, String> {
    let document_dir = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?;
    let canonical_document_dir = std::fs::canonicalize(document_dir)
        .map_err(|error| format!("failed to resolve document directory: {error}"))?;
    let canonical_assets_dir = std::fs::canonicalize(assets_dir)
        .map_err(|error| format!("failed to resolve image assets directory: {error}"))?;
    if canonical_assets_dir != canonical_document_dir.join(ASSETS_DIR_NAME) {
        return Err("image assets directory resolves outside the document directory".into());
    }
    Ok(canonical_assets_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn serializes_camel_case_wire_fields() {
        let batch = PasteAssetBatch {
            batch_id: Some("batch".into()),
            items: vec![PasteAssetResult {
                key: "image".into(),
                relative_path: "assets/pasted.png".into(),
            }],
            failures: Vec::new(),
        };
        let json = serde_json::to_string(&batch).unwrap();
        assert!(json.contains("\"batchId\""));
        assert!(json.contains("\"relativePath\""));
        assert!(!json.contains("batch_id"));
    }

    #[test]
    fn writes_valid_assets_and_reports_invalid_items() {
        let directory = tempfile::tempdir().unwrap();
        let document = directory.path().join("document.md");
        std::fs::write(&document, "# document").unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nbody");
        let (batch, paths, canonical_assets_dir) = write_paste_assets_impl(
            &document,
            vec![
                PasteAssetWrite {
                    key: "good".into(),
                    mime: "image/png".into(),
                    base64: png,
                },
                PasteAssetWrite {
                    key: "bad".into(),
                    mime: "image/gif".into(),
                    base64: "R0lG".into(),
                },
            ],
        )
        .unwrap();
        assert!(batch.batch_id.is_some());
        assert_eq!(batch.items.len(), 1);
        assert_eq!(batch.failures.len(), 1);
        assert_eq!(batch.failures[0].kind, "unsupportedMime");
        assert!(batch.items[0].relative_path.starts_with("assets/pasted-"));
        assert_eq!(paths.len(), 1);
        assert!(paths[0].exists());
        assert!(canonical_assets_dir.is_some());
    }

    #[test]
    fn first_paste_creates_and_returns_the_assets_directory() {
        let directory = tempfile::tempdir().unwrap();
        let document = directory.path().join("standalone.md");
        std::fs::write(&document, "# standalone").unwrap();
        let assets_dir = directory.path().join(ASSETS_DIR_NAME);
        // An all-invalid batch creates no directory and grants no scope.
        let (rejected, rejected_paths, canonical_assets_dir) = write_paste_assets_impl(
            &document,
            vec![PasteAssetWrite {
                key: "bad".into(),
                mime: "image/png".into(),
                base64: base64::engine::general_purpose::STANDARD.encode(b"not a png"),
            }],
        )
        .unwrap();
        assert!(rejected.batch_id.is_none());
        assert!(rejected_paths.is_empty());
        assert_eq!(canonical_assets_dir, None);
        assert!(!assets_dir.exists());

        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nbody");
        let (batch, paths, canonical_assets_dir) = write_paste_assets_impl(
            &document,
            vec![PasteAssetWrite {
                key: "first".into(),
                mime: "image/png".into(),
                base64: png,
            }],
        )
        .unwrap();
        assert!(batch.batch_id.is_some());
        assert_eq!(paths.len(), 1);
        assert!(assets_dir.is_dir());
        // Only the canonical directory may reach the asset protocol scope.
        let dir = directory.path();
        let expected = std::fs::canonicalize(dir).unwrap().join(ASSETS_DIR_NAME);
        assert!(expected.is_dir());
        assert_eq!(canonical_assets_dir.as_deref(), Some(expected.as_path()));
    }

    #[test]
    fn rejects_duplicate_keys_before_writing() {
        let directory = tempfile::tempdir().unwrap();
        let document = directory.path().join("document.md");
        std::fs::write(&document, "# document").unwrap();
        let assets = vec![
            PasteAssetWrite {
                key: "same".into(),
                mime: "image/png".into(),
                base64: String::new(),
            },
            PasteAssetWrite {
                key: "same".into(),
                mime: "image/png".into(),
                base64: String::new(),
            },
        ];
        assert!(write_paste_assets_impl(&document, assets).is_err());
        assert!(!directory.path().join(ASSETS_DIR_NAME).exists());
    }

    #[test]
    fn discard_is_exact_idempotent_and_conflicting_reuse_fails() {
        let directory = tempfile::tempdir().unwrap();
        let state = PasteAssetState::default();
        let asset_path = seed_batch(&state, "batch", "window-a", directory.path());

        finish_batch(&state, "window-a", "batch", TerminalAction::Discard, true).unwrap();
        assert!(!asset_path.exists());
        finish_batch(&state, "window-a", "batch", TerminalAction::Discard, true).unwrap();
        assert!(finish_batch(&state, "window-a", "batch", TerminalAction::Commit, false).is_err());
        assert!(finish_batch(&state, "window-a", "gone", TerminalAction::Discard, true).is_err());
    }

    #[test]
    fn a_foreign_window_neither_finalizes_nor_reaps_a_batch() {
        let directory = tempfile::tempdir().unwrap();
        let state = PasteAssetState::default();
        let mine = seed_batch(&state, "mine", "window-a", directory.path());
        let other = seed_batch(&state, "other", "window-b", directory.path());

        assert!(finish_batch(&state, "window-b", "mine", TerminalAction::Discard, true).is_err());
        assert!(finish_batch(&state, "window-b", "mine", TerminalAction::Commit, false).is_err());
        // A refused finalize touches neither the queue nor the disk; closing a
        // window reaps only the bytes that window wrote.
        assert!(mine.exists());
        remove_batch_files(&take_window_batches(&state, "window-a"));
        assert!(!mine.exists());
        assert!(other.exists());
        assert_eq!(pending_ids(&state), ["other".to_string()]);
        // A drained batch stays finalized as discarded, so a late commit cannot
        // un-delete anything, and the production entry point drains first.
        assert!(finish_batch(&state, "window-a", "mine", TerminalAction::Commit, false).is_err());
        seed_batch(&state, "leaked", "window-a", directory.path());
        discard_window_batches(&state, "window-a");
        assert_eq!(pending_ids(&state), ["other".to_string()]);
    }

    fn pending_ids(state: &PasteAssetState) -> Vec<String> {
        state.0.lock().unwrap().pending.keys().cloned().collect()
    }

    /// Seeds a pending batch the way `write_paste_assets_impl` leaves it.
    fn seed_batch(state: &PasteAssetState, batch_id: &str, window: &str, dir: &Path) -> PathBuf {
        let assets_dir = dir.join(ASSETS_DIR_NAME);
        std::fs::create_dir_all(&assets_dir).unwrap();
        let asset_path = assets_dir.join(format!("pasted-{batch_id}.png"));
        std::fs::write(&asset_path, b"\x89PNG\r\n\x1a\n").unwrap();
        let batch = PendingBatch {
            window_label: window.into(),
            document_path: dir.join(format!("{batch_id}.md")),
            paths: vec![asset_path.clone()],
        };
        let mut inner = state.0.lock().unwrap();
        inner.pending.insert(batch_id.into(), batch);
        asset_path
    }
}
