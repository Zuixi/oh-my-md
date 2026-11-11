//! Minimal GCD one-shot scheduling used by the offscreen macOS exporter.
//!
//! `dispatch_after_f` avoids block ABI complexity while keeping callbacks on
//! the main queue, which is mandatory for WKWebView and NSWindow access.

use std::os::raw::c_void;

pub(super) type DispatchFunctionT = unsafe extern "C" fn(*mut c_void);
type DispatchQueueT = *mut c_void;
type DispatchTimeT = u64;

const DISPATCH_TIME_NOW: DispatchTimeT = 0;
const NSEC_PER_MSEC: i64 = 1_000_000;

extern "C" {
    // dispatch_get_main_queue() is a C macro expanding to (&_dispatch_main_q);
    // the linkable symbol is the global queue object itself.
    static _dispatch_main_q: c_void;
    fn dispatch_time(when: DispatchTimeT, delta: i64) -> DispatchTimeT;
    fn dispatch_after_f(
        when: DispatchTimeT,
        queue: DispatchQueueT,
        context: *mut c_void,
        work: DispatchFunctionT,
    );
}

/// Schedules `work` on the main queue after `delay_ms`. The context box is
/// owned by the dispatch: the trampoline reclaims it when the timer fires.
pub(super) fn dispatch_after(delay_ms: u64, context: *mut c_void, work: DispatchFunctionT) {
    unsafe {
        let when = dispatch_time(DISPATCH_TIME_NOW, (delay_ms as i64) * NSEC_PER_MSEC);
        let queue = (&raw const _dispatch_main_q).cast_mut().cast::<c_void>();
        dispatch_after_f(when, queue, context, work);
    }
}
