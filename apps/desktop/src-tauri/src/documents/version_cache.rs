//! Version-probe cache for `stat_document`'s poll loop.
//!
//! Extracted from `documents.rs` to keep both modules under the size limit; the
//! cache and its keying rules are the only thing here.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use super::*;

/// Stat-first version probe cache (Spec 05b §14.9).
///
/// The background poll and the watcher probe every open tab on each round; a
/// full read plus blake3 per round keeps a 50 MB file generating IO and
/// allocation pressure. The cache records `requested path → (mtime_ns, size,
/// version)` from the previous probe: matching stat data returns the cached
/// `DocumentVersion` without reading, a mismatch does the full read plus blake3
/// and refills the entry. There is no TTL and no explicit invalidation — stat
/// agreement *is* the contract.
///
/// Accepted residual risk: on a coarse-mtime filesystem (HFS+ has 1 s
/// granularity) an external write of the same size inside one timestamp goes
/// unnoticed until the next stat change; likewise a symlink retargeted to a
/// different file with exactly the same (mtime_ns, size). APFS/ext4/NTFS all
/// have nanosecond or 100 ns granularity.
#[derive(Clone, Default)]
pub struct DocumentVersionCache {
    pub(crate) entries: Arc<Mutex<HashMap<PathBuf, CachedVersionStat>>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CachedVersionStat {
    pub(crate) mtime_ns: u64,
    pub(crate) size: u64,
    pub(crate) version: DocumentVersion,
}

/// Cache key (mtime_ns, size) from the target metadata. Platforms without a
/// usable `modified()` return None: the cache is bypassed and the read is full.
pub(crate) fn stat_cache_key(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    let mtime_ns = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        // Pre-UNIX_EPOCH timestamps collapse to 0: two different such mtimes
        // would share a key and, with equal sizes, wrongly hit the cache.
        .unwrap_or(0);
    Some((mtime_ns, metadata.len()))
}

/// Pure check: does the disk stat agree with the cached entry?
pub(crate) fn version_stat_matches(entry: &CachedVersionStat, mtime_ns: u64, size: u64) -> bool {
    entry.mtime_ns == mtime_ns && entry.size == size
}

fn evict_cached_version(cache: &DocumentVersionCache, path: &Path) {
    let mut entries = cache
        .entries
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.remove(path);
}

pub(crate) fn read_document_version_cached(
    cache: &DocumentVersionCache,
    path: &str,
) -> Result<ExpectedDocumentVersion, DocumentError> {
    let path_buf = validate_requested(path)?;
    // Existence and symlink handling match probe_disk_raw; the target metadata
    // is read first for the stat check. A missing file is a normal answer and
    // evicts the entry, so the map cannot grow unbounded across many files.
    let node_metadata = match std::fs::symlink_metadata(&path_buf) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            evict_cached_version(cache, &path_buf);
            return Ok(ExpectedDocumentVersion::Missing);
        }
        Err(error) => return Err(map_read_io_error(&path_buf, error)),
    };
    let node_is_symlink = node_metadata.file_type().is_symlink();
    let resolved = match std::fs::canonicalize(&path_buf) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound && node_is_symlink => {
            evict_cached_version(cache, &path_buf);
            return Err(read_failed("symbolic link target is missing"));
        }
        Err(error) => return Err(map_read_io_error(&path_buf, error)),
    };
    let resolved_path = path_to_string(&resolved)?;
    let metadata =
        std::fs::metadata(&resolved).map_err(|error| map_read_io_error(&path_buf, error))?;
    require_regular_file(&metadata, &path_buf)?;
    let Some((mtime_ns, size)) = stat_cache_key(&metadata) else {
        // No reliable mtime: neither read nor refill the cache; read fully.
        let version = probe_version_uncached(&resolved, &resolved_path, &path_buf)?;
        return Ok(ExpectedDocumentVersion::Existing { version });
    };

    // Cache-hit path: table lookup plus clone under the lock, no IO. A write
    // landing right after the stat is caught by the next round's mismatch.
    {
        let entries = cache
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = entries.get(&path_buf) {
            if version_stat_matches(entry, mtime_ns, size) {
                return Ok(ExpectedDocumentVersion::Existing {
                    version: entry.version.clone(),
                });
            }
        }
    }

    // Miss: full read plus blake3. Two concurrent probes can reach this line;
    // the duplicate read is idempotent and each refills its own stat-checked
    // pairing, which is harmless.
    let version = probe_version_uncached(&resolved, &resolved_path, &path_buf)?;
    // Re-stat after the read (double check): only a pairing whose stat is
    // unchanged is cached. A write landing mid-read makes the (stat, version)
    // pairing untrustworthy; a later redundant read beats caching a mismatch
    // (a mismatch can only cause extra misses, never a wrong hit).
    if let Ok(after) = std::fs::metadata(&resolved) {
        if let Some((mtime_ns_after, size_after)) = stat_cache_key(&after) {
            if mtime_ns_after == mtime_ns && size_after == size {
                let mut entries = cache
                    .entries
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                entries.insert(
                    path_buf,
                    CachedVersionStat {
                        mtime_ns,
                        size,
                        version: version.clone(),
                    },
                );
            }
        }
    }
    Ok(ExpectedDocumentVersion::Existing { version })
}

fn probe_version_uncached(
    resolved: &Path,
    resolved_path: &str,
    error_path: &Path,
) -> Result<DocumentVersion, DocumentError> {
    let (mut file, _metadata) = open_regular_document(resolved, error_path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| map_read_io_error(error_path, error))?;
    Ok(DocumentVersion {
        resolved_path: resolved_path.to_owned(),
        fingerprint: fingerprint(&bytes),
    })
}
