use serde::Serialize;
use tauri::Manager;

#[path = "app_context.rs"]
pub(crate) mod app_context;
#[cfg(feature = "export-smoke")]
#[path = "export_smoke.rs"]
pub mod export_smoke;
use std::path::{Component, Path, PathBuf};

#[cfg(any(windows, target_os = "linux"))]
#[path = "export_host.rs"]
pub(crate) mod export_host;

#[path = "export_cancel.rs"]
mod export_cancel;

#[path = "export_page.rs"]
pub(crate) mod export_page;

// Windows shares one WebView2 user-data directory across windows, so every
// webview must be created with the same browser arguments. The main window sets
// these in `tauri.conf.json`; pass the identical list here or WebView2 refuses
// the second environment and Tauri registers a window whose webview cannot
// receive messages (`FailedToReceiveMessage`).
#[cfg(any(windows, test))]
const WINDOWS_ADDITIONAL_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,HideCursorWhileTyping";

/// Inlined images make the export document self-contained; a 4K screenshot with
/// several retina images can exceed the old 8 MiB cap quickly.
pub(crate) const MAX_EXPORT_HTML_BYTES: usize = 32 * 1024 * 1024;

pub const EXPORT_MIN_WIDTH_CSS: u32 = 320;
pub const EXPORT_MAX_WIDTH_CSS: u32 = 1920;
pub const EXPORT_MIN_SCALE: u32 = 1;
pub const EXPORT_MAX_SCALE: u32 = 3;
/// Single PNG side ceiling used by PNG/WebP consumers and GPU capture paths.
pub const EXPORT_MAX_DEVICE_DIMENSION: u32 = 16_383;
/// Maximum device height for long-document PNG exports (~65,535 px, matching
/// typical browser/OS image decoder ceilings while allowing 30+ screen-tall notes).
pub const EXPORT_MAX_DEVICE_HEIGHT: u32 = 65_535;
/// RGBA bitmap budget per image (~512 MiB). Larger docs are clamped with a
/// warning instead of allocating an unbounded multi-GB bitmap.
pub const EXPORT_MAX_DEVICE_AREA: u64 = 128_000_000;
pub const EXPORT_MIN_HEIGHT_CSS: f64 = 600.0;
#[cfg(target_os = "macos")]
pub const EXPORT_TIMEOUT_SECS: u64 = 20;
#[cfg(any(windows, target_os = "linux"))]
pub const EXPORT_READY_TIMEOUT_MS: u64 = 15_000;

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

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ExportSpec {
    pub width_css: f64,
    pub scale: f64,
}

impl ExportSpec {
    pub fn new(width_css: u32, scale: u32) -> Result<Self, String> {
        if !(EXPORT_MIN_WIDTH_CSS..=EXPORT_MAX_WIDTH_CSS).contains(&width_css) {
            return Err(format!(
                "export width must be between {EXPORT_MIN_WIDTH_CSS} and {EXPORT_MAX_WIDTH_CSS} CSS pixels"
            ));
        }
        if !(EXPORT_MIN_SCALE..=EXPORT_MAX_SCALE).contains(&scale) {
            return Err(format!(
                "export scale must be between {EXPORT_MIN_SCALE} and {EXPORT_MAX_SCALE}"
            ));
        }
        let spec = Self {
            width_css: f64::from(width_css),
            scale: f64::from(scale),
        };
        if spec.device_width() > EXPORT_MAX_DEVICE_DIMENSION {
            return Err(format!(
                "exported image width {} px exceeds the {} px limit; reduce width or scale",
                spec.device_width(),
                EXPORT_MAX_DEVICE_DIMENSION
            ));
        }
        if spec.max_height_css() < EXPORT_MIN_HEIGHT_CSS {
            return Err(
                "the requested width and scale leave less than the minimum export height".into(),
            );
        }
        Ok(spec)
    }

    pub fn device_width(self) -> u32 {
        (self.width_css * self.scale).round() as u32
    }

    /// Largest CSS height that keeps both the per-side dimension and the RGBA
    /// area budget within limits at this scale.
    pub fn max_height_css(self) -> f64 {
        let by_dimension = f64::from(EXPORT_MAX_DEVICE_HEIGHT) / self.scale;
        let by_area = EXPORT_MAX_DEVICE_AREA as f64 / (f64::from(self.device_width()) * self.scale);
        by_dimension.min(by_area)
    }

    /// Clamp a measured page height and report the truncation instead of
    /// silently producing a cut-off image. PDF is vector and is bounded by the
    /// PDF page limit, not by the PNG bitmap budget.
    pub fn clamp_height_css_for(
        self,
        measured: f64,
        format: ExportFormat,
    ) -> (f64, Option<ExportWarning>) {
        let finite = if measured.is_finite() {
            measured
        } else {
            EXPORT_MIN_HEIGHT_CSS
        };
        let max = if format == ExportFormat::Pdf {
            f64::from(EXPORT_MAX_DEVICE_HEIGHT)
        } else {
            self.max_height_css()
        }
        .max(EXPORT_MIN_HEIGHT_CSS)
        .floor();
        let clamped = finite.max(EXPORT_MIN_HEIGHT_CSS).min(max);
        let warning = (clamped < finite).then(|| ExportWarning {
            code: "height-clamped".into(),
            detail: Some(format!(
                "{} CSS px wide export is limited to {} CSS px tall at {}x",
                self.width_css, max, self.scale
            )),
        });
        (clamped.round(), warning)
    }

    #[cfg(test)]
    pub fn clamp_height_css(self, measured: f64) -> (f64, Option<ExportWarning>) {
        self.clamp_height_css_for(measured, ExportFormat::Png)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWarning {
    pub code: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug)]
#[cfg(any(windows, target_os = "linux"))]
pub(crate) struct Probe {
    pub height_css: f64,
    pub incomplete: bool,
}

pub(crate) struct RenderOutput {
    pub bytes: Vec<u8>,
    pub warning: Option<ExportWarning>,
}

pub fn validate_export(path: &str, format: ExportFormat, html: &str) -> Result<PathBuf, String> {
    if html.len() > MAX_EXPORT_HTML_BYTES {
        return Err(format!(
            "export HTML exceeds the {MAX_EXPORT_HTML_BYTES} byte size limit"
        ));
    }
    reject_export_path(path, format)
}

/// Injects the shared print stylesheet at the start of `<head>`. The engine
/// embeds the same CSS; this copy covers smoke fixtures and any caller that
/// did not. A later `@page` in the document (user CSS) still wins.
pub fn styled_export_html(html: &str, page: &export_page::PageSetup) -> String {
    let style = format!("<style>{}</style>", export_page::render_print_css(page));
    // First in <head> (after the charset declaration), so the document's own
    // print rules (custom CSS) override the default margin.
    if let Some(mut index) = head_content_start(html) {
        if html[index..].starts_with("<meta charset") {
            if let Some(end) = html[index..].find('>') {
                index += end + 1;
            }
        }
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

/// Byte offset just after the `<head …>` start tag (attributes allowed), or
/// `None` without one. `<header>` is not a head tag.
fn head_content_start(html: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = html[from..].find("<head") {
        let after = from + found + "<head".len();
        match html[after..].chars().next() {
            Some('>') => return Some(after + 1),
            Some(c) if c.is_ascii_whitespace() || c == '/' => {
                return html[after..].find('>').map(|end| after + end + 1);
            }
            _ => from = after,
        }
    }
    None
}

/// Register the single-use HTML protocol used by the Win/Linux offscreen host.
/// App builder with the export protocol installed (Win/Linux) and the macOS
/// WebView termination hook chained in. Keeps `lib.rs` startup wiring thin.
pub(crate) fn builder_with_export_protocol() -> tauri::Builder<tauri::Wry> {
    #[cfg(target_os = "macos")]
    let builder = crate::logging::install_webview_termination_hook(tauri::Builder::default());
    #[cfg(not(target_os = "macos"))]
    let builder = tauri::Builder::default();
    register(builder)
}

pub(crate) fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    let builder = builder.manage(self::export_cancel::ExportCancelState::default());
    #[cfg(any(windows, target_os = "linux"))]
    {
        builder
            .register_uri_scheme_protocol("omd-export", self::export_host::serve)
            .manage(self::export_host::ExportProtocolState::default())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        builder
    }
}

#[cfg(target_os = "macos")]
#[path = "export_native.rs"]
pub(crate) mod platform;

#[cfg(windows)]
#[path = "export_windows.rs"]
pub(crate) mod platform;

#[cfg(target_os = "linux")]
#[path = "export_linux.rs"]
pub(crate) mod platform;

#[tauri::command]
pub async fn cancel_export(app: tauri::AppHandle, request_id: String) {
    let state = app.state::<self::export_cancel::ExportCancelState>();
    if state.cancel(&request_id) {
        return;
    }
    // The user can click Cancel while the frontend is still dispatching
    // `export_preview`. If that command never reaches us, drop the pre-created
    // entry rather than leaking it; an active export finishes far sooner than
    // this grace period.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        app.state::<self::export_cancel::ExportCancelState>()
            .remove(&request_id);
    });
}

// Eight parameters because the list *is* the IPC wire contract: collapsing it
// into a struct would rename every field the frontend sends.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_preview(
    app: tauri::AppHandle,
    html: String,
    path: String,
    format: String,
    scale: u32,
    width: u32,
    request_id: String,
    page: export_page::PageSetupDto,
) -> Result<Option<ExportWarning>, String> {
    let fmt = ExportFormat::parse(&format)?;
    let spec = ExportSpec::new(width, scale)?;
    let page = export_page::PageSetup::from_dto(page)?;
    let target = validate_export(&path, fmt, &html)?;
    let styled = styled_export_html(&html, &page);
    let state = app.state::<self::export_cancel::ExportCancelState>();
    let cancel = state.token(&request_id);
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        state.remove(&request_id);
        return Err(self::export_cancel::EXPORT_CANCELLED.into());
    }
    let result = platform::render(app.clone(), styled, spec, fmt, cancel.clone(), page).await;
    state.remove(&request_id);
    let output = result?;
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(self::export_cancel::EXPORT_CANCELLED.into());
    }
    crate::atomic_write(&target, &output.bytes)?;
    // Boundary: the export artifact reached the disk. The path is logged
    // through the structured field so the diagnostics redactor can find it.
    log::info!("export ok {}", crate::logging::path_field(&target));
    Ok(output.warning)
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn measure_export_script(min_height: f64, max_height: f64) -> String {
    format!(
        "(function(){{var h=Number(window.__omdExportHeight||0);\
         if(!(h>0)){{var r=document.documentElement,b=document.body;\
         h=Math.max(r?r.scrollHeight:0,b?b.scrollHeight:0);}}\
         return Math.min(Math.max(h,{min}),{max});}})()",
        min = min_height,
        max = max_height,
    )
}

/// JS expression used by the Win/Linux host to wait for fonts, images and the
/// page's own ready flag. It returns a JSON string so every platform can parse
/// the same shape.
#[cfg(any(windows, target_os = "linux"))]
pub(crate) const PROBE_SCRIPT: &str = r#"JSON.stringify({
  ready: window.__omdExportReady === true,
  height: Number(window.__omdExportHeight || 0),
  incomplete: window.__omdExportIncomplete === true
})"#;

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
#[path = "export_tests.rs"]
mod tests;
