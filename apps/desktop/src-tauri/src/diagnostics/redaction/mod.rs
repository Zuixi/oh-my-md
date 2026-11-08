/// What a collapsed directory chain is replaced with (§3.7 rule 3). The string
/// is used as a field *value*, so it goes through `escape_path_field` when it
/// replaces one: the `>` reaches the bundle as `\>`, and unescaping the field
/// answers exactly `<path>/…/<basename>`.
const COLLAPSED_DIRECTORY: &str = "<path>/…/";

/// The two field prefixes the writer's grammar can produce, from
/// `LOG_PATH_FIELD_HELPERS` in `constants.ts`. `key=` deliberately does not
/// participate: Task 10 emits it only for a tab with no path, so it carries no
/// location to collapse.
const PATH_FIELD_PREFIX: &str = "path=";
const PATHS_FIELD_PREFIX: &str = "paths=[";

/// What replaces a stripped secret value (§3.7 rule 4).
const REDACTED: &str = "<redacted>";

// --- §3.7 export-time redaction -------------------------------------------------

/// Rule 1: the current user's home directory becomes `<home>`.
///
/// On Windows `home` *is* `C:\Users\<user>`, so the same literal replacement
/// covers the Windows profile. On another host a leaked Windows profile path is
/// collapsed whole by rule 5, which removes the user name as well.
fn replace_home(line: &str, home: &str) -> String {
    if home.is_empty() {
        line.to_string()
    } else {
        line.replace(home, "<home>")
    }
}

/// Rule 2: a `file:///` URL keeps only its basename (existing behavior, kept).
///
/// A URL carries no raw spaces — they are percent-encoded — which is what makes
/// the whitespace-delimited URL safe to delimit this way.
fn strip_file_urls(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("file:///") {
        result.push_str(&rest[..start]);
        let after_prefix = &rest[start + "file:///".len()..];
        let url_len = after_prefix
            .find(|c: char| c.is_whitespace())
            .unwrap_or(after_prefix.len());
        let url = &after_prefix[..url_len];
        result.push_str(url.rsplit('/').next().unwrap_or(url));
        rest = &after_prefix[url_len..];
    }
    result.push_str(rest);
    result
}

/// Rule 4: secret-shaped material is always stripped.
///
/// `Authorization:` takes the rest of the record: an HTTP header value has no
/// delimiter on a log line, and guessing one is how a token half-escapes. The
/// assignment form matches a whole name at a token boundary, so `monkey=` is
/// not mistaken for `key=`. Updater signing material is covered by the names the
/// updater itself uses (`TAURI_SIGNING_PRIVATE_KEY`, `..._KEY_PASSWORD`).
fn strip_secrets(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut index = 0usize;
    while index < line.len() {
        if let Some(after_header) = authorization_header_end(line, index) {
            out.push_str(&line[index..after_header]);
            // Keep the space between the colon and the value: dropping it turns
            // `Authorization: <redacted>` into a word the reader has to decode.
            let value_start = line[after_header..]
                .find(|ch: char| !ch.is_whitespace())
                .map(|offset| after_header + offset)
                .unwrap_or(after_header);
            out.push_str(&line[after_header..value_start]);
            out.push_str(REDACTED);
            return out;
        }
        if let Some((value_start, value_end)) = secret_assignment(line, index) {
            out.push_str(&line[index..value_start]);
            out.push_str(REDACTED);
            index = value_end;
            continue;
        }
        let ch = line[index..].chars().next().unwrap();
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

/// The index just past `Authorization:`, when a header starts at `index`.
fn authorization_header_end(line: &str, index: usize) -> Option<usize> {
    const HEADER: &str = "authorization:";
    let rest = line.get(index..)?;
    if rest.len() < HEADER.len() || !rest.is_char_boundary(HEADER.len()) {
        return None;
    }
    if !rest[..HEADER.len()].eq_ignore_ascii_case(HEADER) {
        return None;
    }
    Some(index + HEADER.len())
}

/// `NAME=VALUE` where `NAME` is secret-shaped: the span of `NAME=`'s value.
fn secret_assignment(line: &str, index: usize) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let first = *bytes.get(index)?;
    if !(first.is_ascii_alphanumeric() || first == b'_') {
        return None;
    }
    // The name must start at a token boundary, or the tail of `notakey=` would
    // be read as the secret name `key`.
    if index > 0 {
        let previous = bytes[index - 1];
        if previous.is_ascii_alphanumeric() || previous == b'_' {
            return None;
        }
    }
    let name_len = bytes[index..]
        .iter()
        .take_while(|byte| byte.is_ascii_alphanumeric() || **byte == b'_')
        .count();
    if !is_secret_name(&line[index..index + name_len]) || bytes.get(index + name_len) != Some(&b'=')
    {
        return None;
    }
    let value_start = index + name_len + 1;
    Some((value_start, secret_value_end(line, value_start)))
}

/// Whether a name is secret-shaped: `*_KEY`, `*_TOKEN`, `*_PASSWORD`, or the
/// bare word itself (`key=SECRET` on a line that does not spell out the prefix).
fn is_secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["key", "token", "password"].contains(&lower.as_str())
        || ["_key", "_token", "_password"]
            .iter()
            .any(|suffix| lower.ends_with(suffix))
}

/// The end of a secret value: a quoted value runs to its closing quote, anything
/// else to the next whitespace.
fn secret_value_end(line: &str, value_start: usize) -> usize {
    let Some(quote) = line[value_start..]
        .chars()
        .next()
        .filter(|ch| *ch == '"' || *ch == '\'')
    else {
        return line[value_start..]
            .find(char::is_whitespace)
            .map(|offset| value_start + offset)
            .unwrap_or(line.len());
    };
    let body_start = value_start + quote.len_utf8();
    let mut escaped = false;
    for (offset, ch) in line[body_start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return body_start + offset + ch.len_utf8();
        }
    }
    line.len()
}

/// Rules 3 and 5, which have to share one traversal of the line.
///
/// Rule 3 rewrites the structured `path=<…>` / `paths=[…]` fields, where the
/// boundaries are the writer's own grammar. Rule 5 sweeps the text *between*
/// those fields for paths a third-party line leaked.
///
/// They cannot be two independent string passes. Rule 5 recognises an absolute
/// path by its shape, so a preserved `path=/Volumes/…` field looks exactly like
/// leaked free text to it; running rule 5 over the whole line would re-collapse
/// the very fields `include_full_paths` exists to keep, making the opt-in a lie.
///
fn redact_paths(line: &str, home: &str, include_full_paths: bool) -> String {
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0usize;
    while let Some(field) = next_path_field(line, cursor) {
        out.push_str(&sweep_leaked_paths(&line[cursor..field.start]));
        out.push_str(&rewrite_path_field(line, &field, home, include_full_paths));
        cursor = field.end;
    }
    out.push_str(&sweep_leaked_paths(&line[cursor..]));
    out
}

/// A located structured field, with the span of its value.
struct PathField {
    /// The span the field occupies, prefix included.
    start: usize,
    end: usize,
    body: FieldBody,
}

enum FieldBody {
    /// `path=<value>`: the value's span.
    Single { start: usize, end: usize },
    /// `paths=[<body>]`: the span between the brackets.
    List { start: usize, end: usize },
}

/// The next structured field at or after `from`, or `None` when the rest of the
/// record holds none.
fn next_path_field(line: &str, from: usize) -> Option<PathField> {
    let bytes = line.as_bytes();
    let mut search = from;
    while search < line.len() {
        let single = line[search..]
            .find(PATH_FIELD_PREFIX)
            .map(|offset| search + offset);
        let list = line[search..]
            .find(PATHS_FIELD_PREFIX)
            .map(|offset| search + offset);
        let (start, is_list) = match (single, list) {
            (Some(single), Some(list)) if single < list => (single, false),
            (Some(_), Some(list)) => (list, true),
            (Some(single), None) => (single, false),
            (None, Some(list)) => (list, true),
            (None, None) => return None,
        };
        // The prefix must stand alone: `filepath=` is not a field, and neither
        // is the `path=` inside a word.
        if start == 0 || is_path_field_boundary(bytes[start - 1]) {
            return Some(if is_list {
                locate_list_field(line, start)
            } else {
                locate_single_field(line, start)
            });
        }
        search = start + 1;
    }
    None
}

/// Whether the byte before a field prefix ends the previous token.
fn is_path_field_boundary(previous: u8) -> bool {
    previous.is_ascii_whitespace()
        || matches!(
            previous,
            b'"' | b'\'' | b'`' | b'(' | b'[' | b'{' | b'=' | b':' | b',' | b';'
        )
}

/// The `path=<value>` field starting at `start`.
///
/// The grammar emits no closing delimiter for a single path, so the value runs
/// to the end of the record. The one producer that puts anything after it is the
/// recovery record's location-free `path=` followed by `key=…`, so a space
/// followed by another `name=` field ends the value.
fn locate_single_field(line: &str, start: usize) -> PathField {
    let value_start = start + PATH_FIELD_PREFIX.len();
    let value_end = single_value_end(line, value_start);
    PathField {
        start,
        end: value_end,
        body: FieldBody::Single {
            start: value_start,
            end: value_end,
        },
    }
}

/// The `paths=[…]` field starting at `start`.
fn locate_list_field(line: &str, start: usize) -> PathField {
    let body_start = start + PATHS_FIELD_PREFIX.len();
    match unescaped_index(line, body_start, ']') {
        Some(close) => PathField {
            start,
            end: close + 1,
            body: FieldBody::List {
                start: body_start,
                end: close,
            },
        },
        // A list with no closing bracket is not something the writer can emit.
        // Its body runs to the end of the record rather than being dropped.
        None => PathField {
            start,
            end: line.len(),
            body: FieldBody::List {
                start: body_start,
                end: line.len(),
            },
        },
    }
}

/// The end of a `path=` value: the end of the record, or the space before the
/// next `name=` field the record carries.
fn single_value_end(line: &str, value_start: usize) -> usize {
    let mut index = value_start;
    while index < line.len() {
        let ch = line[index..].chars().next().unwrap();
        if ch.is_whitespace() {
            let next = index + ch.len_utf8();
            if next_field_lookahead(&line[next..]) {
                return index;
            }
        }
        index += ch.len_utf8();
    }
    line.len()
}

/// Whether `text` begins another `name=` field.
///
/// Deliberately generic rather than special-casing the one producer: this
/// locator must not own another field's grammar.
fn next_field_lookahead(text: &str) -> bool {
    let name_len = text
        .bytes()
        .take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
        .count();
    name_len > 0 && text.as_bytes().get(name_len) == Some(&b'=')
}

/// Rewrites one located field: rule 3's collapse, or the field verbatim under
/// the opt-in. Splicing from the source keeps the prefix and the escaping in the
/// writer's own grammar rather than re-rendering them here.
fn rewrite_path_field(
    line: &str,
    field: &PathField,
    home: &str,
    include_full_paths: bool,
) -> String {
    if include_full_paths {
        return line[field.start..field.end].to_string();
    }
    match field.body {
        FieldBody::Single { start, end } => {
            match collapse_unescaped_path(&line[start..end], home) {
                Some(collapsed) => format!(
                    "{}{}{}",
                    &line[field.start..start],
                    crate::logging::escape_path_field(&collapsed),
                    &line[end..field.end]
                ),
                None => line[field.start..field.end].to_string(),
            }
        }
        FieldBody::List { start, end } => {
            let (body, changed) = rewrite_path_list(&line[start..end], home);
            if changed {
                format!(
                    "{}{}{}",
                    &line[field.start..start],
                    body,
                    &line[end..field.end]
                )
            } else {
                line[field.start..field.end].to_string()
            }
        }
    }
}

/// Unescapes a field value and collapses a non-home absolute path (rule 3).
///
/// The unescape comes first: the redactor is the reader of the grammar, and
/// `C:\\Users\\alice` is one path with escaped separators, not a relative path
/// that happens to contain backslashes.
fn collapse_unescaped_path(value: &str, home: &str) -> Option<String> {
    let unescaped = crate::logging::unescape_path_field(value);
    if !is_absolute_path_shape(&unescaped) || names_home(&unescaped, home) {
        return None;
    }
    Some(collapse_path(&unescaped))
}

/// Rewrites `paths=[…]`'s body: elements split on unescaped `;`, each collapsed
/// like a single field. `changed` is false when nothing was collapsed, so an
/// untouched field is re-emitted byte-for-byte.
fn rewrite_path_list(body: &str, home: &str) -> (String, bool) {
    let mut changed = false;
    let mut rewritten = String::with_capacity(body.len());
    for (index, element) in split_unescaped(body, ';').into_iter().enumerate() {
        if index > 0 {
            rewritten.push(';');
        }
        match collapse_unescaped_path(element, home) {
            Some(collapsed) => {
                changed = true;
                rewritten.push_str(&crate::logging::escape_path_field(&collapsed));
            }
            None => rewritten.push_str(element),
        }
    }
    (rewritten, changed)
}

/// Splits on `separator` where it is not escaped. The pieces keep their escape
/// sequences: this is a *locator*, and the escaper owns the grammar.
fn split_unescaped(text: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut escaped = false;
    for (index, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == separator {
            parts.push(&text[start..index]);
            start = index + ch.len_utf8();
        }
    }
    parts.push(&text[start..]);
    parts
}

/// The index of the first unescaped `needle` at or after `from`.
fn unescaped_index(text: &str, from: usize, needle: char) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in text[from..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == needle {
            return Some(from + index);
        }
    }
    None
}

/// The §3.7 export-time policy for one record.
///
/// Two orderings differ from the spec's numbering, both deliberate:
///
/// - **Rule 2 runs before rule 1.** Rule 1's literal substitution consumes the
///   home directory's leading `/`, so on `file:///Users/alice/a.png` it rewrites
///   the prefix to `file://<home>` and leaves rule 2 nothing to match — the URL
///   case of the §3.7 table would silently stop collapsing. The spec lists the
///   rules; it does not ask for an order in which one rule disables another.
/// - **Rule 4 runs before rules 3 and 5.** A secret is stripped from the bytes
///   the writer produced rather than from a string a collapse has already
///   rewritten. Neither order can leak — rule 4 removes the whole value — and
///   this one keeps every path rule operating on the grammar's own output.
///   Rules 3 and 5 are one traversal (`redact_paths`), and the sweep runs last,
///   as §3.7 describes: "a second ... scan over the remaining free text".
pub fn redact_line_with(line: &str, home: &str, include_full_paths: bool) -> String {
    let line = strip_file_urls(line);
    let line = replace_home(&line, home);
    let line = strip_secrets(&line);
    redact_paths(&line, home, include_full_paths)
}

/// [`redact_line_with`] with the policy the export ships by default.
///
/// `allow(dead_code)`: production states the policy explicitly at its one call
/// site (`redact_text_with`), so nothing in the bundle path wants the default by
/// name — but the redaction tests do, and they are the contract for what the
/// default means.
#[allow(dead_code)]
pub fn redact_line(line: &str, home: &str) -> String {
    redact_line_with(line, home, false)
}

/// [`redact_line_with`] over every line of a file. `include_full_paths` is the
/// §3.7 rule-3 opt-in the export command takes from the pre-export notice.
pub fn redact_text_with(text: &str, home: &str, include_full_paths: bool) -> String {
    text.lines()
        .map(|line| redact_line_with(line, home, include_full_paths))
        .collect::<Vec<_>>()
        .join("\n")
}

mod path_sweep;
use path_sweep::{collapse_path, is_absolute_path_shape, names_home, sweep_leaked_paths};
#[cfg(test)]
mod tests;
