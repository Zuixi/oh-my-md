//! Windows PNG backend: WebView2 CDP screenshot at an explicit pixel scale.
//!
//! CDP re-rasterizes the page at `clip.scale` instead of upscaling a 1x bitmap,
//! which is what keeps text and vector math crisp on 4K/Retina displays. The
//! shared host owns window creation, readiness polling, clamping and cleanup.

use super::export_host;
use crate::export::{ExportFormat, ExportSpec, Probe, RenderOutput, PROBE_SCRIPT};
use base64::Engine;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, ExecuteScriptCompletedHandler};
use windows::core::HSTRING;

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn render(
    app: tauri::AppHandle,
    html: String,
    spec: ExportSpec,
    format: ExportFormat,
) -> Result<RenderOutput, String> {
    if format != ExportFormat::Png {
        return Err("PDF export is only available on macOS".into());
    }
    export_host::render_with_window(app, html, spec, format, probe, capture).await
}

fn with_core<T: Send + 'static>(
    window: &WebviewWindow,
    timeout: Duration,
    f: impl FnOnce(&ICoreWebView2, mpsc::Sender<Result<T, String>>) -> Result<(), String>
        + Send
        + 'static,
) -> Result<T, String> {
    #[cfg(feature = "export-smoke")]
    eprintln!("[export-smoke] with_core enter");
    let (tx, rx) = mpsc::channel();
    let error_tx = tx.clone();
    // Call from the worker: `with_webview` posts the closure to the event loop.
    // Blocking inside that closure would deadlock WebView2 completions.
    window
        .with_webview(move |platform| {
            #[cfg(feature = "export-smoke")]
            eprintln!("[export-smoke] with_webview closure");
            let result = (|| {
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                f(&core, tx)
            })();
            if let Err(error) = result {
                let _ = error_tx.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => {
            #[cfg(feature = "export-smoke")]
            eprintln!("[export-smoke] with_core timeout");
            Err("webview callback timed out".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => {
            #[cfg(feature = "export-smoke")]
            eprintln!("[export-smoke] with_core dropped");
            Err("webview callback was dropped before running".to_string())
        }
    }
}

fn probe(window: &WebviewWindow) -> Result<Option<Probe>, String> {
    let raw: String = with_core(window, PROBE_TIMEOUT, |core, tx| {
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |_hr, result| {
            let _ = tx.send(Ok(result));
            Ok(())
        }));
        let script = HSTRING::from(PROBE_SCRIPT);
        unsafe { core.ExecuteScript(&script, &handler) }.map_err(|error| error.to_string())
    })?;
    super::export_host::parse_probe(&raw)
}

fn capture(window: &WebviewWindow, spec: &ExportSpec, probe: &Probe) -> Result<Vec<u8>, String> {
    let params = capture_params(spec, probe);
    let raw: String = with_core(window, CAPTURE_TIMEOUT, move |core, tx| {
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_hr, result| {
                let _ = tx.send(Ok(result));
                Ok(())
            }));
        let method = HSTRING::from("Page.captureScreenshot");
        let params = HSTRING::from(params);
        unsafe { core.CallDevToolsProtocolMethod(&method, &params, &handler) }
            .map_err(|error| error.to_string())
    })?;
    decode_capture(&raw, spec.device_width())
}

fn capture_params(spec: &ExportSpec, probe: &Probe) -> String {
    serde_json::json!({
        "format": "png",
        "captureBeyondViewport": true,
        "fromSurface": true,
        "clip": {
            "x": 0,
            "y": 0,
            "width": spec.width_css.round(),
            "height": probe.height_css.round(),
            "scale": spec.scale,
        }
    })
    .to_string()
}

fn decode_capture(raw: &str, expected_width: u32) -> Result<Vec<u8>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| format!("invalid CDP response: {error}"))?;
    if let Some(error) = value.get("error") {
        return Err(format!("Page.captureScreenshot failed: {error}"));
    }
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_str)
        .ok_or("Page.captureScreenshot returned no image data")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("invalid PNG base64: {error}"))?;
    require_png(&bytes, expected_width)?;
    Ok(bytes)
}

fn require_png(bytes: &[u8], expected_width: u32) -> Result<(), String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len() < 24 {
        return Err("capture did not produce a valid PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width slice"));
    if width != expected_width {
        return Err(format!(
            "WebView2 screenshot is {} px wide, expected {} px; the display scale could not be overridden",
            width, expected_width
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_params_request_native_scale() {
        let spec = ExportSpec::new(800, 2).unwrap();
        let params = capture_params(
            &spec,
            &Probe {
                height_css: 1200.0,
                incomplete: false,
            },
        );
        let value: serde_json::Value = serde_json::from_str(&params).unwrap();
        assert_eq!(value["clip"]["scale"], 2.0);
        assert_eq!(value["clip"]["width"], 800.0);
        assert_eq!(value["clip"]["height"], 1200.0);
        assert_eq!(value["captureBeyondViewport"], true);
    }

    #[test]
    fn probe_accepts_double_encoded_json() {
        let raw = r#""{\"ready\":true,\"height\":1234.5,\"incomplete\":false}""#;
        let probe = super::export_host::parse_probe(raw).unwrap().unwrap();
        assert_eq!(probe.height_css, 1234.5);
    }

    #[test]
    fn probe_waits_until_ready() {
        assert!(
            super::export_host::parse_probe(r#"{"ready":false,"height":10}"#)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn decode_rejects_non_png() {
        let raw = serde_json::json!({"data": "aGVsbG8="}).to_string();
        assert!(decode_capture(&raw, 1600).is_err());
    }
}
