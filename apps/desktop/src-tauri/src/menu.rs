use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, Runtime};

const MENU_EVENT: &str = "menu-command";

/// View-mode toggles mirrored as checkable native menu items. Single-word fields
/// so no serde field rename is needed on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewMenuState {
    pub source: bool,
    pub sidebar: bool,
    pub outline: bool,
    pub typewriter: bool,
    pub focus: bool,
}

/// Install the native menu and forward item ids to the webview.
///
/// Window-menu commands are handled natively in Rust (they must not reach the
/// webview); everything else is forwarded as `menu-command`.
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    rebuild(app.handle(), &[])?;
    app.on_menu_event(|handle, event| {
        if handle_window_command(handle, event.id().as_ref()) {
            return;
        }
        let _ = handle.emit(MENU_EVENT, event.id().as_ref());
    });
    Ok(())
}

fn handle_window_command<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    let target = app.get_webview_window("main");
    match id {
        "window-minimize" => {
            if let Some(window) = &target {
                let _ = window.minimize();
            }
        }
        "window-zoom" => {
            if let Some(window) = &target {
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
        }
        "window-fullscreen" => {
            if let Some(window) = &target {
                let fullscreen = window.is_fullscreen().unwrap_or(false);
                let _ = window.set_fullscreen(!fullscreen);
            }
        }
        "window-bring-all-to-front" => {
            for window in app.webview_windows().values() {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        _ => return false,
    }
    true
}

/// Rebuild the application menu, including Open Recent entries.
///
/// The View checkbox states survive a rebuild so `set_recent_files` does not
/// silently uncheck them; the frontend still owns the truth and re-syncs via
/// `set_view_state` whenever it changes.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>, recents: &[String]) -> tauri::Result<()> {
    let previous_checked = app.menu().as_ref().map(read_view_checks);
    let menu = MenuBuilder::new(app)
        .item(&app_submenu(app)?)
        .item(&file_submenu(app, recents)?)
        .item(&edit_submenu(app)?)
        .item(&format_submenu(app)?)
        .item(&view_submenu(app)?)
        .item(&window_submenu(app)?)
        .build()?;
    app.set_menu(menu)?;
    if let Some(checked) = previous_checked {
        if let Some(current) = app.menu() {
            apply_view_checks(&current, &checked);
        }
    }
    Ok(())
}

const VIEW_CHECK_IDS: [&str; 5] = [
    "view-source",
    "view-sidebar",
    "view-outline",
    "view-typewriter",
    "view-focus",
];

fn read_view_checks<R: Runtime>(menu: &Menu<R>) -> [bool; 5] {
    std::array::from_fn(|i| {
        let id: &str = VIEW_CHECK_IDS[i];
        match menu.get(id) {
            Some(kind) => kind
                .as_check_menuitem()
                .and_then(|item| item.is_checked().ok())
                .unwrap_or(false),
            None => false,
        }
    })
}

fn apply_view_checks<R: Runtime>(menu: &Menu<R>, checked: &[bool; 5]) {
    for (i, &on) in checked.iter().enumerate() {
        let id: &str = VIEW_CHECK_IDS[i];
        if let Some(kind) = menu.get(id) {
            if let Some(item) = kind.as_check_menuitem() {
                let _ = item.set_checked(on);
            }
        }
    }
}

/// Replace Open Recent items after the frontend persists a new list.
pub fn set_recent_files(app: &AppHandle, paths: &[String]) -> tauri::Result<()> {
    rebuild(app, paths)
}

/// Mirror the frontend view-mode state into the checkable View menu items.
pub fn set_view_state<R: Runtime>(app: &AppHandle<R>, state: &ViewMenuState) {
    let Some(menu) = app.menu() else { return };
    let set = |id: &str, checked: bool| {
        if let Some(kind) = menu.get(id) {
            if let Some(item) = kind.as_check_menuitem() {
                let _ = item.set_checked(checked);
            }
        }
    };
    set("view-source", state.source);
    set("view-sidebar", state.sidebar);
    set("view-outline", state.outline);
    set("view-typewriter", state.typewriter);
    set("view-focus", state.focus);
}

fn app_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "oh-my-md")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&item(app, "preferences", "Settings…", Some("CmdOrCtrl+,"))?)
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
        .separator()
        .item(&find_submenu(app)?)
        .build()
}

fn find_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Find")
        .item(&item(app, "find", "Find in Document", Some("CmdOrCtrl+F"))?)
        .item(&item(
            app,
            "search",
            "Search in Folder",
            Some("CmdOrCtrl+Shift+F"),
        )?)
        .build()
}

fn format_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "Format")
        .item(&item(app, "bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&item(app, "italic", "Italic", Some("CmdOrCtrl+I"))?)
        .item(&item(
            app,
            "strikethrough",
            "Strikethrough",
            Some("CmdOrCtrl+Shift+X"),
        )?)
        .item(&item(
            app,
            "inline-code",
            "Inline Code",
            Some("CmdOrCtrl+Shift+`"),
        )?)
        .item(&item(
            app,
            "code-block",
            "Code Block",
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .separator()
        .item(&item(app, "heading-1", "Heading 1", Some("CmdOrCtrl+1"))?)
        .item(&item(app, "heading-2", "Heading 2", Some("CmdOrCtrl+2"))?)
        .item(&item(app, "heading-3", "Heading 3", Some("CmdOrCtrl+3"))?)
        .item(&item(app, "heading-4", "Heading 4", Some("CmdOrCtrl+4"))?)
        .item(&item(app, "heading-5", "Heading 5", Some("CmdOrCtrl+5"))?)
        .item(&item(app, "heading-6", "Heading 6", Some("CmdOrCtrl+6"))?)
        .separator()
        .item(&item(
            app,
            "unordered-list",
            "Bulleted List",
            Some("CmdOrCtrl+Alt+8"),
        )?)
        .item(&item(
            app,
            "ordered-list",
            "Numbered List",
            Some("CmdOrCtrl+Alt+7"),
        )?)
        .item(&item(
            app,
            "blockquote",
            "Blockquote",
            Some("CmdOrCtrl+Alt+9"),
        )?)
        .separator()
        .item(&item(app, "link", "Insert Link", Some("CmdOrCtrl+K"))?)
        .item(&item(app, "insert-image", "Insert Image…", None)?)
        .build()
}

fn view_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, "View")
        .item(&check_item(
            app,
            "view-source",
            "Show Source Code",
            Some("CmdOrCtrl+E"),
        )?)
        .item(&check_item(
            app,
            "view-sidebar",
            "Show/Hide Sidebar",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&check_item(
            app,
            "view-outline",
            "Show/Hide Outline",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .separator()
        .item(&check_item(
            app,
            "view-typewriter",
            "Typewriter Mode",
            None,
        )?)
        .item(&check_item(app, "view-focus", "Focus Mode", None)?)
        .separator()
        .item(&item(app, "toggle-theme", "Toggle Theme", None)?)
        .item(&item(app, "load-css", "Load Custom CSS", None)?)
        .build()
}

fn window_submenu<R: Runtime, M: Manager<R>>(app: &M) -> tauri::Result<Submenu<R>> {
    // Regular items with stable ids, handled natively in `handle_window_command`.
    // Predefined window items are avoided: their macOS selectors go through the
    // responder chain and do not act on the Tauri window.
    SubmenuBuilder::new(app, "Window")
        .item(&item(
            app,
            "window-minimize",
            "Minimize",
            Some("CmdOrCtrl+M"),
        )?)
        .item(&item(app, "window-zoom", "Zoom", None)?)
        .separator()
        .item(&item(app, "window-fullscreen", "Toggle Full Screen", None)?)
        .separator()
        .item(&item(
            app,
            "window-bring-all-to-front",
            "Bring All to Front",
            None,
        )?)
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

fn check_item<R: Runtime, M: Manager<R>>(
    app: &M,
    id: &str,
    title: &str,
    accelerator: Option<&str>,
) -> tauri::Result<CheckMenuItem<R>> {
    let mut builder = CheckMenuItemBuilder::with_id(id, title);
    if let Some(keys) = accelerator {
        builder = builder.accelerator(keys);
    }
    builder.build(app)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::ViewMenuState;

    #[test]
    fn view_menu_state_serializes_flat_keys() {
        let state = ViewMenuState {
            source: true,
            sidebar: false,
            outline: true,
            typewriter: false,
            focus: true,
        };
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({"source": true, "sidebar": false, "outline": true, "typewriter": false, "focus": true})
        );
    }
}
