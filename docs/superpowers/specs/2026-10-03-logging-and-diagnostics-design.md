# Logging and Diagnostics Design

**Date:** 2026-10-03

**Status:** Draft — awaiting review

**Scope:** Application logging, uncaught-error and panic capture, and the support
diagnostics bundle for packaged oh-my-md desktop applications

## 1. Goal

Make it possible to diagnose a failure that happened on someone else's computer,
without physical access to that computer and without asking the user to open a
terminal.

Today the application writes a log file, but the file cannot answer a diagnostic
question. The work is therefore not "add logging"; it is "make the existing log
worth reading" plus "close the three channels through which failures currently
escape without a trace."

Success is: a user reports "it lost my edits yesterday," and within one exchange
the maintainer holds a file that names the operation, the error, the app version,
and the OS.

## 2. Current state

Measured on the development machine on 2026-10-03, against `origin/main`
(`2c11ccc`).

### 2.1 The log file exists and is empty of signal

`~/Library/Logs/md.ohmy.desktop/oh-my-md.log` — 303 lines, 33,231 bytes, covering
2026-09-06 through 2026-10-02:

| Lines | Level | Source |
| ----- | ----- | ------ |
| 295 | TRACE | `tao::platform_impl::platform::*` |
| 4 | DEBUG | `tauri_runtime_wry` — `web content process terminated` |
| 4 | INFO | `omd_lib` — `app started 0.0.1` |
| 0 | WARN / ERROR | — |

The application's entire contribution to a month of logs is one sentence,
repeated four times, once per launch.

### 2.2 The Rust host logs at eight places

All eight are environment checks and startup recovery, in `lib.rs` (7),
`watcher.rs` (1), and `windows.rs` (1). No document open, save, rename, delete,
conflict, export, or update path logs anything. Every one of those paths can fail
in a way the user experiences as data loss, and none of them leaves a record.

### 2.3 The webview has no logging path at all

`apps/desktop/src` contains nine `console.*` call sites across four files. None
reach disk. In a packaged build there is no devtools, so every frontend error is
write-only. Two source comments name the gap directly:

- `apps/desktop/src/recoveryWriter.ts:38` — "the app has no logger yet"
- `apps/desktop/src/App.tsx:286` — "no structured logger yet"

The recovery writer is the component that saves drafts when a write fails. Its
failures are currently unobservable.

`tauri-plugin-log` is registered as a Rust plugin, but
`apps/desktop/src-tauri/capabilities/default.json` grants no `log:*` permission
and `@tauri-apps/plugin-log` is not a dependency.

### 2.4 No uncaught-error or panic capture

`window.onerror`, `unhandledrejection`, a React error boundary, and
`std::panic::set_hook` are all absent (verified count: 0). The Rust host contains
201 `.unwrap()` / `.expect()` call sites outside tests. A panic in a release
build therefore terminates the process and writes nothing to the log.

### 2.5 Two `tauri-plugin-log` defaults actively destroy evidence

Confirmed by reading the vendored crate source (`tauri-plugin-log` 2.x):

1. **`Builder::default()` sets `LevelFilter::Trace`, with no
   `#[cfg(debug_assertions)]` distinction.** This is the source of the 295 TRACE
   lines, and it applies to shipped release builds exactly as it does to
   `tauri dev`. There is no "it only looks bad locally" reading.
2. **`DEFAULT_MAX_FILE_SIZE = 40_000` and `DEFAULT_ROTATION_STRATEGY =
   RotationStrategy::KeepOne`.** `KeepOne` is implemented as
   `fs::remove_file(&self.path)` — the previous file is *deleted*, not archived.
   The live file is already at 33 KB. A busy editing day rotates it several
   times, and each rotation discards the only copy of the history. "It broke
   yesterday" is unanswerable by construction.

Two smaller defaults: `TimezoneStrategy::UseUtc` (a user reporting a 20:00 crash
appears as 12:00 in the log), and the absence of any level override for `tao`,
`wry`, or `notify`.

### 2.6 The diagnostics bundle exists but collects almost nothing

`apps/desktop/src-tauri/src/diagnostics.rs` implements `export_diagnostics`,
wired to a menu item ("导出诊断信息…" / "Export Diagnostics…") and a command
palette entry. The bundle contains `version.txt`, `os.txt`, each `*.log` file,
and a combined `diagnostics.txt`, all passed through `redact_text` (home
directory → `<home>`, `file:///` URLs → basename).

The mechanism is correct and worth keeping. Its inputs are the problem: it
redistributes the four `app started` lines. It does not include settings, session
state, the webview's state, or any record of a crash.

### 2.7 A log file that cannot be opened panics before the window appears

`tauri-plugin-log`'s `build()` runs its file open inside the plugin `setup`
closure and propagates the error with `?` (`lib.rs:840-855`). Tauri calls that
closure from `initialize_plugins(handle)?`, the last statement inside
`Builder::build()` (`tauri-2.11.5` `app.rs:2440`), and `lib.rs:1215` is
`.expect("error while building oh-my-md")`.

So an unopenable log file is not a degraded-logging situation the user can live
with — it is a **startup panic with no window and no message**. The triggers are
narrow but real: antivirus or an indexer transiently holding the handle on
Windows, a read-only log directory, a full disk, an unmounted home directory.

The mitigating factor is that `tauri-plugin-single-instance` is registered first
and `initialize_all` runs plugins in registration order via `try_for_each`
(`tauri` `plugin.rs:906-915`), exiting the duplicate process on Windows before
the log plugin's setup runs. Ordinary double-launch is therefore already covered;
the remaining exposure is the environmental cases above.

The same code path has a second half: an error returned from the *app-level*
`.setup()` hook is turned into `panic!("Failed to setup app: {e}")`
(`app.rs:1425-1426`). Any fix that moves work into setup inherits that trap —
§3.12 is built around both halves at once.

## 3. Decisions

### 3.1 One log file, two writers

Rust writes through the `log` crate facade. TypeScript writes through a narrow
`log_frontend` Tauri command into the same facade, so both sides land in one
file with one ordering and one rotation policy.

Rejected: enabling `@tauri-apps/plugin-log`'s JS API plus a `log:allow-log`
capability. It adds a dependency and a capability grant for what a small command
already does, and app-defined `invoke_handler` commands are not gated by the ACL
(existing commands such as `save_document` are absent from
`capabilities/default.json` and work), so the command path needs no capability
change at all.

Rejected: `TargetKind::Webview` / `attachConsole` to mirror the whole webview
console. It captures vendor noise indiscriminately and cannot attach a level or a
target to an application event. Explicit `window.onerror` /
`unhandledrejection` handlers cover the cases that matter with better structure.

### 3.2 Level policy is explicit and build-aware

| Build | Default | `level_for` → `Warn` | `level_for` → `Info` |
| ----- | ------- | -------------------- | -------------------- |
| debug | `Debug` | `tao`, `wry`, `notify`, `ignore`, `hyper`, `reqwest` | `tauri_runtime_wry`, `tauri_runtime` |
| release | `Info` | same | same |

`tauri_runtime_wry` stays at `Info`: `web content process terminated` is a
webview-crash signal and must survive into the shipped log. Note that this
requires listing `tauri_runtime_wry` explicitly — `level_for` matches whole
module-path prefixes, so a rule for the `wry` crate does **not** cover the
`tauri_runtime_wry` target.

The default is a compiled constant. It is overridden at runtime by the verbose
escape hatch (§3.5), and the effective level is written into the startup header
and the diagnostics manifest so a reader never has to guess what was filtered.

### 3.3 Rotation keeps history

- `max_file_size` = 2 MiB
- `rotation_strategy` = `KeepSome(5)` — a 10 MiB ceiling across six files
- `timezone_strategy` = `UseLocal`
- `file_open_strategy` = `Append` (existing default; logs survive restart)

With `tao` suppressed, 2 MiB is weeks of ordinary use. Five archived generations
mean a heavy day no longer erases the previous one. `KeepOne` is never used.

### 3.4 Failures are captured, not inferred

Five mechanisms, each covering a channel that currently produces silence:

1. **Rust panic hook.** Installed before the `tauri::Builder` chain in `run()`.
   Logs the panic message, `Location` (`file:line`), and thread name at `Error`,
   then calls the previous hook so default stderr output is preserved. The
   `file:line` is what identifies which of the 201 `unwrap()` sites fired, so
   this is sufficient without symbol-rich backtraces.
2. **Frontend global handlers dispatch immediately.** `window.onerror` and
   `unhandledrejection` are registered once at startup and bypass the facade's
   flush queue, issuing the `invoke` at once — the queue's timer is precisely
   what a dying webview never reaches. Today uncaught errors vanish entirely in
   packaged builds. The limit is worth stating plainly: Tauri v2 has no
   synchronous IPC (`@tauri-apps/api` `core.js` exposes only
   `async function invoke`), so this removes the timer delay but cannot
   *guarantee* delivery. §3.9 supplies the exit path that does.
3. **React error boundary.** Wraps the app, logs the error and component stack,
   and renders a recovery surface with an "Export Diagnostics" action. It must
   not swallow the error silently and must not replace the last-known-good
   document state.
4. **Webview process termination** uses Tauri's dedicated hook,
   `Builder::on_web_content_process_terminate`, rather than promoting a log
   level. The hook is macOS/iOS only — its own documentation says "Linux /
   Windows / Android: Unsupported" — so Windows and Linux fall back to
   correlating the `tauri_runtime_wry` `web content process terminated` line.
   The hook logs `Error` for the affected window **unless** the app is already
   in its exiting state (§3.4.5), in which case it logs `Info`: WebKit tears the
   content process down on a normal quit, and an ungated hook would report a
   crash on every clean exit. Whether the hook fires during normal teardown is
   **unverified** and is the first thing to confirm before this ships (§8).
5. **Abnormal-exit detection writes no marker file.** The session boundaries are
   already in the log stream — `app started {version}` at `lib.rs:1075` — so
   this design makes them a matched pair and reads it back, rather than adding a
   second artifact to keep in sync:

   | Written at | Line |
   | ---------- | ---- |
   | startup | `session start pid=<pid> version=<v> mode=<release-or-debug>` |
   | `ExitRequested{code: None}` | `session exit intent=<user-or-update-or-shutdown>` |
   | `RunEvent::Exit` | `session end clean=true` |

   `RunEvent::Exit` is the terminal event; the clean-exit line cannot be written
   in `ExitRequested`, because `app.exit(0)` skips it (noted at `lib.rs:186`).

   **Reading it back is bounded and merge-ordered.** Only the last 64 KiB of the
   active log and of the newest archive are read — enough for hundreds of lines,
   and bounded regardless of how retention is later configured. Two traps govern
   the implementation:

   - **Archives are `{stem}_{YYYY-MM-DD_HH-MM-SS}.log`**, produced by
     `rename_file_to_dated` (`tauri-plugin-log` `lib.rs:280-301`) — zero-padded,
     so lexicographic order is chronological. They are *not* numbered
     (`oh-my-md.1.log`).
   - **Seeking to `End(-65536)` can land mid-UTF-8-character.** The log contains
     CJK file paths, so this is not hypothetical. Decode lossily *and* drop the
     first (partial) line.

   Markers from the archive are older than markers from the active log, so the
   two tails are concatenated in that order and the rule is applied to the
   **merged** sequence: find the last `session start`, then look at what follows
   it.

   | What follows the last `session start` | Determination | Level |
   | ------------------------------------- | ------------- | ----- |
   | `session end clean=true` | clean exit | — |
   | `session exit intent=…` with no `session end` | quit was interrupted (macOS shutdown/logout force-kill) | `Info` |
   | nothing | abnormal termination | `Warn` |
   | no `session start` in either tail | unknown (rotated away, or first run) | `Info` |

   Merging matters: a session that outgrows 2 MiB rotates mid-session, leaving
   its `session start` in an archive and its `session end` in the active log.
   Reading only one file would see an unmatched `session end` — which is why the
   last row reports `unknown` rather than falling back to `abnormal`. The design
   never accuses on missing evidence.

   This works because `tauri-plugin-log` flushes on **every** record: `fern`'s
   `writer_log_impl!` calls `writer.flush()?` per line (`log_impl.rs:615`), and
   `RotatingFile::flush` performs `write_all` plus `file.flush()`
   (`lib.rs:310-330`). A line written before a panic, `SIGKILL`, or segfault is
   therefore already with the OS. Only power loss can drop the last lines, and
   that case lands in the unknown row instead of being misreported as a crash.

   The cost is that the record lives in a rotating file. With §3.3's retention
   the previous session's tail is essentially always present; when it is not,
   the answer is `unknown`, never an accusation. The exiting state also exists
   in memory (an `AtomicBool` set when `ExitRequested` arrives) so §3.4.4 can
   consult it without touching the disk.

A line-table-bearing release profile (`debug = 1`) is deliberately **not** part
of this design. It is only needed for symbolicated native crash reports, it costs
binary size, and §3.4.1 already recovers the identity of a Rust panic. Revisit
only if OS-level crash reports have to be symbolicated (see §8).

### 3.5 Verbose logging is reachable by a non-technical user

Primary path: a Settings toggle, "启用详细日志". It persists a flag, takes effect
at the next launch, and raises the level to `Debug`. It does **not** raise
retention: rotation is an unconditional `KeepSome(LOG_KEEP_FILES)` and
`effective_level()` never feeds it, so the retention boost described in earlier
drafts of this section was designed but not implemented.

Secondary path: the `OMD_LOG` environment variable, for maintainers. It is
parsed as a single `log::LevelFilter` name (`OMD_LOG=debug`, `OMD_LOG=trace`);
a filter list such as `tao=warn,omd=debug` is **not** a level and is ignored.
`OMD_LOG` beats the persisted flag when it names a valid level; anything else —
a filter list, a typo — falls through to the persisted flag and only then to the
build default. A typo is not an instruction to disable a persisted preference
(§3.2).

The Settings toggle is not a convenience. On macOS a user launching from Finder
cannot set an environment variable at all, so an env-var-only escape hatch is
unreachable for exactly the population that reports bugs.

### 3.6 Instrument boundaries, not internals

The rule: log at layer boundaries and state transitions. Never log keystrokes,
decoration rebuilds, scroll, or parse activity.

Rust: window create / close / route-open-file; document open, save begin and end
with duration, rename, delete, conflict detected, external change detected;
session flush transitions; update check, download, and install-gate blocked
reason; diagnostics export; and the `Err` arm of every Tauri command, so a
command that returns `Err` also leaves a line.

TypeScript: document save outcome, recovery-write failures, conflict and
normalization transitions, settings and session-restore failures, and IPC
rejections.

Every `log::` and `logger.*` call site introduced by this design is enumerated in
the plan (§9), not left to "log more."

### 3.7 The live log is local and full-fidelity; exports are redacted

File paths and document names are what make a log diagnosable, and the live log
never leaves the user's machine. Redaction is therefore an **export-time**
property, not a write-time one. This matches the existing code, where
`redact_text` is applied only by the bundle writer.

Paths are written as **structured fields**, not spliced into free text: boundary
call sites pass paths through a helper that renders them as an identifiable
`path=<…>` / `paths=[…]` field. Export then redacts *inside the field*, where the
boundaries are known, instead of guessing where a path starts and ends.

**The field grammar is a tested contract, and hand-written concatenation is
forbidden.** `format!("path={}", path)` must never appear: a path containing the
delimiter, a quote, or a newline would silently truncate the field and leak the
remainder past the redactor. Both sides expose one helper — a Rust macro and a
TS function with the same output — and the helpers escape:

| Input | Escaped |
| ----- | ------- |
| `\` | `\\` |
| `>` | `\>` |
| `]` | `\]` |
| `;` (inside `paths=[…]`) | `\;` |
| LF / CR | `\n` / `\r` |

The reader unescapes before redacting. A round-trip property test drives
arbitrary paths — including `"`, `>`, `]`, `;`, newline, spaces, and CJK —
through write-then-parse, on both sides.

Because the redactor is Rust while some producers are TS, the two sides must
agree on this grammar. Per the root `AGENTS.md` rule, that agreement is a
drift-guarded contract: **one shared fixture file of path cases** is consumed by
the Rust test and the TS test alike, and a source-grep test fails if a new
`path=`/`paths=` literal appears outside the helpers.

A naive global regex is not sufficient — it breaks on Windows drive letters, UNC
paths, and paths containing spaces or CJK. Nor can this be fixed by reaching for
`std::path::Path` alone, for two reasons: a `Path` can only be parsed once the
substring has been *located*, and `Path` semantics follow the **host** platform
— `Path::new("C:\\Users\\x").is_absolute()` is `false` on macOS, yet a macOS log
can legitimately contain a Windows path read from a synced volume.

Export-time policy, applied in this order:

1. Home directory → `<home>`; Windows user profile → `<home>`.
2. `file:///` URLs → basename (existing behavior, kept).
3. Non-home absolute paths **inside structured path fields**: the directory
   structure is collapsed to `<path>/…/<basename>`.
4. Always stripped: updater signing material, `*_KEY`, `*_TOKEN`, `*_PASSWORD`,
   `Authorization:` header values.
5. A second, `Path`-based scan over the remaining free text catches paths that
   third-party lines leak. This pass is explicitly **best-effort** and carries no
   guarantee — rules 1–4 are the ones the privacy claim rests on.

The bundle writer shows a pre-export notice naming what will be included.
There is **no** reachable "include full file paths" control in the shipped
build. The command's `include_full_paths` parameter is plumbed and tested, and
the TypeScript caller always passes `false`: the only UI seam available at the
time was an unlabelled `window.confirm`, whose OK button would silently have
meant "include full paths" — the privacy-invasive answer — so that question was
removed instead of shipping an inverted one. The parameter stays in place for a
labelled checkbox to drive when one exists. Privacy-by-default matters beyond
the home directory here: a Vault on an external drive or a NAS can carry project
names in its folder names, and paths therefore collapse on every export.

Rules 1–4 are covered by a cross-platform case table, tested identically on every
host: `C:\Users\…`, `D:\Vault\…`, `\\server\share\…`, `/Volumes/…`, paths with
spaces, paths with CJK, paths inside quotes, and `file:///` URLs.

Document content is never logged, by construction — no call site takes document
text as a field, and the log helpers accept structured fields only. This is
asserted by test, not by convention.

### 3.8 The diagnostics bundle becomes the support artifact

Zip layout (format version recorded in `manifest.json`):

| Entry | Content |
| ----- | ------- |
| `manifest.json` | bundle format version, generated-at, app version, OS/arch, log level in effect, per-file size + blake3, and `previous_exit` — the §3.4.5 determination as `{ state, reason, started_at, ended_at, pid, version }` (`started_at`/`ended_at` are `null`: no marker carries a timestamp, and a fabricated one would read as evidence) |
| `version.txt`, `os.txt` | kept as-is; existing tests and muscle memory depend on them |
| `diagnostics.txt` | combined redacted log; kept as-is |
| `<log>.log` | redacted per §3.7 |
| `environment.txt` | webview version, locale, dev/release, log directory path, enabled flags, log-degradation state (§3.9) |
| `settings.json` | user settings, redacted; never document content |
| `session.json` | session restore state, paths redacted |

The previous-exit record adds **no new entry**: it is summarized into
`manifest.json` and is already present in full inside the log streams, because
§3.4.5 records session boundaries as log lines. Likewise the degraded-logging
state is a field in `environment.txt`, not a file of its own.

Explicitly excluded: document content, version-history snapshots, and the updater
private key. `Cargo.toml` already depends on `zip`, `blake3`, and `os_info`, so
the manifest hashing and environment summary add no dependency.

Collecting OS-level crash reports (`~/Library/Logs/DiagnosticReports/` on macOS,
WER on Windows, `coredumpctl` on Linux) is deferred to Phase 2: the paths are
permission-sensitive, the formats differ per platform, and §3.4.4–3.4.5 cover
the common cases first.

### 3.9 Logging must never break editing, and must not lose its own tail

**Delivery on exit reuses the existing quit protocol.** The repository already
has a tested quit-time flush: `FlushGate` (`session_flush.rs`) with a 2s global
deadline, per-window acks, and a "a hung webview must never trap the user"
timeout. All four clean paths already go through it — `RunEvent::ExitRequested`
(`lib.rs:1213`), `WindowEvent::CloseRequested` (`lib.rs:1101`), `quit_app`
(`lib.rs:358`), and `prepare_update_restart` (`lib.rs:398`). The frontend handler
at `App.tsx:1081` already awaits in-flight work before acking; the log queue is
flushed in that same handler, **before** `sessionFlushAck()`, bounded by the
round's existing deadline.

No `beforeunload` handler is used. It cannot await an async `invoke`, `invoke`
has no synchronous form, and a webview killed by a panic never fires it anyway.

**Rate control, in four layers.** A queue cap alone does not bound IPC rate: a
sustained loop refills and re-flushes the queue indefinitely. Deduplication alone
does not either, since a loop can emit a *distinct* message every iteration.

| Layer | Mechanism | What it bounds |
| ----- | --------- | -------------- |
| 1 | Collapse consecutive identical `(target, level, message)` into `Last message repeated N times` | same-message loops |
| 2 | Token bucket, ≤50 records/s | steady rate |
| 3 | Circuit breaker: 1000 drops within 5s disables the facade for 30s, emitting exactly one summary line | worst case |
| 4 | Per-window record budget on the Rust `log_frontend` command | a wrong or bypassed frontend |

Layer 3 is the one that actually caps IPC; layers 1–2 only reduce the offered
load. Thresholds live in `constants.ts` (§3.10).

**`Error` has a green channel through layers 2, 3, and 4.** The scenario to
avoid: a misbehaving component spams warnings until the breaker opens, and the
*real* fatal record — `window.onerror`, `unhandledrejection`, the error
boundary, the Rust panic hook — lands inside the 30s silence and is swallowed.
The death certificate must not be collateral damage.

- Layers 2, 3, and 4 apply only **below** `Error`. An `Error` record is always
  offered to the IPC, including during the cooldown.
- Layer 1 (deduplication) still applies to `Error`. This is deliberate: a fatal
  error raised in a render loop would otherwise be an unbounded flood, and
  collapsing consecutive identical records loses no information.
- A bypassed `Error` does not count toward the breaker's drop thresholds, so a
  steady trickle of fatal records cannot keep the breaker pinned open.
- Layer 4 cannot be bypassed in the "unbounded" sense — it is the last line of
  defence against a caller that ignores the frontend entirely. It satisfies the
  green channel by **collapsing rather than dropping**: if the budget is
  exceeded, it emits one `N log records collapsed` line. The wording is `log
  records`, not `error records`: with the `Error` bypass above, layer 4 can no
  longer collapse an error at all, so an `error`-worded notice would be false.
  `Error` is never *silently* lost at any layer.
- When the breaker closes, it emits the suppressed count, so a reader can tell
  the log is incomplete rather than assuming nothing happened.

**Failures degrade; they never propagate.**

- Every facade path is wrapped, and a rejected `invoke` is swallowed after
  counting, so `logger.*` cannot throw into a caller. No save, open, or keystroke
  path ever awaits an `invoke`.
- If the log file cannot be opened, the application must still start. Today it
  does not: the plugin's `setup` returns its error through Tauri's
  `initialize_plugins(handle)?` inside `build()` (`tauri-2.11.5` `app.rs:2440`,
  the last statement before `Ok(app)`), which reaches `lib.rs`'s
  `.expect("error while building oh-my-md")` — so a failed log open **panics
  before any window appears**.
- The probe is a **write test, not a metadata check.** `fs::metadata(dir)` plus
  `permissions().readonly()` answers the wrong question on both platforms: on
  Windows the read-only attribute is not the NTFS ACL, and on Unix the mode bits
  say nothing about the effective uid, group, ACL, or a read-only mount. The
  probe therefore creates `.write_test_<pid>` in the target directory, writes a
  few bytes, flushes, and removes it, treating any failure — permission denied,
  disk full, missing directory — as a probe failure.
- On probe failure the design falls back to
  `TargetKind::Folder { path: temp_dir(), file_name: Some(<stem>-{pid}) }` while
  keeping the `Stdout` target. A sibling fallback next to the real log directory
  is explicitly rejected: the failure modes being defended against (read-only
  directory, full or unmounted volume) are exactly the ones that make the real
  directory unwritable. If the fallback *also* fails, the app runs with **no
  logger attached at all** — degraded, but started. Not `Stdout` only: the
  `Stdout` target lives inside the same plugin dispatch as the file target, so a
  plugin that never attaches writes neither. The three states are therefore
  `directory` / `fallback` / `disabled`, and the `disabled` copy says "this
  session is not being logged" rather than naming a path that will never exist.
- The probe is subject to TOCTOU between the test and the plugin's own open, so
  it reduces the risk rather than eliminating it. §3.12 is what makes the
  residual risk survivable.
- The degraded state is held in memory, surfaced in Settings, and recorded in the
  diagnostics bundle's `environment.txt` (§3.8). It is never silent.

### 3.10 New values get a named home

Per the root `AGENTS.md` constant rule, values that cross the TS ↔ Rust boundary
are defined on both sides and drift-guarded:

| Constant | Value | Home | Drift guard |
| -------- | ----- | ---- | ----------- |
| `LOG_MAX_FILE_BYTES` | 2 MiB | `constants.ts` + Rust | `crossLayerConstants.test.ts` |
| `LOG_KEEP_FILES` | 5 | same | same |
| `LOG_LEVEL_ENV_VAR` | `OMD_LOG` | same | same |
| `LOG_FRONTEND_COMMAND` | `log_frontend` | same | same |
| `DIAGNOSTICS_BUNDLE_FORMAT_VERSION` | 1 | same | same |
| `LOG_FRONTEND_BUDGET_PER_SEC` | 200 | same | same — it is the Rust-side safety net of §3.9 layer 4 and **must stay above** the TS rate limit below, or the net silently truncates legitimate logs |
| `SESSION_START_MARKER`, `SESSION_EXIT_MARKER` | see §3.4.5 | Rust only | — |
| `LOG_FALLBACK_FILE_STEM` | `<app>-{pid}` | Rust only | — |
| `LOG_TAIL_READ_BYTES` | 64 KiB | same | same — the Rust scanner and the TS-facing docs must not disagree |
| `LOG_PATH_FIELD_HELPERS` | `path=`, `paths=` | same | shared fixture (§3.7) |

Frontend-only rate control (§3.9 layers 1–3) lives in `constants.ts` with no
drift guard, because nothing on the Rust side reads it:

| Constant | Value |
| -------- | ----- |
| `LOG_RATE_LIMIT_PER_SEC` | 50 |
| `LOG_BREAKER_DROPS` | 1000 |
| `LOG_BREAKER_WINDOW_MS` | 5000 |
| `LOG_BREAKER_COOLDOWN_MS` | 30000 |
| `LOG_ALWAYS_PASS_LEVEL` | `error` |

`LOG_MAX_FILE_BYTES` and `LOG_KEEP_FILES` cross the boundary only for the
`crossLayerConstants.test.ts` drift guard; no UI reads them today (§7.2).

### 3.11 The `log_frontend` IPC contract

Payload: `{ records: [{ level, target, message }, …] }` — batched, one round trip
per batch; `level` is one of the five level names, `target` is a short module tag,
`message` is pre-formatted text. Return: `Result<(), String>`.

Per the root `AGENTS.md` IPC rules, a Rust test asserts the serialized JSON of
the payload: field casing drift compiles cleanly on both sides and only fails at
runtime, which is the documented trap that previously broke folder search.

### 3.12 Bootstrap order is constrained, and that is the whole trick

Moving the probe ahead of plugin registration has a consequence the obvious
implementation gets wrong: **`app_log_dir()` needs an `AppHandle`, which does not
exist before `build()`.** So the plugin cannot be probed-then-registered in the
builder chain.

Tauri supplies the way out. `AppHandle::plugin()` registers a plugin at runtime
and runs its `setup` immediately (`tauri-2.11.5` `app.rs:527-542`), and the
app-level `.setup()` hook runs on the event loop's `Ready` event
(`app.rs:1424-1427`) — long after `build()`'s plugin initialisation released the
plugin-store lock. So the log plugin is registered **from inside `.setup()`**,
where the `AppHandle` and therefore `app_log_dir()` are available. This is also
what makes the residual TOCTOU from §3.9 survivable: registration returns a
`Result` we can catch, so a race that loses the probe is a caught error instead
of a startup panic.

The order is load-bearing at every step:

1. **Install the panic hook** before `build()`. It logs through the `log` facade
   *and* chains to the default hook, so a panic before the logger exists still
   prints to stderr.
2. **`build()` without the log plugin.**
3. **In `.setup()`, first thing:** resolve `app_log_dir()`, run the write probe,
   build the log plugin with either the real `LogDir` target or the `temp_dir`
   fallback, and call `app.handle().plugin(...)`. On error, retry once with the
   fallback configuration; if that also fails, continue with no logger attached
   (`destination = disabled`).
4. **Never return `Err` from `.setup()` for a logging reason.** Tauri turns a
   setup failure into `panic!("Failed to setup app: {e}")` (`app.rs:1425-1426`),
   which is the same startup death this section exists to prevent — it would just
   have moved.
5. **Scan for the previous session's markers** (§3.4.5) *after* registration and
   *before* writing our own `session start`. After, because the plugin may rotate
   the file during its own initialisation, and reading a pre-rotation snapshot
   would be stale. Before, because writing our own `session start` first would
   make every scan find a start with no end — reporting an abnormal exit on every
   single launch.
6. **Write `session start`, then log the determination.**

Steps 3 and 5 also interact through the fallback: the scan must read whichever
directory step 3 actually chose, so the resolved path is carried forward as state
rather than recomputed.

Two accepted costs. The logger is installed slightly later than today, so records
emitted by other plugins' setup hooks and anything before step 3 reach stderr
only — acceptable, since that window contains exactly the `tao`/`wry` traffic
§3.2 suppresses. And the config windows are created before the setup hook runs
(`app.rs:2524-2526`), so the window exists marginally before the logger does.

## 4. Non-goals

- No telemetry, no automatic upload, no Sentry/Crashpad, no remote crash
  reporting, no log-shipping endpoint.
- No structured JSON log format. The consumer is a human reading one file on a
  local machine; JSON is an answer to a problem this design does not have.
- No performance tracing, spans, or OpenTelemetry instrumentation.
- No logging from `packages/engine`. The engine stays framework-independent and
  silent; the desktop host logs at its boundary on the engine's behalf.
- No in-app log viewer.
- No per-document or per-workspace log routing.
- No symbolicated native crash reports (see §3.4 and §8).
- No change to what is written to stdout during `tauri dev`, beyond the level
  change in §3.2.

## 5. Architecture

```
TS call sites
  └─ logger.ts facade  (level filter, bounded queue, never throws)
       └─ invoke("log_frontend", { level, target, message })
            └─ Rust log_frontend command
                 └─ log::log!(target, level, ...)
                      └─ tauri-plugin-log  ──┬─ Stdout target
Rust call sites ──────► log::info!/warn!…   └─ LogDir target
                                               (~/Library/Logs/md.ohmy.desktop/oh-my-md.log)
```

Both writers converge on one `tauri-plugin-log` dispatch, so filtering, rotation,
timestamping, and redaction have a single implementation.

Dev-mode convenience: the TypeScript facade also mirrors to `console.*` when
`import.meta.env.DEV`, so existing devtools workflows are unchanged.

## 6. Where logs live

From the `TargetKind::LogDir` platform table:

| Platform | Path |
| -------- | ---- |
| macOS | `~/Library/Logs/md.ohmy.desktop/` (no `logs/` subdirectory) |
| Windows | `%LOCALAPPDATA%\md.ohmy.desktop\logs\` |
| Linux | `~/.local/share/md.ohmy.desktop/logs/` |

Only the macOS path is discoverable by a normal user. The Windows and Linux
paths are buried in AppData and XDG data directories, which is why §7.2 exists.

## 7. User-facing surface

### 7.1 Menu additions

- "打开日志目录" — reveal the log directory in Finder / Explorer / the Linux file
  manager. This is the single most-requested support action.
- "导出诊断信息…" — existing; unchanged entry point, richer bundle.

Placement is per platform, not a single "Help" home. On macOS the native menubar
is app/File/Edit/Format/View/Window only (`menu.rs:371-380`), and both items live
in the app submenu ("oh-my-md"), between "Check for Updates" and Settings
(`menu.rs:468-481`). Off macOS the in-app menubar has no app submenu, so the
`menuTree.ts` Help section carries them. User-facing wording:
`docs/guides/troubleshooting.md`.

Both also get command palette entries; `export-diagnostics` already has one in
`App.tsx`.

### 7.2 Settings

- "启用详细日志" toggle, with a one-line explanation of when to use it and that
  it takes effect after a restart.
- A visible warning when the log file could not be opened (§3.9).

The retention figure described in earlier drafts is **not** implemented:
`SettingsModal.tsx` renders only the toggle and the degradation warning, and
`LOG_KEEP_FILES` has no UI consumer (it exists on both sides solely for the
`crossLayerConstants.test.ts` drift guard).

### 7.3 Documentation

`docs/guides/troubleshooting.md` — per-platform log locations, how to enable
verbose logging, how to export a bundle, and what to expect to see. This is a
`guides/` document per `docs/AGENTS.md` (user-facing operation), not a spec.
Today it is reachable only from `docs/manual-qa.md` and the specs/plans that
cite it: the planned menu link and the README link were never added (on macOS
there is no Help menu to hang one on — §7.1), and that gap is a follow-up, not
shipped behaviour.

## 8. Resolved decisions and remaining questions

Settled during review on 2026-10-03, recorded here so they are not relitigated:

- **Non-home absolute paths collapse by default** (§3.7 rule 3), with no
  reachable opt-out: the shipped export flow has no labelled control for an
  "include full file paths" choice, so every bundle collapses paths. Privacy by
  default is the right posture for a notes app: a Vault on an external drive or
  NAS can carry project names in its folder names, and a checkbox is enough to
  serve deep debugging once a labelled one exists.
- **The verbose-logging Settings toggle is Phase 1**, not deferred (§3.5). A
  macOS user launching from Finder cannot set `OMD_LOG` at all, so deferring it
  would leave the exact population that reports bugs unable to enable verbose
  mode.
- **Webview termination is a hook, not a log-level promotion** (§3.4.4), and it
  is gated on the exiting state rather than firing unconditionally.
- **No release `debug = 1`** (§3.4). `std::panic::Location` already pinpoints
  which of the 201 `.unwrap()` sites fired; native backtrace symbolication is not
  worth the binary-size cost at this stage.
- **Degraded logging goes to `temp_dir()/<app>-{pid}.log`**, never beside the
  real log directory (§3.9), because the failures being defended against are
  exactly the ones that make the real directory unwritable.
- **The exiting state adds no file** — it is recorded in the log stream and
  summarized into `manifest.json` (§3.4.5, §3.8).
- **Rate-control thresholds** are the values in §3.10.
- **`Error` bypasses the breaker, rate limit, and Rust budget** (§3.9), while
  still being deduplicated. A fatal record must survive a warnings storm.
- **The probe is a write test, not a permission-bit check** (§3.9) — metadata
  read-only flags do not reflect NTFS ACLs or effective Unix permissions.
- **The log plugin is registered from inside `.setup()`** (§3.12), because the
  probe needs `app_log_dir()`, which needs an `AppHandle`.
- **Path fields go through one helper per side and are never hand-concatenated**
  (§3.7), with escape rules and a shared cross-language fixture.

Still open:

1. **Does `on_web_content_process_terminate` fire during a normal quit?** This
   is unverified and must be confirmed first: if it fires on ordinary teardown,
   the exiting-state gate in §3.4.4 is load-bearing, and if it does not, the gate
   is merely defensive. Either way it must not be shipped without an observed
   answer.
2. **macOS shutdown grace period.** `ExitRequested` → `api.prevent_exit()` → up to
   2s of flushing may exceed what logout/shutdown allows before a force-kill.
   The §3.4.5 `session exit intent=…` line is written immediately on arrival, so
   the *determination* stays correct; the question is only whether any pending
   log records are lost, and it is a `Warn`-level annoyance rather than a
   correctness problem.
3. **Release `debug = 1`** remains measurable-later rather than decided forever.
4. **Late logger installation** (§3.12). Other plugins' setup records and the
   config windows now precede the logger. Believed harmless — that window holds
   only the `tao`/`wry` traffic §3.2 suppresses anyway — but it is a real
   behavioural change and should be eyeballed on the first `pnpm dev` run.

## 9. Phasing

Ordered so that each phase is independently useful and the first one is small.

### Phase 0 — stop destroying evidence, and answer "did it crash?" (Rust only)

Level policy (§3.2), rotation and retention (§3.3), startup environment header,
panic hook (§3.4.1), the bootstrap reordering of §3.12, the session boundary
lines and startup determination (§3.4.5), and the log-directory write probe with
degraded fallback (§3.9).

Verifiable without any frontend work: run `pnpm dev`, exercise the app, read the
file — `tao` TRACE lines gone, the header naming the effective level — then
`kill -9` the process and confirm the next launch reports abnormal termination,
and quit cleanly and confirm it does not.

§3.12 makes this phase larger than it first appears: it moves plugin registration
and must be done as one piece, because a half-migrated bootstrap either loses the
logger or reintroduces the startup panic.

### Phase 1 — close the silent channels

TypeScript facade and `log_frontend` (§3.1, §3.11) with the four-layer rate
control and the `Error` green channel (§3.9), global handlers with immediate
dispatch and the error boundary (§3.4.2–3), boundary instrumentation including
the structured path helpers (§3.6, §3.7), the log flush inside the existing
`FlushGate` handler (§3.9), the webview termination hook with its exiting-state
gate (§3.4.4), "打开日志目录" (§7.1), the verbose escape hatch and Settings toggle
(§3.5), and the Settings degradation warning (§7.2).

Also in this phase: update the now-false comments at
`apps/desktop/src/recoveryWriter.ts:38` and `apps/desktop/src/App.tsx:286`, and
route the existing `console.*` sites and the updater's `logFailure` sink through
the facade.

### Phase 2 — the support artifact

Bundle enrichment and the manifest `previous_exit` summary (§3.8), export
redaction with its cross-platform case table and best-effort second pass (§3.7),
the pre-export notice, `docs/guides/troubleshooting.md` (§7.3), and menu
entry points.

OS crash-report collection stays deferred (§3.8) and is not scheduled.

## 10. Verification plan

**Rust unit tests**
- Level policy resolves to the table in §3.2 for debug and release.
- Rotation config equals `LOG_MAX_FILE_BYTES` / `LOG_KEEP_FILES`, and the
  strategy is `KeepSome` rather than `KeepOne`. The size and count are asserted
  by the TS side (`test/crossLayerConstants.test.ts` parses `logging.rs`); there
  is no test that fails on a reintroduced `KeepOne`, so the strategy line is
  guarded by review only.
- Panic hook logs the panic message and `file:line`.
- Session determination returns the right row of the §3.4.5 table for each input,
  including the `unknown` row when no `session start` is found.
- **The split-session case:** a `session start` in the archive with its
  `session end` in the active log resolves to *clean exit*, not to any of the
  other rows — this is the case a single-file reader gets wrong.
- Tail reading survives a seek that lands mid-UTF-8-character: a fixture whose
  64 KiB boundary falls inside a CJK path still parses.
- Archive discovery picks the newest `{stem}_{timestamp}.log` by lexicographic
  order.
- Probe: a write test against a directory whose metadata read-only bit is clear
  but that is not writable still fails; a genuinely writable directory passes.
- Probe failure selects the `temp_dir` fallback and the app still starts; when
  even the fallback fails, the app starts with no logger attached (`disabled`)
  and reports that state.
- Plugin registration failure inside `.setup()` does **not** propagate — asserted
  by returning from setup with `Ok(())` on a forced registration error.
- Path field helpers round-trip every case in the shared fixture, including `"`,
  `>`, `]`, `;`, newline, spaces, and CJK.
- `log_frontend` payload serializes to the expected JSON (the §3.11 contract).
- Rust per-window budget (`LOG_FRONTEND_BUDGET_PER_SEC`) truncates above the limit
  and not below it, and **collapses rather than drops** `Error` records.
- Redaction: the §3.7 case table — `C:\…`, `D:\…`, `\\server\share\…`,
  `/Volumes/…`, spaces, CJK, quotes, `file:///` — plus the existing three cases
  in `diagnostics.rs` and the secret-shaped patterns of §3.7 rule 4.
- Bundle contains exactly the §3.8 entries — asserted as a *closed* set, so a
  reintroduced `abnormal-exit.txt` fails the test — and the manifest hashes match
  file contents.

**TypeScript tests**
- Facade does not throw when `invoke` rejects; the rejection is counted.
- Layer 1 collapses consecutive identical records and emits the repeat count.
- Layer 2 token bucket caps the offered rate.
- Layer 3 breaker fires at `LOG_BREAKER_DROPS` within
  `LOG_BREAKER_WINDOW_MS`, disables the facade for
  `LOG_BREAKER_COOLDOWN_MS`, and emits exactly one summary line.
- **`Error` is delivered while the breaker is open**, and repeated identical
  `Error` records still collapse; a bypassed `Error` does not extend the breaker
  window.
- The exit flush delivers queued records before `sessionFlushAck()`.
- Facade mirrors to `console.*` under `DEV` and not otherwise.
- Global handlers are registered once, bypass the queue, and forward error plus
  stack.
- Path helper output parses with the same shared fixture the Rust test uses.
- Boundary helpers accept structured fields only; a document-content-shaped
  payload is rejected.

**Drift guard**
- `test/crossLayerConstants.test.ts` covers the cross-boundary constants in
  §3.10, including `LOG_FRONTEND_BUDGET_PER_SEC` > `LOG_RATE_LIMIT_PER_SEC`.
- A source-grep test fails on a `path=` or `paths=` literal outside the helpers
  (§3.7).

**Manual QA** (`docs/manual-qa.md` additions)
- "打开日志目录" opens the correct directory on macOS, Windows, and Linux.
- Toggling verbose logging takes effect on the next launch and the startup header
  records the new level.
- `kill -9` mid-edit produces the abnormal-termination `Warn` on the next launch;
  a clean quit produces none.
- A forced macOS logout mid-session is reported as interrupted, **not** as a
  crash.
- Making the log directory unwritable (`chmod 500`, and on Windows an ACL that
  denies write while the read-only attribute stays clear) still lets the app
  start, and the Settings surface reports the degraded `temp_dir` destination.
- Exported bundle opens as a valid zip and contains no document content and no
  full outside-home paths.

**Gate:** `pnpm verify` (engine + desktop + `cargo test` + link stage) before this
branch merges, per the root `AGENTS.md` rule about link-stage failures.

## 11. Documentation maintenance

- Root `AGENTS.md` — no routing change expected; revisit if logging becomes a
  domain.
- `apps/desktop/AGENTS.md` — add the logging ownership rule, the `log_frontend`
  IPC contract, and the §3.12 bootstrap constraint (the log plugin is registered
  from `.setup()`; a setup error must never propagate) once implemented.
- `docs/memory/known-gotchas.md` + `gotchas-rust.md` — **yes, three entries**, all
  verified against vendored sources and all reusable:
  1. `tauri-plugin-log` defaults to `LevelFilter::Trace` in release (no
     `debug_assertions` gate) and `KeepOne` rotation *deletes* the log at 40 KB
     rather than archiving it. Cite the §2.5 evidence.
  2. A `tauri-plugin-log` setup failure — a log file that cannot be opened —
     propagates through Tauri's `initialize_plugins(handle)?` into `build()` and
     reaches `.expect("error while building oh-my-md")`, so it **panics before
     any window appears**. Generalise it: never let a plugin whose `setup`
     touches the filesystem be load-bearing for startup.
  3. The app-level `.setup()` hook runs on the event loop's `Ready` event, not
     inside `build()`, and a non-`Ok` return from it is turned into
     `panic!("Failed to setup app: {e}")`. This is what makes late plugin
     registration possible *and* what makes returning an error from setup fatal
     — both halves have bitten this design at once.
- `docs/manual-qa.md` — the six checks in §10.
- `README` / `CHANGELOG` — at release time, per `docs/AGENTS.md`.
