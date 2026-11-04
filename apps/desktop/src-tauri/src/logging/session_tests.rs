use super::session::*;
use super::test_support::*;
use super::*;
use crate::log_capture::{capture_log, take_captured_records};

#[test]
fn scan_does_not_call_an_old_opt_in_the_previous_session() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session start pid=1 version=0.0.1 mode=release generation=0\nsession end clean=true\n",
    );
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 1).outcome,
        PreviousExit::Unknown
    );
}

#[test]
fn fallback_scan_reads_the_previous_pid_file() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md-111.log",
        "session start pid=111 version=0.0.1 mode=release generation=2\n",
    );
    assert_eq!(
        scan_previous_fallback_session(dir.path(), "oh-my-md-222", 2).outcome,
        PreviousExit::Abnormal
    );
    assert_eq!(
        scan_previous_fallback_session(dir.path(), "oh-my-md-222", 3).outcome,
        PreviousExit::Unknown
    );
}

#[cfg(target_os = "macos")]
#[test]
fn webview_termination_is_an_error_only_before_exit_begins() {
    assert_eq!(webview_termination_level(false), log::Level::Error);
    assert_eq!(webview_termination_level(true), log::Level::Info);
}

#[test]
fn session_boundary_writers_emit_lines_the_scanner_reads_back() {
    let _capture = capture_log();
    let _ = take_captured_records();

    write_session_start(4242, "0.0.1", 0);
    note_clean_exit();
    let clean_quit = take_captured().join("\n");
    assert_eq!(
        classify(&parse_markers(&clean_quit)),
        PreviousExit::Clean,
        "got {clean_quit:?}"
    );

    for outcome in [
        PreviousExit::Clean,
        PreviousExit::Interrupted,
        PreviousExit::Abnormal,
        PreviousExit::Unknown,
    ] {
        log_previous_exit(outcome);
        let run = format!(
            "{}\n{}\n",
            session_start_line(4242, "0.0.1", 0),
            take_captured().join("\n")
        );
        assert_eq!(
            parse_markers(&run),
            vec![Marker {
                kind: MarkerKind::Start,
                clean: false,
                start: Some(SessionStartFacts {
                    pid: Some(4242),
                    version: Some("0.0.1".to_string()),
                    generation: 0,
                }),
            }],
            "{outcome:?} logged a line the scanner reads as a marker"
        );
    }
}

#[test]
fn read_tail_drops_the_partial_first_line_and_survives_split_utf8() {
    let dir = tempfile::tempdir().unwrap();
    // The seek start lands inside the ASCII filler, so the CJK line is
    // wholly inside the window; only the partial first line has to go.
    // `read_tail_drops_a_first_line_cut_inside_a_cjk_character` below
    // covers the boundary-lands-mid-character case.
    let filler = "x".repeat(LOG_TAIL_READ_BYTES as usize - 2);
    let body = format!("{filler}笔记.md\nsession end clean=true\n");
    let path = write_log(dir.path(), "oh-my-md.log", &body);
    let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
    assert!(tail.ends_with("session end clean=true\n"));
    assert!(
        !tail.starts_with('x'),
        "the partial first line must be dropped"
    );
}

// The boundary test above seeks 31 bytes into pure ASCII, so it never
// exercises the lossy half of trap 1. This one cuts 笔 in half.
#[test]
fn read_tail_drops_a_first_line_cut_inside_a_cjk_character() {
    let dir = tempfile::tempdir().unwrap();
    let limit = LOG_TAIL_READ_BYTES as usize;
    // 笔 occupies bytes 65535..65538, so the seek start (65536) is its
    // second byte and the tail opens on two orphaned continuation bytes.
    let body = format!(
        "{}笔记.md\n{}\nsession end clean=true\n",
        "x".repeat(limit - 1),
        "y".repeat(limit - 33)
    );
    let path = write_log(dir.path(), "oh-my-md.log", &body);
    assert_eq!(
        body.len(),
        limit * 2,
        "the fixture must straddle the boundary"
    );
    let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
    assert_eq!(
        tail,
        format!("{}\nsession end clean=true\n", "y".repeat(limit - 33)),
        "the partial line (and its replacement characters) must be dropped"
    );
}

#[test]
fn read_tail_reads_no_more_than_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let limit = LOG_TAIL_READ_BYTES as usize;
    // The start marker is far outside the window: a full-file read would
    // find it, a bounded tail read must not.
    let body = format!(
        "session start pid=1 version=0.0.1 mode=release\n{}\nsession end clean=true\n",
        "filler\n".repeat(limit)
    );
    let path = write_log(dir.path(), "oh-my-md.log", &body);
    assert!(body.len() > limit * 2);
    let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
    assert!(tail.ends_with("session end clean=true\n"));
    assert!(
        !tail.contains(SESSION_START_MARKER),
        "a marker outside the window must not be read"
    );
}

// The whole-file case never enters the partial-line path: the seek start
// is 0, so the first line is complete and must survive.
#[test]
fn read_tail_keeps_the_first_line_when_the_read_starts_at_offset_zero() {
    let dir = tempfile::tempdir().unwrap();
    let body = "session start pid=1 version=0.0.1 mode=release\nsession end clean=true\n";
    assert!((body.len() as u64) < LOG_TAIL_READ_BYTES);
    let path = write_log(dir.path(), "oh-my-md.log", body);
    assert_eq!(read_tail(&path, LOG_TAIL_READ_BYTES), body);
}

// The finding: the first line was dropped on *every* read that started above
// offset 0, including one whose 64 KiB boundary landed exactly on a line
// start. For a session split across the rotation boundary that silently
// discards the archive's `session start` (→ `Unknown`) — or its
// `session end clean=true` (→ `Abnormal`), the one outcome the design says
// must never happen on missing evidence. Offset 0 and a preceding `\n` both
// mean the first line is whole.
#[test]
fn read_tail_keeps_a_complete_first_line_at_a_line_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let limit = LOG_TAIL_READ_BYTES as usize;
    let head = format!("{}\n", "x".repeat(9));
    let first = "session start pid=7 version=0.0.1 mode=release\n";
    let filler = "y".repeat(limit - first.len());
    let body = format!("{head}{first}{filler}");
    let start = body.len() - limit;
    assert!(start > 0, "the premise: the read must start above offset 0");
    assert_eq!(
        body.as_bytes()[start - 1],
        b'\n',
        "the premise: the boundary must land exactly on a line start"
    );

    let path = write_log(dir.path(), "oh-my-md.log", &body);
    let tail = read_tail(&path, LOG_TAIL_READ_BYTES);
    assert_eq!(
        tail,
        format!("{first}{filler}"),
        "the complete first line must survive a boundary that lands on a line start"
    );
    assert!(
        parse_markers(&tail)
            .iter()
            .any(|marker| marker.kind == MarkerKind::Start),
        "the archived `session start` is the point of the window: {tail:?}"
    );
}

// Task 4 logs these human-readable determination lines into the same file,
// *after* the `session start` line (spec §3.4.5). "session exited" and
// "session ended" contain the "session exit"/"session end" markers as bare
// substrings, so a `contains` match invents markers that were never
// written. None of the three may parse.
#[test]
fn parse_markers_ignores_the_determination_lines() {
    let text = "previous session exited cleanly\n\
                previous session ended abnormally\n\
                previous session quit was interrupted\n";
    assert!(
        parse_markers(text).is_empty(),
        "determination lines must not be read as session markers"
    );
}

#[test]
fn newest_archive_is_lexicographically_last() {
    let dir = tempfile::tempdir().unwrap();
    write_log(dir.path(), "oh-my-md_2026-01-01_00-00-00.log", "old");
    write_log(dir.path(), "oh-my-md_2026-10-02_09-30-00.log", "new");
    write_log(dir.path(), "oh-my-md.log", "active");
    let found = newest_archive(dir.path(), "oh-my-md").unwrap();
    assert!(found.to_string_lossy().contains("2026-10-02"));
}

#[test]
fn classify_covers_every_row_of_the_determination_table() {
    use MarkerKind::*;
    assert_eq!(classify(&[]), PreviousExit::Unknown);
    assert_eq!(
        classify(&[Marker {
            kind: Start,
            clean: false,
            start: None
        }]),
        PreviousExit::Abnormal
    );
    assert_eq!(
        classify(&[
            Marker {
                kind: Start,
                clean: false,
                start: None
            },
            Marker {
                kind: End,
                clean: true,
                start: None
            },
        ]),
        PreviousExit::Clean
    );
    assert_eq!(
        classify(&[
            Marker {
                kind: Start,
                clean: false,
                start: None
            },
            Marker {
                kind: Exit,
                clean: false,
                start: None
            },
        ]),
        PreviousExit::Interrupted
    );
    // An unmatched End (start rotated out of both windows) is unknown,
    // never an accusation.
    assert_eq!(
        classify(&[Marker {
            kind: End,
            clean: true,
            start: None
        }]),
        PreviousExit::Unknown
    );
}

// A user-initiated quit writes *both* lines: the intent at
// `ExitRequested{code: None}` and the end at `RunEvent::Exit`. Reading
// only the marker immediately after the start would call every clean quit
// "interrupted".
#[test]
fn classify_lets_a_clean_end_win_over_an_earlier_exit_intent() {
    use MarkerKind::*;
    assert_eq!(
        classify(&[
            Marker {
                kind: Start,
                clean: false,
                start: None
            },
            Marker {
                kind: Exit,
                clean: false,
                start: None
            },
            Marker {
                kind: End,
                clean: true,
                start: None
            },
        ]),
        PreviousExit::Clean
    );
}

#[test]
fn scan_reports_clean_for_the_real_quit_sequence() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session start pid=1 version=0.0.1 mode=release\n\
         session exit intent=user\n\
         session end clean=true\n",
    );
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 0).outcome,
        PreviousExit::Clean
    );
}

#[test]
fn scan_merges_a_split_session_across_the_rotation_boundary() {
    let dir = tempfile::tempdir().unwrap();
    // The session outgrew 2 MiB and rotated mid-session: its start is in
    // the archive, its end in the active log. A single-file reader would
    // see an unmatched end and could only answer "unknown".
    write_log(
        dir.path(),
        "oh-my-md_2026-10-02_09-30-00.log",
        "session start pid=1 version=0.0.1 mode=release\n",
    );
    write_log(dir.path(), "oh-my-md.log", "session end clean=true\n");
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 0).outcome,
        PreviousExit::Clean
    );
}

#[test]
fn scan_reports_abnormal_when_a_later_start_has_no_exit() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md_2026-10-02_09-30-00.log",
        "session start pid=1 version=0.0.1 mode=release\n",
    );
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session end clean=true\nsession start pid=2 version=0.0.1 mode=release\n",
    );
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 0).outcome,
        PreviousExit::Abnormal
    );
}

// The path this feature exists for: run N−1 quits cleanly, so its log ends
// with the (debug-level) "previous session exited cleanly" determination
// line; run N scans it, writes `session start` plus the same line, then
// dies with no exit intent and no clean end (SIGKILL / segfault /
// force-kill). Parsing the determination line as a real `session exit`
// makes run N+1 report Interrupted at Info and suppresses the Abnormal
// warning the feature was built to raise.
#[test]
fn scan_reports_abnormal_for_a_crash_after_a_clean_run() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session start pid=1 version=0.0.1 mode=release\n\
         previous session exited cleanly\n",
    );
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 0).outcome,
        PreviousExit::Abnormal
    );
}

#[test]
fn scan_reports_clean_when_the_last_start_is_followed_by_a_clean_end() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session start pid=1 version=0.0.1 mode=release\nsession end clean=true\n",
    );
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 0).outcome,
        PreviousExit::Clean
    );
}

#[test]
fn scan_reports_interrupted_for_an_intent_without_an_end() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session start pid=1 version=0.0.1 mode=release\nsession exit intent=shutdown\n",
    );
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 0).outcome,
        PreviousExit::Interrupted
    );
}

#[test]
fn scan_reports_unknown_when_no_start_survives() {
    let dir = tempfile::tempdir().unwrap();
    write_log(dir.path(), "oh-my-md.log", "session end clean=true\n");
    assert_eq!(
        scan_previous_session(dir.path(), "oh-my-md", 0).outcome,
        PreviousExit::Unknown
    );
}

// Spec §3.8's `previous_exit` names the previous run's pid and version, and
// the line the scanner already classifies carries both
// (`session start pid=… version=…`). They must belong to the *same* start
// `classify` keys off: reporting one session's outcome beside another's pid
// is a fabricated fact in a support artifact.
#[test]
fn scan_retains_the_last_start_lines_pid_and_version() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session start pid=1 version=0.0.1 mode=release\n\
         session end clean=true\n\
         session start pid=4242 version=9.9.9 mode=release\n\
         session end clean=true\n",
    );
    let session = scan_previous_session(dir.path(), "oh-my-md", 0);
    assert_eq!(session.outcome, PreviousExit::Clean);
    assert_eq!(
        session.pid,
        Some(4242),
        "the last start is the one classified"
    );
    assert_eq!(session.version.as_deref(), Some("9.9.9"));
}

// The other half of the honesty rule: a start line without pid/version (a
// truncated or hand-edited record) answers `None`, which the manifest writes
// as null rather than inventing a value.
#[test]
fn scan_reports_no_facts_when_the_start_line_carries_none() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "oh-my-md.log",
        "session start\nsession end clean=true\n",
    );
    let session = scan_previous_session(dir.path(), "oh-my-md", 0);
    assert_eq!(session.outcome, PreviousExit::Clean);
    assert_eq!(session.pid, None);
    assert_eq!(session.version, None);
}

// The `Disabled` logging state hands the scanner an empty dir, and
// `Path::new("").join("oh-my-md.log")` is *relative*: a naive scan would read
// `./oh-my-md.log` from the process's working directory and report a
// determination sourced from a file this run never wrote. The scan target
// list is `None` there, which is what makes the CWD unreachable.
#[test]
fn scan_has_no_targets_when_the_log_directory_is_empty() {
    assert!(session_scan_files(Path::new(""), "oh-my-md").is_none());
    assert!(session_scan_files(Path::new("/tmp/logs"), "").is_none());
    assert_eq!(
        scan_previous_session(Path::new(""), "oh-my-md", 0).outcome,
        PreviousExit::Unknown
    );

    let dir = tempfile::tempdir().unwrap();
    let targets = session_scan_files(dir.path(), "oh-my-md").unwrap();
    assert_eq!(targets, vec![dir.path().join("oh-my-md.log")]);
}

// The destination is a three-state enum, and Task 12 prints its `kind` in
// `environment.txt` while serde puts the same word on the wire. Two
// spellings of one state is how Settings and a support reader end up
// disagreeing about the same run.
#[test]
fn destination_kind_matches_the_serialized_tag() {
    for destination in [
        LogDestination::Directory,
        LogDestination::Fallback,
        LogDestination::Disabled,
    ] {
        assert_eq!(
            serde_json::to_value(destination).unwrap()["kind"],
            destination.kind(),
            "{destination:?}"
        );
    }
}

// The manifest's `previous_exit.state` is machine-read, so the variant names
// are a wire format, not an implementation detail.
#[test]
fn previous_exit_serializes_as_the_manifest_state_and_reason() {
    for (outcome, state) in [
        (PreviousExit::Clean, "clean"),
        (PreviousExit::Interrupted, "interrupted"),
        (PreviousExit::Abnormal, "abnormal"),
        (PreviousExit::Unknown, "unknown"),
    ] {
        assert_eq!(serde_json::to_value(outcome).unwrap(), state);
        // The reason is the sentence the log carries; it must never be
        // empty, and it must never read as a boundary marker (see
        // `previous_exit_reason`).
        let reason = previous_exit_reason(outcome);
        assert!(!reason.is_empty(), "{outcome:?}");
        assert!(!has_marker(reason, SESSION_EXIT_MARKER), "{reason}");
        assert!(!has_marker(reason, SESSION_END_MARKER), "{reason}");
        assert!(!has_marker(reason, SESSION_START_MARKER), "{reason}");
    }
}

#[test]
fn previous_exit_levels_match_the_spec_table() {
    assert_eq!(level_for_exit(PreviousExit::Clean), None);
    assert_eq!(
        level_for_exit(PreviousExit::Interrupted),
        Some(log::Level::Info)
    );
    assert_eq!(
        level_for_exit(PreviousExit::Abnormal),
        Some(log::Level::Warn)
    );
    assert_eq!(
        level_for_exit(PreviousExit::Unknown),
        Some(log::Level::Info)
    );
}

#[test]
fn session_start_line_carries_pid_version_and_mode() {
    let line = session_start_line(4242, "0.0.1", 0);
    assert!(line.contains("pid=4242"));
    assert!(line.contains("version=0.0.1"));
    assert!(line.starts_with(SESSION_START_MARKER));
}

// Writer and reader are two halves of one contract, so a format change
// the scanner no longer recognizes must fail here instead of silently
// degrading every later determination.
#[test]
fn session_start_line_round_trips_through_the_scanner() {
    let text = format!("{}\n", session_start_line(4242, "0.0.1", 0));
    assert_eq!(
        parse_markers(&text),
        vec![Marker {
            kind: MarkerKind::Start,
            clean: false,
            start: Some(SessionStartFacts {
                pid: Some(4242),
                version: Some("0.0.1".to_string()),
                generation: 0,
            }),
        }]
    );
}

// The flag is the only in-memory evidence that a teardown was intended,
// and spec §3.4.4's termination hook exists to read it.
#[cfg(target_os = "macos")]
#[test]
fn exiting_state_starts_clear_and_stays_marked() {
    let state = ExitingState::default();
    assert!(!state.is_exiting());
    state.mark();
    assert!(state.is_exiting());
}
