//! Runtime smoke test for the native PNG export backends.
//! Build with `--features export-smoke`; see `src/export_smoke.rs`.

fn main() {
    omd_lib::export::export_smoke::run();
}
