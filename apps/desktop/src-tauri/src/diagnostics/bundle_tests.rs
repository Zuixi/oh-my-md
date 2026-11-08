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
            "previous_exit",
            "skipped_logs"
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
    // What install() resolved and handed to the plugin. Deliberately not a
    // value the preference rules below can answer, so a recomputation is
    // observable rather than coincidentally equal.
    let resolved = log::LevelFilter::Trace;
    let mut state = directory_state(Path::new("/tmp/logs"));
    state.level = resolved;

    // The toggle persists immediately, so a fresh resolution at export time
    // would now answer `Debug`. Preferences are data, so this premise needs no
    // settings file and no environment lock.
    let toggled_verbose = crate::logging::logging_preferences(&format!(
        r#"{{"{}":true}}"#,
        crate::logging::VERBOSE_LOGGING_SETTINGS_KEY
    ));
    assert_ne!(
        crate::logging::effective_level(toggled_verbose),
        resolved,
        "the premise: a fresh resolution answers a different level than install resolved"
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
    let session = crate::logging::scan_previous_session(&fixture.logs, "oh-my-md", 0);
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
    let entries = fixture.write_state(&fixture.state, PreviousExit::Clean, false, &settings, "{}");
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
        log_dir_line.starts_with(&format!("log_dir=<home>{}", std::path::MAIN_SEPARATOR))
            || log_dir_line.starts_with("log_dir=<home>/"),
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

// The bundle must not disclose an external volume name just because it is the
// logging destination. Settings still holds the resolved local directory.
#[test]
fn bundle_environment_redacts_a_non_home_log_directory() {
    let fixture = Fixture::new(&[]);
    let state = directory_state(Path::new("/Volumes/ExVault/logs"));
    let entries = fixture.write_state(&state, PreviousExit::Unknown, false, "{}", "{}");
    let environment = text_entry(&entries, "environment.txt");

    let log_dir_line = environment
        .lines()
        .find(|line| line.starts_with("log_dir="))
        .expect("environment.txt must say where the logs went");
    assert_eq!(log_dir_line, "log_dir=<path>/…/logs", "{environment}");
    assert!(!environment.contains("ExVault"), "{environment}");
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

// The bundle is the artifact a support request depends on. A corrupt archive
// used to abort the whole export with "stream did not contain valid UTF-8", so
// the one file the user could actually produce was the one that failed.
#[test]
fn a_corrupt_log_does_not_abort_the_bundle() {
    let fixture = Fixture::new(&[]);
    fixture.log("oh-my-md.log", "save ok path=<home>/a.md\n");
    std::fs::write(
        fixture.logs.join("oh-my-md_2026-01-01_00-00-00.log"),
        [0xff, 0xfe, 0x00],
    )
    .unwrap();

    let entries = fixture.write(PreviousExit::Clean, false);
    let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert!(
        names.contains(&"oh-my-md.log"),
        "the readable log must still ship: {names:?}"
    );
    let readable = text_entry(&entries, "oh-my-md.log");
    assert!(readable.contains("save ok"), "{readable}");

    let manifest = json_entry(&entries, "manifest.json");
    let skipped = manifest["skipped_logs"].as_array().unwrap();
    assert!(
        skipped.is_empty(),
        "a merely non-UTF-8 archive is decoded lossily, not skipped: {skipped:?}"
    );

    // A path that cannot be read as a file at all (a directory carrying the
    // archive's name) is reported in the manifest instead of aborting.
    std::fs::create_dir(fixture.logs.join("oh-my-md_2026-01-03_00-00-00.log")).unwrap();
    let entries = fixture.write(PreviousExit::Clean, false);
    let manifest = json_entry(&entries, "manifest.json");
    let skipped = manifest["skipped_logs"].as_array().unwrap();
    assert_eq!(skipped.len(), 1, "{manifest}");
    assert_eq!(skipped[0]["name"], "oh-my-md_2026-01-03_00-00-00.log");
    assert!(
        skipped[0]["reason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty()),
        "{manifest}"
    );
    // The readable log is still there beside the report.
    assert!(text_entry(&entries, "oh-my-md.log").contains("save ok"));
}

// The stem prefix alone matched `{stem}-notes.log`-style neighbours; in the
// shared temp directory that could ship another tool's file. Only the plugin's
// own two shapes are this writer's.
#[test]
fn only_the_writers_own_log_names_are_collected() {
    let fixture = Fixture::new(&[]);
    fixture.log("oh-my-md.log", "current\n");
    fixture.log("oh-my-md_2026-10-01_09-30-00.log", "archive\n");
    for foreign in [
        "oh-my-md_notes.log",
        "oh-my-md_backup.log",
        "oh-my-md_2026-10-01.log",
        "oh-my-md_2026-10-01_09-30-00.bak",
    ] {
        fixture.log(foreign, "PRIVATE_FOREIGN\n");
    }

    let entries = fixture.write(PreviousExit::Clean, false);
    let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&"oh-my-md.log"), "{names:?}");
    assert!(
        names.contains(&"oh-my-md_2026-10-01_09-30-00.log"),
        "{names:?}"
    );
    for foreign in [
        "oh-my-md_notes.log",
        "oh-my-md_backup.log",
        "oh-my-md_2026-10-01.log",
    ] {
        assert!(
            !names.contains(&foreign),
            "{foreign} must not ship: {names:?}"
        );
    }
    let combined = text_entry(&entries, "diagnostics.txt");
    assert!(!combined.contains("PRIVATE_FOREIGN"), "{combined}");
}

// Default installs have logging off, so they have no markers. Reporting
// `previous session outcome unknown (no markers in range)` there makes a
// reader hunt for lost evidence; the truth is that nothing was ever written.
#[test]
fn bundle_explains_an_undetermined_exit_when_logging_is_off() {
    let fixture = Fixture::new(&[]);
    let state = LogState {
        degraded: false,
        dir: PathBuf::new(),
        file_stem: String::new(),
        destination: LogDestination::Off,
        level: log::LevelFilter::Off,
    };
    let entries = fixture.write_state(&state, PreviousExit::Unknown, false, "{}", "{}");
    let manifest = json_entry(&entries, "manifest.json");
    let exit = &manifest["previous_exit"];

    assert_eq!(exit["state"], "unknown");
    assert_eq!(
        exit["reason"],
        crate::logging::PREVIOUS_EXIT_UNKNOWN_LOGGING_OFF
    );
    assert!(
        exit["reason"].as_str().unwrap().contains("logging was off"),
        "{manifest}"
    );
    // Nothing was recorded, so nothing may be attributed to a session.
    assert!(exit["pid"].is_null());
    assert!(exit["version"].is_null());
    let environment = text_entry(&entries, "environment.txt");
    assert!(environment.contains("log_destination=off"), "{environment}");
}

// The same outcome with logging on keeps the rotation wording: the override must
// be scoped to the opted-out destination, not to `Unknown`.
#[test]
fn bundle_keeps_the_rotation_reason_when_logging_was_on() {
    let fixture = Fixture::new(&[]);
    let entries = fixture.write(PreviousExit::Unknown, false);
    let manifest = json_entry(&entries, "manifest.json");
    assert_eq!(
        manifest["previous_exit"]["reason"],
        "previous session outcome unknown (no markers in range)"
    );
}
