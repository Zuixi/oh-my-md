use std::path::Path;
use std::sync::Mutex;
use tauri::menu::{
    MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State};

const MENU_EVENT: &str = "menu-command";

#[derive(Clone)]
pub struct MenuLabels {
    pub app_menu: &'static str,
    pub preferences: &'static str,
    pub file: &'static str,
    pub new: &'static str,
    pub open_file: &'static str,
    pub open_folder: &'static str,
    pub open_recent: &'static str,
    pub no_recent: &'static str,
    pub clear_recents: &'static str,
    pub close: &'static str,
    pub save: &'static str,
    pub save_as: &'static str,
    pub export: &'static str,
    pub export_html: &'static str,
    pub export_pdf: &'static str,
    pub export_image: &'static str,
}

pub fn menu_strings(locale: &str) -> MenuLabels {
    match locale {
        "zh" => MenuLabels {
            app_menu: "oh-my-md",
            preferences: "设置…",
            file: "文件",
            new: "新建",
            open_file: "打开…",
            open_folder: "打开文件夹…",
            open_recent: "最近打开",
            no_recent: "无最近文件",
            clear_recents: "清除菜单",
            close: "关闭",
            save: "保存",
            save_as: "另存为…",
            export: "导出",
            export_html: "HTML…",
            export_pdf: "PDF…",
            export_image: "图片…",
        },
        _ => MenuLabels {
            app_menu: "oh-my-md",
            preferences: "Settings…",
            file: "File",
            new: "New",
            open_file: "Open…",
            open_folder: "Open Folder…",
            open_recent: "Open Recent",
            no_recent: "No Recent Files",
            clear_recents: "Clear Menu",
            close: "Close",
            save: "Save",
            save_as: "Save As…",
            export: "Export",
            export_html: "HTML…",
            export_pdf: "PDF…",
            export_image: "Image…",
        },
    }
}

pub struct MenuState {
    pub recents: Vec<String>,
    pub locale: String,
}

impl Default for MenuState {
    fn default() -> Self {
        Self {
            recents: Vec::new(),
            locale: "en".to_string(),
        }
    }
}

/// Install the native File / Edit menus and forward item ids to the webview.
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let state = MenuState::default();
    rebuild_from_state(app.handle(), &state.recents, &state.locale)?;
    app.manage(Mutex::new(state));
    app.on_menu_event(|handle, event| {
        let _ = handle.emit(MENU_EVENT, event.id().as_ref());
    });
    Ok(())
}

fn rebuild_from_state<R: Runtime>(
    app: &AppHandle<R>,
    recents: &[String],
    locale: &str,
) -> tauri::Result<()> {
    let l = menu_strings(locale);
    let menu = MenuBuilder::new(app)
        .item(&app_submenu(app, &l)?)
        .item(&file_submenu(app, recents, &l)?)
        .item(&edit_submenu(app)?)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
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
    SubmenuBuilder::new(app, l.app_menu)
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&item(
            app,
            "preferences",
            l.preferences,
            Some("CmdOrCtrl+,"),
        )?)
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
    l: &MenuLabels,
) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, l.file)
        .item(&item(app, "new", l.new, Some("CmdOrCtrl+N"))?)
        .item(&item(app, "open-file", l.open_file, Some("CmdOrCtrl+O"))?)
        .item(&item(app, "open-folder", l.open_folder, None)?)
        .item(&recents_submenu(app, recents, l)?)
        .separator()
        .item(&item(app, "close", l.close, Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&item(app, "save", l.save, Some("CmdOrCtrl+S"))?)
        .item(&item(app, "save-as", l.save_as, Some("CmdOrCtrl+Shift+S"))?)
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
    SubmenuBuilder::new(app, l.export)
        .item(&item(app, "export-html", l.export_html, None)?)
        .item(&item(app, "export-pdf", l.export_pdf, None)?)
        .item(&item(app, "export-image", l.export_image, None)?)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_strings_zh_returns_chinese() {
        let l = menu_strings("zh");
        assert_eq!(l.file, "文件");
        assert_eq!(l.new, "新建");
        assert_eq!(l.save, "保存");
        assert_eq!(l.open_recent, "最近打开");
        assert_eq!(l.no_recent, "无最近文件");
        assert_eq!(l.clear_recents, "清除菜单");
    }

    #[test]
    fn menu_strings_en_returns_english() {
        let l = menu_strings("en");
        assert_eq!(l.file, "File");
        assert_eq!(l.new, "New");
        assert_eq!(l.save, "Save");
    }

    #[test]
    fn menu_strings_unknown_falls_back_to_en() {
        let l = menu_strings("fr");
        assert_eq!(l.file, "File");
    }

    #[test]
    fn menu_state_defaults() {
        let s = MenuState::default();
        assert_eq!(s.locale, "en");
        assert!(s.recents.is_empty());
    }
}
