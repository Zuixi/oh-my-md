use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::menu::{
    CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder,
    PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State};

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

#[derive(Clone)]
pub struct MenuLabels {
    pub app_menu: &'static str,
    pub preferences: &'static str,
    pub file: &'static str,
    pub new: &'static str,
    pub open_file: &'static str,
    pub quick_open: &'static str,
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
    pub edit: &'static str,
    pub find: &'static str,
    pub find_in_document: &'static str,
    pub search_in_folder: &'static str,
    pub format: &'static str,
    pub bold: &'static str,
    pub italic: &'static str,
    pub strikethrough: &'static str,
    pub inline_code: &'static str,
    pub code_block: &'static str,
    pub heading_1: &'static str,
    pub heading_2: &'static str,
    pub heading_3: &'static str,
    pub heading_4: &'static str,
    pub heading_5: &'static str,
    pub heading_6: &'static str,
    pub unordered_list: &'static str,
    pub ordered_list: &'static str,
    pub blockquote: &'static str,
    pub insert_link: &'static str,
    pub insert_image: &'static str,
    pub view: &'static str,
    pub show_source_code: &'static str,
    pub show_hide_sidebar: &'static str,
    pub show_hide_outline: &'static str,
    pub typewriter_mode: &'static str,
    pub focus_mode: &'static str,
    pub toggle_theme: &'static str,
    pub load_custom_css: &'static str,
    pub window: &'static str,
    pub minimize: &'static str,
    pub zoom: &'static str,
    pub toggle_full_screen: &'static str,
    pub bring_all_to_front: &'static str,
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub about: &'static str,
    pub check_updates: &'static str,
    pub services: &'static str,
    pub hide: &'static str,
    pub hide_others: &'static str,
    pub show_all: &'static str,
    pub quit: &'static str,
}

pub fn menu_strings(locale: &str) -> MenuLabels {
    match locale {
        "zh" => MenuLabels {
            app_menu: "oh-my-md",
            preferences: "设置…",
            file: "文件",
            new: "新建",
            open_file: "打开…",
            quick_open: "快速打开…",
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
            edit: "编辑",
            find: "查找",
            find_in_document: "在文档中查找",
            search_in_folder: "在文件夹中搜索",
            format: "格式",
            bold: "加粗",
            italic: "斜体",
            strikethrough: "删除线",
            inline_code: "行内代码",
            code_block: "代码块",
            heading_1: "一级标题",
            heading_2: "二级标题",
            heading_3: "三级标题",
            heading_4: "四级标题",
            heading_5: "五级标题",
            heading_6: "六级标题",
            unordered_list: "无序列表",
            ordered_list: "有序列表",
            blockquote: "引用",
            insert_link: "插入链接",
            insert_image: "插入图片…",
            view: "视图",
            show_source_code: "显示源码",
            show_hide_sidebar: "显示/隐藏侧边栏",
            show_hide_outline: "显示/隐藏大纲",
            typewriter_mode: "打字机模式",
            focus_mode: "专注模式",
            toggle_theme: "切换主题",
            load_custom_css: "加载自定义 CSS",
            window: "窗口",
            minimize: "最小化",
            zoom: "缩放",
            toggle_full_screen: "切换全屏",
            bring_all_to_front: "前置全部窗口",
            undo: "撤销",
            redo: "重做",
            cut: "剪切",
            copy: "拷贝",
            paste: "粘贴",
            select_all: "全选",
            about: "关于 oh-my-md",
            check_updates: "检查更新…",
            services: "服务",
            hide: "隐藏 oh-my-md",
            hide_others: "隐藏其他",
            show_all: "全部显示",
            quit: "退出 oh-my-md",
        },
        _ => MenuLabels {
            app_menu: "oh-my-md",
            preferences: "Settings…",
            file: "File",
            new: "New",
            open_file: "Open…",
            quick_open: "Quick Open…",
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
            edit: "Edit",
            find: "Find",
            find_in_document: "Find in Document",
            search_in_folder: "Search in Folder",
            format: "Format",
            bold: "Bold",
            italic: "Italic",
            strikethrough: "Strikethrough",
            inline_code: "Inline Code",
            code_block: "Code Block",
            heading_1: "Heading 1",
            heading_2: "Heading 2",
            heading_3: "Heading 3",
            heading_4: "Heading 4",
            heading_5: "Heading 5",
            heading_6: "Heading 6",
            unordered_list: "Bulleted List",
            ordered_list: "Numbered List",
            blockquote: "Blockquote",
            insert_link: "Insert Link",
            insert_image: "Insert Image…",
            view: "View",
            show_source_code: "Show Source Code",
            show_hide_sidebar: "Show/Hide Sidebar",
            show_hide_outline: "Show/Hide Outline",
            typewriter_mode: "Typewriter Mode",
            focus_mode: "Focus Mode",
            toggle_theme: "Toggle Theme",
            load_custom_css: "Load Custom CSS",
            window: "Window",
            minimize: "Minimize",
            zoom: "Zoom",
            toggle_full_screen: "Toggle Full Screen",
            bring_all_to_front: "Bring All to Front",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            about: "About oh-my-md",
            check_updates: "Check for Updates…",
            services: "Services",
            hide: "Hide oh-my-md",
            hide_others: "Hide Others",
            show_all: "Show All",
            quit: "Quit oh-my-md",
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

/// Install the native menu and forward item ids to the webview.
///
/// Window-menu commands are handled natively in Rust (they must not reach the
/// webview); everything else is forwarded as `menu-command`.
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let state = MenuState::default();
    rebuild_from_state(app.handle(), &state.recents, &state.locale)?;
    app.manage(Mutex::new(state));
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
fn rebuild_from_state<R: Runtime>(
    app: &AppHandle<R>,
    recents: &[String],
    locale: &str,
) -> tauri::Result<()> {
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
        .item(&PredefinedMenuItem::about(app, Some(l.about), None)?)
        .separator()
        .item(&item(app, "check-updates", l.check_updates, None)?)
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

fn edit_submenu<R: Runtime, M: Manager<R>>(app: &M, l: &MenuLabels) -> tauri::Result<Submenu<R>> {
    SubmenuBuilder::new(app, l.edit)
        .undo_with_text(l.undo)
        .redo_with_text(l.redo)
        .separator()
        .cut_with_text(l.cut)
        .copy_with_text(l.copy)
        .paste_with_text(l.paste)
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
            Some("CmdOrCtrl+Shift+`"),
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
mod tests {
    use serde_json::json;

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
        assert_eq!(l.check_updates, "检查更新…");
    }

    #[test]
    fn menu_strings_en_returns_english() {
        let l = menu_strings("en");
        assert_eq!(l.file, "File");
        assert_eq!(l.new, "New");
        assert_eq!(l.save, "Save");
        assert_eq!(l.check_updates, "Check for Updates…");
    }

    #[test]
    fn menu_strings_zh_returns_format_view_window_chinese() {
        let l = menu_strings("zh");
        assert_eq!(l.edit, "编辑");
        assert_eq!(l.find, "查找");
        assert_eq!(l.format, "格式");
        assert_eq!(l.bold, "加粗");
        assert_eq!(l.italic, "斜体");
        assert_eq!(l.code_block, "代码块");
        assert_eq!(l.view, "视图");
        assert_eq!(l.show_source_code, "显示源码");
        assert_eq!(l.window, "窗口");
        assert_eq!(l.minimize, "最小化");
    }

    #[test]
    fn menu_strings_en_returns_format_view_window_english() {
        let l = menu_strings("en");
        assert_eq!(l.format, "Format");
        assert_eq!(l.bold, "Bold");
        assert_eq!(l.view, "View");
        assert_eq!(l.window, "Window");
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

    #[test]
    fn menu_strings_localizes_predefined_items() {
        let z = menu_strings("zh");
        assert_eq!(z.undo, "撤销");
        assert_eq!(z.copy, "拷贝");
        assert_eq!(z.select_all, "全选");
        assert_eq!(z.quit, "退出 oh-my-md");
        let e = menu_strings("en");
        assert_eq!(e.undo, "Undo");
        assert_eq!(e.copy, "Copy");
        assert_eq!(e.quit, "Quit oh-my-md");
    }

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
