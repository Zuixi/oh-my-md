//! Registry drift guard for `security/command-inventory.toml`.
//!
//! The manifest is the reviewed contract; this test is the mechanical guard. It
//! deliberately reads `tauri::generate_handler![...]` as a comma-separated list
//! of path tokens instead of matching command signatures with a regex: the
//! manifest classifies authority, and the registry list only has to agree on
//! the set of names.
//!
//! No parser crate is used, so the file format stays a small line-oriented
//! subset of TOML that both a reviewer and this module can read.

use std::collections::{BTreeMap, BTreeSet};

const INVENTORY: &str = include_str!("../security/command-inventory.toml");
const LIB_RS: &str = include_str!("lib.rs");

const HANDLER_OPEN: &str = "tauri::generate_handler![";
/// Section headers this parser understands.
const COMMANDS_SECTION: &str = "commands";
const ALLOWLIST_SECTION: &str = "migration_allowlist";

/// Shrinking is the goal, so the allowlist is capped rather than pinned: an
/// accidental addition fails here, a removal never needs this constant edited.
/// Bumped to 29 by `opener::reveal_in_finder`, which replaced the unrestricted
/// `opener:default` capability's path reveal with an `auth_scope`-checked one.
const MIGRATION_ALLOWLIST_MAX: usize = 29;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommandClass {
    Pure,
    ScopedIo,
    System,
    Internal,
}

impl CommandClass {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "pure" => Some(Self::Pure),
            "scoped_io" => Some(Self::ScopedIo),
            "system" => Some(Self::System),
            "internal" => Some(Self::Internal),
            _ => None,
        }
    }
}

#[derive(Debug, Default)]
struct Inventory {
    classes: BTreeMap<String, CommandClass>,
    migration_allowlist: BTreeSet<String>,
}

#[derive(Clone, Copy)]
enum Section {
    None,
    Commands,
    MigrationAllowlist,
}

fn parse_inventory(source: &str) -> Result<Inventory, String> {
    let mut inventory = Inventory::default();
    let mut section = Section::None;
    for (index, raw) in source.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|rest| rest.strip_suffix(']'))
        {
            section = match name.trim() {
                COMMANDS_SECTION => Section::Commands,
                ALLOWLIST_SECTION => Section::MigrationAllowlist,
                other => return Err(format!("line {line_no}: unknown section [{other}]")),
            };
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("line {line_no}: expected `\"command\" = value`"))?;
        let key = entry_name(key, line_no)?;
        let value = value.trim();
        match section {
            Section::Commands => {
                let class = CommandClass::parse(value.trim_matches('"'))
                    .ok_or_else(|| format!("line {line_no}: {key} has unknown class {value}"))?;
                if inventory.classes.insert(key.clone(), class).is_some() {
                    return Err(format!("line {line_no}: {key} is classified twice"));
                }
            }
            Section::MigrationAllowlist => {
                if value != "true" {
                    return Err(format!(
                        "line {line_no}: allowlist entry {key} must be `true`"
                    ));
                }
                if !inventory.migration_allowlist.insert(key.clone()) {
                    return Err(format!("line {line_no}: {key} is allowlisted twice"));
                }
            }
            Section::None => return Err(format!("line {line_no}: entry outside a section")),
        }
    }
    Ok(inventory)
}

/// A quoted command identifier, without the quotes.
fn entry_name(raw: &str, line_no: usize) -> Result<String, String> {
    let raw = raw.trim();
    let quoted = raw
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .ok_or_else(|| format!("line {line_no}: command identifier must be quoted"))?;
    if quoted.is_empty() {
        return Err(format!("line {line_no}: command identifier is empty"));
    }
    Ok(quoted.to_string())
}

/// The command tokens registered in `tauri::generate_handler![...]`, in order.
fn registered_commands(lib_rs: &str) -> Result<Vec<String>, String> {
    let (_, after_open) = lib_rs
        .split_once(HANDLER_OPEN)
        .ok_or_else(|| format!("lib.rs has no {HANDLER_OPEN} invocation"))?;
    let mut commands = Vec::new();
    for line in after_open.lines() {
        let code = line.split("//").next().unwrap_or_default().trim();
        if code.starts_with(']') {
            return Ok(commands);
        }
        commands.extend(
            code.split(',')
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_string),
        );
    }
    Err("generate_handler! is never closed with `]`".into())
}

/// Every way a manifest can disagree with the registry, reported together so one
/// red run lists all the drift instead of the first symptom.
fn validate(registered: &[String], inventory: &Inventory) -> Result<(), String> {
    let registered_set: BTreeSet<&str> = registered.iter().map(String::as_str).collect();
    let classified: BTreeSet<&str> = inventory.classes.keys().map(String::as_str).collect();
    let mut problems = Vec::new();
    if registered_set.len() != registered.len() {
        problems.push("a command is registered twice in generate_handler!".to_string());
    }
    for name in registered_set.difference(&classified) {
        problems.push(format!("{name} is registered but unclassified"));
    }
    for name in classified.difference(&registered_set) {
        problems.push(format!("{name} is classified but not registered (ghost)"));
    }
    for name in &inventory.migration_allowlist {
        match inventory.classes.get(name) {
            Some(CommandClass::ScopedIo) => {}
            Some(_) => problems.push(format!("{name} is allowlisted but is not scoped_io")),
            None => problems.push(format!("{name} is allowlisted but unclassified (ghost)")),
        }
    }
    if inventory.migration_allowlist.is_empty() {
        problems.push("the migration allowlist is empty".to_string());
    }
    if inventory.migration_allowlist.len() > MIGRATION_ALLOWLIST_MAX {
        problems.push(format!(
            "the migration allowlist grew to {} (cap {MIGRATION_ALLOWLIST_MAX})",
            inventory.migration_allowlist.len()
        ));
    }
    for class in [
        CommandClass::Pure,
        CommandClass::ScopedIo,
        CommandClass::System,
        CommandClass::Internal,
    ] {
        if !inventory
            .classes
            .values()
            .any(|assigned| *assigned == class)
        {
            problems.push(format!("no command is classified {class:?}"));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

#[test]
fn every_registered_command_is_classified_exactly_once() {
    let registered = registered_commands(LIB_RS).expect("lib.rs generate_handler! parses");
    let inventory = parse_inventory(INVENTORY).expect("command-inventory.toml parses");

    if let Err(problems) = validate(&registered, &inventory) {
        panic!("command inventory drift: {problems}");
    }
}

#[test]
fn the_migration_allowlist_never_grows() {
    let inventory = parse_inventory(INVENTORY).expect("command-inventory.toml parses");

    assert!(!inventory.migration_allowlist.is_empty());
    assert!(
        inventory.migration_allowlist.len() <= MIGRATION_ALLOWLIST_MAX,
        "allowlist has {} entries, cap is {MIGRATION_ALLOWLIST_MAX}",
        inventory.migration_allowlist.len()
    );
    // Raw-path entries are the only class a capability handle can replace, so a
    // `pure`, `system`, or `internal` entry means the classification is wrong.
    assert!(inventory
        .migration_allowlist
        .iter()
        .all(|name| inventory.classes.get(name) == Some(&CommandClass::ScopedIo)));
}

#[test]
fn the_registry_reader_ignores_comments_and_rejects_a_missing_handler() {
    let sample = "fn setup() {\n  .invoke_handler(tauri::generate_handler![\n    // a comment\n    a::b,\n    c, // trailing comment\n  ])\n}\n";
    assert_eq!(
        registered_commands(sample).unwrap(),
        vec!["a::b".to_string(), "c".to_string()]
    );
    assert!(registered_commands("fn setup() {}").is_err());
    assert!(registered_commands("tauri::generate_handler![\n  a::b,\n").is_err());
}

#[test]
fn the_validator_rejects_ghost_unclassified_and_duplicate_entries() {
    const SAMPLE: &str = r#"
[commands]
"app_version" = "pure"
"list_dir" = "scoped_io"
"pick" = "system"
"ack" = "internal"

[migration_allowlist]
"list_dir" = true
"#;
    let names = |raw: &[&str]| raw.iter().map(|name| name.to_string()).collect::<Vec<_>>();
    let sample = names(&["app_version", "list_dir", "pick", "ack"]);
    validate(&sample, &parse_inventory(SAMPLE).unwrap()).expect("the sample manifest is valid");

    // A ghost: classified, but the registry never registered it.
    let ghost = SAMPLE.replace(
        "[commands]\n",
        "[commands]\n\"removed_command\" = \"pure\"\n",
    );
    let error = validate(&sample, &parse_inventory(&ghost).unwrap()).unwrap_err();
    assert!(error.contains("removed_command"), "{error}");

    // Unclassified: registered, but the manifest never classified it.
    let mut extended = sample.clone();
    extended.push("new_command".to_string());
    let error = validate(&extended, &parse_inventory(SAMPLE).unwrap()).unwrap_err();
    assert!(error.contains("new_command"), "{error}");

    // Duplicate: the same command in two classes, or twice in one.
    for duplicate in [r#""app_version" = "pure""#, r#""app_version" = "system""#] {
        let source = format!("[commands]\n\"app_version\" = \"pure\"\n{duplicate}\n");
        let error = parse_inventory(&source).unwrap_err();
        assert!(error.contains("app_version"), "{error}");
    }

    // An allowlisted command must be scoped_io, and only four classes exist.
    let allowlisted_pure =
        "[commands]\n\"app_version\" = \"pure\"\n\n[migration_allowlist]\n\"app_version\" = true\n";
    let error = validate(
        &names(&["app_version"]),
        &parse_inventory(allowlisted_pure).unwrap(),
    )
    .unwrap_err();
    assert!(error.contains("app_version"), "{error}");
    assert!(parse_inventory("[commands]\n\"app_version\" = \"network\"\n").is_err());
    // An entry before any section is a syntax error, not silently dropped.
    assert!(parse_inventory("\"app_version\" = \"pure\"\n").is_err());
    // A classify-only manifest with no allowlist is still caught.
    let empty_allowlist = "[commands]\n\"app_version\" = \"pure\"\n\n[migration_allowlist]\n";
    let error = validate(
        &names(&["app_version"]),
        &parse_inventory(empty_allowlist).unwrap(),
    )
    .unwrap_err();
    assert!(error.contains("empty"), "{error}");
}
