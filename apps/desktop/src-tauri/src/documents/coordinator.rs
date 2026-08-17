use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, Weak};

use super::DocumentError;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PathKey(String);

pub(crate) fn resolve_path_key(path: &Path) -> Result<PathKey, DocumentError> {
    let canonical = match std::fs::canonicalize(path) {
        Ok(canonical) => canonical,
        Err(_) => {
            let parent = path
                .parent()
                .ok_or_else(|| invalid_path("document path has no parent directory"))?;
            let file_name = path
                .file_name()
                .ok_or_else(|| invalid_path("document path has no file name"))?;
            let canonical_parent = std::fs::canonicalize(parent)
                .map_err(|_| invalid_path("parent directory does not exist"))?;
            canonical_parent.join(file_name)
        }
    };
    let key_string = canonical
        .to_str()
        .ok_or_else(|| invalid_path("document path is not valid UTF-8"))?;
    Ok(PathKey(key_string.to_owned()))
}

#[derive(Clone, Default)]
pub struct DocumentCoordinator {
    locks: Arc<Mutex<HashMap<PathKey, Weak<Mutex<()>>>>>,
}

impl DocumentCoordinator {
    pub fn lock_for(&self, key: &PathKey) -> Arc<Mutex<()>> {
        let mut registry = self
            .locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.retain(|_, weak| weak.strong_count() > 0);

        if let Some(existing) = registry.get(key) {
            if let Some(upgraded) = existing.upgrade() {
                return upgraded;
            }
        }

        let new_lock = Arc::new(Mutex::new(()));
        registry.insert(key.clone(), Arc::downgrade(&new_lock));
        new_lock
    }

    #[cfg(test)]
    pub fn tracked_paths(&self) -> usize {
        let mut registry = self
            .locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry.retain(|_, weak| weak.strong_count() > 0);
        registry.len()
    }
}

fn invalid_path(message: &str) -> DocumentError {
    DocumentError::InvalidPath(message.into())
}
