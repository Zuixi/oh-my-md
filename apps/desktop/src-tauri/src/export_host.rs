//! Shared offscreen-window host for the Windows and Linux exporters.
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// SHA-256 (base64) of the engine's `EXPORT_READY_SCRIPT` body — the only
/// script an export document may run. Mirrored from
/// `packages/engine/src/export/readyScript.ts` and drift-guarded by
/// `apps/desktop/test/crossLayerConstants.test.ts`.
pub(crate) const EXPORT_READY_SCRIPT_SHA256: &str =
    "sha256-MyiKteHaXRL96raOhQ75BjWJi96uGSOxEFhruB2aJPg=";

/// SHA-256 of the `export-smoke` harness's inline ready flag
/// (`window.__omdExportReady=true;window.__omdExportHeight=600;`). Only
/// compiled into the smoke feature so a release build never whitelists it.
#[cfg(feature = "export-smoke")]
const EXPORT_SMOKE_SCRIPT_SHA256: &str = "sha256-SZiSjxhIW5HCEBT2TcbANxb2LQ3rKx+alJgWIuMd8bU=";

/// Hash-pinned CSP for every export document. Raw Markdown may contain a
/// `<script>` tag; with `'unsafe-inline'` it would run inside a page that has
/// the app's protocol handlers in scope. Only the readiness handshake is
/// allowed, by hash.
fn export_csp() -> String {
    // The smoke feature adds the harness's own inline flag; a release build
    // whitelists only the product's readiness script.
    #[cfg(feature = "export-smoke")]
    let script_sources = format!("'{EXPORT_READY_SCRIPT_SHA256}' '{EXPORT_SMOKE_SCRIPT_SHA256}'");
    #[cfg(not(feature = "export-smoke"))]
    let script_sources = format!("'{EXPORT_READY_SCRIPT_SHA256}'");
    format!(
        "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; \
script-src {script_sources}; font-src data:; base-uri 'none'; form-action 'none'"
    )
}

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
                export_csp(),
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
pub(crate) type CaptureFn =
    Box<dyn Fn(&WebviewWindow, &ExportSpec, &Probe) -> Result<Vec<u8>, String> + Send>;

/// One export document's protocol token: 128 CSPRNG bits, hex encoded. It is
/// the only thing standing between a serving page and an attacker guessing the
/// URL, so a clock plus counter (predictable from outside) is not enough.
fn token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // getrandom only fails on a platform with no entropy source at all;
        // fall back to a best-effort hash rather than failing the export.
        return fallback_token();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An export window label uses the token as its suffix. The CSPRNG path is the
/// only one in practice; this keeps a broken entropy source from aborting the
/// user's export.
fn fallback_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hasher = blake3::Hasher::new();
    hasher.update(&nanos.to_le_bytes());
    hasher.update(&std::process::id().to_le_bytes());
    hasher.update(&counter.to_le_bytes());
    hasher.finalize().to_hex().chars().take(32).collect()
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
    cancel: Arc<AtomicBool>,
) -> Result<RenderOutput, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(super::export_cancel::EXPORT_CANCELLED.into());
    }

    let token = token();
    let label = format!("{}{token}", crate::windows::EXPORT_WINDOW_PREFIX);
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
    if cancel.load(Ordering::SeqCst) {
        let _ = window.close();
        app.state::<ExportProtocolState>().remove(&token);
        return Err(super::export_cancel::EXPORT_CANCELLED.into());
    }
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
        if cancel.load(Ordering::SeqCst) {
            cleanup(&window);
            return Err(super::export_cancel::EXPORT_CANCELLED.into());
        }
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

    // Paginated printing consumes the document directly and has no bitmap height limit.
    let (measured, clamp_warning) = if format == ExportFormat::Png {
        let (height_css, warning) = spec.clamp_height_css_for(measured.height_css, format);
        (
            Probe {
                height_css,
                ..measured
            },
            warning,
        )
    } else {
        (measured, None)
    };

    // The Windows CDP capture steps the device scale down when a tall PNG would
    // exceed the GPU texture limit. Report it: a silently downsampled export
    // would contradict the scale the user picked in Settings.
    #[cfg(windows)]
    let scale_warning = if format == ExportFormat::Png {
        spec.effective_gpu_capture_scale(measured.height_css).1
    } else {
        None
    };
    #[cfg(not(windows))]
    let scale_warning: Option<ExportWarning> = None;

    let window_for_capture = window.clone();
    let capture_spec = spec;
    let capture_probe = measured.clone();
    let capture_task = tauri::async_runtime::spawn_blocking(move || {
        capture(&window_for_capture, &capture_spec, &capture_probe)
    });
    tokio::pin!(capture_task);
    let bytes = tokio::select! {
        result = &mut capture_task => match result {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(error)) => {
                cleanup(&window);
                return Err(error);
            }
            Err(error) => {
                cleanup(&window);
                return Err(error.to_string());
            }
        },
        () = wait_for_cancel(cancel.clone()) => {
            // Closing the window aborts the platform capture; the detached
            // blocking task observes a closed/dead webview and exits.
            cleanup(&window);
            return Err(super::export_cancel::EXPORT_CANCELLED.into());
        }
    };
    if cancel.load(Ordering::SeqCst) {
        cleanup(&window);
        return Err(super::export_cancel::EXPORT_CANCELLED.into());
    }

    cleanup(&window);
    let warning = clamp_warning
        .or(scale_warning)
        .or_else(|| partial_warning(&measured));
    Ok(RenderOutput { bytes, warning })
}

async fn wait_for_cancel(cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_32_hex_chars_and_never_repeat() {
        let first = token();
        let second = token();
        assert_eq!(first.len(), 32, "128-bit token: {first}");
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    fn directive<'a>(csp: &'a str, name: &str) -> &'a str {
        csp.split(';')
            .map(str::trim)
            .find(|directive| {
                directive
                    .split_whitespace()
                    .next()
                    .is_some_and(|token| token == name)
            })
            .unwrap_or("")
    }

    #[test]
    fn export_csp_allows_only_the_ready_script_hash() {
        let csp = export_csp();
        let script = directive(&csp, "script-src");
        assert!(
            script.contains(&format!("'{EXPORT_READY_SCRIPT_SHA256}'")),
            "missing ready-script hash in {script}"
        );
        // The whole point: raw Markdown must never be able to run script.
        assert!(!script.contains("'unsafe-inline'"), "{script}");
        assert!(!script.contains("'none'"), "{script}");
        assert_eq!(directive(&csp, "default-src"), "default-src 'none'");
        assert_eq!(directive(&csp, "base-uri"), "base-uri 'none'");
        assert_eq!(directive(&csp, "form-action"), "form-action 'none'");
    }
}
