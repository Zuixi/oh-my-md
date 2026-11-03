use super::COLLAPSED_DIRECTORY;

/// Rule 5: a best-effort sweep for absolute paths in free text.
///
/// **This pass carries no guarantee.** Rules 1-4 are what the privacy claim
/// rests on: they operate on the structured fields and the secret shapes this
/// app itself writes. This one guesses where a path begins and ends in text the
/// app did not write, so it recognises the shapes a leak actually takes (a POSIX
/// root, a `\`-rooted or drive-letter Windows path, a UNC share, spaces, CJK,
/// quotes) and is expected to miss or overreach on adversarial input. A
/// privacy-critical case must never be moved behind it.
pub(super) fn sweep_leaked_paths(text: &str) -> String {
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
pub(super) fn is_absolute_path_shape(value: &str) -> bool {
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
pub(super) fn names_home(value: &str, home: &str) -> bool {
    value.contains("<home>") || (!home.is_empty() && value.starts_with(home))
}

/// §3.7 rule 3's placeholder for a path whose directories must not travel.
pub(super) fn collapse_path(value: &str) -> String {
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
