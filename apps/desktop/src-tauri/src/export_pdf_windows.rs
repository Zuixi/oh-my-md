//! WebView2 prints the prepared HTML using its print stylesheet and page rules.

use std::sync::Arc;
use std::time::Duration;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, HSTRING, PCWSTR};

// Long documents with many formulas can take WebView2 well over 30 s to
// paginate; the user can cancel at any time (closing the window aborts).
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) fn print_pdf(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    // PrintToPdf writes directly to its path. Stage privately so a cancelled
    // or failed render never writes to the user-selected destination.
    let directory = Arc::new(
        tempfile::tempdir().map_err(|error| format!("could not stage PDF export: {error}"))?,
    );
    let target = directory.path().join("export.pdf");
    let path = HSTRING::from(target.as_os_str());
    let callback_directory = Arc::clone(&directory);
    super::with_core(window, PRINT_TIMEOUT, move |core, tx| {
        let printer: ICoreWebView2_7 = core
            .cast()
            .map_err(|error| format!("WebView2 PDF printing is unavailable: {error}"))?;
        let settings = (|| unsafe {
            let environment: ICoreWebView2Environment6 = printer.Environment()?.cast()?;
            let settings = environment.CreatePrintSettings()?;
            settings.SetShouldPrintBackgrounds(true)?;
            settings.SetShouldPrintHeaderAndFooter(false)?;
            Ok::<_, windows::core::Error>(settings)
        })()
        .map_err(|error| format!("could not configure WebView2 PDF printing: {error}"))?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
            // Keep staging alive until WebView2 releases the handler, even on timeout.
            let _directory = callback_directory;
            let result = status
                .map_err(|error| format!("WebView2 PDF printing failed: {error}"))
                .and_then(|()| {
                    success
                        .then_some(())
                        .ok_or_else(|| "WebView2 did not print a PDF".into())
                });
            let _ = tx.send(result);
            Ok(())
        }));
        unsafe { printer.PrintToPdf(PCWSTR(path.as_ptr()), &settings, &handler) }
            .map_err(|error| format!("could not start WebView2 PDF printing: {error}"))
    })?;
    let bytes =
        std::fs::read(target).map_err(|error| format!("could not read printed PDF: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("WebView2 did not produce a valid PDF".into());
    }
    Ok(bytes)
}
