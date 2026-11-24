//! Compile-time build identity shared by both About surfaces.
//!
//! `build.rs` emits `OMD_BUILD_DATE`; every reader goes through this module so
//! the in-app dialog and the native macOS panel cannot disagree.

/// UTC date (`YYYY-MM-DD`) of the build that produced this binary.
pub const BUILD_DATE: &str = env!("OMD_BUILD_DATE");

/// Returns the build date to the About dialog.
#[tauri::command]
pub fn app_build_date() -> &'static str {
    BUILD_DATE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_date_is_an_iso_utc_day() {
        let parts: Vec<&str> = BUILD_DATE.split('-').collect();
        assert_eq!(parts.len(), 3, "expected YYYY-MM-DD, got {BUILD_DATE}");
        assert_eq!(parts[0].len(), 4);
        assert_eq!(parts[1].len(), 2);
        assert_eq!(parts[2].len(), 2);
        let month: u32 = parts[1].parse().expect("month is numeric");
        let day: u32 = parts[2].parse().expect("day is numeric");
        assert!(
            (1..=12).contains(&month),
            "month out of range: {BUILD_DATE}"
        );
        assert!((1..=31).contains(&day), "day out of range: {BUILD_DATE}");
    }
}
