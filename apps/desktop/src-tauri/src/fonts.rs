#[cfg(target_os = "macos")]
use objc2_core_foundation::{CFArray, CFString, CFType};
#[cfg(target_os = "macos")]
use objc2_core_text::{kCTFontFamilyNameAttribute, CTFontCollection, CTFontDescriptor};
#[cfg(windows)]
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteFontCollection, IDWriteLocalizedStrings,
    DWRITE_FACTORY_TYPE_SHARED,
};

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(collect_families)
        .await
        .map_err(|error| format!("font listing task failed: {error}"))
}

fn collect_families() -> Vec<String> {
    normalize_families(raw_families())
}

fn normalize_families(raw: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut families: Vec<String> = raw
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        // Case-insensitive dedupe that keeps the first spelling seen.
        .filter(|name| seen.insert(name.to_lowercase()))
        .collect();
    families.sort_by_cached_key(|name| name.to_lowercase());
    families
}

#[cfg(target_os = "macos")]
fn raw_families() -> Vec<String> {
    // SAFETY: both calls only pass their own retained arguments (and an
    // immortal attribute-name static); no borrowed pointers outlive the calls.
    let collection = unsafe { CTFontCollection::from_available_fonts(None) };
    let Some(descriptors) = (unsafe { collection.matching_font_descriptors() }) else {
        return Vec::new();
    };
    // SAFETY: every element of a CFArray is a CFType, so viewing the opaque
    // array as CFArray<CFType> is always valid; each entry is then checked
    // with a typed downcast before use.
    let entries: &CFArray<CFType> = unsafe { descriptors.cast_unchecked::<CFType>() };
    entries
        .iter()
        .filter_map(|entry| {
            let descriptor = entry.downcast::<CTFontDescriptor>().ok()?;
            let family = unsafe { descriptor.attribute(kCTFontFamilyNameAttribute) }?;
            family
                .downcast::<CFString>()
                .ok()
                .map(|name| name.to_string())
        })
        .collect()
}

#[cfg(windows)]
fn raw_families() -> Vec<String> {
    // SAFETY: creating the shared, read-only DirectWrite factory is safe from
    // any thread and takes no caller-owned pointers.
    let Ok(factory) =
        (unsafe { DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED) })
    else {
        return Vec::new();
    };
    let mut system: Option<IDWriteFontCollection> = None;
    // SAFETY: `system` is a valid out-pointer for the duration of the call.
    if unsafe { factory.GetSystemFontCollection(&mut system, false) }.is_err() {
        return Vec::new();
    }
    let Some(system) = system else {
        return Vec::new();
    };

    let count = unsafe { system.GetFontFamilyCount() };
    (0..count)
        .filter_map(|index| {
            // SAFETY: `index` is below `count`; every out-parameter is a
            // freshly initialized local.
            let family = unsafe { system.GetFontFamily(index) }.ok()?;
            let names = unsafe { family.GetFamilyNames() }.ok()?;
            preferred_family_name(&names)
        })
        .collect()
}

/// Picks the en-US spelling of a family name, falling back to the first entry.
#[cfg(windows)]
fn preferred_family_name(names: &IDWriteLocalizedStrings) -> Option<String> {
    use windows::core::{w, BOOL};

    let mut index = 0;
    let mut exists = BOOL(0);
    // SAFETY: valid out-pointers; the locale literal is NUL-terminated UTF-16.
    let found = unsafe { names.FindLocaleName(w!("en-US"), &mut index, &mut exists) }.is_ok()
        && exists.as_bool();
    read_localized(names, if found { index } else { 0 })
}

#[cfg(windows)]
fn read_localized(names: &IDWriteLocalizedStrings, index: u32) -> Option<String> {
    let length = unsafe { names.GetStringLength(index) }.ok()? as usize;
    let mut buffer = vec![0u16; length + 1];
    // SAFETY: `buffer` spans the reported string length plus one element
    // for the NUL terminator `GetString` writes; `..length` is the name.
    unsafe { names.GetString(index, &mut buffer) }.ok()?;
    Some(String::from_utf16_lossy(&buffer[..length]))
}

// Best-effort: without fontconfig's fc-list installed there is nothing to
// report, and the picker simply offers no system families.
#[cfg(not(any(windows, target_os = "macos")))]
fn raw_families() -> Vec<String> {
    let output = std::process::Command::new("fc-list")
        .args([":", "family"])
        .output();
    match output {
        Ok(output) => String::from_utf8_lossy(&output.stdout)
            .lines()
            .flat_map(|line| line.split(','))
            .map(str::trim)
            .filter(|family| !family.is_empty())
            .map(str::to_string)
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // normalize_families must be idempotent: an already normalized list
    // (trimmed, deduped, sorted case-insensitively) round-trips unchanged.
    fn assert_normalized(families: &[String]) {
        assert_eq!(
            families,
            normalize_families(families.to_vec()).as_slice(),
            "family list must be trimmed, deduped, and sorted case-insensitively"
        );
    }

    #[test]
    fn normalize_families_dedupes_trims_and_sorts() {
        let families = normalize_families(vec![
            "  Helvetica ".to_string(),
            "ARIAL".to_string(),
            "helvetica".to_string(),
            String::new(),
            "   ".to_string(),
            "Arial".to_string(),
            "apple".to_string(),
            "Banana".to_string(),
        ]);
        assert_eq!(
            families,
            vec![
                // Case-insensitive sort: "apple" before "ARIAL"/"Banana",
                // where a byte-order sort would place every uppercase name
                // first. The first spelling ("ARIAL") wins over later
                // case variants ("Arial").
                "apple".to_string(),
                "ARIAL".to_string(),
                "Banana".to_string(),
                "Helvetica".to_string(),
            ]
        );
    }

    #[test]
    fn normalize_families_drops_all_empty_names() {
        assert_eq!(
            normalize_families(vec!["".to_string(), " \t ".to_string()]),
            Vec::<String>::new()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn collect_families_reports_system_fonts() {
        let families = collect_families();
        assert!(!families.is_empty());
        assert!(
            families
                .iter()
                .any(|family| family.eq_ignore_ascii_case("Helvetica")),
            "expected Helvetica among the {} reported families",
            families.len()
        );
        assert_normalized(&families);
    }

    #[cfg(windows)]
    #[test]
    fn collect_families_reports_system_fonts() {
        let families = collect_families();
        assert!(
            families
                .iter()
                .any(|family| family.eq_ignore_ascii_case("Segoe UI")),
            "expected Segoe UI among the {} reported families",
            families.len()
        );
        assert_normalized(&families);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn collect_families_reports_system_fonts() {
        let families = collect_families();
        assert!(!families.is_empty(), "expected fc-list to report fonts");
        assert_normalized(&families);
    }
}
