use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::menu::{
    AboutMetadata, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem,
    MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State};

mod labels;
pub use labels::{menu_strings, MenuLabels};

const MENU_EVENT: &str = "menu-command";

/// Project home page shown in the native About panel. Must match
/// `PROJECT_URL` in `apps/desktop/src/constants.ts`; the cross-layer test
/// pins both to the same repository slug.
const PROJECT_URL: &str = "https://github.com/Zuixi/oh-my-md";

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

pub struct MenuState {
    pub recents: Vec<String>,
    pub locale: String,
    /// Latest View-mode state reported by each window. macOS has ONE global
    /// menubar, so the checkmarks must show the focused window's toggles
    /// instead of whichever window happened to push last.
    pub view_states: HashMap<String, ViewMenuState>,
    /// The editor window the menubar currently reflects (the last one that
    /// reported focus). `None` means "no window recorded yet", which applies
    /// every incoming state so a single-window session still syncs.
    pub focused: Option<String>,
}

impl Default for MenuState {
    fn default() -> Self {
        Self {
            recents: Vec::new(),
            locale: "en".to_string(),
            view_states: HashMap::new(),
            focused: None,
        }
    }
}

/// Install the native menu and route item ids.
///
/// `new-window` creates an editor window natively; window-menu commands are
/// handled natively in Rust against the focused window (they must not reach
/// the webview); everything else is forwarded as `menu-command` to the
/// focused window only — macOS's app-level menu has no window identity, so
/// the registry's MRU decides. With zero windows the command is dropped.
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let state = MenuState::default();
    rebuild_from_state(app.handle(), &state.recents, &state.locale)?;
    app.manage(Mutex::new(state));
    app.on_menu_event(|handle, event| {
        let id = event.id().as_ref();
        if id == "new-window" {
            // A failed window creation must not crash the menu handler.
            let _ = crate::windows::create_editor_window(
                handle,
                &crate::windows::CreateWindowOptions::default(),
            );
            return;
        }
        if handle_window_command(handle, id) {
            return;
        }
        let label = {
            let registry = handle.state::<std::sync::Mutex<crate::windows::WindowRegistry>>();
            let guard = registry.lock().unwrap_or_else(|e| e.into_inner());
            focused_label(&guard, &live_editor_labels(handle))
        };
        if let Some(label) = label {
            let _ = handle.emit_to(&label, MENU_EVENT, id);
        }
        // Zero windows (macOS): no webview to receive the command — drop it.
    });
    Ok(())
}

/// Live editor-window labels. Export render hosts are deliberately excluded:
/// a menu command routed at one would be emitted into a page that has no IPC
/// capability and no menu listener.
fn live_editor_labels<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    app.webview_windows()
        .keys()
        .filter(|label| crate::windows::is_editor_window_label(label))
        .cloned()
        .collect()
}

/// Menu actions target the focused window: macOS's app-level menu has no
/// window identity, so the registry's MRU decides (fallback: any live webview).
/// Non-generic on purpose — the resolution is pure registry/label logic.
fn focused_label(
    registry: &crate::windows::WindowRegistry,
    live_labels: &[String],
) -> Option<String> {
    if let Some(focused) = registry.focused() {
        if live_labels.iter().any(|l| l == focused) {
            return Some(focused.to_string());
        }
    }
    live_labels.first().cloned()
}

fn handle_window_command<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    // Same resolution as menu forwarding: window commands act on the focused
    // window (registry MRU, fallback any live webview) — not a hardcoded
    // "main". Bring-all-to-front needs no target: it iterates every window.
    let target = if id != "window-bring-all-to-front" {
        let registry = app.state::<std::sync::Mutex<crate::windows::WindowRegistry>>();
        let guard = registry.lock().unwrap_or_else(|e| e.into_inner());
        focused_label(&guard, &live_editor_labels(app))
            .and_then(|label| app.get_webview_window(&label))
    } else {
        None
    };
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
            // Export hosts are offscreen helpers, not windows the user can
            // bring forward.
            for (label, window) in app.webview_windows() {
                if !crate::windows::is_editor_window_label(&label) {
                    continue;
                }
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
fn rebuild_from_state<R: Runtime>(
    app: &AppHandle<R>,
    recents: &[String],
    locale: &str,
) -> tauri::Result<()> {
    // The native app menu only renders as a global menubar on macOS; on
    // Windows/Linux the frontend serves an in-app menu instead (spec D2).
    // Gating here makes install/set_recent_files/set_view_state/set_menu_locale
    // natural no-ops while keeping every IPC command registered.
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let previous_checked = app.menu().as_ref().map(read_view_checks);
    let l = menu_strings(locale);
    let menu = MenuBuilder::new(app)
        .item(&app_submenu(app, &l)?)
        .item(&file_submenu(app, recents, &l)?)
        .item(&edit_submenu(app, &l)?)
        .item(&format_submenu(app, &l)?)
        .item(&view_submenu(app, &l)?)
        .item(&window_submenu(app, &l)?)
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
pub fn set_recent_files(app: &AppHandle, paths: &[String]) -> Result<(), String> {
    if let Some(state) = app.try_state::<Mutex<MenuState>>() {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.recents = paths.to_vec();
        let locale = g.locale.clone();
        drop(g);
        return rebuild_from_state(app, paths, &locale).map_err(|e| e.to_string());
    }
    rebuild_from_state(app, paths, "en").map_err(|e| e.to_string())
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

/// Records one window's View state and reflects it in the menubar only when
/// that window owns the menubar (it is the focused editor window, or no window
/// has reported focus yet). Without this, the last window to toggle a mode
/// painted its checkmarks globally.
pub fn set_window_view_state<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    state: ViewMenuState,
) {
    let Some(managed) = app.try_state::<Mutex<MenuState>>() else {
        // Menu not installed yet (tests, non-macOS): still show the state.
        set_view_state(app, &state);
        return;
    };
    let owns_menu = {
        let mut guard = managed.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .view_states
            .insert(window_label.to_string(), state.clone());
        owns_menubar(guard.focused.as_deref(), window_label)
    };
    if owns_menu {
        set_view_state(app, &state);
    }
}

/// Whether `window_label`'s View state should be painted into the single
/// global menubar. Pure so the multi-window rule is unit-testable.
fn owns_menubar(focused: Option<&str>, window_label: &str) -> bool {
    focused.is_none_or(|focused| focused == window_label)
}

/// Focus moved to `window_label`: repaint the menubar with that window's last
/// reported View state, so switching windows cannot leave stale checkmarks.
pub fn sync_focused_window<R: Runtime>(app: &AppHandle<R>, window_label: &str) {
    let Some(managed) = app.try_state::<Mutex<MenuState>>() else {
        return;
    };
    let state = {
        let mut guard = managed.lock().unwrap_or_else(|e| e.into_inner());
        guard.focused = Some(window_label.to_string());
        guard.view_states.get(window_label).cloned()
    };
    if let Some(state) = state {
        set_view_state(app, &state);
    }
}

/// A destroyed window must not keep a View state that would be shown again by
/// a future window reusing its label.
pub fn drop_window_state<R: Runtime>(app: &AppHandle<R>, window_label: &str) {
    let Some(managed) = app.try_state::<Mutex<MenuState>>() else {
        return;
    };
    let mut guard = managed.lock().unwrap_or_else(|e| e.into_inner());
    guard.view_states.remove(window_label);
    if guard.focused.as_deref() == Some(window_label) {
        guard.focused = None;
    }
}

#[tauri::command]
pub fn set_menu_locale(
    app: AppHandle,
    locale: String,
    state: State<'_, Mutex<MenuState>>,
) -> Result<(), String> {
    {
        let mut g = state.lock().map_err(|e| e.to_string())?;
        g.locale = locale.clone();
    }
    let recents = state
        .lock()
        .map(|g| g.recents.clone())
        .map_err(|e| e.to_string())?;
    rebuild_from_state(&app, &recents, &locale).map_err(|e| e.to_string())
}

fn app_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    // The native panel is the only About surface on macOS (`PredefinedMenuItem::about`
    // ignores website/license there, so the URL and build date live in `credits`).
    // No explicit `icon`: the panel falls back to NSApplication's app icon, which
    // is the full-resolution bundle icon. `default_window_icon()` would be the
    // first PNG in `bundle.icon` (32x32) and visibly soft.
    let package = app.package_info();
    let build_year = crate::build_info::BUILD_DATE
        .split('-')
        .next()
        .unwrap_or("2026");
    let metadata = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: Some(format!("© {build_year} oh-my-md Contributors")),
        credits: Some(format!(
            "{} {}\n{PROJECT_URL}",
            l.build,
            crate::build_info::BUILD_DATE
        )),
        ..Default::default()
    };
    SubmenuBuilder::new(app, l.app_menu)
        .item(&PredefinedMenuItem::about(
            app,
            Some(l.about),
            Some(metadata),
        )?)
        .separator()
        .item(&item(app, "check-updates", l.check_updates, None)?)
        .item(&item(
            app,
            "export-diagnostics",
            l.export_diagnostics,
            None,
        )?)
        .item(&item(app, "open-log-folder", l.open_log_folder, None)?)
        .separator()
        .item(&item(
            app,
            "preferences",
            l.preferences,
            Some("CmdOrCtrl+,"),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some(l.services))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some(l.hide))?)
        .item(&PredefinedMenuItem::hide_others(app, Some(l.hide_others))?)
        .item(&PredefinedMenuItem::show_all(app, Some(l.show_all))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some(l.quit))?)
        .build()
}

fn file_submenu<R: Runtime, M: Manager<R>>(
    app: &M,
    recents: &[String],
    l: &MenuLabels,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, l.file)
        .item(&item(app, "new", l.new, Some("CmdOrCtrl+N"))?)
        .item(&item(
            app,
            "new-window",
            l.new_window,
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .item(&item(app, "open-file", l.open_file, Some("CmdOrCtrl+O"))?)
        .item(&item(app, "quick-open", l.quick_open, Some("CmdOrCtrl+P"))?)
        .item(&item(app, "open-folder", l.open_folder, None)?)
        .item(&recents_submenu(app, recents, l)?)
        .separator()
        .item(&item(app, "close", l.close, Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&item(app, "save", l.save, Some("CmdOrCtrl+S"))?)
        .item(&item(app, "save-as", l.save_as, Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item(app, "version-history", l.version_history, None)?)
        .separator()
        .item(&export_submenu(app, l)?)
        .build()
}

fn recents_submenu<R: Runtime, M: Manager<R>>(
    app: &M,
    recents: &[String],
    l: &MenuLabels,
) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::new(app, l.open_recent);
    if recents.is_empty() {
        let empty = MenuItemBuilder::with_id("no-recent", l.no_recent)
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
        .item(&item(app, "clear-recents", l.clear_recents, None)?)
        .build()
}

fn export_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    let mut builder =
        SubmenuBuilder::new(app, l.export).item(&item(app, "export-html", l.export_html, None)?);
    if cfg!(target_os = "macos") {
        builder = builder.item(&item(app, "export-pdf", l.export_pdf, None)?);
    }
    builder
        .item(&item(app, "export-image", l.export_image, None)?)
        .build()
}

fn edit_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, l.edit)
        .undo_with_text(l.undo)
        .redo_with_text(l.redo)
        .separator()
        .cut_with_text(l.cut)
        .copy_with_text(l.copy)
        .paste_with_text(l.paste)
        .item(&item(
            app,
            "paste-plain-text",
            l.paste_plain_text,
            Some("CmdOrCtrl+Shift+V"),
        )?)
        .select_all_with_text(l.select_all)
        .separator()
        .item(&find_submenu(app, l)?)
        .build()
}

fn find_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, l.find)
        .item(&item(app, "find", l.find_in_document, Some("CmdOrCtrl+F"))?)
        .item(&item(
            app,
            "search",
            l.search_in_folder,
            Some("CmdOrCtrl+Shift+F"),
        )?)
        .build()
}

fn format_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, l.format)
        .item(&item(app, "bold", l.bold, Some("CmdOrCtrl+B"))?)
        .item(&item(app, "italic", l.italic, Some("CmdOrCtrl+I"))?)
        .item(&item(app, "underline", l.underline, Some("CmdOrCtrl+U"))?)
        .item(&item(
            app,
            "strikethrough",
            l.strikethrough,
            Some("CmdOrCtrl+Shift+X"),
        )?)
        .item(&item(
            app,
            "inline-code",
            l.inline_code,
            Some("CmdOrCtrl+`"),
        )?)
        .item(&item(
            app,
            "code-block",
            l.code_block,
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .separator()
        .item(&item(app, "heading-1", l.heading_1, Some("CmdOrCtrl+1"))?)
        .item(&item(app, "heading-2", l.heading_2, Some("CmdOrCtrl+2"))?)
        .item(&item(app, "heading-3", l.heading_3, Some("CmdOrCtrl+3"))?)
        .item(&item(app, "heading-4", l.heading_4, Some("CmdOrCtrl+4"))?)
        .item(&item(app, "heading-5", l.heading_5, Some("CmdOrCtrl+5"))?)
        .item(&item(app, "heading-6", l.heading_6, Some("CmdOrCtrl+6"))?)
        .separator()
        .item(&item(
            app,
            "unordered-list",
            l.unordered_list,
            Some("CmdOrCtrl+Alt+8"),
        )?)
        .item(&item(
            app,
            "ordered-list",
            l.ordered_list,
            Some("CmdOrCtrl+Alt+7"),
        )?)
        .item(&item(
            app,
            "blockquote",
            l.blockquote,
            Some("CmdOrCtrl+Alt+9"),
        )?)
        .separator()
        .item(&item(app, "link", l.insert_link, Some("CmdOrCtrl+K"))?)
        .item(&item(app, "insert-image", l.insert_image, None)?)
        .build()
}

fn view_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, l.view)
        .item(&check_item(
            app,
            "view-source",
            l.show_source_code,
            Some("CmdOrCtrl+E"),
        )?)
        .item(&check_item(
            app,
            "view-sidebar",
            l.show_hide_sidebar,
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&check_item(
            app,
            "view-outline",
            l.show_hide_outline,
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .separator()
        .item(&check_item(
            app,
            "view-typewriter",
            l.typewriter_mode,
            None,
        )?)
        .item(&check_item(app, "view-focus", l.focus_mode, None)?)
        .separator()
        .item(&item(app, "toggle-theme", l.toggle_theme, None)?)
        .item(&item(app, "load-css", l.load_custom_css, None)?)
        .build()
}

fn window_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    // Regular items with stable ids, handled natively in `handle_window_command`.
    // Predefined window items are avoided: their macOS selectors go through the
    // responder chain and do not act on the Tauri window.
    SubmenuBuilder::new(app, l.window)
        .item(&item(
            app,
            "window-minimize",
            l.minimize,
            Some("CmdOrCtrl+M"),
        )?)
        .item(&item(app, "window-zoom", l.zoom, None)?)
        .separator()
        .item(&item(app, "window-fullscreen", l.toggle_full_screen, None)?)
        .separator()
        .item(&item(
            app,
            "window-bring-all-to-front",
            l.bring_all_to_front,
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
#[path = "menu_tests.rs"]
mod tests;
