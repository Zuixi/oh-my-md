//! Text layout, encoding and font selection for the Linux PDF stamp.
//!
//! A running title reaches the page through one of two paths: Windows-1252
//! bytes on `/Helvetica`, or an Adobe CJK `Type0` font whose `Uni*-UCS2-H`
//! CMap takes big-endian UCS-2 hex. Both share the metrics below, so a
//! full-width East Asian glyph is measured at its real one-em advance instead
//! of the Latin narrow-glyph width and cannot overflow the right margin.
//!
//! Everything here is pure: no PDF objects, no IO. `export_pdf_stamp.rs` owns
//! the object tree and asks this module what to draw.

/// Helvetica advances ~0.52 em per glyph for mixed prose; exact metrics need
/// the font program and this only positions one short line.
pub(super) const NARROW_CHAR_WIDTH_EM: f64 = 0.52;
/// Every CJK font selectable here draws an East Asian glyph on a full em
/// square, so measuring one as narrow would center and truncate it wrong.
pub(super) const WIDE_CHAR_WIDTH_EM: f64 = 1.0;
pub(super) const ELLIPSIS: &str = "...";
pub(super) const STAMP_FONT_PT: f64 = 8.5;
const STAMP_GRAY: f64 = 0.42;
const FOOTER_BASELINE_RATIO: f64 = 0.42;
const HEADER_BASELINE_RATIO: f64 = 0.58;
const MIN_FOOTER_BASELINE_PT: f64 = 10.0;
const MIN_HEADER_BASELINE_PT: f64 = 12.0;
const MIN_USABLE_WIDTH_PT: f64 = 72.0;
pub(super) const LATIN_FONT: &str = "/OmdF1";
/// Adobe's standard CID fonts: every CJK-capable viewer substitutes the font
/// program, so a Unicode title needs no embedded font.
pub(super) const CJK_FONT: &str = "/OmdF2";
pub(super) const LATIN_FONT_OBJECT: &str =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct PageBoxPt {
    /// Oriented paper box and margins, in PDF points.
    pub width_pt: f64,
    pub height_pt: f64,
    pub top_pt: f64,
    pub right_pt: f64,
    pub bottom_pt: f64,
    pub left_pt: f64,
}

/// One line of user text as a text-showing operator can draw it: layout
/// characters become spaces, other control characters have no glyph and are
/// dropped, and an astral character is replaced by a middle dot. That dot has a
/// single WinAnsi byte (`0xB7`) and a single UCS-2 unit (`00B7`), so neither
/// path ever emits half a surrogate pair.
pub(super) fn sanitize_stamp_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\t' | '\n' | '\r' => out.push(' '),
            _ if (ch as u32) > 0xFFFF => out.push('\u{B7}'),
            _ if (ch as u32) < 0x20 || (0x7F..=0x9F).contains(&(ch as u32)) => {}
            _ => out.push(ch),
        }
    }
    out
}

/// Windows-1252 byte for `ch`, or `None` when the glyph is outside it.
///
/// Latin-1 maps straight through; the five unassigned positions of the
/// `0x80..=0x9F` block map from nothing, so only the 27 printable glyphs
/// CP1252 defines there have an entry.
fn win_ansi_byte(ch: char) -> Option<u8> {
    match ch {
        '\u{20}'..='\u{7E}' | '\u{A0}'..='\u{FF}' => Some(ch as u8),
        '\u{20AC}' => Some(0x80),
        '\u{201A}' => Some(0x82),
        '\u{0192}' => Some(0x83),
        '\u{201E}' => Some(0x84),
        '\u{2026}' => Some(0x85),
        '\u{2020}' => Some(0x86),
        '\u{2021}' => Some(0x87),
        '\u{02C6}' => Some(0x88),
        '\u{2030}' => Some(0x89),
        '\u{0160}' => Some(0x8A),
        '\u{2039}' => Some(0x8B),
        '\u{0152}' => Some(0x8C),
        '\u{017D}' => Some(0x8E),
        '\u{2018}' => Some(0x91),
        '\u{2019}' => Some(0x92),
        '\u{201C}' => Some(0x93),
        '\u{201D}' => Some(0x94),
        '\u{2022}' => Some(0x95),
        '\u{2013}' => Some(0x96),
        '\u{2014}' => Some(0x97),
        '\u{02DC}' => Some(0x98),
        '\u{2122}' => Some(0x99),
        '\u{0161}' => Some(0x9A),
        '\u{203A}' => Some(0x9B),
        '\u{0153}' => Some(0x9C),
        '\u{017E}' => Some(0x9E),
        '\u{0178}' => Some(0x9F),
        _ => None,
    }
}

/// Every character as a WinAnsi byte, or `None` when one of them is outside
/// CP1252 — the whole title then needs a CID font instead.
pub(super) fn win_ansi_bytes(text: &str) -> Option<Vec<u8>> {
    text.chars().map(win_ansi_byte).collect()
}

/// PDF literal string for WinAnsi bytes. `\`, `(` and `)` are the only bytes
/// needing an escape, and bytes above `0x7F` become three-digit octal so the
/// appended revision stays pure ASCII whatever charset a reader assumes.
pub(super) fn encode_win_ansi_literal(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 4);
    out.push('(');
    for &byte in bytes {
        match byte {
            b'\\' | b'(' | b')' => {
                out.push('\\');
                out.push(byte as char);
            }
            0x20..=0x7E => out.push(byte as char),
            _ => out.push_str(&format!("\\{byte:03o}")),
        }
    }
    out.push(')');
    out
}

/// Adobe's standard CJK CID collection a title can be drawn with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum CjkScript {
    Korean,
    Japanese,
    SimplifiedChinese,
}

impl CjkScript {
    /// Script of the title. Hangul outranks Kana whatever their order, so a
    /// mixed title picks the font that can draw the script only it covers.
    fn for_title(title: &str) -> CjkScript {
        let mut script = CjkScript::SimplifiedChinese;
        for ch in title.chars() {
            let code = ch as u32;
            if matches!(code, 0xAC00..=0xD7AF | 0x1100..=0x11FF | 0x3130..=0x318F) {
                return CjkScript::Korean;
            }
            if matches!(code, 0x3040..=0x309F | 0x30A0..=0x30FF | 0x31F0..=0x31FF) {
                script = CjkScript::Japanese;
            }
        }
        script
    }

    /// Adobe's `BaseFont`, CMap, collection ordering and supplement for it.
    fn font(self) -> (&'static str, &'static str, &'static str, u8) {
        match self {
            CjkScript::Korean => ("HYSMyeongJo-Medium", "UniKS-UCS2-H", "Korea1", 2),
            CjkScript::Japanese => ("HeiseiMin-W3", "UniJIS-UCS2-H", "Japan1", 4),
            CjkScript::SimplifiedChinese => ("STSong-Light", "UniGB-UCS2-H", "GB1", 4),
        }
    }

    /// Descendant `CIDFontType0` dictionary naming the standard font program.
    pub(super) fn descendant_font_dict(self) -> String {
        let (base_font, _, ordering, supplement) = self.font();
        format!(
            "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /{base_font} /CIDSystemInfo \
             << /Registry (Adobe) /Ordering ({ordering}) /Supplement {supplement} >> >>"
        )
    }

    /// `Type0` dictionary that selects this script's `Uni*-UCS2-H` CMap.
    pub(super) fn type0_font_dict(self, descendant: u32) -> String {
        let (base_font, encoding, _, _) = self.font();
        format!(
            "<< /Type /Font /Subtype /Type0 /BaseFont /{base_font} /Encoding /{encoding} \
             /DescendantFonts [ {descendant} 0 R ] >>"
        )
    }
}

/// How the header title is drawn: single-byte WinAnsi text on `/Helvetica`, or
/// a `Type0` CID font when a character has no CP1252 byte.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum HeaderFontPlan {
    WinAnsi,
    Cjk(CjkScript),
}

impl HeaderFontPlan {
    /// Plan for an already sanitized title. A title made only of Latin prose
    /// and typographic punctuation keeps the Helvetica font, so no CID font
    /// object is appended to the revision.
    pub(super) fn for_title(title: &str) -> HeaderFontPlan {
        match win_ansi_bytes(title) {
            Some(_) => HeaderFontPlan::WinAnsi,
            None => HeaderFontPlan::Cjk(CjkScript::for_title(title)),
        }
    }

    /// Font resource and text-showing operand drawing `title`. The operand is
    /// `None` only if a WinAnsi plan is handed a character it cannot encode,
    /// which cannot happen: the plan is chosen from the same sanitized string
    /// and `truncate` only drops trailing characters. Callers turn that into
    /// the usual fail-open result rather than drawing a wrong glyph.
    fn operand(self, title: &str) -> Option<(&'static str, String)> {
        match self {
            HeaderFontPlan::WinAnsi => {
                Some((LATIN_FONT, encode_win_ansi_literal(&win_ansi_bytes(title)?)))
            }
            HeaderFontPlan::Cjk(_) => Some((CJK_FONT, ucs2_hex(title))),
        }
    }
}

/// `Uni*-UCS2-H` are big-endian UCS-2 CMaps, so the hex string holds raw code
/// units. No `FEFF` BOM: it would draw a stray glyph and be copied into every
/// text selection.
pub(super) fn ucs2_hex(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 4 + 2);
    out.push('<');
    for ch in text.chars() {
        // `sanitize_stamp_text` already replaced astral characters, so no
        // character here needs a surrogate pair a UCS-2 CMap cannot address.
        debug_assert!((ch as u32) <= 0xFFFF, "astral character in a UCS-2 CMap");
        out.push_str(&format!("{:04X}", ch as u32));
    }
    out.push('>');
    out
}

/// East Asian full-width glyphs the CJK fonts draw on a one-em square.
pub(super) fn is_wide_glyph(ch: char) -> bool {
    matches!(
        ch as u32,
        0x1100..=0x115F
            | 0x2E80..=0xA4CF
            | 0xAC00..=0xD7AF
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE6F
            | 0xFF01..=0xFF60
            | 0xFFE0..=0xFFE6
    ) || (ch as u32) > 0xFFFF
}

pub(super) fn char_width_em(ch: char) -> f64 {
    if is_wide_glyph(ch) {
        WIDE_CHAR_WIDTH_EM
    } else {
        NARROW_CHAR_WIDTH_EM
    }
}

pub(super) fn text_width(text: &str) -> f64 {
    text.chars().map(char_width_em).sum::<f64>() * STAMP_FONT_PT
}

/// Longest prefix of `text` that fits `usable_pt`, marked with `...` when the
/// room left is worth more than one glyph. Always keeps one character so a
/// narrow page still shows something instead of an empty header.
pub(super) fn truncate(text: &str, usable_pt: f64) -> String {
    if text_width(text) <= usable_pt {
        return text.to_string();
    }
    let ellipsis_pt = text_width(ELLIPSIS);
    let with_ellipsis = usable_pt > ellipsis_pt + STAMP_FONT_PT;
    let budget = if with_ellipsis {
        usable_pt - ellipsis_pt
    } else {
        usable_pt
    };
    let mut width = 0.0;
    let mut keep = 0usize;
    for ch in text.chars() {
        let next = width + char_width_em(ch) * STAMP_FONT_PT;
        if next > budget {
            break;
        }
        width = next;
        keep += 1;
    }
    let mut out: String = text.chars().take(keep.max(1)).collect();
    if with_ellipsis {
        out.push_str(ELLIPSIS);
    }
    out
}

/// Header and footer text for page `index`, with the page number already
/// formatted the way every PDF reader shows it.
pub(super) fn header_footer_texts(
    draw_header: bool,
    draw_footer: bool,
    title: &str,
    index: usize,
    total: usize,
) -> (Option<String>, Option<String>) {
    let header = draw_header.then(|| title.to_string());
    let footer = draw_footer.then(|| format!("{} / {total}", index + 1));
    (header, footer)
}

/// `Q` restores the state the page's own content left behind, then `q … Q`
/// draws the stamp in clean default user space.
pub(super) fn stamp_content(
    (header, footer): (Option<String>, Option<String>),
    media: (f64, f64, f64, f64),
    page_box: PageBoxPt,
    plan: HeaderFontPlan,
) -> Option<String> {
    let (x0, y0, x1, y1) = media;
    let mut out = String::from("Q\nq\n");
    if let Some(footer) = footer {
        // `header_footer_texts` builds the footer from page numbers and `/`,
        // so its UTF-8 bytes are already its WinAnsi bytes.
        let x = (x1 - page_box.right_pt - text_width(&footer)).max(x0 + page_box.left_pt);
        let y = y0 + (page_box.bottom_pt * FOOTER_BASELINE_RATIO).max(MIN_FOOTER_BASELINE_PT);
        let literal = encode_win_ansi_literal(footer.as_bytes());
        out.push_str(&show_text(LATIN_FONT, x, y, &literal));
    }
    if let Some(header) = header {
        let usable = (x1 - x0 - page_box.left_pt - page_box.right_pt).max(MIN_USABLE_WIDTH_PT);
        let title = truncate(&header, usable);
        let x = x0 + page_box.left_pt + ((usable - text_width(&title)).max(0.0) / 2.0);
        let y = y1 - (page_box.top_pt * HEADER_BASELINE_RATIO).max(MIN_HEADER_BASELINE_PT);
        let (font, operand) = plan.operand(&title)?;
        out.push_str(&show_text(font, x, y, &operand));
    }
    out.push_str("Q\n");
    Some(out)
}

fn show_text(font: &str, x: f64, y: f64, text: &str) -> String {
    format!("BT\n{font} {STAMP_FONT_PT} Tf\n{STAMP_GRAY} g\n{x:.2} {y:.2} Td\n{text} Tj\nET\n")
}
