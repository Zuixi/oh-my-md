//! Shared environment lock for tests that redirect settings/recovery IO.
use std::sync::Mutex;

static CONFIG_ENV_LOCK: Mutex<()> = Mutex::new(());

/// Held by every test that sets or removes `OMD_CONFIG_DIR` / `OMD_RECOVERY_DIR`,
/// in this module or any other: `config_dir()` reads the env live, so a test
/// that swaps it can change what an unrelated parallel test's `get_settings()`
/// returns. Crate-visible because `logging`'s level tests pin the same variable
/// to keep the persisted verbose flag out of their assertions.
pub(crate) fn config_env_guard() -> std::sync::MutexGuard<'static, ()> {
    CONFIG_ENV_LOCK.lock().unwrap()
}
