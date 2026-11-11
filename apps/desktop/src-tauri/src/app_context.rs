//! One `generate_context!` expansion shared by the app and the export smoke
//! harness; expanding it twice in one crate duplicates its embedded symbols.

pub(crate) fn context() -> tauri::Context {
    tauri::generate_context!()
}
