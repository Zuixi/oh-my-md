//! Authorization tests for the document IPC gates.
//!
//! `documents.rs` is deliberately pure IO: every command authorizes first and
//! then hands its path to a `*_blocking` function, so the gate itself is what
//! these tests pin down. `authorize_document_ipc` is the single choke point for
//! reads, version probes, stats, streaming opens, and saves.

use super::*;

fn tmp(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("omd-doc-auth-{}-{name}", std::process::id()));
    std::fs::remove_dir_all(&path).ok();
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn write(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "x").unwrap();
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn an_ungranted_document_is_refused_before_any_io() {
    let root = tmp("ungranted");
    let doc = root.join("note.md");
    write(&doc);

    let error = authorize_document_ipc("doc-w", &path_string(&doc)).unwrap_err();

    assert!(
        matches!(error, DocumentError::PermissionDenied(_)),
        "unexpected error: {error:?}"
    );
    // The webview classifies rejections by this tag, so the wire shape is part
    // of the contract: a rename here would silently disable the error UI.
    let json = serde_json::to_string(&error).unwrap();
    assert!(
        json.starts_with(r#"{"code":"permissionDenied","#),
        "unexpected payload: {json}"
    );
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn relative_and_traversal_paths_fail_validation_not_authorization() {
    assert!(matches!(
        authorize_document_ipc("doc-w", "relative/note.md"),
        Err(DocumentError::InvalidPath(_))
    ));
    assert!(matches!(
        authorize_document_ipc("doc-w", "/tmp/../etc/passwd.md"),
        Err(DocumentError::InvalidPath(_))
    ));
}

#[test]
fn a_granted_file_and_its_workspace_root_are_accepted() {
    let root = tmp("granted");
    let standalone = root.join("standalone.md");
    let inside = root.join("nested").join("inside.md");
    write(&standalone);
    write(&inside);

    crate::auth_scope::authorize_document_file("doc-w", &standalone).unwrap();
    assert!(authorize_document_ipc("doc-w", &path_string(&standalone)).is_ok());
    // A single-file grant does not reach a sibling.
    assert!(authorize_document_ipc("doc-w", &path_string(&inside)).is_err());

    crate::auth_scope::authorize_workspace_root("doc-w", &root).unwrap();
    assert!(authorize_document_ipc("doc-w", &path_string(&inside)).is_ok());
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_workspace_root_never_opens_hidden_or_non_markdown_files() {
    let root = tmp("root-scope");
    let shared = root.join("note.md");
    let secrets = [
        root.join(".ssh").join("id_rsa"),
        root.join(".git").join("config"),
        root.join(".env"),
        root.join("Cargo.toml"),
    ];
    write(&shared);
    for path in &secrets {
        write(path);
    }
    crate::auth_scope::authorize_workspace_root("root-scope", &root).unwrap();

    assert!(authorize_document_ipc("root-scope", &path_string(&shared)).is_ok());
    for path in &secrets {
        assert!(
            authorize_document_ipc("root-scope", &path_string(path)).is_err(),
            "{path:?} must stay closed inside a workspace root"
        );
    }
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_missing_document_is_authorized_so_reads_report_missing() {
    let root = tmp("missing");
    let doc = root.join("draft.md");
    crate::auth_scope::authorize_document_file("doc-missing", &doc).unwrap();

    // `read_document_blocking` answers Missing for this path; the gate must not
    // turn that into PermissionDenied before the probe runs.
    assert!(authorize_document_ipc("doc-missing", &path_string(&doc)).is_ok());
    assert!(matches!(
        read_document_blocking(&path_string(&doc)).unwrap(),
        DiskSnapshot::Missing { .. }
    ));
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn the_host_derives_read_only_from_the_byte_size_not_from_the_renderer() {
    let root = tmp("read-only-threshold");
    let doc = root.join("huge.md");
    write(&doc);
    crate::auth_scope::authorize_document_file("doc-ro", &doc).unwrap();
    let requested = path_string(&doc);

    // One byte under the threshold: an ordinary writable document.
    sync_read_only_mode(
        "doc-ro",
        &requested,
        None,
        OPEN_READONLY_THRESHOLD_BYTES - 1,
    );
    assert!(authorize_document_write_ipc("doc-ro", &requested).is_ok());

    // At the threshold the host itself refuses writes while reads stay open.
    sync_read_only_mode("doc-ro", &requested, None, OPEN_READONLY_THRESHOLD_BYTES);
    assert!(authorize_document_ipc("doc-ro", &requested).is_ok());
    assert!(matches!(
        authorize_document_write_ipc("doc-ro", &requested),
        Err(DocumentError::PermissionDenied(_))
    ));

    // A shrunken file (or a reload) clears the verdict again.
    sync_read_only_mode("doc-ro", &requested, None, 0);
    assert!(authorize_document_write_ipc("doc-ro", &requested).is_ok());
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn a_read_only_document_is_refused_by_the_save_gate_but_not_the_read_gate() {
    let root = tmp("read-only-save");
    let doc = root.join("note.md");
    write(&doc);
    crate::auth_scope::authorize_workspace_root("doc-ro-save", &root).unwrap();
    let requested = path_string(&doc);

    crate::auth_scope::set_document_access_mode(
        "doc-ro-save",
        &doc,
        crate::auth_scope::AccessMode::ReadOnly,
    );

    assert!(authorize_document_ipc("doc-ro-save", &requested).is_ok());
    assert!(matches!(
        authorize_document_write_ipc("doc-ro-save", &requested),
        Err(DocumentError::PermissionDenied(_))
    ));
    // A sibling in the same root is unaffected.
    let sibling = root.join("other.md");
    write(&sibling);
    assert!(authorize_document_write_ipc("doc-ro-save", &path_string(&sibling)).is_ok());
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn revoking_a_window_closes_its_documents() {
    let root = tmp("revoked");
    let doc = root.join("note.md");
    write(&doc);
    crate::auth_scope::authorize_document_file("doc-revoke", &doc).unwrap();
    assert!(authorize_document_ipc("doc-revoke", &path_string(&doc)).is_ok());

    crate::auth_scope::revoke_window("doc-revoke");

    assert!(matches!(
        authorize_document_ipc("doc-revoke", &path_string(&doc)),
        Err(DocumentError::PermissionDenied(_))
    ));
    std::fs::remove_dir_all(root).ok();
}
