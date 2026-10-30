use std::collections::{HashMap, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};

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
    document_path: PathBuf,
    paths: Vec<PathBuf>,
}

#[derive(Default)]
pub(crate) struct PasteAssetState(Mutex<PasteAssetStateInner>);

#[tauri::command]
pub(crate) async fn write_paste_assets(
    state: tauri::State<'_, PasteAssetState>,
    document_path: String,
    assets: Vec<PasteAssetWrite>,
) -> Result<PasteAssetBatch, String> {
    let registered_document_path = PathBuf::from(&document_path);
    let batch = tauri::async_runtime::spawn_blocking(move || {
        write_paste_assets_impl(Path::new(&document_path), assets)
    })
    .await
    .map_err(|error| format!("paste asset task failed: {error}"))??;
    if let Some(batch_id) = &batch.0.batch_id {
        state
            .0
            .lock()
            .map_err(|_| "paste asset state lock poisoned".to_string())?
            .pending
            .insert(batch_id.clone(), PendingBatch {
                document_path: registered_document_path,
                paths: batch.1.clone(),
            });
    }
    Ok(batch.0)
}

#[tauri::command]
pub(crate) async fn commit_paste_assets(
    state: tauri::State<'_, PasteAssetState>,
    batch_id: String,
) -> Result<(), String> {
    finish_batch(&state, &batch_id, TerminalAction::Commit, false)
}

#[tauri::command]
pub(crate) async fn discard_paste_assets(
    state: tauri::State<'_, PasteAssetState>,
    batch_id: String,
) -> Result<(), String> {
    finish_batch(&state, &batch_id, TerminalAction::Discard, true)
}

fn finish_batch(
    state: &PasteAssetState,
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
    if remove_files {
        let batch = inner
            .pending
            .get(batch_id)
            .ok_or_else(|| "unknown paste asset batch".to_string())?;
        let assets_dir = batch
            .document_path
            .parent()
            .ok_or_else(|| "document path must have a parent directory".to_string())?
            .join(ASSETS_DIR_NAME);
        reject_symlink_directory(&assets_dir)?;
        validate_assets_directory(&assets_dir, &batch.document_path)?;
        if batch.paths.iter().any(|path| path.parent() != Some(assets_dir.as_path())) {
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
                inner.pending.insert(batch_id.to_string(), PendingBatch {
                    document_path: batch.document_path,
                    paths: batch.paths[index..].to_vec(),
                });
                return Err(format!("failed to discard paste asset: {error}"));
            }
        }
    }
    inner.terminal.push_back((batch_id.to_string(), action));
    while inner.terminal.len() > TERMINAL_BATCH_LIMIT {
        inner.terminal.pop_front();
    }
    Ok(())
}

fn write_paste_assets_impl(
    document_path: &Path,
    assets: Vec<PasteAssetWrite>,
) -> Result<(PasteAssetBatch, Vec<PathBuf>), String> {
    validate_document_path(document_path)?;
    let mut seen = std::collections::HashSet::new();
    if assets.iter().any(|asset| asset.key.is_empty() || !seen.insert(asset.key.clone())) {
        return Err("paste asset keys must be non-empty and unique".into());
    }

    let mut valid = Vec::new();
    let mut failures = Vec::new();
    for asset in assets {
        match decode_asset(&asset) {
            Ok((extension, bytes)) => valid.push((asset.key, extension, bytes)),
            Err(kind) => failures.push(PasteAssetFailure { key: asset.key, kind }),
        }
    }
    if valid.is_empty() {
        return Ok((PasteAssetBatch { batch_id: None, items: Vec::new(), failures }, Vec::new()));
    }

    let assets_dir = document_path
        .parent()
        .ok_or_else(|| "document path must have a parent directory".to_string())?
        .join(ASSETS_DIR_NAME);
    std::fs::create_dir_all(&assets_dir)
        .map_err(|error| format!("failed to create image assets directory: {error}"))?;
    reject_symlink_directory(&assets_dir)?;
    validate_assets_directory(&assets_dir, document_path)?;

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
    Ok((PasteAssetBatch { batch_id: Some(batch_id), items, failures }, paths))
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

fn validate_assets_directory(assets_dir: &Path, document_path: &Path) -> Result<(), String> {
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
    Ok(())
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
        let (batch, paths) = write_paste_assets_impl(
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
    }

    #[test]
    fn rejects_duplicate_keys_before_writing() {
        let directory = tempfile::tempdir().unwrap();
        let document = directory.path().join("document.md");
        std::fs::write(&document, "# document").unwrap();
        let assets = vec![
            PasteAssetWrite { key: "same".into(), mime: "image/png".into(), base64: String::new() },
            PasteAssetWrite { key: "same".into(), mime: "image/png".into(), base64: String::new() },
        ];
        assert!(write_paste_assets_impl(&document, assets).is_err());
        assert!(!directory.path().join(ASSETS_DIR_NAME).exists());
    }

    #[test]
    fn discard_is_exact_idempotent_and_conflicting_reuse_fails() {
        let directory = tempfile::tempdir().unwrap();
        let document = directory.path().join("document.md");
        std::fs::write(&document, "# document").unwrap();
        let asset_path = directory.path().join(ASSETS_DIR_NAME).join("pasted-test.png");
        std::fs::create_dir_all(asset_path.parent().unwrap()).unwrap();
        std::fs::write(&asset_path, b"\x89PNG\r\n\x1a\n").unwrap();
        let state = PasteAssetState::default();
        state.0.lock().unwrap().pending.insert("batch".into(), PendingBatch {
            document_path: document,
            paths: vec![asset_path.clone()],
        });

        finish_batch(&state, "batch", TerminalAction::Discard, true).unwrap();
        assert!(!asset_path.exists());
        finish_batch(&state, "batch", TerminalAction::Discard, true).unwrap();
        assert!(finish_batch(&state, "batch", TerminalAction::Commit, false).is_err());
        assert!(finish_batch(&state, "unknown", TerminalAction::Discard, true).is_err());
    }
}
