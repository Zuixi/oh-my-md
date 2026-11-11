use super::*;

use super::*;

const TINY_PDF: &[u8] = b"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 40] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 31 >>
stream
BT /F1 12 Tf 8 16 Td (Hi) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000239 00000 n 
0000000320 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
390
%%EOF
";

fn png_size(png: &[u8]) -> (u32, u32) {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    (
        u32::from_be_bytes(png[16..20].try_into().unwrap()),
        u32::from_be_bytes(png[20..24].try_into().unwrap()),
    )
}

#[test]
fn rasterize_pdf_to_png_is_one_to_one_at_scale_one() {
    let png = rasterize_pdf_to_png_scaled(TINY_PDF, 80.0, 40.0, 1.0).expect("pdf should rasterize");
    assert_eq!(png_size(&png), (80, 40));
}

#[test]
fn rasterize_pdf_to_png_honors_retina_scale() {
    let png = rasterize_pdf_to_png_scaled(TINY_PDF, 80.0, 40.0, 2.0).expect("pdf should rasterize");
    assert_eq!(png_size(&png), (160, 80));
}

#[test]
fn rasterize_pdf_to_png_rejects_non_pdf() {
    assert!(rasterize_pdf_to_png_scaled(b"not-a-pdf", 80.0, 40.0, 1.0).is_err());
}

#[test]
fn ready_timeout_is_five_seconds() {
    assert_eq!(READY_TIMEOUT, Duration::from_secs(5));
}

#[test]
fn ready_poll_interval_is_one_hundred_ms() {
    assert_eq!(READY_POLL_MS, 100);
}

#[test]
fn cleanup_deadline_fires_before_the_channel_backstop() {
    let cleanup = Duration::from_millis(EXPORT_CLEANUP_MS);
    assert_eq!(
        cleanup,
        Duration::from_secs(EXPORT_TIMEOUT_SECS),
        "cleanup must preserve the previous export deadline"
    );
    assert_eq!(
        EXPORT_CHANNEL_BACKSTOP,
        Duration::from_secs(EXPORT_TIMEOUT_SECS + EXPORT_BACKSTOP_GRACE_SECS)
    );
    assert!(
        cleanup < EXPORT_CHANNEL_BACKSTOP,
        "scheduled cleanup {cleanup:?} must beat the backstop {EXPORT_CHANNEL_BACKSTOP:?}"
    );
}

#[test]
fn take_pending_completes_only_once() {
    let slot: RefCell<Option<u8>> = RefCell::new(Some(1));
    assert_eq!(take_pending(&slot), Some(1));
    assert_eq!(take_pending(&slot), None);
}
