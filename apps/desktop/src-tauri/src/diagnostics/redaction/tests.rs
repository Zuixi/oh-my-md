use super::*;
use std::path::{Path, PathBuf};
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
