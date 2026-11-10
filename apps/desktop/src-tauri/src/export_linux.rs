//! Linux PNG backend: WebKitGTK full-document snapshot at an explicit pixel
//! scale.
//!
//! WebKitGTK snapshots in device pixels. To keep the CSS layout at
//! `spec.width_css` while producing `width_css * scale` pixels, the export
//! window is widened and `zoom_level` is raised by `scale / gdk_scale`; the
//! layout viewport therefore stays at the requested CSS width. The surface
//! dimensions are checked before encoding so a 1x fallback can never be
//! mistaken for a high-DPI export.
//!
//! The snapshot is taken only after the page itself reports that two animation
//! frames have elapsed since the zoom change, so a slow or throttled relayout
//! can never be exported as a stale, wrongly-sized surface: it fails instead.

use super::export_host;
use crate::export::{ExportFormat, ExportSpec, Probe, RenderOutput, PROBE_SCRIPT};
use javascriptcore::ValueExt;
use std::cell::Cell;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{LogicalSize, WebviewWindow};
use webkit2gtk::glib::ControlFlow;
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);
/// Clears a flag and sets it again from the second of two nested animation frame
/// callbacks. The second frame is the first point at which WebKitGTK has
/// committed a layout for the zoom level applied just before this script runs,
/// which makes the flag an observable relayout signal instead of a fixed sleep.
const RELAYOUT_SCRIPT: &str = "window.__omdRelaidOut = false;\
requestAnimationFrame(() => requestAnimationFrame(() => { window.__omdRelaidOut = true; }));";
/// Reads the relayout flag back; evaluates to a JS boolean.
const RELAYOUT_READY_SCRIPT: &str = "window.__omdRelaidOut === true";
/// One animation frame is ~16 ms at 60 Hz; poll slightly slower so a tick never
/// queues a second evaluation while the previous one is still in flight.
const RELAYOUT_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// Hard bound on the relayout handshake. If the flag never arrives (page
/// throttled, rAF suppressed, webview torn down) the capture fails instead of
/// snapshotting a layout that does not match the requested scale.
const RELAYOUT_TIMEOUT: Duration = Duration::from_secs(2);

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

fn with_view<T: Send + 'static>(
    window: &WebviewWindow,
    timeout: Duration,
    f: impl FnOnce(webkit2gtk::WebView, mpsc::Sender<Result<T, String>>) + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |platform| {
            let view = platform.inner();
            f(view, tx);
        })
        .map_err(|error| error.to_string())?;
    rx.recv_timeout(timeout)
        .map_err(|_| "webview callback timed out".to_string())?
}

fn probe(window: &WebviewWindow) -> Result<Option<Probe>, String> {
    let raw = with_view(window, PROBE_TIMEOUT, |view, tx| {
        view.evaluate_javascript(
            PROBE_SCRIPT,
            None,
            None,
            None::<&webkit2gtk::gio::Cancellable>,
            move |result| {
                let _ = tx.send(
                    result
                        .map(|value| value.to_str().to_string())
                        .map_err(|error| error.to_string()),
                );
            },
        );
    })?;
    export_host::parse_probe(&raw)
}

fn capture(window: &WebviewWindow, spec: &ExportSpec, probe: &Probe) -> Result<Vec<u8>, String> {
    let gdk_scale = window.scale_factor().map_err(|error| error.to_string())?;
    let gdk_scale = if gdk_scale.is_finite() && gdk_scale > 0.0 {
        gdk_scale
    } else {
        1.0
    };
    let zoom = spec.scale / gdk_scale;
    let logical_width = spec.width_css * zoom;
    let logical_height = probe.height_css * zoom;
    window
        .set_size(LogicalSize::new(logical_width, logical_height))
        .map_err(|error| error.to_string())?;

    let expected_width = spec.device_width();
    with_view(window, CAPTURE_TIMEOUT, move |view, tx| {
        view.set_zoom_level(zoom);
        await_relayout(&view, tx, expected_width);
    })
}

/// Starts the two-animation-frame relayout handshake and, once it has
/// completed, snapshots the page. Runs on the GTK main thread: every WebKit
/// call below and `timeout_add_local` require that context.
fn await_relayout(
    view: &webkit2gtk::WebView,
    tx: mpsc::Sender<Result<Vec<u8>, String>>,
    expected_width: u32,
) {
    let poll_view = view.clone();
    // The flag is only polled after the clearing script has run, so a previous
    // value on the same page can never be mistaken for this load's relayout.
    view.evaluate_javascript(
        RELAYOUT_SCRIPT,
        None,
        None,
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| match result {
            Ok(_) => poll_relayout(poll_view, tx, expected_width),
            Err(error) => {
                let _ = tx.send(Err(format!("failed to start WebKitGTK relayout: {error}")));
            }
        },
    );
}

/// Polls the relayout flag on the GTK main context until it is set, the page
/// reports an error, or `RELAYOUT_TIMEOUT` elapses. Never snapshots a layout
/// that has not confirmed itself.
fn poll_relayout(
    view: webkit2gtk::WebView,
    tx: mpsc::Sender<Result<Vec<u8>, String>>,
    expected_width: u32,
) {
    let started = Instant::now();
    // `ControlFlow::Break` removes the source, so a settled or failed poll stops
    // itself without tracking the `SourceId`.
    let settled = Rc::new(Cell::new(false));
    let in_flight = Rc::new(Cell::new(false));

    webkit2gtk::glib::timeout_add_local(RELAYOUT_POLL_INTERVAL, move || {
        if settled.get() {
            return ControlFlow::Break;
        }
        if started.elapsed() >= RELAYOUT_TIMEOUT {
            settled.set(true);
            let _ = tx.send(Err("WebKitGTK relayout timed out".to_string()));
            return ControlFlow::Break;
        }
        if in_flight.get() {
            return ControlFlow::Continue;
        }
        in_flight.set(true);
        let callback_view = view.clone();
        let tx = tx.clone();
        let in_flight = Rc::clone(&in_flight);
        let settled = Rc::clone(&settled);
        view.evaluate_javascript(
            RELAYOUT_READY_SCRIPT,
            None,
            None,
            None::<&webkit2gtk::gio::Cancellable>,
            move |result| {
                in_flight.set(false);
                if settled.get() {
                    return;
                }
                match result {
                    Ok(value) if value.to_boolean() => {
                        settled.set(true);
                        snapshot(&callback_view, tx, expected_width);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        settled.set(true);
                        let _ = tx.send(Err(format!("failed to poll WebKitGTK relayout: {error}")));
                    }
                }
            },
        );
        ControlFlow::Continue
    });
}

fn snapshot(
    view: &webkit2gtk::WebView,
    tx: mpsc::Sender<Result<Vec<u8>, String>>,
    expected_width: u32,
) {
    view.snapshot(
        SnapshotRegion::FullDocument,
        SnapshotOptions::NONE,
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| {
            let _ = tx.send(finish_snapshot(result, expected_width));
        },
    );
}

fn finish_snapshot(
    result: Result<cairo::Surface, webkit2gtk::glib::Error>,
    expected_width: u32,
) -> Result<Vec<u8>, String> {
    let surface = result.map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    surface
        .write_to_png(&mut bytes)
        .map_err(|error| format!("failed to encode PNG: {error}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len() < 24 {
        return Err("snapshot did not produce a valid PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("PNG width slice"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("PNG height slice"));
    if width == 0 || height == 0 {
        return Err("WebKitGTK returned an empty snapshot".into());
    }
    if width != expected_width {
        return Err(format!(
            "WebKitGTK snapshot is {} px wide, expected {} px; this display/scale combination cannot produce a crisp export",
            width, expected_width
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_math_keeps_css_width_and_device_pixels() {
        for (width, scale, gdk) in [
            (800.0, 2.0, 1.0),
            (800.0, 2.0, 2.0),
            (800.0, 2.0, 1.25),
            (1200.0, 3.0, 1.5),
        ] {
            let zoom = scale / gdk;
            let logical_width = width * zoom;
            assert!((logical_width / zoom - width).abs() < f64::EPSILON);
            assert!((logical_width * gdk - width * scale).abs() < 1e-6);
        }
    }
}
