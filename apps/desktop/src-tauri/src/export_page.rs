//! PDF page contract. Numbers and the static print rules are the files in
//! `packages/engine/src/export/`; this module only reads them.
//!
//! CSS `@page { size }` is the final page box, so landscape swaps width and
//! height. WebView2 (and the future `NSPrintInfo` / `GtkPageSetup` backends)
//! take the portrait paper plus an orientation flag — the same split Electron
//! uses for `pageSize` + `landscape`. Setting both a swapped size and
//! `LANDSCAPE` would rotate the page twice.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

const MM_PER_INCH: f64 = 25.4;
#[cfg(any(target_os = "linux", test, feature = "export-smoke"))]
const POINTS_PER_INCH: f64 = 72.0;

const PRINT_CONTRACT_JSON: &str =
    include_str!("../../../../packages/engine/src/export/printContract.json");
const PRINT_RULES: &str = include_str!("../../../../packages/engine/src/export/printRules.css");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paper {
    A4,
    Letter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadingBreak {
    None,
    H1,
    H1H2,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageSetup {
    pub paper: Paper,
    pub orientation: Orientation,
    pub heading_page_break: HeadingBreak,
    pub margin_top: i32,
    pub margin_right: i32,
    pub margin_bottom: i32,
    pub margin_left: i32,
    #[allow(dead_code)]
    pub print_backgrounds: bool,
    pub header_footer: bool,
    pub header_title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSetupDto {
    pub paper: String,
    pub orientation: String,
    #[serde(default)]
    pub heading_page_break: String,
    pub margin_top_mm: f64,
    pub margin_right_mm: f64,
    pub margin_bottom_mm: f64,
    pub margin_left_mm: f64,
    #[allow(dead_code)]
    pub print_backgrounds: bool,
    pub header_footer: bool,
    #[serde(default)]
    pub header_title: String,
}

#[derive(Debug, Clone, Copy)]
pub struct NativePage {
    /// Portrait paper width in inches. Landscape is a flag, not a swapped size.
    pub width_in: f64,
    pub height_in: f64,
    pub landscape: bool,
    pub margin_top_in: f64,
    pub margin_right_in: f64,
    pub margin_bottom_in: f64,
    pub margin_left_in: f64,
    #[allow(dead_code)]
    pub print_backgrounds: bool,
    // Read on macOS/Windows; WebKitGTK on Linux exposes no native header/footer print-chrome API.
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    pub header_footer: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ContractFile {
    papers: BTreeMap<String, PaperSpec>,
    default_paper: String,
    default_orientation: String,
    default_heading_break: String,
    default_margins_tenth_mm: MarginSpec,
    margin_min_tenth_mm: i32,
    margin_max_tenth_mm: i32,
    print_backgrounds: bool,
    header_footer: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaperSpec {
    width_tenth_mm: i32,
    height_tenth_mm: i32,
}

#[derive(Debug, Deserialize)]
struct MarginSpec {
    top: i32,
    right: i32,
    bottom: i32,
    left: i32,
}

fn contract() -> &'static ContractFile {
    static CONTRACT: OnceLock<ContractFile> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(PRINT_CONTRACT_JSON).expect("print contract JSON is valid")
    })
}

fn paper_spec(paper: Paper) -> &'static PaperSpec {
    let key = match paper {
        Paper::A4 => "a4",
        Paper::Letter => "letter",
    };
    contract()
        .papers
        .get(key)
        .expect("print contract lists a4 and letter")
}

pub fn format_tenth_mm(tenths: i32) -> String {
    let sign = if tenths < 0 { "-" } else { "" };
    let abs = tenths.abs();
    let whole = abs / 10;
    let frac = abs % 10;
    if frac == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{frac}")
    }
}

fn tenth_mm_to_inches(tenths: i32) -> f64 {
    f64::from(tenths) / 10.0 / MM_PER_INCH
}

fn clean_title(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_control() {
            continue;
        }
        out.push(ch);
        if out.chars().count() >= 120 {
            break;
        }
    }
    out.trim().to_string()
}

fn parse_margin(mm: f64, label: &str) -> Result<i32, String> {
    if !mm.is_finite() {
        return Err(format!("{label} is not a number"));
    }
    let tenths = (mm * 10.0).round() as i32;
    let contract = contract();
    if tenths < contract.margin_min_tenth_mm || tenths > contract.margin_max_tenth_mm {
        return Err(format!(
            "{label} must be between {} and {} mm",
            format_tenth_mm(contract.margin_min_tenth_mm),
            format_tenth_mm(contract.margin_max_tenth_mm),
        ));
    }
    Ok(tenths)
}

impl PageSetup {
    pub fn contract_default() -> Self {
        let contract = contract();
        let paper = match contract.default_paper.as_str() {
            "letter" => Paper::Letter,
            _ => Paper::A4,
        };
        let orientation = match contract.default_orientation.as_str() {
            "landscape" => Orientation::Landscape,
            _ => Orientation::Portrait,
        };
        let heading_page_break = match contract.default_heading_break.as_str() {
            "h1" => HeadingBreak::H1,
            "h1-h2" => HeadingBreak::H1H2,
            _ => HeadingBreak::None,
        };
        let margins = &contract.default_margins_tenth_mm;
        Self {
            paper,
            orientation,
            heading_page_break,
            margin_top: margins.top,
            margin_right: margins.right,
            margin_bottom: margins.bottom,
            margin_left: margins.left,
            print_backgrounds: contract.print_backgrounds,
            header_footer: contract.header_footer,
            header_title: String::new(),
        }
    }

    pub fn from_dto(dto: PageSetupDto) -> Result<Self, String> {
        let paper = match dto.paper.as_str() {
            "a4" => Paper::A4,
            "letter" => Paper::Letter,
            other => return Err(format!("unsupported paper size: {other}")),
        };
        let orientation = match dto.orientation.as_str() {
            "portrait" => Orientation::Portrait,
            "landscape" => Orientation::Landscape,
            other => return Err(format!("unsupported page orientation: {other}")),
        };
        let heading_page_break = match dto.heading_page_break.as_str() {
            "" | "none" => HeadingBreak::None,
            "h1" => HeadingBreak::H1,
            "h1-h2" => HeadingBreak::H1H2,
            other => return Err(format!("unsupported heading page break: {other}")),
        };
        let setup = Self {
            paper,
            orientation,
            heading_page_break,
            margin_top: parse_margin(dto.margin_top_mm, "top margin")?,
            margin_right: parse_margin(dto.margin_right_mm, "right margin")?,
            margin_bottom: parse_margin(dto.margin_bottom_mm, "bottom margin")?,
            margin_left: parse_margin(dto.margin_left_mm, "left margin")?,
            print_backgrounds: dto.print_backgrounds,
            header_footer: dto.header_footer,
            header_title: clean_title(&dto.header_title),
        };
        let (width, height) = oriented_tenths(&setup);
        if setup.margin_top + setup.margin_bottom >= height
            || setup.margin_left + setup.margin_right >= width
        {
            return Err("margins leave no room on the page".into());
        }
        Ok(setup)
    }

    pub fn default_dto() -> PageSetupDto {
        let setup = Self::contract_default();
        PageSetupDto {
            paper: match setup.paper {
                Paper::A4 => "a4",
                Paper::Letter => "letter",
            }
            .into(),
            orientation: match setup.orientation {
                Orientation::Portrait => "portrait",
                Orientation::Landscape => "landscape",
            }
            .into(),
            heading_page_break: match setup.heading_page_break {
                HeadingBreak::None => "none",
                HeadingBreak::H1 => "h1",
                HeadingBreak::H1H2 => "h1-h2",
            }
            .into(),
            margin_top_mm: f64::from(setup.margin_top) / 10.0,
            margin_right_mm: f64::from(setup.margin_right) / 10.0,
            margin_bottom_mm: f64::from(setup.margin_bottom) / 10.0,
            margin_left_mm: f64::from(setup.margin_left) / 10.0,
            print_backgrounds: setup.print_backgrounds,
            header_footer: setup.header_footer,
            header_title: String::new(),
        }
    }
}

fn oriented_tenths(setup: &PageSetup) -> (i32, i32) {
    let paper = paper_spec(setup.paper);
    match setup.orientation {
        Orientation::Landscape => (paper.height_tenth_mm, paper.width_tenth_mm),
        Orientation::Portrait => (paper.width_tenth_mm, paper.height_tenth_mm),
    }
}

fn heading_break_css(mode: HeadingBreak) -> &'static str {
    match mode {
        HeadingBreak::None => "",
        HeadingBreak::H1 => {
            "@media print{body>h1:not(:first-child){break-before:page;page-break-before:always}}"
        }
        HeadingBreak::H1H2 => {
            "@media print{body>h1:not(:first-child),body>h2:not(:first-child){break-before:page;page-break-before:always}}"
        }
    }
}

fn background_css(print_backgrounds: bool) -> &'static str {
    if print_backgrounds {
        "@media print{html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}"
    } else {
        ""
    }
}

pub fn render_print_css(setup: &PageSetup) -> String {
    let (width, height) = oriented_tenths(setup);
    let page = format!(
        "@page{{size:{}mm {}mm;margin:{}mm {}mm {}mm {}mm}}",
        format_tenth_mm(width),
        format_tenth_mm(height),
        format_tenth_mm(setup.margin_top),
        format_tenth_mm(setup.margin_right),
        format_tenth_mm(setup.margin_bottom),
        format_tenth_mm(setup.margin_left),
    );
    let rules = PRINT_RULES.trim_end_matches(['\r', '\n']);
    let backgrounds = background_css(setup.print_backgrounds);
    let heading_break = heading_break_css(setup.heading_page_break);
    format!("{page}{rules}{backgrounds}{heading_break}")
}

pub fn native_page(setup: &PageSetup) -> NativePage {
    let paper = paper_spec(setup.paper);
    NativePage {
        width_in: tenth_mm_to_inches(paper.width_tenth_mm),
        height_in: tenth_mm_to_inches(paper.height_tenth_mm),
        landscape: setup.orientation == Orientation::Landscape,
        margin_top_in: tenth_mm_to_inches(setup.margin_top),
        margin_right_in: tenth_mm_to_inches(setup.margin_right),
        margin_bottom_in: tenth_mm_to_inches(setup.margin_bottom),
        margin_left_in: tenth_mm_to_inches(setup.margin_left),
        print_backgrounds: setup.print_backgrounds,
        header_footer: setup.header_footer,
    }
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn page_points(setup: &PageSetup) -> (f64, f64) {
    let (width, height) = oriented_tenths(setup);
    (
        f64::from(width) / 10.0 * POINTS_PER_INCH / MM_PER_INCH,
        f64::from(height) / 10.0 * POINTS_PER_INCH / MM_PER_INCH,
    )
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn margin_points(setup: &PageSetup) -> (f64, f64, f64, f64) {
    let to_pt = |tenths: i32| f64::from(tenths) / 10.0 * POINTS_PER_INCH / MM_PER_INCH;
    (
        to_pt(setup.margin_top),
        to_pt(setup.margin_right),
        to_pt(setup.margin_bottom),
        to_pt(setup.margin_left),
    )
}

#[cfg(any(test, feature = "export-smoke"))]
pub fn media_box_points(setup: &PageSetup) -> (f64, f64) {
    let (width, height) = oriented_tenths(setup);
    (
        f64::from(width) / 10.0 * POINTS_PER_INCH / MM_PER_INCH,
        f64::from(height) / 10.0 * POINTS_PER_INCH / MM_PER_INCH,
    )
}

#[cfg(any(test, feature = "export-smoke"))]
pub fn pdf_media_box(bytes: &[u8]) -> Option<(f64, f64)> {
    let text = String::from_utf8_lossy(bytes);
    static BOX: OnceLock<regex::Regex> = OnceLock::new();
    let caps = BOX
        .get_or_init(|| {
            regex::Regex::new(r"/MediaBox\s*\[\s*-?[\d.]+\s+-?[\d.]+\s+([\d.]+)\s+([\d.]+)\s*\]")
                .expect("media box regex")
        })
        .captures(&text)?;
    Some((caps[1].parse().ok()?, caps[2].parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_css_matches_the_engine_page_rule() {
        let css = render_print_css(&PageSetup::contract_default());
        assert!(css.starts_with("@page{size:210mm 297mm;margin:16mm 16mm 16mm 16mm}"));
        assert!(css.contains(".page-break,.pagebreak{break-after:page"));
        assert!(!css.contains("88vh"));
    }

    #[test]
    fn landscape_letter_swaps_css_but_not_the_native_paper() {
        let setup = PageSetup::from_dto(PageSetupDto {
            paper: "letter".into(),
            orientation: "landscape".into(),
            heading_page_break: "none".into(),
            margin_top_mm: 10.0,
            margin_right_mm: 12.5,
            margin_bottom_mm: 10.0,
            margin_left_mm: 12.5,
            print_backgrounds: true,
            header_footer: true,
            header_title: "Notes\n".into(),
        })
        .unwrap();
        assert!(render_print_css(&setup)
            .starts_with("@page{size:279.4mm 215.9mm;margin:10mm 12.5mm 10mm 12.5mm}"));
        let native = native_page(&setup);
        assert!((native.width_in - (215.9 / 25.4)).abs() < 1e-9);
        assert!((native.height_in - (279.4 / 25.4)).abs() < 1e-9);
        assert!(native.landscape);
        assert_eq!(setup.header_title, "Notes");
    }

    #[test]
    fn margins_outside_the_contract_range_are_rejected() {
        let error = PageSetup::from_dto(PageSetupDto {
            paper: "a4".into(),
            orientation: "portrait".into(),
            heading_page_break: "none".into(),
            margin_top_mm: 200.0,
            margin_right_mm: 16.0,
            margin_bottom_mm: 16.0,
            margin_left_mm: 16.0,
            print_backgrounds: true,
            header_footer: false,
            header_title: String::new(),
        })
        .expect_err("200 mm is outside the contract");
        assert!(error.contains("between"), "{error}");
    }

    #[test]
    fn dto_deserializes_camel_case_wire_json() {
        let json = r#"{
            "paper": "letter",
            "orientation": "landscape",
            "headingPageBreak": "h1-h2",
            "marginTopMm": 10,
            "marginRightMm": 12.5,
            "marginBottomMm": 10,
            "marginLeftMm": 12.5,
            "printBackgrounds": true,
            "headerFooter": true,
            "headerTitle": "Doc"
        }"#;
        let dto: PageSetupDto = serde_json::from_str(json).expect("camelCase DTO parses");
        let setup = PageSetup::from_dto(dto).expect("valid setup");
        assert_eq!(setup.paper, Paper::Letter);
        assert_eq!(setup.orientation, Orientation::Landscape);
        assert_eq!(setup.heading_page_break, HeadingBreak::H1H2);
        assert_eq!(setup.margin_top, 100);
        assert_eq!(setup.margin_right, 125);
        assert!(setup.header_footer);
        assert_eq!(setup.header_title, "Doc");
        let css = render_print_css(&setup);
        assert!(css.contains(
            "@media print{body>h1:not(:first-child),body>h2:not(:first-child){break-before:page;page-break-before:always}}"
        ));
    }

    #[test]
    fn rejects_unsupported_heading_page_break() {
        let mut dto = PageSetup::default_dto();
        dto.heading_page_break = "h3".into();
        let error = PageSetup::from_dto(dto).expect_err("unsupported heading break");
        assert!(error.contains("heading page break"), "{error}");
    }

    #[test]
    fn media_box_parser_reads_the_first_page_box() {
        let pdf = b"%PDF-1.4\n<< /Type /Page /MediaBox [0 0 595.28 841.89] >>";
        let (width, height) = pdf_media_box(pdf).unwrap();
        let (expect_w, expect_h) = media_box_points(&PageSetup::contract_default());
        assert!((width - expect_w).abs() < 0.2, "{width} vs {expect_w}");
        assert!((height - expect_h).abs() < 0.2, "{height} vs {expect_h}");
    }
}
