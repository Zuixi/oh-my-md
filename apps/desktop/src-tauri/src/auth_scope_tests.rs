//! Unit tests for per-window filesystem authorization.
//!
//! Split out of `auth_scope.rs` so the production module stays reviewable;
//! wired in through `#[path = "auth_scope_tests.rs"] mod tests;`.

use super::*;

fn tmp(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("omd-auth-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn write(path: &Path) {
    std::fs::write(path, "x").unwrap();
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap()
}

#[test]
fn workspace_root_authorization_is_scoped_per_window() {
    let root = tmp("per-window");
    let doc = root.join("note.md");
    write(&doc);

    authorize_workspace_root("editor-1", &root).unwrap();
    assert!(assert_dir_authorized(Some("editor-1"), &root).is_ok());
    assert!(assert_file_or_workspace_authorized(Some("editor-1"), &doc).is_ok());
    // A different window was never granted this root.
    assert!(assert_dir_authorized(Some("editor-2"), &root).is_err());

    revoke_window("editor-1");
    assert!(assert_dir_authorized(Some("editor-1"), &root).is_err());
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn revoking_one_window_keeps_another_windows_grant() {
    let first = tmp("revoke-first");
    let second = tmp("revoke-second");
    authorize_workspace_root("editor-a", &first).unwrap();
    authorize_workspace_root("editor-b", &second).unwrap();

    revoke_window("editor-a");

    assert!(assert_dir_authorized(Some("editor-a"), &first).is_err());
    assert!(assert_dir_authorized(Some("editor-b"), &second).is_ok());
    std::fs::remove_dir_all(first).ok();
    std::fs::remove_dir_all(second).ok();
}

#[test]
fn a_single_file_grant_does_not_open_its_directory() {
    let root = tmp("single-file");
    let doc = root.join("standalone.md");
    let sibling = root.join("sibling.md");
    write(&doc);
    write(&sibling);

    authorize_document_file("editor-file", &doc).unwrap();

    assert!(assert_file_or_workspace_authorized(Some("editor-file"), &doc).is_ok());
    // Siblings and the folder stay out of scope; the grant is that one file.
    assert!(assert_file_or_workspace_authorized(Some("editor-file"), &sibling).is_err());
    assert!(assert_dir_authorized(Some("editor-file"), &root).is_err());
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_file_that_does_not_exist_yet_is_authorizable_by_parent_and_name() {
    let root = tmp("future-file");
    let future = root.join("not-written-yet.md");

    let resolved = authorize_document_file("editor-new", &future).unwrap();

    assert_eq!(resolved, canonical(&root).join("not-written-yet.md"));
    assert!(assert_file_or_workspace_authorized(Some("editor-new"), &future).is_ok());
    // A deleted tail still resolves against its deepest existing ancestor,
    // so an open tab whose folder vanished reads as missing, not forbidden.
    let gone = root.join("gone/deep/note.md");
    assert_eq!(
        resolve_canonical_with_missing_tail(&gone).unwrap(),
        canonical(&root).join("gone/deep/note.md")
    );
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn paths_must_be_absolute_existing_and_free_of_traversal() {
    let root = tmp("reject");
    let doc = root.join("note.md");
    write(&doc);
    let base = std::env::temp_dir();

    assert!(assert_dir_authorized(Some("editor-none"), &root).is_err());
    assert!(assert_file_or_workspace_authorized(None, &doc).is_err());
    assert!(resolve_canonical_with_missing_tail(Path::new("relative/x.md")).is_err());
    for traversal in [root.join("../etc"), root.join("../note.md")] {
        assert!(reject_traversal(&traversal).is_err());
        assert!(canonical_parent_and_name(&traversal).is_err());
        assert!(resolve_canonical_with_missing_tail(&traversal).is_err());
    }
    assert!(absolute_path(&base.join("notes")).is_ok());
    assert!(absolute_path(Path::new("notes")).is_err());
    assert!(absolute_path(&base.join(".").join("notes")).is_err());
    assert!(absolute_path(&base.join("..").join("notes")).is_err());
    assert_eq!(workspace_directory(&root).unwrap(), canonical(&root));
    assert_eq!(
        document_directory_for_assets(&doc).unwrap(),
        canonical(&root)
    );
    assert!(workspace_directory(&root.join("..")).is_err());
    assert!(document_directory_for_assets(Path::new("relative/document.md")).is_err());
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn authorized_watch_path_restricts_watches_to_window_scope() {
    let workspace = tmp("watch-ws");
    let outside = tmp("watch-outside");
    let inside_doc = workspace.join("a.md");
    let standalone_doc = outside.join("solo.md");
    let sibling_doc = outside.join("other.md");
    for path in [&inside_doc, &standalone_doc, &sibling_doc] {
        write(path);
    }

    authorize_workspace_root("watch-w1", &workspace).unwrap();
    authorize_document_file("watch-w1", &standalone_doc).unwrap();

    assert_eq!(
        authorized_watch_path("watch-w1", &workspace),
        Some(canonical(&workspace))
    );
    assert_eq!(
        authorized_watch_path("watch-w1", &inside_doc),
        Some(canonical(&inside_doc))
    );
    assert_eq!(
        authorized_watch_path("watch-w1", &standalone_doc),
        Some(canonical(&standalone_doc))
    );
    assert_eq!(authorized_watch_path("watch-w1", &outside), None);
    assert_eq!(authorized_watch_path("watch-w1", &sibling_doc), None);
    assert_eq!(authorized_watch_path("watch-w2", &workspace), None);

    revoke_window("watch-w1");
    assert_eq!(authorized_watch_path("watch-w1", &workspace), None);
    std::fs::remove_dir_all(workspace).ok();
    std::fs::remove_dir_all(outside).ok();
}

#[test]
fn a_requested_workspace_dir_must_have_been_granted() {
    let root = tmp("requested");
    let doc = root.join("note.md");
    write(&doc);

    assert!(authorize_requested_workspace_dir("req-w", &root).is_err());

    // A standalone file promotes its own folder once, which is how the tree
    // reveals a lone document.
    authorize_document_file("req-w", &doc).unwrap();
    assert_eq!(
        authorize_requested_workspace_dir("req-w", &root).unwrap().0,
        canonical(&root)
    );
    // One-way and root-scoped: a sibling folder and `/` are both refused.
    let sibling = tmp("requested-sibling");
    assert!(authorize_requested_workspace_dir("req-w", &sibling).is_err());
    assert!(authorize_requested_workspace_dir("req-w", Path::new("/")).is_err());
    if let Some(home) = dirs::home_dir() {
        if authorize_document_file("req-home", &home.join("omd-auth-probe.md")).is_ok() {
            assert!(authorize_requested_workspace_dir("req-home", &home).is_err());
        }
    }
    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(sibling).ok();
}

#[test]
fn session_and_settings_state_cannot_launder_an_unauthorized_path() {
    let root = tmp("config-state");
    let doc = root.join("note.md");
    let css = root.join("theme.css");
    write(&doc);
    write(&css);
    let session = format!(
        r#"{{"folder":{:?},"openPaths":[{:?}],"hotExitTabs":[{{"path":{doc:?}}}]}}"#,
        root.to_string_lossy(),
        doc.to_string_lossy(),
    );
    let settings = format!(r#"{{"customCssPath":{:?}}}"#, css.to_string_lossy());

    // Nothing is granted yet, so no persisted payload may claim these paths.
    assert!(validate_session_json_for_save("state-w", &session, None).is_err());
    assert!(validate_session_json_for_save("state-w", "{not json", None).is_err());
    assert!(validate_settings_json_for_save("state-w", &settings, "{}").is_err());

    authorize_from_session_json("state-w", &session);
    authorize_from_settings_json("state-w", &settings);
    validate_session_json_for_save("state-w", &session, None).unwrap();
    validate_settings_json_for_save("state-w", &settings, "{}").unwrap();

    // Laundering: state that names a path this window never had. It has to
    // be outside the granted root — a Markdown file inside it is legitimate.
    let other = std::env::temp_dir().join(format!("omd-auth-laundered-{}.md", std::process::id()));
    let laundered_session = format!(r#"{{"openPaths":[{:?}]}}"#, other.to_string_lossy());
    let laundered_settings = format!(r#"{{"customCssPath":{:?}}}"#, other.to_string_lossy());
    assert!(validate_session_json_for_save("state-w", &laundered_session, None).is_err());
    assert!(validate_settings_json_for_save("state-w", &laundered_settings, "{}").is_err());
    // ...unless that exact path is already on disk (keeps a flush alive).
    let on_disk = Some(laundered_session.as_str());
    validate_session_json_for_save("state-w", &laundered_session, on_disk).unwrap();
    validate_settings_json_for_save("state-w", &laundered_settings, &laundered_settings).unwrap();
    validate_settings_json_for_save("state-w", r#"{"fontSize":18}"#, "{}").unwrap();
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_window_handoff_copies_only_authorized_files() {
    let root = tmp("handoff");
    let doc = root.join("note.md");
    let foreign = root.join("foreign.md");
    write(&doc);
    write(&foreign);
    authorize_document_file("handoff-from", &doc).unwrap();

    let copy =
        |paths: &[String]| copy_authorized_files_to_window("handoff-from", "handoff-to", paths);
    copy(&[doc.to_string_lossy().into_owned()]).unwrap();
    assert!(assert_file_or_workspace_authorized(Some("handoff-to"), &doc).is_ok());

    let foreign_paths = [foreign.to_string_lossy().into_owned()];
    assert!(copy(&foreign_paths).is_err());
    assert!(assert_file_or_workspace_authorized(Some("handoff-to"), &foreign).is_err());

    authorize_recovered_paths("handoff-to", [foreign.to_string_lossy().as_ref()]);
    assert!(assert_file_or_workspace_authorized(Some("handoff-to"), &foreign).is_ok());
    assert!(!is_document_inside_workspace(Some("handoff-to"), &foreign));
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_hidden_directory_inside_a_root_is_never_authorized() {
    let root = tmp("hidden-dirs");
    let visible = root.join("sub");
    let hidden = root.join(".git");
    let nested = visible.join(".cache");
    for dir in [&visible, &hidden, &nested] {
        std::fs::create_dir_all(dir).unwrap();
    }
    authorize_workspace_root("hidden-w", &root).unwrap();

    assert!(assert_dir_authorized(Some("hidden-w"), &root).is_ok());
    assert!(assert_dir_authorized(Some("hidden-w"), &visible).is_ok());
    // One gate protects every caller: listing, search, quick open, create,
    // rename, and delete all resolve their directory here, so `.git`, `.env`,
    // and `.ssh` never become reachable through a visible root.
    assert!(assert_dir_authorized(Some("hidden-w"), &hidden).is_err());
    assert!(assert_dir_authorized(Some("hidden-w"), &nested).is_err());
    // A session shard may not persist one either, or a restore would re-grant.
    assert!(!is_authorized_directory(Some("hidden-w"), &hidden));
    assert!(is_authorized_directory(Some("hidden-w"), &visible));
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_root_that_lives_under_a_hidden_ancestor_stays_authorized() {
    let parent = tmp(".hidden-parent");
    let root = parent.join("ws");
    let sub = root.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    authorize_workspace_root("hidden-root-w", &root).unwrap();

    // Only components relative to the grant are inspected, so a workspace that
    // the user keeps at `~/.worktrees/notes` keeps working.
    assert!(assert_dir_authorized(Some("hidden-root-w"), &root).is_ok());
    assert!(assert_dir_authorized(Some("hidden-root-w"), &sub).is_ok());
    std::fs::remove_dir_all(parent).ok();
}

#[test]
fn the_mutation_gate_accepts_only_visible_markdown_files_and_folders() {
    let root = tmp("mutable");
    let assets = root.join("assets");
    std::fs::create_dir_all(&assets).unwrap();
    write(&root.join("note.md"));
    write(&root.join(".env"));
    write(&root.join("Cargo.toml"));
    write(&assets.join("img.png"));
    write(&assets.join(".DS_Store"));
    authorize_workspace_root("mutable-w", &root).unwrap();

    let entry = assert_workspace_entry_mutable(Some("mutable-w"), &root, "note.md").unwrap();
    assert_eq!(entry.target, canonical(&root.join("note.md")));
    assert_eq!(entry.target.parent(), Some(canonical(&root).as_path()));
    assert!(entry.metadata.is_file());
    // A visible folder stays mutable even when it holds images and dotfiles:
    // failing here would break ordinary folder rename and delete.
    assert!(assert_workspace_entry_mutable(Some("mutable-w"), &root, "assets").is_ok());
    // Hidden names, non-Markdown files, and missing targets are all refused.
    for name in [".env", "Cargo.toml", "missing.md"] {
        assert!(
            assert_workspace_entry_mutable(Some("mutable-w"), &root, name).is_err(),
            "{name} must not be mutable"
        );
    }
    // The workspace root itself cannot be renamed or trashed through a parent
    // folder the same window also has granted.
    let parent = tmp("mutable-parent");
    let nested_root = parent.join("ws");
    std::fs::create_dir_all(&nested_root).unwrap();
    authorize_workspace_root("mutable-parent-w", &nested_root).unwrap();
    authorize_workspace_root("mutable-parent-w", &parent).unwrap();
    assert!(assert_workspace_entry_mutable(Some("mutable-parent-w"), &parent, "ws").is_err());
    assert!(
        assert_workspace_entry_mutable(Some("mutable-parent-w"), &nested_root, "x.md").is_err()
    );
    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(parent).ok();
}

#[test]
fn a_read_only_document_stays_readable_but_not_writable() {
    let root = tmp("read-only");
    let doc = root.join("huge.md");
    write(&doc);
    authorize_document_file("ro-w", &doc).unwrap();

    set_document_access_mode("ro-w", &doc, AccessMode::ReadOnly);

    // Reads, exports, and asset resolution keep working: only writes are gated.
    assert!(assert_file_or_workspace_authorized(Some("ro-w"), &doc).is_ok());
    assert_eq!(
        assert_file_writable(Some("ro-w"), &doc).unwrap_err(),
        DOCUMENT_READ_ONLY
    );

    // The verdict belongs to the window that opened the document.
    authorize_document_file("ro-other", &doc).unwrap();
    assert!(assert_file_writable(Some("ro-other"), &doc).is_ok());

    // Clearing the verdict (file shrank, tab reloaded) restores writing.
    set_document_access_mode("ro-w", &doc, AccessMode::ReadWrite);
    assert!(assert_file_writable(Some("ro-w"), &doc).is_ok());
    set_document_access_mode("ro-w", &doc, AccessMode::ReadOnly);
    revoke_window("ro-w");
    assert!(!is_document_read_only(Some("ro-w"), &doc));
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_read_only_document_inside_a_root_blocks_writes_but_not_reads() {
    let root = tmp("read-only-root");
    let doc = root.join("note.md");
    let sibling = root.join("other.md");
    write(&doc);
    write(&sibling);
    authorize_workspace_root("ro-root-w", &root).unwrap();

    set_document_access_mode("ro-root-w", &doc, AccessMode::ReadOnly);

    assert!(assert_file_or_workspace_authorized(Some("ro-root-w"), &doc).is_ok());
    assert!(assert_file_writable(Some("ro-root-w"), &doc).is_err());
    // The verdict is per document, not per folder.
    assert!(assert_file_writable(Some("ro-root-w"), &sibling).is_ok());
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn huge_files_on_disk_are_rejected_without_a_prior_stat_or_read() {
    let root = tmp("read-only-disk-size");
    let huge = root.join("huge.md");
    let just_under = root.join("just-under.md");
    // Sparse files set logical size without allocating 50 MiB of disk blocks.
    std::fs::File::create(&huge)
        .unwrap()
        .set_len(crate::documents::OPEN_READONLY_THRESHOLD_BYTES)
        .unwrap();
    std::fs::File::create(&just_under)
        .unwrap()
        .set_len(crate::documents::OPEN_READONLY_THRESHOLD_BYTES - 1)
        .unwrap();
    authorize_workspace_root("ro-size-w", &root).unwrap();

    // Neither file has been stat/read yet, so `read_only_files` is empty;
    // direct writes and workspace mutations must still reject the >=50 MiB file.
    assert!(assert_file_or_workspace_authorized(Some("ro-size-w"), &huge).is_ok());
    assert_eq!(
        assert_file_writable(Some("ro-size-w"), &huge).unwrap_err(),
        DOCUMENT_READ_ONLY
    );
    assert_eq!(
        assert_workspace_entry_mutable(Some("ro-size-w"), &root, "huge.md").err(),
        Some(DOCUMENT_READ_ONLY.to_string())
    );
    assert!(assert_file_writable(Some("ro-size-w"), &just_under).is_ok());
    assert!(assert_workspace_entry_mutable(Some("ro-size-w"), &root, "just-under.md").is_ok());
    std::fs::remove_dir_all(root).ok();
}

#[cfg(unix)]
#[test]
fn the_mutation_gate_refuses_symbolic_links() {
    use std::os::unix::fs::symlink;

    let root = tmp("mutable-symlink");
    let outside = tmp("mutable-symlink-target");
    let secret = outside.join("id_rsa");
    write(&secret);
    symlink(&secret, root.join("leak.md")).unwrap();
    symlink(&outside, root.join("outside")).unwrap();
    authorize_workspace_root("symlink-w", &root).unwrap();

    // A link planted in the workspace must not become a way to move or trash
    // something it points at outside the grant.
    assert!(assert_workspace_entry_mutable(Some("symlink-w"), &root, "leak.md").is_err());
    assert!(assert_workspace_entry_mutable(Some("symlink-w"), &root, "outside").is_err());
    assert!(secret.exists());
    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(outside).ok();
}
