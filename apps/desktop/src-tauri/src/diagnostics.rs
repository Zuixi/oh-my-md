use std::io::Write;
use std::path::{Path, PathBuf};

const LOG_DIR_NAME: &str = "Library/Logs/md.ohmy.desktop";

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

pub fn redact_text(text: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    text.lines()
        .map(|line| redact_line(line, &home))
        .collect::<Vec<_>>()
        .join("\n")
}

fn log_dir(home: &str) -> PathBuf {
    Path::new(home).join(LOG_DIR_NAME)
}

fn write_diagnostics_bundle(path: &Path, home: &str) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();

    zip.start_file("version.txt", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(env!("CARGO_PKG_VERSION").as_bytes())
        .map_err(|e| e.to_string())?;

    let uname = std::process::Command::new("uname")
        .arg("-a")
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_else(|error| format!("uname failed: {error}"));
    zip.start_file("uname.txt", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(uname.as_bytes()).map_err(|e| e.to_string())?;

    let mut log_files: Vec<PathBuf> = Vec::new();
    let dir = log_dir(home);
    if dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
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
        let redacted = redact_text(&contents);
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
pub fn export_diagnostics(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    let home = std::env::var("HOME").unwrap_or_default();
    write_diagnostics_bundle(Path::new(&path), &home)
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
        let home = dir.path().join("empty-home");
        std::fs::create_dir_all(&home).unwrap();

        write_diagnostics_bundle(&bundle, home.to_str().unwrap()).unwrap();

        assert!(bundle.exists());
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&bundle).unwrap()).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.iter().any(|n| n == "version.txt"));
        assert!(names.iter().any(|n| n == "uname.txt"));
        assert!(names.iter().any(|n| n == "diagnostics.txt"));
    }
}
