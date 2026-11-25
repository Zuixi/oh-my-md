//! Mutation-surface tests for the workspace commands.
//!
//! Split out of `workspace.rs` to keep that module inside its size cap. Each
//! case goes through the command function the renderer reaches, so the gate is
//! proven at the IPC boundary and not only inside `auth_scope`.

use super::*;

const LABEL: &str = "mut-w";

fn tmp(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("omd-ws-mut-{}-{name}", std::process::id()));
    fs::remove_dir_all(&path).ok();
    fs::create_dir_all(&path).unwrap();
    crate::auth_scope::authorize_workspace_root(LABEL, &path).unwrap();
    path
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn workspace_commands_cannot_enter_a_hidden_directory() {
    let root = tmp("hidden");
    let git = root.join(".git");
    fs::create_dir_all(&git).unwrap();
    fs::write(git.join("config"), "secret").unwrap();

    assert!(list_dir_sync(&text(&git), Some(LABEL)).is_err());
    assert!(search_markdown_sync(&text(&git), "secret", false, Some(LABEL)).is_err());
    assert!(list_markdown_files_sync(&text(&git), Some(LABEL)).is_err());
    assert!(create_markdown(text(&git), "a.md".into(), Some(LABEL.into())).is_err());
    assert!(create_dir(text(&git), "sub".into(), Some(LABEL.into())).is_err());
    assert!(rename_path(
        text(&git.join("config")),
        "leak.md".into(),
        Some(LABEL.into())
    )
    .is_err());
    assert!(delete_path(text(&git.join("config")), Some(LABEL.into())).is_err());
    // Nothing inside the hidden directory moved, and no visible copy appeared.
    assert_eq!(fs::read_to_string(git.join("config")).unwrap(), "secret");
    assert!(!root.join("leak.md").exists());
    fs::remove_dir_all(root).ok();
}

#[test]
fn workspace_commands_refuse_hidden_names() {
    let root = tmp("hidden-name");

    assert!(create_markdown(text(&root), ".hidden.md".into(), Some(LABEL.into())).is_err());
    assert!(create_dir(text(&root), ".hidden".into(), Some(LABEL.into())).is_err());
    assert!(!root.join(".hidden").exists());
    assert!(!root.join(".hidden.md").exists());
    fs::write(root.join("note.md"), "x").unwrap();
    assert!(rename_path(
        text(&root.join("note.md")),
        ".hidden.md".into(),
        Some(LABEL.into())
    )
    .is_err());
    assert!(root.join("note.md").exists());
    fs::remove_dir_all(root).ok();
}

#[test]
fn rename_and_delete_refuse_hidden_and_non_markdown_sources() {
    let root = tmp("non-markdown");
    for name in [".env", "Cargo.toml", "package.json"] {
        fs::write(root.join(name), "secret").unwrap();
        // The laundering path: rename a secret to a Markdown name, then read it
        // back through a document command that trusts workspace Markdown.
        assert!(rename_path(text(&root.join(name)), "leak.md".into(), Some(LABEL.into())).is_err());
        assert!(delete_path(text(&root.join(name)), Some(LABEL.into())).is_err());
        assert!(root.join(name).exists());
        assert!(!root.join("leak.md").exists());
    }
    fs::remove_dir_all(root).ok();
}

#[test]
fn rename_keeps_a_markdown_file_visible() {
    let root = tmp("rename-visible");
    fs::write(root.join("note.md"), "hello").unwrap();

    // A rename that drops the extension strands the document outside every
    // Markdown-only command, including the next rename.
    assert!(rename_path(
        text(&root.join("note.md")),
        "note".into(),
        Some(LABEL.into())
    )
    .is_err());
    assert!(rename_path(
        text(&root.join("note.md")),
        "note.txt".into(),
        Some(LABEL.into())
    )
    .is_err());
    let renamed = rename_path(
        text(&root.join("note.md")),
        "renamed.md".into(),
        Some(LABEL.into()),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(renamed).unwrap(), "hello");
    assert!(!root.join("note.md").exists());
    fs::remove_dir_all(root).ok();
}

/// Own label so the read-only verdict below cannot leak into the tests that
/// share `LABEL` (they run in parallel in one process).
const READ_ONLY_LABEL: &str = "mut-read-only";

#[test]
fn rename_and_delete_refuse_a_read_only_document() {
    let root = std::env::temp_dir().join(format!("omd-ws-mut-{}-read-only", std::process::id()));
    fs::remove_dir_all(&root).ok();
    fs::create_dir_all(&root).unwrap();
    crate::auth_scope::authorize_workspace_root(READ_ONLY_LABEL, &root).unwrap();
    let doc = root.join("huge.md");
    fs::write(&doc, "huge").unwrap();

    // The host opened this document read-only (huge tier), so neither rename
    // nor trash may pass even though the workspace root is granted.
    crate::auth_scope::set_document_access_mode(
        READ_ONLY_LABEL,
        &doc,
        crate::auth_scope::AccessMode::ReadOnly,
    );
    assert!(rename_path(
        text(&doc),
        "renamed.md".into(),
        Some(READ_ONLY_LABEL.into())
    )
    .is_err());
    assert!(delete_path(text(&doc), Some(READ_ONLY_LABEL.into())).is_err());
    assert_eq!(fs::read_to_string(&doc).unwrap(), "huge");
    assert!(!root.join("renamed.md").exists());

    // Leaving the read-only tier (file shrank) reopens both mutations.
    crate::auth_scope::set_document_access_mode(
        READ_ONLY_LABEL,
        &doc,
        crate::auth_scope::AccessMode::ReadWrite,
    );
    let renamed = rename_path(
        text(&doc),
        "renamed.md".into(),
        Some(READ_ONLY_LABEL.into()),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(renamed).unwrap(), "huge");
    fs::remove_dir_all(root).ok();
}

#[cfg(unix)]
#[test]
fn rename_and_delete_refuse_symlinks() {
    use std::os::unix::fs::symlink;

    let root = tmp("symlink");
    let outside = std::env::temp_dir().join(format!("omd-ws-mut-outside-{}", std::process::id()));
    fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("id_rsa");
    fs::write(&secret, "key").unwrap();
    symlink(&secret, root.join("leak.md")).unwrap();

    assert!(rename_path(
        text(&root.join("leak.md")),
        "public.md".into(),
        Some(LABEL.into())
    )
    .is_err());
    assert!(delete_path(text(&root.join("leak.md")), Some(LABEL.into())).is_err());
    assert_eq!(fs::read_to_string(&secret).unwrap(), "key");
    assert!(!root.join("public.md").exists());
    fs::remove_dir_all(root).ok();
    fs::remove_dir_all(outside).ok();
}
