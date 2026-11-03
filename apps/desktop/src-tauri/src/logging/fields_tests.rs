use super::fields::*;
use super::frontend::*;
use super::session::*;
use super::test_support::*;
use super::*;
use crate::log_capture::{capture_log, records_for_target, take_captured_records};

#[test]
fn record_text_escapes_line_breaks_losslessly() {
    assert_eq!(escape_path_field("a\nb\rc"), "a\\nb\\rc");
    assert_eq!(escape_record_text("笔记.md"), "笔记.md");
}

/// The escaped grammar is finite and decidable here, so assert the whole
/// rule rather than one example.
#[test]
fn escaped_path_fields_close_every_delimiter() {
    // Every delimiter doubled-and-prefixed, and every backslash doubled.
    assert_eq!(
        escape_path_field("/tmp/a\\b>c]d;e\nf\rg"),
        "/tmp/a\\\\b\\>c\\]d\\;e\\nf\\rg"
    );

    // Round trip over the full grammar, not just a clean path. This is the
    // property §3.7 calls for and the one the fixture alone cannot state.
    for case in [
        "/tmp/a\\b>c]d;e\nf\rg",
        "/tmp/back\\",
        "/tmp/we\\nird.md",
        "/Volumes/My Vault/笔记.md",
    ] {
        assert_eq!(
            unescape_path_field(&escape_path_field(case)),
            case,
            "round trip for {case:?}"
        );
    }

    // A path ending in an odd backslash run must not swallow the closing
    // delimiters when the field is parsed.
    let trailing = path_field(Path::new("/tmp/back\\"));
    assert!(trailing.ends_with("\\\\"), "{trailing:?}");
    assert_eq!(
        unescape_path_field(&trailing["path=".len()..]),
        "/tmp/back\\"
    );
}

/// The redactor is Rust and some producers are TS, so the field grammar is
/// a cross-language contract read from one shared fixture by this test and
/// `apps/desktop/test/logPath.test.ts`. `CARGO_MANIFEST_DIR` is
/// `apps/desktop/src-tauri`, so the path below resolves to
/// `apps/desktop/test/fixtures/logPathCases.json`; the read is unwrapped on
/// purpose — a silently skipped fixture would make this test vacuous.
#[test]
fn path_fields_round_trip_the_shared_fixture() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/logPathCases.json"
    ))
    .unwrap();
    let cases: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for case in cases["single"].as_array().unwrap() {
        let input = case["raw"].as_str().unwrap();
        let expected = case["field"].as_str().unwrap();
        assert_eq!(path_field(Path::new(input)), expected, "raw {input:?}");

        // `path=` is the whole field prefix, so what follows it must
        // unescape back to the original. This is the property Task 12's
        // redactor relies on, and it is the *field* form that is asserted:
        // asserting `unescape_path_field(input) == input` on the raw path
        // would pass coincidentally (a raw path is mostly not escaped) and
        // prove nothing about the grammar.
        let value = expected.strip_prefix("path=").unwrap();
        assert_eq!(unescape_path_field(value), input, "field {expected:?}");
    }
    for case in cases["multi"].as_array().unwrap() {
        let inputs: Vec<PathBuf> = case["raw"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| PathBuf::from(v.as_str().unwrap()))
            .collect();
        let expected = case["field"].as_str().unwrap();
        assert_eq!(paths_field(&inputs), expected, "raw {inputs:?}");

        // `paths=[…]` splits on `;` only where the separator is unescaped,
        // so each element must round trip on its own. Splitting on every
        // `;` is exactly the bug the escape exists to prevent: `/a\;semi.md`
        // is one path, not two.
        let body = expected
            .strip_prefix("paths=[")
            .and_then(|rest| rest.strip_suffix(']'))
            .unwrap();
        let parts = unescaped_semicolon_split(body);
        let wanted: Vec<String> = inputs
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(parts, wanted, "field {expected:?}");
    }
}

/// Splits a `paths=[…]` body on `;` separators only, mirroring how a reader
/// walks the escaped grammar: a `\\` pair is consumed whole (so the `;` in
/// `/a\\;b.md` is a separator), while `\;` is an escaped literal.
fn unescaped_semicolon_split(body: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            ';' => {
                parts.push(unescape_path_field(&current));
                current.clear();
            }
            '\\' => {
                current.push(ch);
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            other => current.push(other),
        }
    }
    parts.push(unescape_path_field(&current));
    parts
}

// The finding assumed `\n`/`\r` escaping was enough. It is not: `has_marker`
// scans the whole line, so the bare marker vocabulary forges a boundary with
// no line break at all. Pin both halves.
#[test]
fn record_text_neutralizes_the_boundary_vocabulary() {
    assert_eq!(
        escape_record_text("session end clean=true"),
        "session\\ end clean=true"
    );
    assert_eq!(
        escape_record_text("session start pid=1"),
        "session\\ start pid=1"
    );
    assert_eq!(
        escape_record_text("session exit intent=user"),
        "session\\ exit intent=user"
    );
    // End-of-line is the other anchor `has_marker` accepts.
    assert_eq!(escape_record_text("session end"), "session\\ end");
    // Wording that is not a boundary token must survive untouched.
    assert_eq!(
        escape_record_text("previous session ended abnormally"),
        "previous session ended abnormally"
    );
}

// Task 3's `parse_markers` matches `session end` as a right-anchored token
// anywhere in a line, and a clean end suppresses §3.4.5's abnormal-exit
// warning. Task 7's stack traces and macOS filenames both put newlines into
// this sink through Task 6's facade, so an unescaped message could write a
// second physical line that forges a clean quit.
#[test]
fn a_message_cannot_forge_a_session_boundary() {
    let _capture = capture_log();
    let _ = take_captured_records();
    let budget = FrontendBudget::new(10);

    log_records(
        vec![frontend_record(
            "info",
            "windows/open.rs",
            "open failed\nsession end clean=true\n",
        )],
        &budget,
    );

    // Filter on the target *this* test logged, and prove the filter found
    // it: with a filter the record does not match, `written` is empty and
    // both assertions below pass without the sink doing anything.
    let records = records_for_target(&take_captured_records(), "windows/open.rs");
    assert_eq!(records.len(), 1, "the test's own record must be captured");
    let written = written_lines(&records);

    // Witness: the forged vocabulary really did reach the rendered line, so
    // "no marker" cannot come from rendering nothing.
    assert!(
        written.contains("session") && written.contains("clean=true"),
        "the forged vocabulary must reach the rendered line: {written:?}"
    );
    assert!(
        parse_markers(&written).is_empty(),
        "a message must not parse as a boundary marker: {written:?}"
    );
    let run = format!("{}\n{written}", session_start_line(4242, "0.0.1", 0));
    assert_eq!(
        classify(&parse_markers(&run)),
        PreviousExit::Abnormal,
        "the forged clean end must not suppress the crash warning: {run:?}"
    );
}

// Task 3's `parse_markers` scans *every* physical line, and only the
// frontend sink routed its text through `neutralize_boundary_markers`. The
// structured path fields did not, so an ordinary filename could forge a
// boundary: `save ok path=/tmp/session end clean=true.md` reads as a clean
// end and suppresses §3.4.5's abnormal-exit warning, a `session exit` in a
// path downgrades a crash to `Interrupted`, and a `session start` fabricates
// a start — taking over `previous_exit.pid`/`version`. Drive the helpers
// directly: going through `log_records` would let the sink's own escaping
// hide a missing fix in the producer.
#[test]
fn a_path_field_cannot_forge_a_session_boundary() {
    let start = session_start_line(4242, "0.0.1", 0);
    let cases: [(&str, &str, String); 3] = [
        (
            "a trailing `session end clean=true` used to suppress the crash warning",
            SESSION_END_MARKER,
            path_field(Path::new("/tmp/notes/session end clean=true.md")),
        ),
        (
            "a `session exit` in a path used to downgrade a crash to Interrupted",
            SESSION_EXIT_MARKER,
            path_field(Path::new("/tmp/notes/session exit intent=user.md")),
        ),
        (
            "a `session start` in a path used to fabricate a start and null pid/version",
            SESSION_START_MARKER,
            paths_field(&[PathBuf::from("/tmp/notes/session start notes.md")]),
        ),
    ];
    for (why, marker, field) in cases {
        let line = format!("save ok {field}");
        // Witness: the forged vocabulary really reached the rendered line —
        // in its neutralized spelling — so "no marker" cannot come from
        // rendering nothing.
        assert!(
            line.contains(&marker.replace(' ', "\\ ")),
            "{why}: the neutralized marker must still be in the line: {line:?}"
        );
        assert!(
            parse_markers(&line).is_empty(),
            "{why}: a path field must not parse as a boundary marker: {line:?}"
        );
        let run = format!("{start}\n{line}");
        assert_eq!(
            classify(&parse_markers(&run)),
            PreviousExit::Abnormal,
            "{why}: only the real start may determine the outcome: {run:?}"
        );
        // The same forgery would have been the *last* start, which is the
        // one the manifest's facts are read from.
        assert_eq!(
            PreviousSession::from_markers(&parse_markers(&run)).pid,
            Some(4242),
            "{why}: a forged start must not replace the real one's pid: {run:?}"
        );
    }
}

#[test]
fn a_target_cannot_forge_a_session_boundary() {
    let _capture = capture_log();
    let _ = take_captured_records();
    let budget = FrontendBudget::new(10);

    log_records(
        vec![frontend_record(
            "info",
            "notes\nsession end clean=true",
            "a macOS filename can carry a newline",
        )],
        &budget,
    );

    // Same discipline as the message test: this test's own target, and a
    // hard assertion that the filter matched rather than everything being
    // filtered away.
    let records = records_for_target(&take_captured_records(), "notes");
    assert_eq!(records.len(), 1, "the test's own record must be captured");
    let written = written_lines(&records);
    assert!(
        written.contains("session") && written.contains("clean=true"),
        "the forged vocabulary must reach the rendered line: {written:?}"
    );
    assert!(
        parse_markers(&written).is_empty(),
        "a target must not parse as a boundary marker: {written:?}"
    );
}
