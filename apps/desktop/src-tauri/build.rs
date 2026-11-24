use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // tauri-build embeds icons/icon.icns on macOS dev but does not emit
    // rerun-if-changed for it, so `tauri dev` keeps the previous icon.
    println!("cargo::rerun-if-changed=icons/icon.icns");
    println!("cargo::rerun-if-changed=icons/icon.png");
    // The build date is part of the About surfaces. Cargo only reruns this
    // script for the paths below, so every input that can relink the binary
    // without touching `src` must be tracked or the date lags the binary.
    println!("cargo::rerun-if-changed=src");
    println!("cargo::rerun-if-changed=Cargo.toml");
    println!("cargo::rerun-if-changed=Cargo.lock");
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=tauri.conf.json");
    println!("cargo::rerun-if-changed=capabilities");
    println!("cargo::rerun-if-changed=../dist");
    println!("cargo::rerun-if-env-changed=SOURCE_DATE_EPOCH");

    println!("cargo::rustc-env=OMD_BUILD_DATE={}", build_date());
    tauri_build::build()
}

/// UTC `YYYY-MM-DD` for the build. `SOURCE_DATE_EPOCH` wins so reproducible
/// builds keep the date their environment declares.
fn build_date() -> String {
    let seconds = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0)
        });
    utc_date_from_unix_seconds(seconds)
}

/// Civil date from Unix seconds (Howard Hinnant's days-to-civil algorithm).
/// Kept dependency-free: a build script should not pull a calendar crate just
/// to format one date.
fn utc_date_from_unix_seconds(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}
