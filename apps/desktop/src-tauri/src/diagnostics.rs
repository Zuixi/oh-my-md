use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

pub fn redact_line(line: &str, home: &str) -> String {
    let replaced = if home.is_empty() {
        line.to_string()
    } else {
        line.replace(home, "<home>")
    };

    let mut result = String::with_capacity(replaced.len());
    let mut rest = replaced.as_str();
    while let Some(start) = rest.find("file:///") {
        result.push_str(&rest[..start]);
        let after_prefix = &rest[start + "file:///".len()..];
        let url_len = after_prefix
            .find(|c: char| c.is_whitespace())
            .unwrap_or(after_prefix.len());
        let url = &after_prefix[..url_len];
        let basename = url.rsplit('/').next().unwrap_or(url);
        result.push_str(basename);
        rest = &after_prefix[url_len..];
    }
    result.push_str(rest);
    result
}

pub fn redact_text(text: &str, home: &str) -> String {
    text.lines()
        .map(|line| redact_line(line, home))
        .collect::<Vec<_>>()
        .join("\n")
}

fn os_summary() -> String {
    let os = os_info::get();
    format!("{} {} ({})", os.os_type(), os.version(), os.bitness())
}

fn write_diagnostics_bundle(path: &Path, log_dir: &Path, home: &str) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();

    zip.start_file("version.txt", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(env!("CARGO_PKG_VERSION").as_bytes())
        .map_err(|e| e.to_string())?;

    zip.start_file("os.txt", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(os_summary().as_bytes())
        .map_err(|e| e.to_string())?;

    let mut log_files: Vec<PathBuf> = Vec::new();
    if log_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(log_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|extension| extension.to_str()) == Some("log") {
                    log_files.push(path);
                }
            }
        }
    }
    log_files.sort();

    let mut combined = String::new();
    for log_path in &log_files {
        let contents = std::fs::read_to_string(log_path).map_err(|e| e.to_string())?;
        let name = log_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("log");
        let redacted = redact_text(&contents, home);
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(redacted.as_bytes())
            .map_err(|e| e.to_string())?;
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&redacted);
    }

    zip.start_file("diagnostics.txt", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(combined.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_diagnostics(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let home = dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default();
    write_diagnostics_bundle(Path::new(&path), &log_dir, &home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_line_replaces_home_path() {
        let out = redact_line("opened /Users/alice/notes/a.md", "/Users/alice");
        assert!(out.contains("<home>/notes/a.md"));
        assert!(!out.contains("/Users/alice"));
    }

    #[test]
    fn redact_line_strips_file_url_to_basename() {
        let out = redact_line("asset file:///Users/alice/a.png", "/Users/alice");
        assert!(out.contains("a.png"));
        assert!(!out.contains("file:///"));
        assert!(!out.contains("/Users/alice"));
    }

    #[test]
    fn export_diagnostics_writes_zip_without_logs() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("bundle.zip");
        let log_dir = dir.path().join("empty-logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let home = dir.path().join("empty-home");
        std::fs::create_dir_all(&home).unwrap();

        write_diagnostics_bundle(&bundle, &log_dir, home.to_str().unwrap()).unwrap();

        assert!(bundle.exists());
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&bundle).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "version.txt"));
        assert!(names.iter().any(|n| n == "os.txt"));
        assert!(names.iter().any(|n| n == "diagnostics.txt"));
    }

    #[test]
    fn export_diagnostics_collects_and_redacts_logs_from_dir() {
        let dir = tempfile::tempdir().unwrap();
        let log_dir = dir.path().join("logs");
        std::fs::create_dir_all(&log_dir).unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let home_str = home.to_str().unwrap().to_string();
        std::fs::write(
            log_dir.join("app.log"),
            format!(
                "opened {}/notes/a.md asset file:///{}/notes/a.png",
                home_str, home_str
            ),
        )
        .unwrap();

        let bundle = dir.path().join("bundle.zip");
        write_diagnostics_bundle(&bundle, &log_dir, &home_str).unwrap();

        let mut archive = zip::ZipArchive::new(std::fs::File::open(&bundle).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "os.txt"));
        assert!(names.iter().any(|n| n == "diagnostics.txt"));
        let mut diagnostics = String::new();
        use std::io::Read;
        archive
            .by_name("diagnostics.txt")
            .unwrap()
            .read_to_string(&mut diagnostics)
            .unwrap();
        assert!(diagnostics.contains("a.md"));
        assert!(diagnostics.contains("<home>/notes"));
        assert!(!diagnostics.contains(&home_str));
    }
}
