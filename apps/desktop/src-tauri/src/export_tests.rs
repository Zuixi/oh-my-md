use super::export_page::{render_print_css, PageSetup};
use super::*;

fn default_style() -> String {
    render_print_css(&PageSetup::contract_default())
}

fn styled(html: &str) -> String {
    styled_export_html(html, &PageSetup::contract_default())
}

#[test]
fn parse_accepts_pdf_and_png_only() {
    assert_eq!(ExportFormat::parse("pdf").unwrap(), ExportFormat::Pdf);
    assert_eq!(ExportFormat::parse("png").unwrap(), ExportFormat::Png);
    assert!(ExportFormat::parse("html").is_err());
}

#[test]
fn validate_export_rejects_traversal_and_mismatched_extension() {
    let html = "<p>hi</p>";
    let dir = std::env::temp_dir();
    let traversal = dir.join("..").join("etc").join("x.pdf");
    let png = dir.join("out.png");
    let pdf = dir.join("out.pdf");
    assert!(validate_export(traversal.to_str().unwrap(), ExportFormat::Pdf, html).is_err());
    assert!(validate_export(png.to_str().unwrap(), ExportFormat::Pdf, html).is_err());
    assert!(validate_export(pdf.to_str().unwrap(), ExportFormat::Png, html).is_err());
    assert_eq!(
        validate_export(pdf.to_str().unwrap(), ExportFormat::Pdf, html).unwrap(),
        pdf
    );
}

#[test]
fn validate_export_appends_png_when_save_dialog_omits_extension() {
    let html = "<p>hi</p>";
    let base = std::env::temp_dir().join("out");
    let base_str = base.to_str().unwrap();
    assert_eq!(
        validate_export(base_str, ExportFormat::Png, html).unwrap(),
        std::env::temp_dir().join("out.png")
    );
    assert_eq!(
        validate_export(base_str, ExportFormat::Pdf, html).unwrap(),
        std::env::temp_dir().join("out.pdf")
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
    let styled = styled(html);
    let expected = format!("<head><style>{}</style></head>", default_style());
    assert!(styled.contains(&expected));
    assert!(styled.contains("<h1>Hi</h1>"));
}

#[test]
fn default_print_margin_follows_the_charset_declaration() {
    let html = "<!doctype html><html><head><meta charset=\"utf-8\"><title>t</title></head><body></body></html>";
    let expected = format!(
        "<head><meta charset=\"utf-8\"><style>{}</style><title>",
        default_style()
    );
    assert!(styled(html).contains(&expected));
}

#[test]
fn default_print_margin_goes_inside_a_head_with_attributes() {
    let html = "<!doctype html><html><head data-x=\"1\"><meta charset=\"utf-8\"></head><body><header>h</header></body></html>";
    let expected = format!(
        "<head data-x=\"1\"><meta charset=\"utf-8\"><style>{}</style></head>",
        default_style()
    );
    assert!(styled(html).contains(&expected));
    // `<header>` alone is not a head: the document gets a wrapper.
    let fragment = "<header>h</header>";
    assert!(
        styled(fragment).starts_with("<!doctype html><html><head><meta charset=\"utf-8\"><style>")
    );
}

#[test]
fn document_print_rules_override_the_default_margin() {
    // Custom CSS arrives in the document head; the later @page wins.
    let html = "<!doctype html><html><head><meta charset=\"utf-8\"><style>@page{margin:25mm}</style></head><body></body></html>";
    let styled = styled(html);
    assert!(
        styled
            .find("@page{size:210mm 297mm;margin:16mm 16mm 16mm 16mm}")
            .unwrap()
            < styled.find("@page{margin:25mm}").unwrap()
    );
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

#[test]
fn every_platform_shares_one_export_readiness_timeout() {
    assert_eq!(EXPORT_READY_TIMEOUT_SECS, 20);
    #[cfg(any(windows, target_os = "linux"))]
    assert_eq!(EXPORT_READY_TIMEOUT_MS, EXPORT_READY_TIMEOUT_SECS * 1_000);
    #[cfg(target_os = "macos")]
    assert_eq!(EXPORT_TIMEOUT_SECS, EXPORT_READY_TIMEOUT_SECS);
}

#[test]
fn gpu_capture_scale_keeps_a_short_page_at_the_requested_scale() {
    let spec = ExportSpec::new(800, 2).unwrap();
    // 8000 CSS px at 2x is 16,000 device px, still inside the 16,383 px cap.
    let (scale, warning) = spec.effective_gpu_capture_scale(8_000.0);
    assert_eq!(scale, 2.0);
    assert!(warning.is_none());
    let (scale, warning) = spec.effective_gpu_capture_scale(6_000.0);
    assert_eq!(scale, 2.0);
    assert!(warning.is_none());
}

#[test]
fn gpu_capture_scale_reports_a_downsampled_long_png() {
    let spec = ExportSpec::new(640, 2).unwrap();
    let (scale, warning) = spec.effective_gpu_capture_scale(10_000.0);
    assert!(
        scale < 2.0,
        "10,000 CSS px at 2x cannot fit one texture: {scale}"
    );
    assert_eq!(scale, f64::from(EXPORT_MAX_DEVICE_DIMENSION) / 10_000.0);
    let warning = warning.expect("a stepped-down capture must report itself");
    assert_eq!(warning.code, "downsampled");
    let detail = warning.detail.unwrap();
    assert!(detail.contains("10000 CSS px"), "{detail}");
    assert!(detail.contains("from 2x to 1.64x"), "{detail}");
    assert!(detail.contains("16383 px"), "{detail}");
    // Re-capturing at the reported scale is exactly what the backend requests.
    let device_height = (10_000.0 * scale).round();
    assert!(device_height <= f64::from(EXPORT_MAX_DEVICE_DIMENSION));
    assert!(device_height >= f64::from(EXPORT_MAX_DEVICE_DIMENSION) - 1.0);
}

#[test]
fn gpu_capture_scale_never_goes_below_the_settled_floor() {
    let spec = ExportSpec::new(800, 1).unwrap();
    let (scale, warning) = spec.effective_gpu_capture_scale(1_000_000.0);
    assert_eq!(scale, 0.25);
    assert_eq!(warning.unwrap().code, "downsampled");
    // A zero/NaN measurement still yields a usable, positive scale.
    let (scale, _) = spec.effective_gpu_capture_scale(0.0);
    assert_eq!(scale, 1.0);
}

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

#[test]
fn validate_export_requires_an_absolute_path() {
    let html = "<p>hi</p>";
    assert!(validate_export("out/relative.pdf", ExportFormat::Pdf, html).is_err());
    assert!(validate_export("out", ExportFormat::Png, html).is_err());
}

#[cfg(unix)]
#[test]
fn validate_export_rejects_a_symlink_target() {
    let html = "<p>hi</p>";
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real.pdf");
    std::fs::write(&real, b"old").unwrap();
    let link = dir.path().join("link.pdf");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(validate_export(link.to_str().unwrap(), ExportFormat::Pdf, html).is_err());
}
