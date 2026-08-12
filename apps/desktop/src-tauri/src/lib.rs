#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file])
        .run(tauri::generate_context!())
        .expect("error while running oh-my-md");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("omd-test-{}-{}", std::process::id(), name));
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn write_then_read_roundtrip() {
        let path = tmp_path("roundtrip.md");
        let contents = "# 标题\n\nbody with **bold** and 🦀\n".to_string();
        write_file(path.clone(), contents.clone()).unwrap();
        assert_eq!(read_file(path.clone()).unwrap(), contents);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn read_missing_file_errors() {
        assert!(read_file(tmp_path("does-not-exist.md")).is_err());
    }
}
