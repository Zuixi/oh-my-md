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
    assert_eq!(l.export_diagnostics, "导出诊断信息…");
}

#[test]
fn menu_strings_en_returns_english() {
    let l = menu_strings("en");
    assert_eq!(l.file, "File");
    assert_eq!(l.new, "New");
    assert_eq!(l.save, "Save");
    assert_eq!(l.check_updates, "Check for Updates…");
    assert_eq!(l.export_diagnostics, "Export Diagnostics…");
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
fn focused_label_prefers_mru_then_any_registered_window() {
    let mut r = crate::windows::WindowRegistry::default();
    assert_eq!(focused_label(&r, &[]), None);
    r.register("main");
    r.register("editor-2");
    r.note_focused("main");
    assert_eq!(
        focused_label(&r, &["main".to_string(), "editor-2".to_string()]),
        Some("main".to_string())
    );
    let mut r2 = crate::windows::WindowRegistry::default();
    r2.register("editor-2");
    // `register` seeds the MRU head, so a window never explicitly focused
    // is still the MRU pick; note_focused just re-moves it to the front.
    r2.note_focused("editor-2");
    assert_eq!(
        focused_label(&r2, &["editor-2".to_string()]),
        Some("editor-2".to_string())
    );
    // Fallback: the registry's focused label has no live webview anymore
    // (window destroyed before its Destroyed/unregister ran) — route to
    // any live webview instead of dropping the command.
    let mut r3 = crate::windows::WindowRegistry::default();
    r3.register("editor-2");
    r3.register("main"); // "main" becomes the MRU head, but only editor-2 is live
    assert_eq!(
        focused_label(&r3, &["editor-2".to_string()]),
        Some("editor-2".to_string())
    );
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
