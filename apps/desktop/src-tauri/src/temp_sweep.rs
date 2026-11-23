//! Sweep of this app's own crash leftovers.
//!
//! Every durable write stages a `NamedTempFile` sibling (`.tmpXXXXXX`), and the
//! document save path additionally uses `.omd-save-{pid}-{nanos}.tmp` plus a
//! `.omd-save-backup` rename fallback on Windows. A crash between staging and
//! rename leaves those behind; nothing else ever removes them, so they would
//! accumulate in app-owned directories forever.
//!
//! Only files older than [`STALE_TEMP_AGE`] are removed: a concurrent writer in
//! the same directory may legitimately own a fresh temp file.

use std::path::Path;
use std::time::{Duration, SystemTime};

/// A temp file must survive at least this long before it is considered
/// abandoned. Generous on purpose — the cost of keeping a stale file for an
/// hour is zero, the cost of deleting a live one is a failed save.
pub const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

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
    name.starts_with('.') && name.ends_with(".omd-save-backup")
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
}
