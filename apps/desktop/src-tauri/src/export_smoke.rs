//! Feature-gated runtime smoke test for the native PNG export backends.
//!
//! Built as the `export-smoke` binary (`--features export-smoke`) and run on
//! each CI platform, it proves the real WebView renders a PNG at
//! `width * scale` instead of trusting compile-time plumbing alone.

use super::{ExportFormat, ExportSpec};
use std::path::PathBuf;
use tauri::Manager;

const SMOKE_HEIGHT_CSS: u32 = 600;
const DEFAULT_WIDTH_CSS: u32 = 800;
const DEFAULT_SCALE: u32 = 2;
const PNG_OUTPUT_NAME: &str = "omd-export-smoke.png";
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// Entry point for `src/bin/export-smoke.rs`.
pub fn run() {
    let result = super::builder_with_export_protocol()
        .setup(|app| {
            let handle = app.handle().clone();
            // A real event loop is required on every backend (macOS dispatches
            // the capture to the main thread, Win/Linux drive an offscreen
            // WebView), so the smoke export runs as a task instead of inside
            // setup, where the loop is not spinning yet.
            tauri::async_runtime::spawn(async move {
                match smoke(handle).await {
                    Ok(line) => {
                        println!("{line}");
                        std::process::exit(0);
                    }
                    Err(error) => {
                        eprintln!("EXPORT_SMOKE_FAIL {error}");
                        std::process::exit(1);
                    }
                }
            });
            Ok(())
        })
        .run(super::app_context::context());
    // `run` returns only when the event loop stops without the task having
    // exited the process; that is a failure, never a silent success.
    let message = match result {
        Ok(()) => "event loop exited before the smoke export finished".to_string(),
        Err(error) => error.to_string(),
    };
    eprintln!("EXPORT_SMOKE_FAIL {message}");
    std::process::exit(1);
}

async fn smoke(app: tauri::AppHandle) -> Result<String, String> {
    // Let the app's event loop enter its running state before building a second
    // window; a window built from `setup` can otherwise be registered before the
    // runtime is ready to receive its messages.
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    // Do not query `main.url()` here: WKWebView reports no URL until its first
    // navigation commits, and wry unwraps that `Option` inside `url()`, which
    // panics the macOS smoke before the export window is built.
    eprintln!(
        "[export-smoke] windows={:?}",
        app.webview_windows().keys().collect::<Vec<_>>()
    );
    let width_css = env_u32("OMD_EXPORT_SMOKE_WIDTH", DEFAULT_WIDTH_CSS)?;
    let scale = env_u32("OMD_EXPORT_SMOKE_SCALE", DEFAULT_SCALE)?;
    #[cfg(windows)]
    {
        let pdf_only = std::env::args().any(|arg| arg == "--pdf-only");
        let output = if pdf_only {
            std::env::var_os("OMD_EXPORT_SMOKE_OUT").map(PathBuf::from)
        } else {
            None
        };
        verify_pdf(&app, width_css, output).await?;
        if pdf_only {
            return Ok("EXPORT_SMOKE_OK format=pdf".into());
        }
    }
    let out = std::env::var_os("OMD_EXPORT_SMOKE_OUT")
        .map_or_else(|| std::env::temp_dir().join(PNG_OUTPUT_NAME), PathBuf::from);
    let spec = ExportSpec::new(width_css, scale)?;
    let html = smoke_html();
    // Drive the real Tauri command body rather than the platform function, so
    // path validation, styled HTML, atomic write and warning serialization are
    // covered on every platform (the dialog/IPC envelope is covered by tests).
    let requested = out
        .to_str()
        .ok_or_else(|| format!("invalid smoke output path: {}", out.display()))?;
    let target = super::validate_export(requested, ExportFormat::Png, &html)?;
    let target_text = target
        .to_str()
        .ok_or_else(|| format!("invalid smoke target path: {}", target.display()))?;
    super::export_preview(
        app.clone(),
        html,
        target_text.to_owned(),
        "png".to_owned(),
        scale,
        width_css,
        format!("smoke-{}", std::process::id()),
    )
    .await?;
    let bytes =
        std::fs::read(&target).map_err(|error| format!("read {}: {error}", target.display()))?;
    let (width, height) = png_dimensions(&bytes)?;
    if width != spec.device_width() || height != SMOKE_HEIGHT_CSS * scale {
        return Err(format!(
            "expected {}x{}, rendered {width}x{height}",
            spec.device_width(),
            SMOKE_HEIGHT_CSS * scale
        ));
    }
    verify_cancel(&app, scale, width_css, ExportFormat::Png).await?;
    Ok(format!(
        "EXPORT_SMOKE_OK width={width} height={height} scale={scale} path={}",
        target.display()
    ))
}

#[cfg(windows)]
async fn verify_pdf(
    app: &tauri::AppHandle,
    width_css: u32,
    target: Option<PathBuf>,
) -> Result<(), String> {
    let output = tempfile::tempdir().map_err(|error| error.to_string())?;
    let target = target.unwrap_or_else(|| output.path().join("smoke.pdf"));
    let target_text = target.to_str().ok_or("invalid PDF smoke target path")?;
    let html = r#"<!doctype html><html><head><meta charset="utf-8">
<style>@media print { .second { break-before: page } }</style></head><body>
<table><tr><th>Quantity</th><th>Formula</th></tr>
<tr><td>Square</td><td><math><msup><mi>x</mi><mn>2</mn></msup></math></td></tr></table>
<p class="second">Second page</p>
<script>window.__omdExportReady=true;window.__omdExportHeight=600;</script>
</body></html>"#;
    let warning = super::export_preview(
        app.clone(),
        html.into(),
        target_text.into(),
        "pdf".into(),
        1,
        width_css,
        format!("smoke-pdf-{}", std::process::id()),
    )
    .await?;
    let bytes = std::fs::read(target).map_err(|error| error.to_string())?;
    // Chromium's page tree is plain PDF syntax. The page break must survive
    // the print stylesheet, and the output must reach its end-of-file marker.
    let contents = String::from_utf8_lossy(&bytes);
    if warning.is_some()
        || !bytes.starts_with(b"%PDF-")
        || !contents.trim_end().ends_with("%%EOF")
        || pdf_page_count(&bytes) != 2
    {
        return Err("WebView2 did not print a complete two-page PDF".into());
    }
    verify_cancel(app, 1, width_css, ExportFormat::Pdf).await?;
    println!("EXPORT_PDF_SMOKE_OK pages=2");
    Ok(())
}

/// Cancels a render whose page never signals ready. This exercises the real
/// cancel command, token registration, platform poll, and window cleanup on
/// every CI platform instead of trusting the button wiring alone.
async fn verify_cancel(
    app: &tauri::AppHandle,
    scale: u32,
    width_css: u32,
    format: ExportFormat,
) -> Result<(), String> {
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let request_id = format!("cancel-{nonce}");
    let extension = format.extension();
    let out = std::env::temp_dir().join(format!("omd-export-cancel-{nonce}.{extension}"));
    let target = super::validate_export(
        out.to_str()
            .ok_or_else(|| format!("invalid cancel smoke path: {}", out.display()))?,
        format,
        CANCEL_PROBE_HTML,
    )?;
    let target_text = target
        .to_str()
        .ok_or_else(|| format!("invalid cancel target path: {}", target.display()))?
        .to_owned();
    let task = tauri::async_runtime::spawn(super::export_preview(
        app.clone(),
        CANCEL_PROBE_HTML.to_owned(),
        target_text.clone(),
        extension.to_owned(),
        scale,
        width_css,
        request_id.clone(),
    ));
    // Let the command register its token and build the offscreen window.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let cancelled_at = Instant::now();
    super::cancel_export(app.clone(), request_id).await;
    let result = task
        .await
        .map_err(|error| format!("cancel task failed: {error}"))?;
    if !matches!(&result, Err(error) if error.contains("export cancelled")) {
        return Err(format!("cancel did not abort the export: {result:?}"));
    }
    let elapsed = cancelled_at.elapsed();
    if elapsed > Duration::from_secs(8) {
        return Err(format!("cancel took {elapsed:?}"));
    }
    if target.exists() {
        let _ = std::fs::remove_file(&target);
        return Err(format!("cancelled {extension} export wrote a file"));
    }
    eprintln!("[export-smoke] {extension} cancel ok in {elapsed:?}");
    Ok(())
}

const CANCEL_PROBE_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\">\
<style>html,body{margin:0;padding:0;width:100%;height:600px;background:#fff}</style>\
</head><body>cancel probe never signals ready</body></html>";

fn smoke_html() -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>\
         html,body{{margin:0;padding:0;width:100%;height:{SMOKE_HEIGHT_CSS}px;background:#fff}}\
         </style></head><body>\
         <div style=\"position:absolute;top:0;left:40px;width:1px;height:200px;background:#000\"></div>\
         <script>window.__omdExportReady=true;window.__omdExportHeight={SMOKE_HEIGHT_CSS};</script>\
         </body></html>"
    )
}

fn env_u32(key: &str, default: u32) -> Result<u32, String> {
    match std::env::var(key) {
        Ok(value) => value
            .trim()
            .parse()
            .map_err(|_| format!("{key} must be a number, got {value:?}")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(format!("{key}: {error}")),
    }
}

/// Reads the IHDR width/height so the assertion covers the actual pixels the
/// platform backend encoded, not just the requested spec.
fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    const IHDR_LENGTH: usize = 24;
    if bytes.len() < IHDR_LENGTH || bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return Err("render did not produce a PNG IHDR header".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| "truncated IHDR")?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| "truncated IHDR")?);
    Ok((width, height))
}

/// Page objects (`/Type /Page`, not `/Pages`), with any whitespace PDF allows
/// between the tokens, so a writer formatting change cannot fake a failure.
#[cfg(any(windows, test))]
fn pdf_page_count(bytes: &[u8]) -> usize {
    static PAGE: std::sync::OnceLock<regex::bytes::Regex> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| regex::bytes::Regex::new(r"/Type\s*/Page(?:[^s\w]|$)").expect("page regex"))
        .find_iter(bytes)
        .count()
}

#[cfg(test)]
mod pdf_page_tests {
    use super::pdf_page_count;

    #[test]
    fn counts_page_objects_not_the_page_tree() {
        let pdf = b"%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >>\n2 0 obj << /Type /Page\n/Parent 1 0 R >>\n3 0 obj <</Type/Page/Parent 1 0 R>>\n%%EOF";
        assert_eq!(pdf_page_count(pdf), 2);
        assert_eq!(
            pdf_page_count(b"<< /Type /Page\r\n>> << /Type  /Page >>"),
            2
        );
        assert_eq!(pdf_page_count(b"<< /Type /Pages >>"), 0);
        assert_eq!(pdf_page_count(b"/Type /Page"), 1);
    }
}
