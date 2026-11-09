//! Per-tab crash-recovery drafts.
//!
//! Owns the recovery directory and its file protocol. A record is a small
//! header line (the draft's original path, if any) followed by the raw
//! document bytes, so the identity survives a crash without escaping the
//! document again. The file *name* stays an opaque frontend-derived key; the
//! frontend maps records back to tabs. Writes are atomic so a crash mid-write
//! leaves the previous draft intact instead of a truncated file the next
//! launch would offer to restore. Files written before the header existed are
//! still readable: the whole file is the draft and `path` is unknown.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use super::config_dir;

/// Versioned marker; bump it if the header shape ever changes incompatibly.
const HEADER_MAGIC: &str = "OMD-RECOVERY 1\n";

/// An envelope's JSON header is tiny (one optional path); this bound keeps a
/// malformed file from making a listing read an unbounded line. The body is
/// never read here.
const MAX_HEADER_BYTES: u64 = 4096;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RecoveryRecord {
    pub key: String,
    pub label: String,
    /// The draft's document path, when the writer recorded one.
    pub path: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct RecoveryContents {
    pub path: Option<String>,
    pub contents: String,
}

#[derive(Serialize, Deserialize)]
struct RecoveryHeader {
    path: Option<String>,
}

pub fn recovery_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("OMD_RECOVERY_DIR") {
        return PathBuf::from(dir);
    }
    config_dir().join("recovery")
}

pub fn write_recovery(key: String, path: Option<String>, contents: String) -> Result<(), String> {
    let dir = recovery_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let header = serde_json::to_string(&RecoveryHeader { path }).map_err(|e| e.to_string())?;
    let mut body = String::with_capacity(HEADER_MAGIC.len() + header.len() + 1 + contents.len());
    body.push_str(HEADER_MAGIC);
    body.push_str(&header);
    body.push('\n');
    body.push_str(&contents);
    crate::atomic_write(&dir.join(valid_key(&key)?), body.as_bytes())
}

pub fn list_recoveries() -> Result<Vec<RecoveryRecord>, String> {
    let dir = recovery_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Atomic writes stage a hidden tempfile in this directory; a crash can
        // leave one behind, and it is not a draft the user can restore.
        if name.starts_with('.') {
            continue;
        }
        // Read only the header: listing a large draft must never load its body.
        let path = envelope_path(&entry.path());
        records.push(RecoveryRecord {
            label: path.clone().unwrap_or_else(|| name.clone()),
            key: name,
            path,
        });
    }
    records.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(records)
}

pub fn read_recovery(key: String) -> Result<RecoveryContents, String> {
    let raw =
        fs::read_to_string(recovery_dir().join(valid_key(&key)?)).map_err(|e| e.to_string())?;
    let (path, contents) = split_envelope(&raw);
    Ok(RecoveryContents {
        path,
        contents: contents.to_string(),
    })
}

pub fn clear_recovery(key: String) -> Result<(), String> {
    let path = recovery_dir().join(valid_key(&key)?);
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The record's document path, or `None` for a legacy headerless file or one
/// with no path (untitled draft).
fn envelope_path(file: &Path) -> Option<String> {
    // Read a bounded prefix: a legacy headerless draft may be one enormous
    // line, and `read_line` would then load the whole body just to list it.
    let mut file = fs::File::open(file).ok()?;
    let mut magic = [0_u8; HEADER_MAGIC.len()];
    file.read_exact(&mut magic).ok()?;
    if magic != HEADER_MAGIC.as_bytes() {
        return None;
    }
    let mut header = String::new();
    BufReader::new(file)
        .take(MAX_HEADER_BYTES)
        .read_line(&mut header)
        .ok()?;
    serde_json::from_str::<RecoveryHeader>(header.trim_end())
        .ok()
        .and_then(|header| header.path)
}

/// Splits a stored draft into its path and raw contents. A corrupt header is
/// treated as headerless: the user's text is preserved verbatim rather than
/// dropped or offered with a guessed identity.
fn split_envelope(raw: &str) -> (Option<String>, &str) {
    let Some(rest) = raw.strip_prefix(HEADER_MAGIC) else {
        return (None, raw);
    };
    let Some((header, body)) = rest.split_once('\n') else {
        return (None, raw);
    };
    match serde_json::from_str::<RecoveryHeader>(header) {
        Ok(header) => (header.path, body),
        Err(_) => (None, raw),
    }
}

/// Longest name accepted, in bytes — the limit common to ext4, APFS, and NTFS.
const MAX_KEY_BYTES: usize = 255;

/// A key must be exactly one portable file-name component.
///
/// Rejecting separators, `.`/`..`, NUL, and `:` keeps `dir.join(key)` inside
/// the recovery directory on every platform (on Windows a `:` would address an
/// alternate data stream). Embedded `..` is *legal* — a document named
/// `a..b.md` must still get a draft — so only the exact traversal names are
/// refused. The frontend generates bounded ASCII keys; this accepts older keys
/// as well, as long as the filesystem could have stored them.
fn valid_key(key: &str) -> Result<&str, String> {
    let invalid = key.is_empty()
        || key.len() > MAX_KEY_BYTES
        || key == "."
        || key == ".."
        || key.contains('/')
        || key.contains('\\')
        || key.contains('\0')
        || key.contains(':');
    if invalid {
        return Err("recovery key is invalid".into());
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::config_env_guard;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("omd-recovery-{name}-{}", std::process::id()))
    }

    fn reset_dir(path: &PathBuf) {
        fs::remove_dir_all(path).ok();
        fs::create_dir_all(path).unwrap();
    }

    #[test]
    fn recovery_dir_defaults_under_config_dir() {
        let _guard = config_env_guard();
        let dir = tmp("config-recovery");
        reset_dir(&dir);
        std::env::set_var("OMD_CONFIG_DIR", &dir);
        let had_recovery = std::env::var_os("OMD_RECOVERY_DIR");
        std::env::remove_var("OMD_RECOVERY_DIR");

        assert_eq!(recovery_dir(), dir.join("recovery"));

        if let Some(v) = had_recovery {
            std::env::set_var("OMD_RECOVERY_DIR", v);
        }
        std::env::remove_var("OMD_CONFIG_DIR");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn recovery_payloads_serialize_with_the_documented_field_names() {
        let record = serde_json::to_string(&RecoveryRecord {
            key: "untitled_main_1".into(),
            label: "/notes/one.md".into(),
            path: Some("/notes/one.md".into()),
        })
        .unwrap();
        assert_eq!(
            record,
            r#"{"key":"untitled_main_1","label":"/notes/one.md","path":"/notes/one.md"}"#
        );
        let contents = serde_json::to_string(&RecoveryContents {
            path: None,
            contents: "draft".into(),
        })
        .unwrap();
        assert_eq!(contents, r#"{"path":null,"contents":"draft"}"#);
    }

    #[test]
    fn recovery_roundtrip_keeps_the_document_path() {
        let _guard = config_env_guard();
        let dir = tmp("recovery");
        reset_dir(&dir);
        std::env::set_var("OMD_RECOVERY_DIR", &dir);
        let path = Some("/notes/one.md".to_string());
        write_recovery("_notes_one.md".into(), path.clone(), "draft".into()).unwrap();
        // Repeated writes replace the draft in place (atomic rename).
        write_recovery("_notes_one.md".into(), path.clone(), "newer draft".into()).unwrap();
        // A crash-leftover staging file must not be offered as a record.
        fs::write(dir.join(".tmp012345"), "garbage").unwrap();
        let listed = list_recoveries().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].key, "_notes_one.md");
        assert_eq!(listed[0].label, "/notes/one.md");
        assert_eq!(listed[0].path, path);
        let read = read_recovery("_notes_one.md".into()).unwrap();
        assert_eq!(read.path, path);
        assert_eq!(read.contents, "newer draft");
        clear_recovery("_notes_one.md".into()).unwrap();
        assert!(list_recoveries().unwrap().is_empty());
        std::env::remove_var("OMD_RECOVERY_DIR");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_a_legacy_headerless_draft_as_raw_contents() {
        let _guard = config_env_guard();
        let dir = tmp("recovery-legacy");
        reset_dir(&dir);
        std::env::set_var("OMD_RECOVERY_DIR", &dir);
        fs::write(dir.join("untitled_1"), "old draft").unwrap();

        let listed = list_recoveries().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, None);
        let read = read_recovery("untitled_1".into()).unwrap();
        assert_eq!(read.path, None);
        assert_eq!(read.contents, "old draft");

        std::env::remove_var("OMD_RECOVERY_DIR");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn recovery_keys_are_single_portable_file_names() {
        // A document literally named `a..b.md` must still have a draft.
        assert_eq!(
            valid_key("_notes_a..b.md_0123456789abcdef").unwrap(),
            "_notes_a..b.md_0123456789abcdef"
        );
        assert!(valid_key("..").is_err());
        assert!(valid_key(".").is_err());
        assert!(valid_key("").is_err());
        assert!(valid_key("a/b").is_err());
        assert!(valid_key("a\\b").is_err());
        // Windows would address an alternate data stream instead of a file.
        assert!(valid_key("a:b").is_err());
        assert!(valid_key("a\0b").is_err());
        assert!(valid_key(&"a".repeat(MAX_KEY_BYTES)).is_ok());
        assert!(valid_key(&"a".repeat(MAX_KEY_BYTES + 1)).is_err());
    }

    #[test]
    fn lists_a_single_line_legacy_draft_without_a_path() {
        let _guard = config_env_guard();
        let dir = tmp("recovery-single-line");
        reset_dir(&dir);
        std::env::set_var("OMD_RECOVERY_DIR", &dir);
        // A legacy draft can be one huge line; listing must read at most the
        // magic prefix and still see it as path-less.
        let huge = "x".repeat(2 * 1024 * 1024);
        fs::write(dir.join("untitled_1"), &huge).unwrap();

        let listed = list_recoveries().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, None);
        assert_eq!(read_recovery("untitled_1".into()).unwrap().contents, huge);

        std::env::remove_var("OMD_RECOVERY_DIR");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn preserves_a_draft_whose_header_is_corrupt() {
        let _guard = config_env_guard();
        let dir = tmp("recovery-corrupt");
        reset_dir(&dir);
        std::env::set_var("OMD_RECOVERY_DIR", &dir);
        fs::write(
            dir.join("untitled_1"),
            format!("{HEADER_MAGIC}{{not json}}\nbody"),
        )
        .unwrap();

        let read = read_recovery("untitled_1".into()).unwrap();
        assert_eq!(read.path, None);
        assert_eq!(read.contents, format!("{HEADER_MAGIC}{{not json}}\nbody"));

        std::env::remove_var("OMD_RECOVERY_DIR");
        fs::remove_dir_all(dir).ok();
    }
}
