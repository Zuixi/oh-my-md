//! Linux PNG backend: WebKitGTK full-document snapshot at an explicit pixel
//! scale.
//!
//! WebKitGTK snapshots in device pixels. To keep the CSS layout at
//! `spec.width_css` while producing `width_css * scale` pixels, the export
//! window is widened and `zoom_level` is raised by `scale / gdk_scale`; the
//! layout viewport therefore stays at the requested CSS width. The surface
//! dimensions are checked before encoding so a 1x fallback can never be
//! mistaken for a high-DPI export.

use super::export_host;
use crate::export::{ExportFormat, ExportSpec, Probe, RenderOutput, PROBE_SCRIPT};
use javascriptcore::ValueExt;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{LogicalSize, WebviewWindow};
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);
/// Snapshot after the zoom/resize has been applied. Two animation frames are
/// not observable through a synchronous callback, so a short main-loop delay
/// is used; the surface-size check below still fails closed if it was too
/// early and produced a stale layout.
const LAYOUT_SETTLE: Duration = Duration::from_millis(150);

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
        let view = view.clone();
        webkit2gtk::glib::timeout_add_local_once(LAYOUT_SETTLE, move || {
            view.snapshot(
                SnapshotRegion::FullDocument,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let _ = tx.send(finish_snapshot(result, expected_width));
                },
            );
        });
    })
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
