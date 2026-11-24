use super::stamp_header_footer_if_enabled;
use crate::export::export_page::PageSetup;

fn build_classic_pdf(objects: &[(u32, &str)], root_id: u32) -> Vec<u8> {
    let mut out = Vec::from(b"%PDF-1.5\n%\xE2\xE3\xCF\xD3\n".as_slice());
    let max_id = objects.iter().map(|(id, _)| *id).max().unwrap_or(0);
    let mut offsets = vec![0usize; (max_id + 1) as usize];
    for (id, body) in objects {
        offsets[*id as usize] = out.len();
        out.extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
    }
    let startxref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", max_id + 1).as_bytes());
    for offset in offsets.iter().skip(1) {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root {root_id} 0 R >>\nstartxref\n{startxref}\n%%EOF\n",
            max_id + 1
        )
        .as_bytes(),
    );
    out
}

/// Builds a 2-page PDF whose `/Kids [ 5 0 R 4 0 R ]` intentionally reverses
/// object-ID order so tests verify page-tree traversal rather than ID sorting.
fn two_page_fixture() -> Vec<u8> {
    let stream = "<< /Length 12 >>\nstream\nBT 0 0 Td ET\nendstream";
    build_classic_pdf(
        &[
            (1, "<< /Type /Catalog /Pages 2 0 R >>"),
            (2, "<< /Type /Pages /Kids [ 5 0 R 4 0 R ] /Count 2 >>"),
            (
                3,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>",
            ),
            (
                4,
                "<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 595.28 841.89 ] \
                 /Resources << /Font << /F0 3 0 R >> >> /Contents 7 0 R >>",
            ),
            (
                5,
                "<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 595.28 841.89 ] \
                 /Resources << /Font << /F0 3 0 R >> >> /Contents [ 6 0 R ] >>",
            ),
            (6, stream),
            (7, stream),
        ],
        1,
    )
}

fn enabled_setup(title: &str) -> PageSetup {
    let mut dto = PageSetup::default_dto();
    dto.header_footer = true;
    dto.header_title = title.into();
    PageSetup::from_dto(dto).expect("valid setup")
}

#[test]
fn returns_original_bytes_when_header_footer_disabled() {
    let original = two_page_fixture();
    let mut dto = PageSetup::default_dto();
    dto.header_footer = false;
    dto.header_title = "Ignored".into();
    let setup = PageSetup::from_dto(dto).expect("valid setup");
    assert_eq!(
        stamp_header_footer_if_enabled(original.clone(), &setup),
        original
    );
}

#[test]
fn skips_stamping_when_margins_are_below_minimum_chrome_threshold() {
    let original = two_page_fixture();
    let mut dto = PageSetup::default_dto();
    dto.header_footer = true;
    dto.header_title = "Tight Margins".into();
    dto.margin_top_mm = 5.0;
    dto.margin_bottom_mm = 5.0;
    let setup = PageSetup::from_dto(dto).expect("valid setup");
    assert_eq!(
        stamp_header_footer_if_enabled(original.clone(), &setup),
        original
    );
}

#[test]
fn stamps_incremental_revision_in_page_tree_order_and_preserves_existing_fonts() {
    let original = two_page_fixture();
    let setup = enabled_setup("Design (Spec) \\ v1");
    let stamped = stamp_header_footer_if_enabled(original.clone(), &setup);

    assert!(stamped.len() > original.len());
    assert_eq!(&stamped[..original.len()], original.as_slice());

    let appended = String::from_utf8_lossy(&stamped[original.len()..]);
    assert!(appended.contains("/Prev "), "{appended}");
    assert!(
        appended.contains("(Design \\(Spec\\) \\\\ v1) Tj"),
        "{appended}"
    );
    assert!(appended.contains("(1 / 2) Tj"), "{appended}");
    assert!(appended.contains("(2 / 2) Tj"), "{appended}");

    // Verify the final `startxref` offset points strictly to the `xref\n` keyword.
    let tail_startxref = stamped
        .windows(b"startxref\n".len())
        .rposition(|window| window == b"startxref\n")
        .expect("final startxref");
    let offset_str = std::str::from_utf8(&stamped[tail_startxref + b"startxref\n".len()..])
        .expect("ascii tail")
        .lines()
        .next()
        .expect("offset line");
    let xref_offset: usize = offset_str.trim().parse().expect("numeric xref offset");
    assert!(
        stamped[xref_offset..].starts_with(b"xref\n"),
        "startxref {xref_offset} must start with xref\\n"
    );

    // Page object 5 is Kids[0] (page 1/2) and page object 4 is Kids[1] (page 2/2).
    // Both redefined page dictionaries must preserve `/F0 3 0 R` alongside `/OmdF1`.
    let page5_pos = appended.find("5 0 obj\n").expect("redefined page 5");
    let page4_pos = appended.find("4 0 obj\n").expect("redefined page 4");
    let page5_obj = &appended[page5_pos..appended[page5_pos..].find("endobj").unwrap() + page5_pos];
    let page4_obj = &appended[page4_pos..appended[page4_pos..].find("endobj").unwrap() + page4_pos];
    assert!(
        page5_obj.contains("/F0 3 0 R") && page5_obj.contains("/OmdF1 "),
        "{page5_obj}"
    );
    assert!(
        page4_obj.contains("/F0 3 0 R") && page4_obj.contains("/OmdF1 "),
        "{page4_obj}"
    );
    // Kids[0] (object 5) wraps original stream 6 0 R with prep (9) and stamp (10);
    // Kids[1] (object 4) wraps original stream 7 0 R with prep (11) and stamp (12).
    assert!(
        page5_obj.contains("/Contents [ 9 0 R 6 0 R 10 0 R ]"),
        "{page5_obj}"
    );
    assert!(
        page4_obj.contains("/Contents [ 11 0 R 7 0 R 12 0 R ]"),
        "{page4_obj}"
    );
    let stamp1_pos = appended.find("10 0 obj\n").expect("page 1 stamp stream");
    let stamp2_pos = appended.find("12 0 obj\n").expect("page 2 stamp stream");
    let stamp1_obj =
        &appended[stamp1_pos..appended[stamp1_pos..].find("endobj").unwrap() + stamp1_pos];
    let stamp2_obj =
        &appended[stamp2_pos..appended[stamp2_pos..].find("endobj").unwrap() + stamp2_pos];
    assert!(stamp1_obj.contains("(1 / 2) Tj"), "{stamp1_obj}");
    assert!(stamp2_obj.contains("(2 / 2) Tj"), "{stamp2_obj}");
}

#[test]
fn encodes_cjk_header_titles_with_cid_type0_utf16be_hex() {
    let original = two_page_fixture();
    let setup = enabled_setup("中文标题 Notes");
    let stamped = stamp_header_footer_if_enabled(original.clone(), &setup);
    let appended = String::from_utf8_lossy(&stamped[original.len()..]);

    assert!(appended.contains("/BaseFont /STSong-Light"), "{appended}");
    assert!(appended.contains("/Encoding /UniGB-UCS2-H"), "{appended}");
    assert!(
        appended.contains("<4E2D6587680798980020004E006F007400650073> Tj"),
        "{appended}"
    );
}

#[test]
fn fails_open_without_corrupting_compressed_xref_or_malformed_pdfs() {
    let xref_stream_pdf =
        b"%PDF-1.6\n1 0 obj\n<< /Type /XRef >>\nendobj\nstartxref\n9\n%%EOF\n".to_vec();
    let setup = enabled_setup("Doc");
    assert_eq!(
        stamp_header_footer_if_enabled(xref_stream_pdf.clone(), &setup),
        xref_stream_pdf
    );
}
