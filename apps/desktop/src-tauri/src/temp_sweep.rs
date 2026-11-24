//! Sweep of this app's own crash leftovers.
//!
//! Every durable write stages a `NamedTempFile` sibling (`.tmpXXXXXX`), and the
//! document save path additionally uses `.omd-save-{pid}-{nanos}.tmp` plus a
//! `.omd-save-backup` rename fallback on Windows. A crash between staging and
//! rename leaves those behind; nothing else ever removes them, so they would
//! accumulate in app-owned directories forever.
//!
//! Only files older than [`STALE_TEMP_AGE`] are removed: a concurrent writer in
//! the same directory may legitimately own a fresh temp file. Snapshot buckets
//! (`snapshots/<hash>/`) stage one level deeper, so they are swept explicitly,
//! and a `.omd-save-backup` that is the last copy of a missing document is kept.

use std::path::Path;
use std::time::{Duration, SystemTime};

/// A temp file must survive at least this long before it is considered
/// abandoned. Generous on purpose — the cost of keeping a stale file for an
/// hour is zero, the cost of deleting a live one is a failed save.
pub const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

const SAVE_BACKUP_SUFFIX: &str = ".omd-save-backup";

/// Scans `dir` (non-recursive) and removes abandoned staging files. A missing
/// or unreadable directory is a no-op: sweeping is housekeeping, never a
/// reason to fail startup or a save.
pub fn sweep_stale_entries(dir: &Path) -> usize {
    sweep_stale_entries_older_than(dir, STALE_TEMP_AGE)
}

/// Age-parameterized sweep, so tests can drive both branches without waiting.
pub(crate) fn sweep_stale_entries_older_than(dir: &Path, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_staging_name(&name) {
            continue;
        }
        if backup_missing_target(dir, &name) {
            // A crash mid-save left the document's only copy in this backup.
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let age = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .unwrap_or_default();
        if !is_stale(age, max_age) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Sweeps `snapshots_root` and its direct bucket subdirectories. Buckets live
/// one level below the config dir, so the flat sweep of `config_dir` can never
/// see the staging files `atomic_write` leaves inside them. Directory symlinks
/// are never followed: a linked bucket must not become a licence to delete
/// files outside the config dir.
pub fn sweep_snapshots_dir(snapshots_root: &Path) -> usize {
    sweep_snapshots_dir_older_than(snapshots_root, STALE_TEMP_AGE)
}

/// Age-parameterized bucket sweep, so tests can drive both branches.
pub(crate) fn sweep_snapshots_dir_older_than(snapshots_root: &Path, max_age: Duration) -> usize {
    let mut removed = sweep_stale_entries_older_than(snapshots_root, max_age);
    let Ok(entries) = std::fs::read_dir(snapshots_root) else {
        return removed;
    };
    for entry in entries.flatten() {
        // `DirEntry::file_type` reports the link itself, never its target.
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        removed += sweep_stale_entries_older_than(&entry.path(), max_age);
    }
    removed
}

/// Every app-owned directory that can hold crash leftovers.
pub fn sweep_app_dirs(config_dir: &Path, recovery_dir: &Path) -> usize {
    sweep_stale_entries(config_dir)
        + sweep_stale_entries(recovery_dir)
        + sweep_snapshots_dir(&config_dir.join("snapshots"))
}

/// Names this app's writers can leave behind:
/// - `tempfile`'s default `.tmpXXXXXX` staging names,
/// - `documents::save`'s `.omd-save-{pid}-{nanos}.tmp`,
/// - `workspace`'s case-only rename staging `.omd-rename-*`,
/// - the Windows `.omd-save-backup` rename fallback (`.{pid}-{nanos}...`).
fn is_staging_name(name: &str) -> bool {
    if name.starts_with(".tmp") || name.starts_with(".omd-rename-") {
        return true;
    }
    if name.starts_with(".omd-save-") && name.ends_with(".tmp") {
        return true;
    }
    name.starts_with('.') && name.ends_with(SAVE_BACKUP_SUFFIX)
}

/// `.omd-save-backup` names embed the document they replaced
/// (`.{pid}-{nanos}.{file_name}.omd-save-backup`). A Windows crash between the
/// backup rename and the persist leaves that document missing while the backup
/// holds the user's only copy, so such a backup is kept until the document is
/// back. Legacy names without an embedded file name (`.{pid}-{nanos}`) cannot
/// be matched to a document and sweep like any other leftover.
fn backup_missing_target(dir: &Path, staging_name: &str) -> bool {
    let Some(stamp_and_target) = staging_name
        .strip_prefix('.')
        .and_then(|name| name.strip_suffix(SAVE_BACKUP_SUFFIX))
    else {
        return false;
    };
    let Some((stamp, target_name)) = stamp_and_target.split_once('.') else {
        return false;
    };
    if !stamp.contains('-') || target_name.is_empty() {
        return false;
    }
    !dir.join(target_name).exists()
}

fn is_stale(age: Duration, max_age: Duration) -> bool {
    age >= max_age
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("omd-sweep-{}-{name}", std::process::id()));
        std::fs::remove_dir_all(&path).ok();
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn staging_names_are_recognized_and_user_files_are_not() {
        for staging in [
            ".tmpA1B2C3",
            ".omd-save-1234-5678.tmp",
            ".omd-rename-AbC123",
            ".1234-5678.omd-save-backup",
            ".1234-5678.note.md.omd-save-backup",
        ] {
            assert!(is_staging_name(staging), "{staging} must be staging");
        }
        for user in [
            "note.md",
            "session.json",
            "settings.json",
            ".gitignore",
            "123.md",
        ] {
            assert!(!is_staging_name(user), "{user} must be left alone");
        }
    }

    #[test]
    fn only_stale_staging_files_are_removed() {
        let dir = tmp("sweep");
        for staging in [
            ".tmpA1B2C3",
            ".omd-save-1234-5678.tmp",
            ".1234-5678.omd-save-backup",
            ".omd-rename-AbC123",
        ] {
            std::fs::write(dir.join(staging), "leftover").unwrap();
        }
        std::fs::write(dir.join("note.md"), "user content").unwrap();
        std::fs::write(dir.join("session.json"), "{}").unwrap();

        let removed = sweep_stale_entries_older_than(&dir, Duration::ZERO);

        assert_eq!(removed, 4);
        assert!(dir.join("note.md").is_file(), "user files must survive");
        assert!(dir.join("session.json").is_file());
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "left: {names:?}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn fresh_staging_files_are_kept_for_a_concurrent_writer() {
        let dir = tmp("sweep-fresh");
        std::fs::write(dir.join(".tmpA1B2C3"), "in flight").unwrap();

        let removed = sweep_stale_entries_older_than(&dir, STALE_TEMP_AGE);

        assert_eq!(removed, 0);
        assert!(dir.join(".tmpA1B2C3").is_file());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_age_guard_boundary_is_inclusive_and_missing_dirs_are_noops() {
        assert!(!is_stale(Duration::from_secs(30), STALE_TEMP_AGE));
        assert!(is_stale(STALE_TEMP_AGE, STALE_TEMP_AGE));
        assert!(is_stale(STALE_TEMP_AGE * 2, STALE_TEMP_AGE));
        assert_eq!(
            sweep_stale_entries_older_than(&tmp("missing-base").join("absent"), STALE_TEMP_AGE),
            0
        );
    }

    /// Ages a file past [`STALE_TEMP_AGE`] without sleeping.
    fn backdate(path: &Path) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - STALE_TEMP_AGE * 2)
            .unwrap();
    }

    #[test]
    fn app_sweep_reaches_one_level_into_snapshot_buckets() {
        let config = tmp("app-config");
        let recovery = tmp("app-recovery");
        let bucket = config.join("snapshots").join("0123456789abcdef");
        std::fs::create_dir_all(&bucket).unwrap();
        for stale in [
            config.join(".tmpA1B2C3"),
            recovery.join(".omd-save-1234-5678.tmp"),
            bucket.join(".tmpD4E5F6"),
        ] {
            std::fs::write(&stale, "leftover").unwrap();
            backdate(&stale);
        }
        let snapshot = bucket.join("1699999999999.md");
        std::fs::write(&snapshot, "# snapshot").unwrap();
        backdate(&snapshot);

        assert_eq!(sweep_app_dirs(&config, &recovery), 3);

        assert!(!config.join(".tmpA1B2C3").exists());
        assert!(!recovery.join(".omd-save-1234-5678.tmp").exists());
        assert!(!bucket.join(".tmpD4E5F6").exists());
        assert!(snapshot.is_file(), "snapshots must never be swept");
        std::fs::remove_dir_all(config).ok();
        std::fs::remove_dir_all(recovery).ok();
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_sweep_never_follows_a_linked_bucket() {
        let root = tmp("snapshots-link");
        let outside = tmp("snapshots-outside");
        let victim = outside.join(".tmpA1B2C3");
        std::fs::write(&victim, "not ours").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("0123456789abcdef")).unwrap();

        assert_eq!(sweep_snapshots_dir_older_than(&root, Duration::ZERO), 0);
        assert!(victim.is_file(), "a linked bucket must stay untouched");
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(outside).ok();
    }

    #[test]
    fn save_backups_are_kept_while_their_document_is_missing() {
        let dir = tmp("save-backup");
        let backup = ".1234-5678.note.md.omd-save-backup";
        std::fs::write(dir.join(backup), "unsaved edits").unwrap();
        std::fs::write(dir.join(".1234-5678.omd-save-backup"), "legacy").unwrap();

        assert_eq!(sweep_stale_entries_older_than(&dir, Duration::ZERO), 1);
        assert!(dir.join(backup).is_file(), "the last copy must survive");
        assert!(!dir.join(".1234-5678.omd-save-backup").exists());

        // Once the document is back, the backup is only duplication.
        std::fs::write(dir.join("note.md"), "saved").unwrap();
        assert_eq!(sweep_stale_entries_older_than(&dir, Duration::ZERO), 1);
        assert!(!dir.join(backup).exists());
        assert!(dir.join("note.md").is_file());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn backup_target_extraction_only_matches_embedded_file_names() {
        let dir = tmp("backup-names");
        std::fs::write(dir.join("note.md"), "x").unwrap();

        assert!(backup_missing_target(&dir, ".1-2.gone.md.omd-save-backup"));
        assert!(!backup_missing_target(&dir, ".1-2.note.md.omd-save-backup"));
        assert!(!backup_missing_target(&dir, ".1-2.omd-save-backup"));
        assert!(!backup_missing_target(
            &dir,
            ".nodash.note.md.omd-save-backup"
        ));
        assert!(!backup_missing_target(&dir, ".tmpA1B2C3"));
        std::fs::remove_dir_all(dir).ok();
    }
}
