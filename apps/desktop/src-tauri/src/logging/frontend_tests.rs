use super::frontend::*;
use super::test_support::*;
use super::{LOG_ERROR_BUDGET_PER_SEC, LOG_MAX_MESSAGE_CHARS};
use crate::log_capture::{capture_log, take_captured_records};

#[test]
fn distinct_errors_have_an_independent_bounded_reserve() {
    let _capture = capture_log();
    let _ = take_captured_records();
    let budget = FrontendBudget::new(1);
    let records = (0..LOG_ERROR_BUDGET_PER_SEC + 10).map(|i| error(&format!("fatal {i}")));
    log_records(records, &budget);
    let captured = take_captured_records();
    assert_eq!(
        frontend_records(&captured).len(),
        LOG_ERROR_BUDGET_PER_SEC as usize
    );
    assert_eq!(collapse_notices(&captured), ["10 log records collapsed"]);
}

#[test]
fn frontend_messages_are_bounded_before_escaping_and_writing() {
    let _capture = capture_log();
    let _ = take_captured_records();
    let budget = FrontendBudget::new(1);
    log_records([error(&"x".repeat(LOG_MAX_MESSAGE_CHARS * 2))], &budget);
    let records = frontend_records(&take_captured_records());
    let message = crate::logging::unescape_path_field(&records[0].message);
    assert!(message.encode_utf16().count() <= LOG_MAX_MESSAGE_CHARS);
    assert!(message.ends_with("[truncated]"));
}

#[test]
fn frontend_record_serializes_with_single_word_fields() {
    // The IPC wire format is a tested contract: TS types cannot catch
    // casing drift, and desktop tests mock services at the TS boundary.
    let record = FrontendRecord {
        level: "error".into(),
        target: "updates".into(),
        message: "boom".into(),
    };
    let json = serde_json::to_string(&record).unwrap();
    assert_eq!(
        json,
        r#"{"level":"error","target":"updates","message":"boom"}"#
    );
}

#[test]
fn unknown_levels_fall_back_to_info_rather_than_erroring() {
    assert_eq!(parse_level("nonsense"), log::Level::Info);
    assert_eq!(parse_level("ERROR"), log::Level::Error);
}

#[test]
fn budget_collapses_above_the_limit_instead_of_dropping() {
    let budget = FrontendBudget::new(2);
    assert!(budget.allow());
    assert!(budget.allow());
    assert!(!budget.allow());
    assert_eq!(budget.collapsed(), 1);
}

// The window rollover is what separates a per-second budget from a
// permanent wall: without it, `limit` records would be the whole run's
// allowance and every legitimate log after the first second would be
// collapsed.
#[test]
fn budget_refills_when_the_window_rolls_over() {
    let budget = FrontendBudget::new(1);
    assert!(budget.allow());
    assert!(!budget.allow());
    assert_eq!(budget.collapsed(), 1);
    std::thread::sleep(std::time::Duration::from_millis(1100));
    assert!(budget.allow(), "a new window must refill the budget");
    assert_eq!(
        budget.collapsed(),
        1,
        "collapsed is cumulative, not per window"
    );
}

// Spec §3.9's green channel: a warning storm that exhausts the budget must
// not take the fatal record with it. The budget is consulted *after* the
// level is parsed, so an `Error` never even reaches `allow` — that is also
// why it cannot count as a collapse.
#[test]
fn error_records_are_logged_even_when_the_budget_is_exhausted() {
    let _capture = capture_log();
    let _ = take_captured_records();
    let budget = FrontendBudget::new(1);
    log_records(vec![info("before"), info("over")], &budget);
    assert_eq!(budget.collapsed(), 1, "the second record must be collapsed");
    let _ = take_captured_records();

    log_records(vec![error("fatal")], &budget);
    let records = frontend_records(&take_captured_records());
    assert_eq!(records.len(), 1, "an Error must pass an exhausted budget");
    assert_eq!(records[0].level, log::Level::Error);
    assert_eq!(records[0].message, "fatal");
    assert_eq!(
        budget.collapsed(),
        1,
        "the bypass must neither collapse nor consume"
    );
}

// The other half of the green channel: because `Error` never calls
// `allow`, a burst of fatal records cannot starve the records below it.
#[test]
fn bypassed_errors_do_not_consume_the_non_error_allowance() {
    let _capture = capture_log();
    let _ = take_captured_records();
    let budget = FrontendBudget::new(2);
    log_records(vec![info("a")], &budget);
    let _ = take_captured_records();

    log_records(vec![error("e1"), error("e2"), error("e3")], &budget);
    let records = frontend_records(&take_captured_records());
    assert_eq!(records.len(), 3, "every Error must reach the logger");
    assert!(records.iter().all(|r| r.level == log::Level::Error));

    // "a" used one of the window's two slots; if the errors had consumed
    // any, "b" could not still pass.
    log_records(vec![info("b"), info("c")], &budget);
    let messages = frontend_messages(&take_captured_records());
    assert!(
        messages.contains(&"b".to_string()),
        "a non-error record must still pass after a burst of errors: {messages:?}"
    );
    assert!(
        !messages.contains(&"c".to_string()),
        "only the slot left by \"a\" was available: {messages:?}"
    );
    assert_eq!(budget.collapsed(), 1);
}

// `N log records collapsed`, not the spec's `N error records collapsed`:
// with the `Error` bypass above, layer 4 can no longer collapse an error,
// so the spec's wording would be false.
#[test]
fn collapse_notice_is_emitted_once_per_window_with_that_windows_count() {
    let _capture = capture_log();
    let _ = take_captured_records();
    let budget = FrontendBudget::new(2);

    log_records(vec![info("a"), info("b"), info("c"), info("d")], &budget);
    let records = take_captured_records();
    assert_eq!(
        collapse_notices(&records),
        vec!["2 log records collapsed"],
        "the window's first collapse must be reported with its count"
    );
    assert_eq!(frontend_messages(&records), ["a", "b"]);

    // Same window, more collapses: the notice slot is already spent, so a
    // caller that bypasses the frontend cannot rotate the log away.
    log_records(vec![info("e"), info("f")], &budget);
    let records = take_captured_records();
    assert!(collapse_notices(&records).is_empty());
    assert!(frontend_messages(&records).is_empty());

    // A new window gets a fresh notice, and the count is that window's —
    // not the run's running total (`collapsed()` is 6 by now).
    std::thread::sleep(std::time::Duration::from_millis(1100));
    log_records(vec![info("g"), info("h"), info("i"), info("j")], &budget);
    assert_eq!(budget.collapsed(), 6);
    let records = take_captured_records();
    assert_eq!(
        collapse_notices(&records),
        vec!["2 log records collapsed"],
        "second window, its own count"
    );
    assert_eq!(frontend_messages(&records), ["g", "h"]);
}
