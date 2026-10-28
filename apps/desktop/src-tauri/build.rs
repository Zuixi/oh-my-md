fn main() {
    // tauri-build embeds icons/icon.icns on macOS dev but does not emit
    // rerun-if-changed for it, so `tauri dev` keeps the previous icon.
    println!("cargo::rerun-if-changed=icons/icon.icns");
    println!("cargo::rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
