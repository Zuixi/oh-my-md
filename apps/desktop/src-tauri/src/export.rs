use std::path::{Component, Path, PathBuf};

const MAX_EXPORT_HTML_BYTES: usize = 8 * 1024 * 1024;
const EXPORT_STYLE: &str = concat!(
    "html,body{background:#fff;color:#111}",
    "body{font:16px/1.6 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;",
    "max-width:720px;margin:0 auto;padding:32px}",
    "img{max-width:100%}pre{overflow:auto}table{border-collapse:collapse}",
    "td,th{border:1px solid #ccc;padding:4px 8px}",
    "@page{margin:16mm}",
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    Pdf,
    Png,
}

impl ExportFormat {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pdf" => Ok(Self::Pdf),
            "png" => Ok(Self::Png),
            _ => Err("export format must be pdf or png".into()),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Png => "png",
        }
    }
}

pub fn validate_export(path: &str, format: ExportFormat, html: &str) -> Result<PathBuf, String> {
    if html.len() > MAX_EXPORT_HTML_BYTES {
        return Err(format!(
            "export HTML exceeds the {MAX_EXPORT_HTML_BYTES} byte size limit"
        ));
    }
    reject_export_path(path, format)
}

pub fn styled_export_html(html: &str) -> String {
    let style = format!("<style>{EXPORT_STYLE}</style>");
    if let Some(index) = html.find("</head>") {
        let mut out = String::with_capacity(html.len() + style.len());
        out.push_str(&html[..index]);
        out.push_str(&style);
        out.push_str(&html[index..]);
        return out;
    }
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">{style}</head><body>{html}</body></html>"
    )
}

#[cfg(target_os = "macos")]
#[path = "export_native.rs"]
mod native;

pub(crate) fn measure_export_script(min_height: i32, max_height: i32) -> String {
    format!(
        "(function(){{var r=document.documentElement,b=document.body;\
         var h=Math.max(r?r.scrollHeight:0,b?b.scrollHeight:0,{min});\
         return Math.min(h,{max});}})()",
        min = min_height,
        max = max_height,
    )
}

const EXPORT_TIMEOUT_SECS: u64 = 20;

#[tauri::command]
pub async fn export_preview(
    app: tauri::AppHandle,
    html: String,
    path: String,
    format: String,
) -> Result<Option<String>, String> {
    let fmt = ExportFormat::parse(&format)?;
    let target = validate_export(&path, fmt, &html)?;
    let styled = styled_export_html(&html);
    let (bytes, warning) = render_bytes(app, styled, fmt).await?;
    crate::atomic_write(&target, &bytes)?;
    Ok(warning)
}

#[cfg(target_os = "macos")]
async fn render_bytes(
    app: tauri::AppHandle,
    html: String,
    format: ExportFormat,
) -> Result<(Vec<u8>, Option<String>), String> {
    native::render(app, html, format, EXPORT_TIMEOUT_SECS).await
}

#[cfg(not(target_os = "macos"))]
async fn render_bytes(
    app: tauri::AppHandle,
    html: String,
    format: ExportFormat,
) -> Result<(Vec<u8>, Option<String>), String> {
    let _ = (app, html, format);
    Err("PDF and image export are only available on macOS".into())
}

fn reject_export_path(path: &str, format: ExportFormat) -> Result<PathBuf, String> {
    let target = Path::new(path);
    if target
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("path must not contain traversal".into());
    }
    if target.is_dir() {
        return Err("export path must be a file, not a directory".into());
    }
    let extension = target.extension().and_then(|extension| extension.to_str());
    match extension {
        Some(value) if value.eq_ignore_ascii_case(format.extension()) => Ok(target.to_path_buf()),
        None => Ok(target.with_extension(format.extension())),
        Some(_) => Err(format!(
            "export path must use a .{} extension",
            format.extension()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_pdf_and_png_only() {
        assert_eq!(ExportFormat::parse("pdf").unwrap(), ExportFormat::Pdf);
        assert_eq!(ExportFormat::parse("png").unwrap(), ExportFormat::Png);
        assert!(ExportFormat::parse("html").is_err());
    }

    #[test]
    fn validate_export_rejects_traversal_and_mismatched_extension() {
        let html = "<p>hi</p>";
        assert!(validate_export("/tmp/../etc/x.pdf", ExportFormat::Pdf, html).is_err());
        assert!(validate_export("/tmp/out.png", ExportFormat::Pdf, html).is_err());
        assert!(validate_export("/tmp/out.pdf", ExportFormat::Png, html).is_err());
        assert_eq!(
            validate_export("/tmp/out.pdf", ExportFormat::Pdf, html).unwrap(),
            PathBuf::from("/tmp/out.pdf")
        );
    }

    #[test]
    fn validate_export_appends_png_when_save_dialog_omits_extension() {
        let html = "<p>hi</p>";
        assert_eq!(
            validate_export("/tmp/out", ExportFormat::Png, html).unwrap(),
            PathBuf::from("/tmp/out.png")
        );
        assert_eq!(
            validate_export("/tmp/out", ExportFormat::Pdf, html).unwrap(),
            PathBuf::from("/tmp/out.pdf")
        );
    }

    #[test]
    fn validate_export_rejects_an_existing_directory() {
        let directory = std::env::temp_dir().join(format!("omd-export-dir-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let result = validate_export(directory.to_str().unwrap(), ExportFormat::Png, "<p>hi</p>");
        let _ = std::fs::remove_dir(&directory);
        let error = result.expect_err("directory path must not be treated as a PNG file");
        assert!(
            error.to_lowercase().contains("directory"),
            "expected directory error, got {error}"
        );
    }

    #[test]
    fn measure_export_script_does_not_return_a_promise() {
        let script = measure_export_script(600, 16384);
        assert!(!script.contains("Promise"));
        assert!(!script.contains("fonts.ready"));
        assert!(script.contains("scrollHeight"));
    }

    #[test]
    fn validate_export_rejects_oversized_html() {
        let html = "a".repeat(MAX_EXPORT_HTML_BYTES + 1);
        assert!(validate_export("/tmp/out.pdf", ExportFormat::Pdf, &html).is_err());
    }

    #[test]
    fn styled_export_html_injects_print_stylesheet() {
        let html = "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>";
        let styled = styled_export_html(html);
        assert!(styled.contains("</style></head>"));
        assert!(styled.contains("@page{margin:16mm}"));
        assert!(styled.contains("<h1>Hi</h1>"));
    }
}
