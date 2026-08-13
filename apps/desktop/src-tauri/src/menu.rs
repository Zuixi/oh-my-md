use tauri::menu::{
    MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{App, Emitter, Runtime};

const MENU_EVENT: &str = "menu-command";

/// Install the native File / Edit menus and forward item ids to the webview.
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .item(&app_submenu(app)?)
        .item(&file_submenu(app)?)
        .item(&edit_submenu(app)?)
        .build()?;
    app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        let _ = handle.emit(MENU_EVENT, event.id().as_ref());
    });
    Ok(())
}

fn app_submenu<R: Runtime>(app: &App<R>) -> tauri::Result<Submenu<R>> {
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

fn file_submenu<R: Runtime>(app: &App<R>) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "File")
        .item(&item(app, "new-tab", "New Tab", None)?)
        .item(&item(app, "open-file", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&item(app, "open-folder", "Open Folder…", None)?)
        .item(&item(app, "save", "Save", Some("CmdOrCtrl+S"))?)
        .separator()
        .item(&item(app, "export-html", "Export HTML", None)?)
        .item(&item(app, "export-pdf", "Export PDF", None)?)
        .build()
}

fn edit_submenu<R: Runtime>(app: &App<R>) -> tauri::Result<Submenu<R>> {
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

fn item<R: Runtime>(
    app: &App<R>,
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
