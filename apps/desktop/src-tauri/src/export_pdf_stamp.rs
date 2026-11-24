//! Linux PDF running header/footer stamp layer.
//!
//! WebKitGTK paginates the PDF natively but GTK exposes no running
//! header/footer API (macOS has `NSPrintHeaderAndFooter`, WebView2 prints its
//! own chrome), so this module appends a standard ISO 32000-1 incremental
//! update to the Cairo bytes: the original file is copied byte for byte and the
//! new revision only adds fonts and content streams plus a redefinition of each
//! page object.
//!
//! Anything the parser does not understand — a compressed xref stream, inline
//! page contents, a missing page tree — bails out before a byte is appended, so
//! an unusual PDF is exported untouched instead of corrupted.

use crate::export::export_page::{self, PageSetup};
use std::collections::BTreeMap;

/// A 8 mm top/bottom margin is the smallest one that still leaves room for
/// print chrome inside the margin.
const MIN_STAMP_MARGIN_TENTHS: i32 = 80;
const STAMP_FONT_PT: f64 = 8.5;
const STAMP_GRAY: f64 = 0.42;
/// Helvetica advances ~0.52 em per glyph for mixed prose; exact metrics need
/// the font program and this only positions one short line.
const CHAR_WIDTH_EM: f64 = 0.52;
const FOOTER_BASELINE_RATIO: f64 = 0.42;
const HEADER_BASELINE_RATIO: f64 = 0.58;
const MIN_FOOTER_BASELINE_PT: f64 = 10.0;
const MIN_HEADER_BASELINE_PT: f64 = 12.0;
const MIN_USABLE_WIDTH_PT: f64 = 72.0;
const MAX_PAGE_TREE_DEPTH: usize = 32;
const LATIN_FONT: &str = "/OmdF1";
/// Adobe's standard Simplified-Chinese CID font: every CJK-capable viewer
/// substitutes it, so a Unicode title needs no embedded font program.
const CJK_FONT: &str = "/OmdF2";
const LATIN_FONT_OBJECT: &str =
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

pub(crate) fn stamp_header_footer_if_enabled(bytes: Vec<u8>, page: &PageSetup) -> Vec<u8> {
    if !page.header_footer {
        return bytes;
    }
    let (width_pt, height_pt) = export_page::page_points(page);
    let (top_pt, right_pt, bottom_pt, left_pt) = export_page::margin_points(page);
    let draw_header = !page.header_title.is_empty() && page.margin_top >= MIN_STAMP_MARGIN_TENTHS;
    let draw_footer = page.margin_bottom >= MIN_STAMP_MARGIN_TENTHS;
    if !draw_header && !draw_footer {
        return bytes;
    }
    let page_box = PageBoxPt {
        width_pt,
        height_pt,
        top_pt,
        right_pt,
        bottom_pt,
        left_pt,
    };
    match try_stamp(
        &bytes,
        &page.header_title,
        draw_header,
        draw_footer,
        page_box,
    ) {
        Some(stamped) => stamped,
        None => {
            log::warn!("skipping Linux PDF header/footer stamp: unsupported PDF structure");
            bytes
        }
    }
}

fn try_stamp(
    bytes: &[u8],
    title: &str,
    draw_header: bool,
    draw_footer: bool,
    page_box: PageBoxPt,
) -> Option<Vec<u8>> {
    let (startxref, prev_xref) = last_startxref(bytes)?;
    // Cairo always writes a classic xref table; a compressed xref stream means
    // objects cannot be addressed here, so the caller keeps the original bytes.
    if !bytes.get(prev_xref..)?.starts_with(b"xref") {
        return None;
    }
    let revision = &bytes[prev_xref..startxref];
    let trailer = dict_at(revision, find_last(revision, b"trailer")? + "trailer".len())?;
    let (_, size_at) = field(trailer, "Size")?;
    let size = uint(trailer, size_at)?.0;
    let (_, root_at) = field(trailer, "Root")?;
    let (root, root_generation, _) = reference(trailer, root_at)?;
    let info = field(trailer, "Info")
        .and_then(|(_, at)| reference(trailer, at))
        .map(|(id, generation, _)| format!("{id} {generation} R"));
    let table = ObjTable {
        bytes,
        offsets: parse_xref(&revision["xref".len()..find_last(revision, b"trailer")?]),
    };
    let fallback = (0.0, 0.0, page_box.width_pt, page_box.height_pt);
    let pages = collect_pages(&table, root, fallback)?;

    let highest = table.offsets.keys().next_back().copied().unwrap_or(0);
    let mut revision = Revision::new(bytes, size.max(highest + 1));
    let latin_font = revision.reserve();
    revision.object(latin_font, LATIN_FONT_OBJECT);
    let cjk_font = (draw_header && !title.is_ascii()).then(|| revision.cjk_font());
    let fonts = match cjk_font {
        Some(cjk) => format!("{LATIN_FONT} {latin_font} 0 R {CJK_FONT} {cjk} 0 R"),
        None => format!("{LATIN_FONT} {latin_font} 0 R"),
    };
    let mut editor = Editor::new(&table, revision, fonts);
    for (index, page) in pages.iter().enumerate() {
        editor.stamp_page(
            page,
            header_footer_texts(draw_header, draw_footer, title, index, pages.len()),
            page_box,
            cjk_font.is_some(),
        )?;
    }
    Some(editor.revision.finish(
        &format!("{root} {root_generation} R"),
        info.as_deref(),
        prev_xref,
    ))
}

/// Header and footer text for page `index`, with the page number already
/// formatted the way every PDF reader shows it.
fn header_footer_texts(
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

/// Allocates the appended objects for one page: the two content streams, the
/// merged resources and the redefined page dictionary.
struct Editor<'a> {
    table: &'a ObjTable<'a>,
    revision: Revision,
    fonts: String,
    resource_copies: BTreeMap<u32, u32>,
    font_copies: BTreeMap<u32, u32>,
}

impl<'a> Editor<'a> {
    fn new(table: &'a ObjTable<'a>, revision: Revision, fonts: String) -> Editor<'a> {
        Editor {
            table,
            revision,
            fonts,
            resource_copies: BTreeMap::new(),
            font_copies: BTreeMap::new(),
        }
    }

    fn stamp_page(
        &mut self,
        page: &PageRef,
        texts: (Option<String>, Option<String>),
        page_box: PageBoxPt,
        cjk: bool,
    ) -> Option<()> {
        let dict = self.table.dict(page.id)?;
        let contents = contents(dict)?;
        // `q` before the page's own content and `Q` after it: the stamp never
        // inherits a page `cm`, clip or fill color, and the page never sees one.
        let prep = self.revision.reserve();
        self.revision.stream(prep, "q\n");
        let stamp = self.revision.reserve();
        self.revision
            .stream(stamp, &stamp_content(texts, page.media, page_box, cjk));
        let refs: String = contents
            .refs
            .iter()
            .map(|(id, generation)| format!(" {id} {generation} R"))
            .collect();
        let mut edits = vec![(
            contents.key,
            contents.end,
            format!("/Contents [ {prep} 0 R{refs} {stamp} 0 R ]"),
        )];
        let mut extras = Vec::new();
        match resources(dict)? {
            Resources::Missing => {
                extras.push(format!("/Resources << /Font << {} >> >>", self.fonts))
            }
            Resources::Inline { key, value, end } => {
                let merged = self.merge_fonts(&dict[value..end])?;
                edits.push((key, end, format!("/Resources {merged}")));
            }
            Resources::Indirect { key, end, id } => {
                let copy = match self.resource_copies.get(&id) {
                    Some(copy) => *copy,
                    None => {
                        let merged = self.merge_fonts(self.table.dict(id)?)?;
                        let copy = self.revision.reserve();
                        self.revision.object(copy, &merged);
                        self.resource_copies.insert(id, copy);
                        copy
                    }
                };
                edits.push((key, end, format!("/Resources {copy} 0 R")));
            }
        }
        let body = rebuild(dict, edits, &extras)?;
        self.revision.object(page.id, &body);
        Some(())
    }

    /// Adds the stamp fonts to a resources dictionary, keeping every existing
    /// entry. An indirect `/Font` dictionary is copied instead of redefined
    /// because a form XObject or another page may still use that object.
    fn merge_fonts(&mut self, dict: &[u8]) -> Option<String> {
        let Some((key, value)) = field(dict, "Font") else {
            return rebuild(dict, Vec::new(), &[format!("/Font << {} >>", self.fonts)]);
        };
        if dict.get(value..)?.starts_with(b"<<") {
            let end = dict_end(dict, value)?;
            let existing = String::from_utf8_lossy(&dict[value + 2..end - 2]);
            return Some(format!("<<{} {} >>", existing.trim_end(), self.fonts));
        }
        let (id, _, end) = reference(dict, value)?;
        let copy = match self.font_copies.get(&id) {
            Some(copy) => *copy,
            None => {
                let merged = rebuild(self.table.dict(id)?, Vec::new(), &[self.fonts.clone()])?;
                let copy = self.revision.reserve();
                self.revision.object(copy, &merged);
                self.font_copies.insert(id, copy);
                copy
            }
        };
        rebuild(dict, vec![(key, end, format!("/Font {copy} 0 R"))], &[])
    }
}

struct ObjTable<'a> {
    bytes: &'a [u8],
    offsets: BTreeMap<u32, usize>,
}

impl<'a> ObjTable<'a> {
    fn dict(&self, id: u32) -> Option<&'a [u8]> {
        object_dict(self.bytes, *self.offsets.get(&id)?)
    }
}

struct PageRef {
    id: u32,
    media: (f64, f64, f64, f64),
}

/// Pages in page-tree order, so `1 / N` follows what the reader shows instead
/// of the object-id order, with inherited `/MediaBox` values resolved.
fn collect_pages(
    table: &ObjTable,
    catalog_id: u32,
    fallback: (f64, f64, f64, f64),
) -> Option<Vec<PageRef>> {
    let catalog = table.dict(catalog_id)?;
    let (_, pages_at) = field(catalog, "Pages")?;
    let (root, _, _) = reference(catalog, pages_at)?;
    let mut pending = vec![(root, fallback, 0usize)];
    let mut pages = Vec::new();
    while let Some((id, inherited, depth)) = pending.pop() {
        if depth > MAX_PAGE_TREE_DEPTH {
            return None;
        }
        let dict = table.dict(id)?;
        let media = media_box(dict).unwrap_or(inherited);
        let (_, kind_at) = field(dict, "Type")?;
        match name(dict, kind_at)? {
            b"Page" => pages.push(PageRef { id, media }),
            b"Pages" => {
                let (_, kids_at) = field(dict, "Kids")?;
                if dict.get(kids_at) != Some(&b'[') {
                    return None;
                }
                let kids = references(dict, kids_at + 1, b']')?;
                if kids.is_empty() {
                    return None;
                }
                for (kid, _) in kids.into_iter().rev() {
                    pending.push((kid, media, depth + 1));
                }
            }
            _ => return None,
        }
    }
    (!pages.is_empty()).then_some(pages)
}

struct Contents {
    key: usize,
    end: usize,
    refs: Vec<(u32, u32)>,
}

/// `/Contents` as one reference or an array of them; anything else cannot be
/// spliced without rewriting bytes WebKitGTK already wrote.
fn contents(dict: &[u8]) -> Option<Contents> {
    let (key, value) = field(dict, "Contents")?;
    let (end, refs) = if dict.get(value) == Some(&b'[') {
        let close = value + dict[value..].iter().position(|byte| *byte == b']')?;
        (close + 1, references(dict, value + 1, b']')?)
    } else {
        let (id, generation, end) = reference(dict, value)?;
        (end, vec![(id, generation)])
    };
    (refs.iter().all(|(id, _)| *id > 0)).then_some(Contents { key, end, refs })
}

enum Resources {
    Missing,
    Inline {
        key: usize,
        value: usize,
        end: usize,
    },
    Indirect {
        key: usize,
        end: usize,
        id: u32,
    },
}

fn resources(dict: &[u8]) -> Option<Resources> {
    let Some((key, value)) = field(dict, "Resources") else {
        return Some(Resources::Missing);
    };
    if dict.get(value..)?.starts_with(b"<<") {
        return Some(Resources::Inline {
            key,
            value,
            end: dict_end(dict, value)?,
        });
    }
    let (id, _, end) = reference(dict, value)?;
    Some(Resources::Indirect { key, end, id })
}

/// Applies byte-span edits in one pass — spans index the original slice, so
/// they stay valid — and appends `extras` before the closing `>>`.
fn rebuild(
    dict: &[u8],
    mut edits: Vec<(usize, usize, String)>,
    extras: &[String],
) -> Option<String> {
    edits.sort_by_key(|edit| edit.0);
    let mut out = String::with_capacity(dict.len() + 96);
    let mut cursor = 0usize;
    for (start, end, text) in edits {
        if start < cursor || end > dict.len() {
            return None;
        }
        out.push_str(&String::from_utf8_lossy(&dict[cursor..start]));
        out.push_str(&text);
        cursor = end;
    }
    out.push_str(&String::from_utf8_lossy(&dict[cursor..]));
    if !extras.is_empty() {
        if !out.ends_with(">>") {
            return None;
        }
        out.insert_str(out.len() - 2, &format!(" {} ", extras.join(" ")));
    }
    Some(out)
}

/// `Q` restores the state the page's own content left behind, then `q … Q`
/// draws in clean default user space.
fn stamp_content(
    (header, footer): (Option<String>, Option<String>),
    media: (f64, f64, f64, f64),
    page_box: PageBoxPt,
    cjk: bool,
) -> String {
    let (x0, y0, x1, y1) = media;
    let mut out = String::from("Q\nq\n");
    if let Some(footer) = footer {
        let x = (x1 - page_box.right_pt - text_width(&footer)).max(x0 + page_box.left_pt);
        let y = y0 + (page_box.bottom_pt * FOOTER_BASELINE_RATIO).max(MIN_FOOTER_BASELINE_PT);
        out.push_str(&show_text(LATIN_FONT, x, y, &literal(&footer)));
    }
    if let Some(header) = header {
        let usable = (x1 - x0 - page_box.left_pt - page_box.right_pt).max(MIN_USABLE_WIDTH_PT);
        let title = truncate(&header, usable);
        let x = x0 + page_box.left_pt + ((usable - text_width(&title)).max(0.0) / 2.0);
        let y = y1 - (page_box.top_pt * HEADER_BASELINE_RATIO).max(MIN_HEADER_BASELINE_PT);
        let (font, text) = if cjk {
            (CJK_FONT, ucs2_hex(&title))
        } else {
            (LATIN_FONT, literal(&title))
        };
        out.push_str(&show_text(font, x, y, &text));
    }
    out.push_str("Q\n");
    out
}

fn show_text(font: &str, x: f64, y: f64, text: &str) -> String {
    format!("BT\n{font} {STAMP_FONT_PT} Tf\n{STAMP_GRAY} g\n{x:.2} {y:.2} Td\n{text} Tj\nET\n")
}

fn text_width(text: &str) -> f64 {
    text.chars().count() as f64 * STAMP_FONT_PT * CHAR_WIDTH_EM
}

/// Cut at a character boundary so the title cannot run into the right margin.
fn truncate(text: &str, usable_pt: f64) -> String {
    let room = (usable_pt / (STAMP_FONT_PT * CHAR_WIDTH_EM))
        .floor()
        .max(1.0) as usize;
    text.chars().take(room).collect()
}

/// PDF literal string: `\`, `(` and `)` are the only characters WinAnsi text
/// needs escaped.
fn literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 4);
    for ch in text.chars() {
        if matches!(ch, '\\' | '(' | ')') {
            out.push('\\');
        }
        out.push(ch);
    }
    format!("({out})")
}

/// `UniGB-UCS2-H` is a big-endian UCS-2 CMap, so the hex string holds raw code
/// units. No `FEFF` BOM: it would draw a stray glyph and be copied into every
/// text selection.
fn ucs2_hex(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 4 + 2);
    out.push('<');
    for unit in text.encode_utf16() {
        out.push_str(&format!("{unit:04X}"));
    }
    out.push('>');
    out
}

/// Appended objects and the incremental `xref`/`trailer` pair, written onto a
/// copy of the input: the original bytes are never mutated.
struct Revision {
    out: Vec<u8>,
    xref: BTreeMap<u32, usize>,
    next: u32,
}

impl Revision {
    fn new(base: &[u8], next: u32) -> Self {
        let mut out = base.to_vec();
        // A file without a trailing newline would run the new object header
        // into the previous token.
        out.push(b'\n');
        Self {
            out,
            xref: BTreeMap::new(),
            next,
        }
    }

    fn reserve(&mut self) -> u32 {
        self.next += 1;
        self.next - 1
    }

    fn object(&mut self, id: u32, body: &str) {
        self.xref.insert(id, self.out.len());
        self.out
            .extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
    }

    fn stream(&mut self, id: u32, content: &str) {
        self.object(
            id,
            &format!(
                "<< /Length {} >>\nstream\n{content}endstream",
                content.len()
            ),
        );
    }

    /// Type0 font over the standard descendant CIDFont.
    fn cjk_font(&mut self) -> u32 {
        let descendant = self.reserve();
        self.object(
            descendant,
            "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light \
             /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>",
        );
        let type0 = self.reserve();
        self.object(
            type0,
            &format!(
                "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light \
                 /Encoding /UniGB-UCS2-H /DescendantFonts [ {descendant} 0 R ] >>"
            ),
        );
        type0
    }

    fn finish(mut self, root: &str, info: Option<&str>, prev: usize) -> Vec<u8> {
        let size = self.next;
        let startxref = self.out.len();
        self.out.extend_from_slice(b"xref\n");
        let entries: Vec<(u32, usize)> = self.xref.iter().map(|(id, at)| (*id, *at)).collect();
        let mut at = 0usize;
        while at < entries.len() {
            let mut end = at + 1;
            while end < entries.len() && entries[end].0 == entries[end - 1].0 + 1 {
                end += 1;
            }
            self.out
                .extend_from_slice(format!("{} {}\n", entries[at].0, end - at).as_bytes());
            for (_, offset) in &entries[at..end] {
                self.out
                    .extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
            }
            at = end;
        }
        let mut trailer = format!("trailer\n<< /Size {size} /Root {root} ");
        if let Some(info) = info {
            trailer.push_str(&format!("/Info {info} "));
        }
        trailer.push_str(&format!("/Prev {prev} >>\n"));
        self.out.extend_from_slice(trailer.as_bytes());
        self.out
            .extend_from_slice(format!("startxref\n{startxref}\n%%EOF\n").as_bytes());
        self.out
    }
}

/// In-use, generation-0 objects from a classic `xref` table.
fn parse_xref(section: &[u8]) -> BTreeMap<u32, usize> {
    let mut offsets = BTreeMap::new();
    let mut next: Option<u32> = None;
    for line in section.split(|byte| *byte == b'\n') {
        let fields: Vec<&[u8]> = line
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|field| !field.is_empty())
            .collect();
        match fields.as_slice() {
            [start, _count] => next = number(start),
            [offset, generation, kind] => {
                let id = next;
                if *kind == b"n" && number(generation) == Some(0) {
                    if let (Some(id), Some(offset)) = (id, number(offset)) {
                        if let Ok(offset) = usize::try_from(offset) {
                            offsets.insert(id, offset);
                        }
                    }
                }
                next = id.map(|id| id + 1);
            }
            _ => {}
        }
    }
    offsets
}

/// The final `startxref` keyword and the xref offset it points at. The caller
/// has already checked that the file ends with `%%EOF`.
fn last_startxref(bytes: &[u8]) -> Option<(usize, usize)> {
    let keyword = find_last(bytes, b"startxref")?;
    let value = skip(bytes, keyword + "startxref".len())?;
    Some((keyword, usize::try_from(uint(bytes, value)?.0).ok()?))
}

/// Offset of the value that follows `/{key}`, or `None` for an absent key. A
/// key name ends where the next name character starts: `/Font` must never
/// match `/FontDescriptor`.
fn field(dict: &[u8], key: &str) -> Option<(usize, usize)> {
    let needle = format!("/{key}");
    let mut from = 0usize;
    while let Some(offset) = dict[from..]
        .windows(needle.len())
        .position(|window| window == needle.as_bytes())
    {
        let key_at = from + offset;
        let end = key_at + needle.len();
        if !dict.get(end).is_some_and(u8::is_ascii_alphanumeric) {
            return Some((key_at, skip(dict, end)?));
        }
        from = end;
    }
    None
}

/// Indirect references of a `/Kids` or `/Contents` list, in document order.
fn references(bytes: &[u8], from: usize, close: u8) -> Option<Vec<(u32, u32)>> {
    let mut out = Vec::new();
    let mut at = from;
    loop {
        let pos = skip(bytes, at)?;
        if bytes.get(pos) == Some(&close) {
            return Some(out);
        }
        let (id, generation, end) = reference(bytes, pos)?;
        out.push((id, generation));
        at = end;
    }
}

/// `12 0 R` at `at`: object id, generation, and the offset past `R`.
fn reference(bytes: &[u8], at: usize) -> Option<(u32, u32, usize)> {
    let (id, after_id) = uint(bytes, skip(bytes, at)?)?;
    let (generation, after_generation) = uint(bytes, skip(bytes, after_id)?)?;
    let keyword = skip(bytes, after_generation)?;
    (bytes.get(keyword) == Some(&b'R')).then_some((id, generation, keyword + 1))
}

fn name(bytes: &[u8], at: usize) -> Option<&[u8]> {
    let value = bytes.get(at..)?.strip_prefix(b"/")?;
    let len = value
        .iter()
        .take_while(|byte| !byte.is_ascii_whitespace() && !b"/[]<>()".contains(byte))
        .count();
    (len > 0).then(|| &value[..len])
}

fn media_box(dict: &[u8]) -> Option<(f64, f64, f64, f64)> {
    let (_, open) = field(dict, "MediaBox")?;
    if dict.get(open) != Some(&b'[') {
        return None;
    }
    let (x0, at) = number_at(dict, open + 1)?;
    let (y0, at) = number_at(dict, at)?;
    let (x1, at) = number_at(dict, at)?;
    let (y1, _) = number_at(dict, at)?;
    Some((x0, y0, x1, y1))
}

/// Whole number at `at`, plus the offset past it.
fn uint(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
    let len = bytes
        .get(at..)?
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if len == 0 {
        return None;
    }
    Some((number(&bytes[at..at + len])?, at + len))
}

fn number_at(bytes: &[u8], at: usize) -> Option<(f64, usize)> {
    let len = bytes
        .get(at..)?
        .iter()
        .take_while(|byte| matches!(byte, b'0'..=b'9' | b'.' | b'-' | b'+'))
        .count();
    if len == 0 {
        return None;
    }
    std::str::from_utf8(&bytes[at..at + len])
        .ok()?
        .parse()
        .ok()
        .map(|value| (value, at + len))
}

fn number(bytes: &[u8]) -> Option<u32> {
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

fn skip(bytes: &[u8], at: usize) -> Option<usize> {
    let tail = bytes.get(at..)?;
    Some(
        at + tail
            .iter()
            .take_while(|byte| byte.is_ascii_whitespace())
            .count(),
    )
}

fn find_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

/// The dictionary that starts at or after `from`.
fn dict_at(bytes: &[u8], from: usize) -> Option<&[u8]> {
    let open = skip(bytes, from)?;
    Some(&bytes[open..dict_end(bytes, open)?])
}

/// Offset just past the `>>` closing the `<<` at `open`, so a `/Resources`
/// value that holds a `/Font` dictionary is not cut in half.
fn dict_end(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut at = open;
    while let Some(pair) = bytes.get(at..at + 2) {
        match pair {
            b"<<" => {
                depth += 1;
                at += 2;
            }
            b">>" => {
                depth = depth.checked_sub(1)?;
                at += 2;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => at += 1,
        }
    }
    None
}

/// The dictionary of `<id> <gen> obj`, or `None` for anything else.
fn object_dict(bytes: &[u8], offset: usize) -> Option<&[u8]> {
    let object = bytes.get(offset..)?;
    let (_, after_id) = uint(object, 0)?;
    let (_, after_generation) = uint(object, skip(object, after_id)?)?;
    let keyword = skip(object, after_generation)?;
    let open = skip(object, keyword + 3)?;
    object.get(keyword..)?.starts_with(b"obj").then_some(())?;
    object.get(open..)?.starts_with(b"<<").then_some(())?;
    Some(&object[open..dict_end(object, open)?])
}

#[cfg(test)]
#[path = "export_pdf_stamp_tests.rs"]
mod tests;
