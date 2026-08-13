use std::path::Path;
use tauri::menu::{
    MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

const MENU_EVENT: &str = "menu-command";

/// Install the native File / Edit menus and forward item ids to the webview.
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    rebuild(app.handle(), &[])?;
    app.on_menu_event(|handle, event| {
        let _ = handle.emit(MENU_EVENT, event.id().as_ref());
    });
    Ok(())
}

/// Rebuild the application menu, including Open Recent entries.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, recents: &[String]) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&app_submenu(app)?)
        .item(&file_submenu(app, recents)?)
        .item(&edit_submenu(app)?)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Replace Open Recent items after the frontend persists a new list.
pub fn set_recent_files(app: &AppHandle, paths: &[String]) -> tauri::Result<()> {
    rebuild(app, paths)
}

fn app_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "oh-my-md")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()
}

fn file_submenu<R: Runtime, M: Manager<R>>(
    app: &M,
    recents: &[String],
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "File")
        .item(&item(app, "new", "New", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "open-file", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&item(app, "open-folder", "Open Folder…", None)?)
        .item(&recents_submenu(app, recents)?)
        .separator()
        .item(&item(app, "close", "Close", Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&item(app, "save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item(
            app,
            "save-as",
            "Save As…",
            Some("CmdOrCtrl+Shift+S"),
        )?)
        .separator()
        .item(&export_submenu(app)?)
        .build()
}

fn recents_submenu<R: Runtime, M: Manager<R>>(
    app: &M,
    recents: &[String],
) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::new(app, "Open Recent");
    if recents.is_empty() {
        let empty = MenuItemBuilder::with_id("no-recent", "No Recent Files")
            .enabled(false)
            .build(app)?;
        return builder.item(&empty).build();
    }
    for path in recents {
        let label = Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(path);
        builder = builder.item(&item(app, &format!("recent:{path}"), label, None)?);
    }
    builder
        .separator()
        .item(&item(app, "clear-recents", "Clear Menu", None)?)
        .build()
}

fn export_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Export")
        .item(&item(app, "export-html", "HTML…", None)?)
        .item(&item(app, "export-pdf", "PDF…", None)?)
        .item(&item(app, "export-image", "Image…", None)?)
        .build()
}

fn edit_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
}

fn item<R: Runtime, M: Manager<R>>(
    app: &M,
    id: &str,
    title: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, title);
    if let Some(keys) = accelerator {
        builder = builder.accelerator(keys);
    }
    builder.build(app)
}
