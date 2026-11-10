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
    if let Some(main) = app.get_webview_window("main") {
        eprintln!(
            "[export-smoke] main url={:?} visible={:?}",
            main.url(),
            main.is_visible()
        );
    }
    eprintln!(
        "[export-smoke] windows={:?}",
        app.webview_windows().keys().collect::<Vec<_>>()
    );
    let width_css = env_u32("OMD_EXPORT_SMOKE_WIDTH", DEFAULT_WIDTH_CSS)?;
    let scale = env_u32("OMD_EXPORT_SMOKE_SCALE", DEFAULT_SCALE)?;
    let out = std::env::var_os("OMD_EXPORT_SMOKE_OUT")
        .map_or_else(|| std::env::temp_dir().join(PNG_OUTPUT_NAME), PathBuf::from);
    let spec = ExportSpec::new(width_css, scale)?;
    let output = super::platform::render(app, smoke_html(), spec, ExportFormat::Png).await?;
    let (width, height) = png_dimensions(&output.bytes)?;
    if width != spec.device_width() || height != SMOKE_HEIGHT_CSS * scale {
        return Err(format!(
            "expected {}x{}, rendered {width}x{height}",
            spec.device_width(),
            SMOKE_HEIGHT_CSS * scale
        ));
    }
    std::fs::write(&out, &output.bytes)
        .map_err(|error| format!("write {}: {error}", out.display()))?;
    Ok(format!(
        "EXPORT_SMOKE_OK width={width} height={height} scale={scale} path={}",
        out.display()
    ))
}

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
