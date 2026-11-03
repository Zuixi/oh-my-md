use super::session::marker_anchored_at;
use super::{SESSION_END_MARKER, SESSION_EXIT_MARKER, SESSION_START_MARKER};
use std::path::{Path, PathBuf};

/// Escapes a value for use inside a `path=<…>` / `paths=[…]` field (§3.7).
///
/// This is the one implementation of the field grammar: `\`, the field-closing
/// `>` and `]`, the `paths` separator `;`, and the record-splitting LF/CR. A
/// path carrying any of them is otherwise indistinguishable from the grammar
/// around it, so the field would truncate early and leak its remainder past the
/// export redactor.
///
/// Hand-written concatenation is forbidden for the same reason; the field
/// markers themselves are `LOG_PATH_FIELD_HELPERS` on the TS side and the
/// shared fixture is the cross-language contract.
///
/// [`escape_record_text`] routes record targets and messages through this too:
/// the log file is line-oriented, so an unescaped line break in either writes a
/// second physical line.
pub fn escape_path_field(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '>' => out.push_str("\\>"),
            ']' => out.push_str("\\]"),
            ';' => out.push_str("\\;"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            other => out.push(other),
        }
    }
    out
}

/// The exact inverse of [`escape_path_field`]: collapse each `\x` pair back to
/// the character it escaped, and treat a trailing lone `\` as a literal.
///
/// The redactor unescapes a located field with this before deciding what to
/// remove, so it must be total — an input the writer never produced still
/// answers a `String` rather than panicking mid-export.
///
/// `allow(dead_code)`: Task 12's redactor is the production reader; until it
/// lands only the tests below call this.
#[allow(dead_code)]
pub fn unescape_path_field(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('\\') => out.push('\\'),
            Some('>') => out.push('>'),
            Some(']') => out.push(']'),
            Some(';') => out.push(';'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            // Not an escape this grammar produces; keep both characters so a
            // hand-built or future-extended input is not silently mangled.
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Renders one path as a `path=<escaped>` field.
///
/// Two layers, and both are needed: [`escape_path_field`] keeps the path out of
/// the field/record grammar, and [`neutralize_boundary_markers`] keeps its
/// *content* from being read as a session boundary. A file named
/// `session end clean=true.md` is ordinary, and `parse_markers` scans every
/// physical line — without the second layer that filename alone forges a clean
/// quit and suppresses §3.4.5's abnormal-exit warning.
///
/// `allow(dead_code)`: the fence is the API boundary, not the call sites. The
/// save, export, and diagnostics lines consume [`path_field`] directly, while
/// [`paths_field`] is reached only where a watcher reconciles a path set; the
/// Rust and TypeScript guard tests assert both exist. Do not fold either into
/// `log_records`.
#[allow(dead_code)]
pub fn path_field(path: &Path) -> String {
    let escaped = escape_path_field(&path.to_string_lossy());
    format!("path={}", neutralize_boundary_markers(&escaped))
}

/// Renders a list as a `paths=[<escaped>;<escaped>]` field. `;` is escaped
/// inside each element, so the separator is unambiguous for a path containing
/// one. Boundary vocabulary is neutralized exactly as in [`path_field`].
/// `allow(dead_code)` for the same reason as [`path_field`].
#[allow(dead_code)]
pub fn paths_field(paths: &[PathBuf]) -> String {
    let joined = paths
        .iter()
        .map(|p| escape_path_field(&p.to_string_lossy()))
        .collect::<Vec<_>>()
        .join(";");
    format!("paths=[{}]", neutralize_boundary_markers(&joined))
}

/// Removes the session-boundary vocabulary from record text, by escaping the
/// space inside every marker token [`has_marker`] would accept
/// (`session end` → `session\ end`).
///
/// [`escape_path_field`] alone does **not** make a forged boundary impossible.
/// `has_marker` scans a whole line — it is mid-line matching that keeps the
/// determination lines ("previous session ended abnormally") from parsing — and
/// anchors on the character *after* the token. So
/// `open failed\nsession end clean=true\n` still forges a clean end even with
/// its newlines escaped, because `session end` is followed by a space. Removing
/// the anchored token is the only escaping that closes the hole: afterwards the
/// text cannot contain an accepted `session start` / `session exit` /
/// `session end` at any position.
///
/// Only anchored occurrences are touched, so wording that merely contains a
/// marker as a prefix ("session ended abnormally") survives byte-for-byte. The
/// escaping stays readable, in the same backslash style as §3.7.
fn neutralize_boundary_markers(text: &str) -> String {
    let mut neutralized = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((index, marker)) = first_anchored_marker(rest) {
        neutralized.push_str(&rest[..index]);
        neutralized.push_str(&marker.replace(' ', "\\ "));
        rest = &rest[index + marker.len()..];
    }
    neutralized.push_str(rest);
    neutralized
}

/// The earliest anchored boundary marker in `text`, with the marker it belongs
/// to. Anchors come from [`marker_anchored_at`], the same rule the scanner
/// classifies with.
fn first_anchored_marker(text: &str) -> Option<(usize, &'static str)> {
    let mut earliest: Option<(usize, &'static str)> = None;
    for marker in [
        SESSION_START_MARKER,
        SESSION_EXIT_MARKER,
        SESSION_END_MARKER,
    ] {
        let found = text
            .match_indices(marker)
            .map(|(index, _)| index)
            .find(|&index| marker_anchored_at(text, index, marker));
        if let Some(index) = found {
            if earliest.is_none_or(|(first, _)| index < first) {
                earliest = Some((index, marker));
            }
        }
    }
    earliest
}

/// Makes one frontend-supplied field safe to write into the line-oriented log:
/// one physical line, and no session-boundary vocabulary.
///
/// The line-break half is [`escape_path_field`], shared with the structured
/// path fields rather than reimplemented here (§3.7).
pub(super) fn escape_record_text(raw: &str) -> String {
    neutralize_boundary_markers(&escape_path_field(raw))
}
