//! Shared offscreen-window host for the Windows and Linux PNG exporters.
//!
//! The engine emits one self-contained HTML document; this module serves it
//! through a single-use custom protocol, waits for the page's ready flag, then
//! hands the platform module a measured CSS height. Platform code only probes
//! and captures; window lifecycle, token cleanup, timeouts and warnings stay
//! here so both backends behave identically.

use crate::export::{
    ExportFormat, ExportSpec, ExportWarning, Probe, RenderOutput, EXPORT_READY_TIMEOUT_MS,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// HTML documents are addressed by an unguessable token. The entry is removed
/// when the export window closes; a reload after that gets a 404.
#[derive(Default)]
pub struct ExportProtocolState {
    documents: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl ExportProtocolState {
    fn insert(&self, token: &str, html: Vec<u8>) {
        self.documents
            .lock()
            .expect("export protocol state poisoned")
            .insert(token.to_owned(), html);
    }

    fn remove(&self, token: &str) {
        self.documents
            .lock()
            .expect("export protocol state poisoned")
            .remove(token);
    }
}

const EXPORT_CSP: &str = "default-src 'none'; img-src data: https: http:; \
style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; \
base-uri 'none'; form-action 'none'";

pub fn serve<R: Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let token = request.uri().path().trim_start_matches('/');
    let body = ctx
        .app_handle()
        .state::<ExportProtocolState>()
        .documents
        .lock()
        .expect("export protocol state poisoned")
        .get(token)
        .cloned();
    match body {
        Some(body) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(
                header::HeaderName::from_static("content-security-policy"),
                EXPORT_CSP,
            )
            .header(header::CACHE_CONTROL, "no-store")
            .body(body)
            .expect("valid export response"),
        None => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Vec::new())
            .expect("valid export response"),
    }
}

pub(crate) type ProbeFn = fn(&WebviewWindow) -> Result<Option<Probe>, String>;
pub(crate) type CaptureFn = fn(&WebviewWindow, &ExportSpec, &Probe) -> Result<Vec<u8>, String>;

fn token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    format!(
        "{nanos:016x}{:08x}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn build_window(
    app: &tauri::AppHandle,
    label: &str,
    token: &str,
    spec: &ExportSpec,
) -> Result<WebviewWindow, String> {
    let url = tauri::Url::parse(&format!("omd-export://localhost/{token}"))
        .map_err(|error| error.to_string())?;
    // Build from the async worker, not the event-loop thread. Tauri documents
    // that WebView2 window creation must not run inside a synchronous command or
    // event handler (it can deadlock/fail before the HWND is registered); the
    // builder dispatches CreateWindow to the loop and returns a detached handle.
    let (visible, x, y) = if cfg!(windows) {
        (false, 0.0, 0.0)
    } else {
        (true, -20_000.0, -20_000.0)
    };
    let url = WebviewUrl::CustomProtocol(url);
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, label.to_owned(), url)
        .inner_size(spec.width_css, 600.0)
        .position(x, y)
        .visible(visible)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false);
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(super::WINDOWS_ADDITIONAL_BROWSER_ARGS);
    }
    builder.build().map_err(|error| error.to_string())?;
    // `build` may hand back a detached handle before the runtime stores the
    // registered window. Re-resolve from the manager so later `with_webview`
    // and URL messages target the registered instance.
    app.get_webview_window(label)
        .ok_or_else(|| format!("export window {label} was not registered"))
}

/// Parse the JSON emitted by `PROBE_SCRIPT`. WebView2 wraps the expression
/// result in a JSON string; WebKitGTK returns the string directly, so accept
/// both shapes.
pub(crate) fn parse_probe(raw: &str) -> Result<Option<Probe>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|error| format!("invalid probe JSON: {error}"))?;
    let value = match value {
        serde_json::Value::String(inner) => serde_json::from_str(&inner)
            .map_err(|error| format!("invalid probe payload: {error}"))?,
        other => other,
    };
    let ready = value
        .get("ready")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !ready {
        return Ok(None);
    }
    let height_css = value
        .get("height")
        .and_then(serde_json::Value::as_f64)
        .ok_or("probe returned no height")?;
    let incomplete = value
        .get("incomplete")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    Ok(Some(Probe {
        height_css,
        incomplete,
    }))
}

fn partial_warning(probe: &Probe) -> Option<ExportWarning> {
    probe.incomplete.then(|| ExportWarning {
        code: "partial-render".into(),
        detail: Some("the export page did not finish loading fonts or images within 5 s".into()),
    })
}

pub(crate) async fn render_with_window(
    app: tauri::AppHandle,
    html: String,
    spec: ExportSpec,
    format: ExportFormat,
    probe_page: ProbeFn,
    capture: CaptureFn,
) -> Result<RenderOutput, String> {
    if format != ExportFormat::Png {
        return Err("PDF export is only available on macOS".into());
    }

    let token = token();
    let label = format!("omd-export-{token}");
    {
        let state = app.state::<ExportProtocolState>();
        state.insert(&token, html.into_bytes());
    }

    let window = match build_window(&app, &label, &token, &spec) {
        Ok(window) => window,
        Err(error) => {
            app.state::<ExportProtocolState>().remove(&token);
            return Err(error);
        }
    };

    // Windows WebView2 creation is asynchronous even though the window builder
    // has returned; give the webview a moment to register before the first
    // `with_webview` dispatch (a message sent before registration is dropped).
    tokio::time::sleep(Duration::from_millis(250)).await;
    #[cfg(feature = "export-smoke")]
    eprintln!(
        "[export-smoke] after delay windows={:?} url={:?} visible={:?} size={:?}",
        app.webview_windows().keys().collect::<Vec<_>>(),
        window.url(),
        window.is_visible(),
        window.inner_size()
    );

    let cleanup = |window: &WebviewWindow| {
        let _ = window.close();
        app.state::<ExportProtocolState>().remove(&token);
    };

    let deadline = tokio::time::Instant::now() + Duration::from_millis(EXPORT_READY_TIMEOUT_MS);
    let mut last_error = None;
    let measured = loop {
        match probe_page(&window) {
            Ok(Some(probe)) => break probe,
            Ok(None) => {}
            Err(error) => last_error = Some(error),
        }
        if tokio::time::Instant::now() >= deadline {
            cleanup(&window);
            return Err(last_error.unwrap_or_else(|| "export-ready-timeout".into()));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };

    let (height_css, clamp_warning) =
        spec.clamp_height_css_for(measured.height_css, ExportFormat::Png);
    if height_css < crate::export::EXPORT_MIN_HEIGHT_CSS {
        cleanup(&window);
        return Err("export page reported a zero height".into());
    }
    let measured = Probe {
        height_css,
        incomplete: measured.incomplete,
    };

    let window_for_capture = window.clone();
    let capture_spec = spec;
    let capture_probe = measured.clone();
    let bytes = match tauri::async_runtime::spawn_blocking(move || {
        capture(&window_for_capture, &capture_spec, &capture_probe)
    })
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            cleanup(&window);
            return Err(error);
        }
        Err(error) => {
            cleanup(&window);
            return Err(error.to_string());
        }
    };

    cleanup(&window);
    let warning = clamp_warning.or_else(|| partial_warning(&measured));
    Ok(RenderOutput { bytes, warning })
}
