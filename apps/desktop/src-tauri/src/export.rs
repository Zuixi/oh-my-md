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
const MAX_EXPORT_HTML_BYTES: usize = 32 * 1024 * 1024;
const EXPORT_STYLE: &str = "@page{margin:16mm}";

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

/// The engine owns the export document CSS; Rust only adds the print page rule
/// so HTML, PDF and PNG share one document model.
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

#[tauri::command]
pub async fn export_preview(
    app: tauri::AppHandle,
    html: String,
    path: String,
    format: String,
    scale: u32,
    width: u32,
    request_id: String,
) -> Result<Option<ExportWarning>, String> {
    let fmt = ExportFormat::parse(&format)?;
    let spec = ExportSpec::new(width, scale)?;
    let target = validate_export(&path, fmt, &html)?;
    let styled = styled_export_html(&html);
    let state = app.state::<self::export_cancel::ExportCancelState>();
    let cancel = state.token(&request_id);
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        state.remove(&request_id);
        return Err(self::export_cancel::EXPORT_CANCELLED.into());
    }
    let result = platform::render(app.clone(), styled, spec, fmt, cancel.clone()).await;
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

    #[test]
    fn spec_validates_width_and_scale() {
        assert!(ExportSpec::new(319, 2).is_err());
        assert!(ExportSpec::new(1921, 2).is_err());
        assert!(ExportSpec::new(800, 0).is_err());
        assert!(ExportSpec::new(800, 4).is_err());
        assert!(ExportSpec::new(1920, 2).is_ok());
    }

    #[test]
    fn high_scale_keeps_device_width_inside_png_limit() {
        let spec = ExportSpec::new(1920, 3).unwrap();
        assert_eq!(spec.device_width(), 5760);
        assert!(spec.max_height_css() >= EXPORT_MIN_HEIGHT_CSS);
        assert!(spec.max_height_css() * spec.scale <= EXPORT_MAX_DEVICE_HEIGHT as f64);
        let area = f64::from(spec.device_width()) * spec.max_height_css() * spec.scale;
        assert!(area <= EXPORT_MAX_DEVICE_AREA as f64 + 1.0);
    }

    #[test]
    fn warning_serializes_with_lower_camel_case_fields() {
        let warning = ExportWarning {
            code: "height-clamped".into(),
            detail: Some("too tall".into()),
        };
        assert_eq!(
            serde_json::to_string(&warning).unwrap(),
            r#"{"code":"height-clamped","detail":"too tall"}"#
        );
    }

    #[test]
    fn measure_script_is_synchronous_and_bounded() {
        let script = measure_export_script(600.0, 16_383.0);
        assert!(script.contains("scrollHeight"));
        assert!(script.contains("16383"));
        assert!(!script.contains("Promise"));
    }

    #[test]
    fn clamp_reports_instead_of_silently_cutting() {
        let spec = ExportSpec::new(800, 2).unwrap();
        let (height, warning) = spec.clamp_height_css(100_000.0);
        assert!(height <= spec.max_height_css());
        assert_eq!(warning.unwrap().code, "height-clamped");
        let (normal, warning) = spec.clamp_height_css(1200.0);
        assert_eq!(normal, 1200.0);
        assert!(warning.is_none());
    }
}

#[cfg(test)]
mod browser_args_tests {
    use super::WINDOWS_ADDITIONAL_BROWSER_ARGS;

    #[test]
    fn windows_browser_args_match_the_main_window_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri config");
        let main = config["app"]["windows"]
            .as_array()
            .and_then(|windows| windows.iter().find(|window| window["label"] == "main"))
            .expect("main window config");
        assert_eq!(
            main["additionalBrowserArgs"].as_str(),
            Some(WINDOWS_ADDITIONAL_BROWSER_ARGS)
        );
    }
}
