//! The diagnostics bundle: what a support request gets, and what it must not.
//!
//! Spec: `docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md`
//! §3.7 (export-time redaction) and §3.8 (the bundle layout).

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::logging::{LogDestination, LogState, PreviousSession};

/// Layout version recorded in `manifest.json`. A support reader keys off this,
/// not off the file list it happens to find, so it is bumped whenever an entry
/// is added, removed, or changes shape.
const BUNDLE_FORMAT_VERSION: u64 = 1;

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

/// The prefix of `environment.txt`'s own log-directory line. Named once because
/// two readers depend on it agreeing with `log_dir_line`: the writer builds the
/// line with it, and `redact_environment_text` recognises the line it must not
/// hand to rule 5's free-text sweep.
const LOG_DIR_PREFIX: &str = "log_dir=";

/// What replaces a stripped secret value (§3.7 rule 4).
const REDACTED: &str = "<redacted>";

/// The runtime facts the writer cannot derive from the log directory.
///
/// A struct rather than four more parameters because these travel together: the
/// command reads them off managed state and the persisted blobs, and the tests
/// hand-build them so every §3.8 entry can be asserted byte-for-byte.
struct BundleContext<'a> {
    /// Task 11's three-state destination. `environment.txt` reports it as-is,
    /// including the `Disabled` state where no directory may be named.
    log_state: &'a LogState,
    /// Task 4's startup determination, and the pid/version of the start line it
    /// keyed off, summarized into `manifest.json`.
    previous_session: PreviousSession,
    /// The persisted settings blob, redacted into `settings.json`.
    settings_json: &'a str,
    /// The persisted session shards, redacted into `session.json`.
    session_json: &'a str,
}

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
/// `sweep_free_text` turns rule 5 off without reordering anything, for the one
/// caller whose text is entirely its own (`redact_environment_text`).
fn redact_paths(line: &str, home: &str, include_full_paths: bool, sweep_free_text: bool) -> String {
    let mut out = String::with_capacity(line.len());
    let mut cursor = 0usize;
    while let Some(field) = next_path_field(line, cursor) {
        if sweep_free_text {
            out.push_str(&sweep_leaked_paths(&line[cursor..field.start]));
        } else {
            out.push_str(&line[cursor..field.start]);
        }
        out.push_str(&rewrite_path_field(line, &field, home, include_full_paths));
        cursor = field.end;
    }
    if sweep_free_text {
        out.push_str(&sweep_leaked_paths(&line[cursor..]));
    } else {
        out.push_str(&line[cursor..]);
    }
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

/// Rule 5: a best-effort sweep for absolute paths in free text.
///
/// **This pass carries no guarantee.** Rules 1-4 are what the privacy claim
/// rests on: they operate on the structured fields and the secret shapes this
/// app itself writes. This one guesses where a path begins and ends in text the
/// app did not write, so it recognises the shapes a leak actually takes (a POSIX
/// root, a `\`-rooted or drive-letter Windows path, a UNC share, spaces, CJK,
/// quotes) and is expected to miss or overreach on adversarial input. A
/// privacy-critical case must never be moved behind it.
fn sweep_leaked_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0usize;
    while index < text.len() {
        if let Some(end) = leaked_path_end(text, index) {
            let run = &text[index..end];
            if is_collapsible_run(run) {
                out.push_str(&collapse_path(run));
            } else {
                out.push_str(run);
            }
            index = end;
            continue;
        }
        let ch = text[index..].chars().next().unwrap();
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

/// Whether a run may be replaced by [`collapse_path`]'s placeholder.
///
/// A control character ends the question. The sweep runs on text the app did
/// not write, and the placeholder keeps the run's basename, so a run carrying a
/// live LF/CR/tab would be re-emitted with that character still inside and
/// split the one-record-per-line contract `diagnostics.txt` promises. The
/// shape test alone accepts such a run, which is how a path with a real newline
/// reached the bundle. Refusing the collapse leaves the bytes exactly as they
/// arrived.
///
/// The `<home>` carve-out is the other half of the shape test: rule 1 has
/// already replaced the user's home with a placeholder, and re-collapsing the
/// remainder would delete the structure rule 1 deliberately kept.
fn is_collapsible_run(run: &str) -> bool {
    is_absolute_path_shape(run) && !run.contains("<home>") && !run.chars().any(char::is_control)
}

/// The end of the path-shaped run starting at `index`, or `None` when no run
/// starts there.
fn leaked_path_end(text: &str, index: usize) -> Option<usize> {
    if !run_starts_at(text, index) {
        return None;
    }
    let mut end = index;
    let mut cursor = index;
    while cursor < text.len() {
        let ch = text[cursor..].chars().next().unwrap();
        if ch.is_whitespace() {
            let next = cursor + ch.len_utf8();
            if !path_continues_after_space(text, index, end, next) {
                break;
            }
            cursor = next;
            continue;
        }
        if is_run_terminator(ch) {
            break;
        }
        cursor += ch.len_utf8();
        end = cursor;
    }
    (end > index).then_some(end)
}

/// Whether a path-shaped run can start at `index`.
///
/// Each shape is recognised explicitly rather than through `Path`: host
/// semantics would miss a Windows path on macOS (and the reverse), which is the
/// platform trap §3.7 names. The `\`-rooted and UNC forms are found without
/// looking at the host at all.
fn run_starts_at(text: &str, index: usize) -> bool {
    let bytes = text.as_bytes();
    let Some(first) = bytes.get(index).copied() else {
        return false;
    };
    if index > 0 && !is_run_boundary(bytes[index - 1]) {
        return false;
    }
    match first {
        // A `/` directly after `:` is a URL scheme separator: `https://host/a`
        // must not lose its host to a collapse.
        b'/' => !(index > 0 && bytes[index - 1] == b':') && has_path_body(text, index + 1),
        b'\\' => has_path_body(text, index + 1),
        // A drive letter. The token boundary above already rules out a letter
        // that continues a word, which is what keeps `https:` out: its `p` is
        // preceded by an alphanumeric.
        byte if byte.is_ascii_alphabetic() => {
            bytes.len() > index + 2
                && bytes[index + 1] == b':'
                && (bytes[index + 2] == b'\\' || bytes[index + 2] == b'/')
                && has_path_body(text, index + 3)
        }
        _ => false,
    }
}

/// Whether `from` begins a path component.
///
/// A root with nothing but whitespace after it is text, not a path: `separator
/// / alone` and `lone backslash \ here` must survive the sweep untouched, and
/// `C:\ end` is a drive root with no component.
fn has_path_body(text: &str, from: usize) -> bool {
    text[from..]
        .chars()
        .next()
        .is_some_and(|ch| !ch.is_whitespace() && !is_run_terminator(ch))
}

/// Characters a path may follow. `<` and `>` are deliberately absent, so the
/// `<home>` placeholder rule 1 writes never lets rule 5 re-scan the path after
/// it — that is what keeps `<home>/notes/a.md` intact while a collapsed
/// `<path>/…/a.md` stays stable under a second pass.
fn is_run_boundary(previous: u8) -> bool {
    previous.is_ascii_whitespace()
        || matches!(
            previous,
            b'"' | b'\'' | b'`' | b'(' | b'[' | b'{' | b'=' | b',' | b';' | b'|'
        )
}

/// Characters that end a path run.
fn is_run_terminator(ch: char) -> bool {
    matches!(
        ch,
        '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';' | '|'
    )
}

/// Whether a run continues across a space.
///
/// A path may contain spaces and a log record has no quoting to tell one from
/// prose. The heuristic: the space is inside the path when the next token
/// carries a separator (`Vault/sub/笔记.md`), or when what the run has so far
/// ends in a directory-looking component (`…/My Vault`). Best-effort by
/// construction — see `sweep_leaked_paths`.
fn path_continues_after_space(text: &str, start: usize, end: usize, next: usize) -> bool {
    if next >= text.len() {
        return false;
    }
    let token_end = text[next..]
        .find(|ch: char| ch.is_whitespace() || is_run_terminator(ch))
        .map(|offset| next + offset)
        .unwrap_or(text.len());
    if token_end == next {
        return false;
    }
    let token = &text[next..token_end];
    token.contains('/') || token.contains('\\') || !basename_of(&text[start..end]).contains('.')
}

/// Whether a value has the shape of an absolute path on either platform.
///
/// `Path::new("C:\\Users\\x").is_absolute()` is false on macOS, yet a macOS log
/// can legitimately carry a Windows path (a synced volume, a WSL mount), so the
/// host's `Path` cannot decide this.
fn is_absolute_path_shape(value: &str) -> bool {
    // Each shape also needs *something after* its root. A bare `/`, a lone `\`,
    // or an escaped `\n` (two characters of ordinary log text) has no directory
    // and no basename to keep: collapsing it would replace text rather than
    // redact a location.
    if let Some(rest) = value.strip_prefix("\\\\") {
        // UNC: `\\server\share\a.md`.
        return !rest.is_empty();
    }
    if let Some(rest) = value.strip_prefix('\\') {
        // Windows-rooted: a second separator is what makes it a path.
        return rest.contains('\\');
    }
    if let Some(rest) = value.strip_prefix('/') {
        return !rest.is_empty();
    }
    let bytes = value.as_bytes();
    bytes.len() > 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// Whether a path is, or has already been rewritten to, the home directory.
fn names_home(value: &str, home: &str) -> bool {
    value.contains("<home>") || (!home.is_empty() && value.starts_with(home))
}

/// §3.7 rule 3's placeholder for a path whose directories must not travel.
fn collapse_path(value: &str) -> String {
    format!("{COLLAPSED_DIRECTORY}{}", basename_of(value))
}

/// The final component, splitting on both separators: a Windows path must
/// collapse on a macOS host, and a POSIX path on a Windows host.
fn basename_of(value: &str) -> &str {
    value
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(value)
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
    redact_line_impl(line, home, include_full_paths, true)
}

/// [`redact_line_with`] with rule 5's free-text sweep switched off.
///
/// Only `environment.txt`'s own `log_dir=` line uses this: every rule that can
/// remove a location still runs, but the sweep cannot mistake the directory
/// this writer is deliberately naming for a third party's leak.
fn redact_line_fields(line: &str, home: &str, include_full_paths: bool) -> String {
    redact_line_impl(line, home, include_full_paths, false)
}

/// The §3.7 pipeline in its one order, with rule 5 switchable.
fn redact_line_impl(
    line: &str,
    home: &str,
    include_full_paths: bool,
    sweep_free_text: bool,
) -> String {
    let line = strip_file_urls(line);
    let line = replace_home(&line, home);
    let line = strip_secrets(&line);
    redact_paths(&line, home, include_full_paths, sweep_free_text)
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

// --- §3.8 the bundle -----------------------------------------------------------

fn os_summary() -> String {
    let os = os_info::get();
    format!("{} {} ({})", os.os_type(), os.version(), os.bitness())
}

/// The webview runtime's version (WKWebView / WebView2 / WebKitGTK).
///
/// Without it a support reader cannot separate a webview regression from an app
/// bug. Failure is not fatal: an unknown version is reported as such.
fn webview_version() -> String {
    tauri::webview_version().unwrap_or_else(|_| "unknown".to_string())
}

/// Unix epoch seconds. No date/time crate is a dependency, and an epoch is the
/// honest machine-readable value a reader can format itself.
fn generated_at() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// A string field of the persisted settings blob, when it is present and a
/// string. The settings shape is owned by TypeScript, so this is read-only and
/// total: anything unexpected answers `None`.
fn settings_string(settings_json: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

/// Whether the persisted blob carries exactly the boolean `true` for `key`.
fn settings_bool(settings_json: &str, key: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()
        .and_then(|value| value.get(key).and_then(serde_json::Value::as_bool))
        == Some(true)
}

/// The resolved log directory, or an explicit statement that there is none.
///
/// `LogState.dir` is empty in the `Disabled` state *because* no directory holds
/// this run's records. Printing `log_dir=` there would read as "your logs are at
/// <nothing>", the lie Task 11's three-state destination exists to prevent.
fn log_dir_line(state: &LogState) -> String {
    if state.destination == LogDestination::Disabled || state.dir.as_os_str().is_empty() {
        format!("{LOG_DIR_PREFIX}<none: file logging is disabled>")
    } else {
        format!("{LOG_DIR_PREFIX}{}", state.dir.display())
    }
}

/// `environment.txt`: the facts a maintainer would otherwise have to ask for
/// (§3.8). One `key=value` per line, greppable like the startup header, and it
/// records which redaction this bundle used.
fn environment_text(context: &BundleContext<'_>, include_full_paths: bool) -> String {
    let state = context.log_state;
    [
        format!("app_version={}", env!("CARGO_PKG_VERSION")),
        format!(
            "build={}",
            if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            }
        ),
        format!("webview_version={}", webview_version()),
        format!(
            "locale={}",
            settings_string(context.settings_json, "locale").unwrap_or_else(|| "unknown".into())
        ),
        // The level the process actually ran at, carried on the managed state.
        // Never `effective_level()`: that re-reads the persisted verbose flag,
        // which the Settings toggle writes immediately, so an export after a
        // mid-session change would name a level this run never used (§3.2).
        format!("log_level={}", state.level),
        format!("log_destination={}", state.destination.kind()),
        log_dir_line(state),
        format!("degraded={}", state.degraded),
        format!(
            "verbose_logging={}",
            settings_bool(
                context.settings_json,
                crate::logging::VERBOSE_LOGGING_SETTINGS_KEY
            )
        ),
        format!("full_paths_included={include_full_paths}"),
    ]
    .join("\n")
}

/// `environment.txt` with §3.7's policy applied.
///
/// Rule 5's free-text sweep is skipped for the writer's own `log_dir=` line.
/// That line names the directory the bundle's logs came from — it is written
/// here for the reader, not leaked by a third party — and the sweep reads any
/// absolute path as a leak, so a log directory outside home came back as
/// `log_dir=<path>/…/logs` and the one artifact whose job is to name the log
/// directory refused to name it. Rules 1-4 still apply, so a home-relative
/// directory stays readable as `log_dir=<home>/logs`.
fn redact_environment_text(text: &str, home: &str, include_full_paths: bool) -> String {
    text.lines()
        .map(|line| {
            if line.starts_with(LOG_DIR_PREFIX) {
                redact_line_fields(line, home, include_full_paths)
            } else {
                redact_line_with(line, home, include_full_paths)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The `*.log` files of `log_dir` that belong to `stem`: the active
/// `{stem}.log` and its `{stem}_<timestamp>.log` rotation archives, in a stable
/// order.
///
/// The stem filter is the privacy boundary, not tidiness. In
/// [`LogDestination::Fallback`] the directory is `std::env::temp_dir()` —
/// `/tmp` on Linux — so a stem-less sweep packs every unrelated application's
/// log, and whatever secrets it holds, into the user's support bundle. The
/// bundle's contract is privacy by default; only this writer's own files may
/// ship. The match is on the writer's own naming (`newest_archive`'s
/// `{stem}_` prefix and the plugin's `{stem}.log`), so a same-prefix foreign
/// name like `{stem}-notes.log` stays out too.
fn log_files(log_dir: &Path, stem: &str) -> Vec<PathBuf> {
    let mut log_files: Vec<PathBuf> = Vec::new();
    if stem.is_empty() || !log_dir.is_dir() {
        return log_files;
    }
    if let Ok(entries) = std::fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if !name.ends_with(".log") {
                continue;
            }
            let is_own = name == format!("{stem}.log") || name.starts_with(&format!("{stem}_"));
            if is_own {
                log_files.push(path);
            }
        }
    }
    log_files.sort();
    log_files
}

/// `manifest.json`, built from the entries that actually go into the zip.
///
/// The hashes are of the *redacted* bytes a reader can verify, not of the live
/// log, which never leaves the machine.
fn manifest_json(
    entries: &[(String, Vec<u8>)],
    context: &BundleContext<'_>,
) -> Result<String, String> {
    let files: Vec<serde_json::Value> = entries
        .iter()
        .map(|(name, bytes)| {
            serde_json::json!({
                "name": name,
                "size_bytes": bytes.len(),
                "blake3": blake3::hash(bytes).to_hex().to_string(),
            })
        })
        .collect();
    let manifest = serde_json::json!({
        "bundle_format_version": BUNDLE_FORMAT_VERSION,
        "generated_at": generated_at(),
        "app_version": env!("CARGO_PKG_VERSION"),
        "os": os_summary(),
        "arch": std::env::consts::ARCH,
        // The level carried on the managed state, not a fresh read of the
        // persisted flag — see `environment_text`.
        "log_level": context.log_state.level.to_string(),
        "files": files,
        // §3.4.5's determination, and the facts of the start line it keyed off.
        // The scanner retains the pid and version in the same traversal that
        // classified the line (`PreviousSession`), so these are read, not
        // guessed. `started_at` / `ended_at` stay null because there genuinely
        // is no source: the markers carry no timestamps and no time crate is a
        // dependency. Null there reads as "not recorded", which is the truth;
        // a fabricated value would be read as evidence.
        "previous_exit": {
            "state": context.previous_session.outcome,
            "reason": crate::logging::previous_exit_reason(context.previous_session.outcome),
            "started_at": serde_json::Value::Null,
            "ended_at": serde_json::Value::Null,
            "pid": context.previous_session.pid,
            "version": context.previous_session.version,
        },
    });
    serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())
}

fn write_diagnostics_bundle(
    path: &Path,
    log_dir: &Path,
    home: &str,
    include_full_paths: bool,
    context: &BundleContext<'_>,
) -> Result<(), String> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    entries.push((
        "version.txt".to_string(),
        env!("CARGO_PKG_VERSION").as_bytes().to_vec(),
    ));
    entries.push(("os.txt".to_string(), os_summary().into_bytes()));

    let mut combined = String::new();
    for log_path in log_files(log_dir, &context.log_state.file_stem) {
        let contents = std::fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
        let name = log_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("log")
            .to_string();
        let redacted = redact_text_with(&contents, home, include_full_paths);
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(&redacted);
        entries.push((name, redacted.into_bytes()));
    }
    entries.push(("diagnostics.txt".to_string(), combined.into_bytes()));

    // Every entry carries the same redaction, including the ones this task adds:
    // a settings blob or a session shard holds the same paths the logs do.
    // `environment.txt` goes through its own entry point because its `log_dir=`
    // line is the writer's own statement, not third-party free text.
    entries.push((
        "environment.txt".to_string(),
        redact_environment_text(
            &environment_text(context, include_full_paths),
            home,
            include_full_paths,
        )
        .into_bytes(),
    ));
    entries.push((
        "settings.json".to_string(),
        redact_text_with(context.settings_json, home, include_full_paths).into_bytes(),
    ));
    entries.push((
        "session.json".to_string(),
        redact_text_with(context.session_json, home, include_full_paths).into_bytes(),
    ));

    let manifest = manifest_json(&entries, context)?;

    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in &entries {
        zip.start_file(name.as_str(), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
    }
    // The manifest is written last and is not one of the files it lists: a hash
    // of itself cannot be computed, and a reader can tell the two apart.
    zip.start_file("manifest.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(manifest.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// The persisted session shards, raw.
///
/// Read as a file rather than through one window's shard: the bundle is a
/// whole-app artifact, and every shard holds only the paths a tab had open. A
/// missing or unreadable file answers `{}` — an export must never fail because
/// session restore has nothing to say.
fn session_json() -> String {
    std::fs::read_to_string(
        crate::workspace::config_dir().join(crate::workspace::SESSION_FILE_NAME),
    )
    .unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
pub async fn export_diagnostics(
    app: tauri::AppHandle,
    path: String,
    include_full_paths: bool,
) -> Result<(), String> {
    // Capture everything the zipper needs before leaving the IPC thread: a
    // `tauri::State` guard is not `Send`, and a command must not hold managed
    // state across the await.
    let (log_dir, destination, degraded, file_stem, level) = {
        let state = app.state::<LogState>();
        (
            state.dir.clone(),
            state.destination,
            state.degraded,
            state.file_stem.clone(),
            state.level,
        )
    };
    // A `PreviousSession` is not `Copy`, and a `tauri::State` guard must not be
    // held across the await, so the facts are cloned out here with the rest of
    // the managed state.
    let previous_session = app.state::<crate::logging::PreviousExitState>().0.clone();
    let target = PathBuf::from(&path);

    // Redacting and hashing every log is IO-bound, and this command runs on the
    // crash path it exists for: spawn_blocking keeps the main thread serving
    // IPC (AGENTS.md, "Sync-command trap").
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs::home_dir()
            .map(|home| home.to_string_lossy().into_owned())
            .unwrap_or_default();
        let log_state = LogState {
            degraded,
            dir: log_dir.clone(),
            file_stem,
            destination,
            level,
        };
        let settings_json = crate::workspace::get_settings().unwrap_or_else(|_| "{}".to_string());
        let session_json = session_json();
        let context = BundleContext {
            log_state: &log_state,
            previous_session,
            settings_json: &settings_json,
            session_json: &session_json,
        };
        write_diagnostics_bundle(&target, &log_dir, &home, include_full_paths, &context)?;
        // Boundary: the support bundle was written; only a successful export is
        // worth a line, since a failure already surfaces to the caller.
        log::info!("diagnostics export {}", crate::logging::path_field(&target));
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("diagnostics export task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::PreviousExit;
    use std::io::Read;

    /// A `LogState` in the healthy case: this run's records landed in `dir`.
    ///
    /// The level is a fixed value, not `effective_level()`: the bundle must
    /// report what `install()` resolved, and a helper that recomputed it could
    /// not tell the two apart.
    fn directory_state(dir: &Path) -> LogState {
        LogState {
            degraded: false,
            dir: dir.to_path_buf(),
            file_stem: "oh-my-md".to_string(),
            destination: LogDestination::Directory,
            level: log::LevelFilter::Info,
        }
    }

    /// The both-registrations-failed state: no directory holds this run's logs.
    fn disabled_state() -> LogState {
        LogState {
            degraded: true,
            dir: PathBuf::new(),
            file_stem: String::new(),
            destination: LogDestination::Disabled,
            level: log::LevelFilter::Info,
        }
    }

    fn context_for<'a>(
        state: &'a LogState,
        previous_exit: PreviousExit,
        settings_json: &'a str,
        session_json: &'a str,
    ) -> BundleContext<'a> {
        BundleContext {
            log_state: state,
            // Hand-built determinations carry no session facts; the bundled
            // end-to-end case is `bundle_manifest_carries_the_previous_session_pid_and_version`,
            // which drives the real scanner.
            previous_session: PreviousSession {
                outcome: previous_exit,
                pid: None,
                version: None,
            },
            settings_json,
            session_json,
        }
    }

    /// A bundle written to a real zip on disk and read back as bytes. Every
    /// assertion below reads the archive, not the writer's intentions.
    struct Fixture {
        _dir: tempfile::TempDir,
        bundle: PathBuf,
        logs: PathBuf,
        home: String,
        state: LogState,
    }

    impl Fixture {
        /// `home` holds the log directory, mirroring a real macOS layout, so
        /// rule 1's `<home>` substitution is observable in `environment.txt`.
        fn new(logs: &[(&str, &str)]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path().join("home");
            let log_dir = home.join("logs");
            std::fs::create_dir_all(&log_dir).unwrap();
            let home_str = home.to_str().unwrap().to_string();
            let fixture = Fixture {
                _dir: dir,
                bundle: home.join("bundle.zip"),
                logs: log_dir.clone(),
                home: home_str,
                state: directory_state(&log_dir),
            };
            for (name, contents) in logs {
                fixture.log(name, contents);
            }
            fixture
        }

        fn log(&self, name: &str, contents: &str) {
            std::fs::write(self.logs.join(name), contents).unwrap();
        }

        fn write(
            &self,
            previous_exit: PreviousExit,
            include_full_paths: bool,
        ) -> Vec<(String, Vec<u8>)> {
            self.write_state(&self.state, previous_exit, include_full_paths, "{}", "{}")
        }

        fn write_state(
            &self,
            state: &LogState,
            previous_exit: PreviousExit,
            include_full_paths: bool,
            settings_json: &str,
            session_json: &str,
        ) -> Vec<(String, Vec<u8>)> {
            let context = context_for(state, previous_exit, settings_json, session_json);
            write_diagnostics_bundle(
                &self.bundle,
                &self.logs,
                &self.home,
                include_full_paths,
                &context,
            )
            .unwrap();
            read_entries(&self.bundle)
        }

        /// Writes with a caller-supplied session record, so a test can feed the
        /// output of the real scanner straight into the real writer.
        fn write_session(
            &self,
            previous_session: PreviousSession,
            include_full_paths: bool,
        ) -> Vec<(String, Vec<u8>)> {
            let context = BundleContext {
                log_state: &self.state,
                previous_session,
                settings_json: "{}",
                session_json: "{}",
            };
            write_diagnostics_bundle(
                &self.bundle,
                &self.logs,
                &self.home,
                include_full_paths,
                &context,
            )
            .unwrap();
            read_entries(&self.bundle)
        }
    }

    fn read_entries(bundle: &Path) -> Vec<(String, Vec<u8>)> {
        let mut archive = zip::ZipArchive::new(std::fs::File::open(bundle).unwrap()).unwrap();
        let mut entries = Vec::new();
        for index in 0..archive.len() {
            let mut file = archive.by_index(index).unwrap();
            let name = file.name().to_string();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            entries.push((name, bytes));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries
    }

    fn entry<'a>(entries: &'a [(String, Vec<u8>)], name: &str) -> &'a [u8] {
        entries
            .iter()
            .find(|(entry_name, _)| entry_name == name)
            .map(|(_, bytes)| bytes.as_slice())
            .unwrap_or_else(|| {
                panic!(
                    "bundle has no {name}: {:?}",
                    entries
                        .iter()
                        .map(|(entry_name, _)| entry_name.as_str())
                        .collect::<Vec<_>>()
                )
            })
    }

    fn text_entry(entries: &[(String, Vec<u8>)], name: &str) -> String {
        String::from_utf8(entry(entries, name).to_vec()).unwrap()
    }

    fn json_entry(entries: &[(String, Vec<u8>)], name: &str) -> serde_json::Value {
        serde_json::from_str(&text_entry(entries, name)).unwrap()
    }

    /// §3.8's layout, as the closed set the writer must produce. A new entry is
    /// a deliberate change: it has to be added here *and* to the spec.
    const BUNDLE_ENTRIES: [&str; 8] = [
        "diagnostics.txt",
        "environment.txt",
        "manifest.json",
        "oh-my-md.log",
        "os.txt",
        "session.json",
        "settings.json",
        "version.txt",
    ];

    #[test]
    fn bundle_entries_are_a_closed_set() {
        let fixture = Fixture::new(&[("oh-my-md.log", "session end clean=true\n")]);
        let entries = fixture.write(PreviousExit::Clean, false);
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names, BUNDLE_ENTRIES,
            "the entry set is closed: a new file needs a §3.8 row and this list"
        );
        assert!(
            !names.iter().any(|name| name.contains("abnormal-exit")),
            "the previous-exit record lives in manifest.json, not its own file"
        );
    }

    #[test]
    fn bundle_manifest_hashes_the_redacted_bytes_it_lists() {
        let fixture = Fixture::new(&[]);
        let line = format!("opened {}/notes/a.md\n", fixture.home);
        fixture.log("oh-my-md.log", &line);
        let entries = fixture.write(PreviousExit::Clean, false);

        let manifest = json_entry(&entries, "manifest.json");
        let listed = manifest["files"].as_array().unwrap();
        let mut listed_names: Vec<&str> = listed
            .iter()
            .map(|file| file["name"].as_str().unwrap())
            .collect();
        listed_names.sort_unstable();
        let mut payload: Vec<&str> = entries
            .iter()
            .map(|(name, _)| name.as_str())
            .filter(|name| *name != "manifest.json")
            .collect();
        payload.sort_unstable();
        assert_eq!(
            listed_names, payload,
            "the manifest must list exactly the payload entries"
        );

        for file in listed {
            let name = file["name"].as_str().unwrap();
            let bytes = entry(&entries, name);
            assert_eq!(
                file["size_bytes"].as_u64().unwrap(),
                bytes.len() as u64,
                "{name} size"
            );
            assert_eq!(
                file["blake3"].as_str().unwrap(),
                blake3::hash(bytes).to_hex().as_str(),
                "{name} hash"
            );
        }

        // The hash is of the *redacted* bytes, which is what makes it
        // checkable by whoever receives the bundle.
        assert!(!text_entry(&entries, "oh-my-md.log").contains(&fixture.home));
    }

    #[test]
    fn bundle_manifest_carries_the_documented_shape_and_the_determination() {
        let fixture = Fixture::new(&[("oh-my-md.log", "session end clean=true\n")]);
        let entries = fixture.write(PreviousExit::Abnormal, false);
        let manifest = json_entry(&entries, "manifest.json");

        let mut keys: Vec<&str> = manifest
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "app_version",
                "arch",
                "bundle_format_version",
                "files",
                "generated_at",
                "log_level",
                "os",
                "previous_exit"
            ]
        );

        let exit = &manifest["previous_exit"];
        let mut exit_keys: Vec<&str> = exit
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        exit_keys.sort_unstable();
        assert_eq!(
            exit_keys,
            [
                "ended_at",
                "pid",
                "reason",
                "started_at",
                "state",
                "version"
            ]
        );
        assert_eq!(exit["state"], "abnormal");
        assert_eq!(
            exit["reason"],
            crate::logging::previous_exit_reason(PreviousExit::Abnormal)
        );
        // `started_at`/`ended_at` have no source at all — no marker carries a
        // timestamp and no time crate is a dependency — so they are pinned null.
        // `pid`/`version` are null *here* because this fixture hand-builds a
        // determination with no session line; the scanner does retain both when
        // there is a line, which the next test drives end to end.
        assert!(exit["started_at"].is_null());
        assert!(exit["ended_at"].is_null());
        assert!(exit["pid"].is_null());
        assert!(exit["version"].is_null());

        assert_eq!(manifest["bundle_format_version"].as_u64().unwrap(), 1);
        assert!(manifest["generated_at"].as_u64().unwrap() > 1_600_000_000);
        assert_eq!(manifest["app_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            manifest["log_level"],
            log::LevelFilter::Info.to_string(),
            "the manifest reports the level carried on LogState"
        );
    }

    // The finding: `environment_text`/`manifest_json` called `effective_level()`
    // at *export* time, which re-reads the persisted `verboseLogging` flag the
    // Settings toggle writes immediately. Enabling verbose mid-session and then
    // exporting produced a bundle claiming `Debug` while the process was still
    // filtering at `Info` — defeating §3.2's "a reader never has to guess what
    // was filtered". The level is resolved once in `install()` and carried on
    // `LogState`; flip the persisted setting after that and the bundle must not
    // move.
    #[test]
    fn bundle_reports_the_level_resolved_at_install_not_a_later_setting_change() {
        let _config_guard = crate::workspace::config_env_guard();
        let config = tempfile::tempdir().unwrap();
        std::env::set_var("OMD_CONFIG_DIR", config.path());

        // What install() resolved and handed to the plugin. Deliberately not a
        // value the fallback rules below can answer, so a recomputation is
        // observable rather than coincidentally equal.
        let resolved = log::LevelFilter::Trace;
        let mut state = directory_state(Path::new("/tmp/logs"));
        state.level = resolved;

        // The toggle persists immediately; this is the settings file a fresh
        // read at export time would see.
        crate::workspace::save_settings(format!(
            r#"{{"{}":true}}"#,
            crate::logging::VERBOSE_LOGGING_SETTINGS_KEY
        ))
        .unwrap();
        assert_ne!(
            crate::logging::effective_level(),
            resolved,
            "the premise: a fresh read answers a different level than install resolved"
        );

        let fixture = Fixture::new(&[]);
        let entries = fixture.write_state(&state, PreviousExit::Clean, false, "{}", "{}");
        let environment = text_entry(&entries, "environment.txt");
        assert!(
            environment.contains(&format!("log_level={resolved}")),
            "environment.txt must report the level the process ran at: {environment}"
        );
        assert_eq!(
            json_entry(&entries, "manifest.json")["log_level"],
            resolved.to_string()
        );
    }

    // The finding this closes: §3.8's `pid`/`version` were hardcoded nulls while
    // the line the scanner classifies already names both. Drive the *real*
    // scanner and the *real* writer so the two are proven threaded together —
    // a hand-built context could pass while production still dropped them.
    #[test]
    fn bundle_manifest_carries_the_previous_session_pid_and_version() {
        let fixture = Fixture::new(&[(
            "oh-my-md.log",
            "session start pid=4242 version=9.9.9 mode=release\n",
        )]);
        let session = crate::logging::scan_previous_session(&fixture.logs, "oh-my-md");
        assert_eq!(session.outcome, PreviousExit::Abnormal);
        assert_eq!(session.pid, Some(4242));
        assert_eq!(session.version.as_deref(), Some("9.9.9"));

        let manifest = json_entry(&fixture.write_session(session, false), "manifest.json");
        let exit = &manifest["previous_exit"];
        assert_eq!(exit["state"], "abnormal");
        assert_eq!(
            exit["pid"], 4242,
            "the manifest must carry the start line's pid, not a null"
        );
        assert_eq!(exit["version"], "9.9.9");
        // Still no timestamp source, and the nulls stay deliberate.
        assert!(exit["started_at"].is_null());
        assert!(exit["ended_at"].is_null());
    }

    #[test]
    fn bundle_environment_reports_the_disabled_destination_without_naming_a_directory() {
        let fixture = Fixture::new(&[]);
        let state = disabled_state();
        assert!(
            state.dir.as_os_str().is_empty(),
            "the premise: the disabled state has no directory to name"
        );
        let entries = fixture.write_state(&state, PreviousExit::Unknown, false, "{}", "{}");
        let environment = text_entry(&entries, "environment.txt");

        assert!(
            environment.contains("log_destination=disabled"),
            "{environment}"
        );
        let log_dir_line = environment
            .lines()
            .find(|line| line.starts_with("log_dir="))
            .expect("environment.txt must say where the logs went");
        assert_eq!(log_dir_line, "log_dir=<none: file logging is disabled>");
    }

    #[test]
    fn bundle_environment_names_the_resolved_directory_and_the_flags() {
        let fixture = Fixture::new(&[]);
        let settings = format!(
            r#"{{"locale":"zh","{}":true}}"#,
            crate::logging::VERBOSE_LOGGING_SETTINGS_KEY
        );
        let entries =
            fixture.write_state(&fixture.state, PreviousExit::Clean, false, &settings, "{}");
        let environment = text_entry(&entries, "environment.txt");

        assert!(
            environment.contains("log_destination=directory"),
            "{environment}"
        );
        let log_dir_line = environment
            .lines()
            .find(|line| line.starts_with("log_dir="))
            .unwrap();
        assert!(
            log_dir_line.starts_with("log_dir=<home>/"),
            "the log directory is under home and must be shown relative to it: {log_dir_line}"
        );
        assert!(!log_dir_line.contains(&fixture.home), "{log_dir_line}");
        assert!(environment.contains("locale=zh"), "{environment}");
        assert!(
            environment.contains("verbose_logging=true"),
            "{environment}"
        );
        assert!(environment.contains("degraded=false"), "{environment}");
        assert!(
            environment.contains("full_paths_included=false"),
            "{environment}"
        );
        assert!(environment.contains("webview_version="), "{environment}");
        assert!(environment.contains("log_level="), "{environment}");
    }

    // The one artifact whose job is to name the log directory must name it even
    // when it is outside home. The free-text sweep used to read that line as a
    // leaked path and answer `log_dir=<path>/…/logs`, so the bundle refused to
    // say where its own logs came from.
    #[test]
    fn bundle_environment_names_a_non_home_log_directory() {
        let fixture = Fixture::new(&[]);
        let state = directory_state(Path::new("/Volumes/ExVault/logs"));
        let entries = fixture.write_state(&state, PreviousExit::Unknown, false, "{}", "{}");
        let environment = text_entry(&entries, "environment.txt");

        let log_dir_line = environment
            .lines()
            .find(|line| line.starts_with("log_dir="))
            .expect("environment.txt must say where the logs went");
        assert_eq!(
            log_dir_line, "log_dir=/Volumes/ExVault/logs",
            "{environment}"
        );
        assert!(
            !environment.contains("<path>"),
            "the writer's own log_dir line must not be swept: {environment}"
        );
    }

    #[test]
    fn bundle_redacts_the_settings_and_session_entries() {
        let fixture = Fixture::new(&[]);
        let settings = format!(
            r#"{{"locale":"en","recentFolder":"/Volumes/My Vault/sub","lastOpened":"{}/notes/a.md"}}"#,
            fixture.home
        );
        let session =
            r#"{"version":2,"shards":{"main":{"openPaths":["/Volumes/Client Work/笔记.md"]}}}"#;
        let entries = fixture.write_state(
            &fixture.state,
            PreviousExit::Clean,
            false,
            &settings,
            session,
        );

        let settings_entry = text_entry(&entries, "settings.json");
        assert!(!settings_entry.contains("My Vault"), "{settings_entry}");
        assert!(!settings_entry.contains(&fixture.home), "{settings_entry}");
        assert!(
            settings_entry.contains("<home>/notes/a.md"),
            "{settings_entry}"
        );

        let session_entry = text_entry(&entries, "session.json");
        assert!(!session_entry.contains("Client Work"), "{session_entry}");
        assert!(session_entry.contains("笔记.md"), "{session_entry}");
    }

    #[test]
    fn bundle_with_the_opt_in_keeps_field_paths_and_still_strips_secrets() {
        let fixture = Fixture::new(&[]);
        // The field comes from the writer's helper and is followed by another
        // field on the same record, which is the shape the value-end lookahead
        // exists for.
        let line = format!(
            "save begin {} GITHUB_TOKEN=ghp_secret\n",
            crate::logging::path_field(Path::new("/Volumes/Vault/Client Work/a.md"))
        );
        fixture.log("oh-my-md.log", &line);

        let collapsed = text_entry(&fixture.write(PreviousExit::Clean, false), "oh-my-md.log");
        assert!(!collapsed.contains("Vault"), "{collapsed}");
        assert!(!collapsed.contains("ghp_secret"), "{collapsed}");

        let full = text_entry(&fixture.write(PreviousExit::Clean, true), "oh-my-md.log");
        assert!(
            full.contains("/Volumes/Vault/Client Work/a.md"),
            "the opt-in exists to make the bundle diagnosable: {full}"
        );
        assert!(
            !full.contains("ghp_secret"),
            "the opt-in is not a licence to ship secrets: {full}"
        );

        let environment = text_entry(
            &fixture.write_state(&fixture.state, PreviousExit::Clean, true, "{}", "{}"),
            "environment.txt",
        );
        assert!(
            environment.contains("full_paths_included=true"),
            "the bundle must record which redaction it used: {environment}"
        );
    }

    #[test]
    fn export_diagnostics_writes_zip_without_logs() {
        let fixture = Fixture::new(&[]);
        let entries = fixture.write(PreviousExit::Unknown, false);
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"version.txt"));
        assert!(names.contains(&"os.txt"));
        assert!(names.contains(&"diagnostics.txt"));
        assert!(fixture.bundle.exists());
    }

    // The finding: the bundle collected every `*.log` in the log directory, and
    // in the `Fallback` state that directory is `std::env::temp_dir()` — `/tmp`
    // on Linux. Unrelated applications' logs, and any secrets in them, shipped
    // inside the one artifact whose contract is privacy by default. The sweep is
    // now bounded by the resolved `file_stem`; this drives both destinations
    // through the real writer and reads the archive back.
    #[test]
    fn export_diagnostics_collects_only_the_resolved_stem_and_redacts_it() {
        let fixture = Fixture::new(&[]);
        let contents = format!(
            "opened {}/notes/a.md asset file:///{}/notes/a.png",
            fixture.home, fixture.home
        );
        fixture.log("oh-my-md.log", &contents);
        // A rotation archive is this writer's own file and ships too.
        fixture.log(
            "oh-my-md_2026-10-01_09-30-00.log",
            "session end clean=true\n",
        );
        // Foreign logs in the same directory, and one that merely shares the
        // stem's prefix.
        fixture.log("app.log", "SECRET=ghp_foreign_app\n");
        fixture.log(
            "other-app_2026-01-01_00-00-00.log",
            "SECRET=ghp_foreign_other\n",
        );
        fixture.log("oh-my-md-notes.log", "SECRET=ghp_foreign_prefix\n");

        let entries = fixture.write(PreviousExit::Clean, false);
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"oh-my-md.log"), "{names:?}");
        assert!(
            names.contains(&"oh-my-md_2026-10-01_09-30-00.log"),
            "a rotation archive belongs to the same writer: {names:?}"
        );
        for foreign in [
            "app.log",
            "other-app_2026-01-01_00-00-00.log",
            "oh-my-md-notes.log",
        ] {
            assert!(
                !names.contains(&foreign),
                "a foreign log must not ship: {foreign} in {names:?}"
            );
        }

        // The writer's own file is still redacted as before.
        let diagnostics = text_entry(&entries, "diagnostics.txt");
        assert!(diagnostics.contains("a.md"));
        assert!(diagnostics.contains("<home>/notes"));
        assert!(!diagnostics.contains(&fixture.home));
        assert!(
            !diagnostics.contains("ghp_foreign"),
            "no foreign bytes may reach the combined log: {diagnostics}"
        );

        // The fallback destination is the case the finding is about: its
        // directory is shared, so a *second instance's* file and an unrelated
        // application's must both stay out while this run's pid-suffixed stem
        // ships.
        fixture.log(
            "oh-my-md-1234.log",
            "session start pid=1234 version=0.0.1 mode=release\n",
        );
        fixture.log("oh-my-md-9999.log", "SECRET=ghp_other_instance\n");
        let fallback = LogState {
            degraded: true,
            dir: fixture.logs.clone(),
            file_stem: "oh-my-md-1234".to_string(),
            destination: LogDestination::Fallback,
            level: log::LevelFilter::Info,
        };
        let entries = fixture.write_state(&fallback, PreviousExit::Clean, false, "{}", "{}");
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert!(names.contains(&"oh-my-md-1234.log"), "{names:?}");
        for foreign in ["oh-my-md-9999.log", "app.log", "oh-my-md.log"] {
            assert!(
                !names.contains(&foreign),
                "the fallback directory is shared; {foreign} must not ship: {names:?}"
            );
        }
        assert!(
            !text_entry(&entries, "diagnostics.txt").contains("ghp_other_instance"),
            "a sibling instance's secrets must not ship"
        );
    }

    #[test]
    fn redact_line_replaces_home_path() {
        let out = redact_line("opened /Users/alice/notes/a.md", "/Users/alice");
        assert!(out.contains("<home>/notes/a.md"));
        assert!(!out.contains("/Users/alice"));
    }

    #[test]
    fn redact_line_strips_file_url_to_basename() {
        let out = redact_line("asset file:///Users/alice/a.png", "/Users/alice");
        assert!(out.contains("a.png"));
        assert!(!out.contains("file:///"));
        assert!(!out.contains("/Users/alice"));
    }

    #[test]
    fn redaction_collapses_outside_home_paths_and_strips_secrets() {
        let line = "open D:\\Vault\\Client Work\\a.md token=abc key=SECRET";
        let out = redact_line(line, "/Users/alice");
        assert!(!out.contains("Vault\\Client Work"), "got {out}");
        assert!(!out.contains("SECRET"));
        assert!(!out.contains("abc"), "got {out}");
    }

    #[test]
    fn redaction_handles_unc_and_volumes() {
        for line in [
            r"open \\server\share\a.md",
            "open /Volumes/My Vault/sub/笔记.md",
            r#"open "C:\Users\alice\My Notes\x.md""#,
        ] {
            let out = redact_line(line, "/Users/alice");
            assert!(
                out.contains("a.md") || out.contains("笔记.md") || out.contains("x.md"),
                "got {out}"
            );
            assert!(!out.contains("My Vault"));
            assert!(!out.contains("My Notes"));
            assert!(!out.contains("server"));
        }
    }

    #[test]
    fn redaction_covers_the_cross_platform_case_table() {
        // §3.7's table, asserted identically on every host. The shapes are
        // recognised explicitly because `Path` semantics follow the *host*:
        // `Path::new("C:\\Users\\x").is_absolute()` is false on macOS, while a
        // macOS log can legitimately carry a Windows path.
        let cases: [(&str, &[&str], &str, bool); 8] = [
            (
                r"open C:\Users\alice\notes\a.md",
                &["Users\\alice"],
                "a.md",
                true,
            ),
            (
                r"open D:\Vault\Client Work\a.md",
                &["Vault", "Client Work"],
                "a.md",
                true,
            ),
            (
                r"open \\server\share\a.md",
                &["server", "share"],
                "a.md",
                true,
            ),
            (
                "open /Volumes/My Vault/sub/笔记.md",
                &["My Vault", "sub"],
                "笔记.md",
                true,
            ),
            (
                r#"open "C:\Users\alice\My Notes\x.md""#,
                &["My Notes"],
                "x.md",
                true,
            ),
            (
                // A `file:///` URL carries no raw spaces (they are
                // percent-encoded), which is what lets rule 2 delimit the URL at
                // whitespace. It also runs before rule 1: otherwise the `<home>`
                // substitution would eat the prefix's third slash and the URL
                // would never be reduced (see `redact_line_with`).
                "asset file:///Users/alice/MyNotes/a.png",
                &["MyNotes"],
                "a.png",
                true,
            ),
            (
                r"C:\Users\alice\notes\a.md token=abc key=SECRET",
                &["alice"],
                "a.md",
                true,
            ),
            (
                // The control-character row: a raw path can carry a real
                // newline, and the sweep refuses such a run outright rather
                // than folding the newline into a placeholder. Nothing leaks
                // and nothing is claimed to be redacted, so the row is
                // `changed == false`.
                "opened /tmp/new\nline.md",
                &[],
                "new\nline.md",
                false,
            ),
        ];
        for (line, leaked, basename, changed) in cases {
            let out = redact_line(line, "/Users/alice");
            for secret in leaked {
                assert!(!out.contains(secret), "{line:?} leaked {secret:?}: {out}");
            }
            assert!(out.contains(basename), "{line:?} lost {basename:?}: {out}");
            assert_eq!(
                out != line,
                changed,
                "{line:?} -> {out:?}: the redactor changed the wrong rows"
            );
        }
    }

    #[test]
    fn redaction_collapses_structured_path_fields_after_unescaping() {
        // Built through the writer's own helper, so the redactor is pinned to
        // the grammar the producer emits, not to a hand-written copy of it.
        let path = PathBuf::from(r"C:\Users\alice\My Notes\a.md");
        let line = format!("save begin {}", crate::logging::path_field(&path));
        let out = redact_line(&line, "/Users/alice");
        assert!(!out.contains("My Notes"), "{out}");
        assert!(out.contains("a.md"), "{out}");
        // The placeholder is a field *value*, so the grammar's escaping applies
        // to it: unescaping the field answers §3.7's `<path>/…/<basename>`.
        let value = out.split("path=").nth(1).unwrap();
        assert_eq!(
            crate::logging::unescape_path_field(value),
            "<path>/…/a.md",
            "{out}"
        );
    }

    #[test]
    fn redaction_collapses_each_element_of_a_paths_field_and_keeps_home_paths() {
        // Again through the writer's helper: the list form's `[`/`;`/`]`
        // framing is the producer's, not this test's to guess.
        let paths = [
            PathBuf::from("/Volumes/My Vault/a.md"),
            PathBuf::from("/Volumes/Other/b.md"),
        ];
        let line = format!("reconcile {}", crate::logging::paths_field(&paths));
        let out = redact_line(&line, "/Users/alice");
        assert!(!out.contains("My Vault"), "{out}");
        assert!(!out.contains("Other"), "{out}");
        assert!(out.contains("a.md") && out.contains("b.md"), "{out}");

        // A home path keeps its structure, inside a field or out of it.
        let home_line = format!(
            "open {}",
            crate::logging::path_field(Path::new("/Users/alice/notes/a.md"))
        );
        let home_out = redact_line(&home_line, "/Users/alice");
        assert!(
            home_out.contains("path=<home>/notes/a.md"),
            "the field must not be collapsed twice: {home_out}"
        );
    }

    #[test]
    fn redaction_replaces_a_windows_profile_when_that_is_the_home_directory() {
        let out = redact_line(r"opened C:\Users\alice\notes\a.md", r"C:\Users\alice");
        assert!(out.contains(r"<home>\notes\a.md"), "{out}");
        assert!(!out.contains("alice"), "{out}");
    }

    #[test]
    fn redaction_strips_secret_shaped_values() {
        let out = redact_line(
            r#"token=abc key=SECRET GITHUB_TOKEN=ghp_x DB_PASSWORD="p@ss w" TAURI_SIGNING_PRIVATE_KEY=sig monkey=keep"#,
            "/Users/alice",
        );
        for secret in ["abc", "SECRET", "ghp_x", "p@ss", "sig"] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
        assert!(
            out.contains("monkey=keep"),
            "a name that merely contains `key` is not a secret: {out}"
        );
        assert!(out.contains("token=<redacted>"), "{out}");
        assert!(out.contains("key=<redacted>"), "{out}");

        // An `Authorization:` value has no delimiter on a log line, so the rest
        // of the record is what gets removed.
        let header = redact_line("GET /x Authorization: Bearer abc.def", "/Users/alice");
        assert!(!header.contains("abc.def"), "{header}");
        assert!(header.contains("Authorization: <redacted>"), "{header}");

        let lower = redact_line("authorization: Basic Zm9vYmFy", "/Users/alice");
        assert!(!lower.contains("Zm9vYmFy"), "{lower}");
    }

    #[test]
    fn redaction_is_idempotent_for_what_it_writes() {
        let line = r"save path=D:\Vault\Client Work\a.md token=abc";
        let once = redact_line(line, "/Users/alice");
        assert_eq!(
            redact_line(&once, "/Users/alice"),
            once,
            "a second export pass must not rewrite the first one's output"
        );
    }

    // A path can carry a real newline (macOS allows one in a file name; the
    // `logPathCases.json` newline row is that case). The writer escapes it, and
    // the redactor's field rewrite re-escapes its placeholder, so the field form
    // must never come back with a live LF — that would split the record.
    #[test]
    fn a_path_with_a_newline_round_trips_escaped_in_a_field() {
        let path = Path::new("/tmp/new\nline.md");
        let line = crate::logging::path_field(path);
        assert!(
            line.contains("\\n") && !line.contains('\n'),
            "premise: the writer escapes the newline: {line:?}"
        );

        let out = redact_line(&line, "/Users/alice");
        assert!(
            !out.contains('\n'),
            "the field must not inject a live newline into the bundle: {out:?}"
        );
        assert!(out.contains("\\n"), "{out:?}");
    }

    // Rule 5 guesses where a path starts and ends, so it must leave text that
    // merely *begins* like a path alone: replacing it would corrupt the record
    // for the reader the bundle exists to help, and collapse nothing.
    #[test]
    fn the_free_text_sweep_leaves_non_path_text_alone() {
        for line in [
            "separator / alone",
            "ratio / here",
            "lone backslash \\ here",
            "escaped newline line\\nnext",
            "escaped marker session\\ end",
            "escaped newline after space \\n here",
            "drive root C:\\ end",
            "scheme https://example.com/a/b",
        ] {
            assert_eq!(redact_line(line, "/Users/alice"), line, "{line:?}");
        }
    }

    // Rule 5 guesses at free text, and a raw path can carry a real newline,
    // carriage return, or tab. Collapsing such a run would fold the control
    // character into `<path>/…/<basename>` and split the record the bundle
    // promises, so the sweep refuses any run that carries one and leaves the
    // bytes exactly as they arrived.
    #[test]
    fn the_free_text_sweep_refuses_runs_that_carry_control_characters() {
        for line in [
            "opened /tmp/new\nline.md",
            "opened /tmp/new\rline.md",
            "opened /tmp/new\tline.md",
        ] {
            assert_eq!(redact_line(line, "/Users/alice"), line, "{line:?}");
        }
        // The discriminating half: the same path without a control character is
        // still swept, so the guard refuses the run rather than the rule.
        assert_eq!(
            redact_line("opened /tmp/newline.md", "/Users/alice"),
            "opened <path>/…/newline.md"
        );
    }
}
