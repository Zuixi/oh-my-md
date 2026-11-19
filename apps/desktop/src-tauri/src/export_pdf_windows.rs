//! WebView2 prints the prepared HTML using its print stylesheet and page rules.

use crate::export::export_page::{self, PageSetup};
use std::sync::Arc;
use std::time::Duration;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, HSTRING, PCWSTR};

// Long documents with many formulas can take WebView2 well over 30 s to
// paginate; the user can cancel at any time (closing the window aborts).
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) fn print_pdf(window: &WebviewWindow, page: &PageSetup) -> Result<Vec<u8>, String> {
    let native = export_page::native_page(page);
    let header_title = page.header_title.clone();
    // PrintToPdf writes directly to its path. Stage privately so a cancelled
    // or failed render never writes to the user-selected destination.
    let directory = Arc::new(
        tempfile::tempdir().map_err(|error| format!("could not stage PDF export: {error}"))?,
    );
    let target = directory.path().join("export.pdf");
    let path = HSTRING::from(target.as_os_str());
    let callback_directory = Arc::clone(&directory);
    let printed = super::with_core(window, PRINT_TIMEOUT, move |core, tx| {
        let printer: ICoreWebView2_7 = core
            .cast()
            .map_err(|error| format!("WebView2 PDF printing is unavailable: {error}"))?;
        let settings = (|| unsafe {
            let environment: ICoreWebView2Environment6 = printer.Environment()?.cast()?;
            let settings = environment.CreatePrintSettings()?;
            let orientation = if native.landscape {
                COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
            } else {
                COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
            };
            settings.SetOrientation(orientation)?;
            settings.SetPageWidth(native.width_in)?;
            settings.SetPageHeight(native.height_in)?;
            settings.SetMarginTop(native.margin_top_in)?;
            settings.SetMarginBottom(native.margin_bottom_in)?;
            settings.SetMarginLeft(native.margin_left_in)?;
            settings.SetMarginRight(native.margin_right_in)?;
            settings.SetShouldPrintBackgrounds(native.print_backgrounds)?;
            settings.SetShouldPrintHeaderAndFooter(native.header_footer)?;
            if native.header_footer {
                // Empty FooterUri keeps the local path out of the PDF. WebView2
                // still prints the page number; HeaderTitle is the document name.
                settings.SetHeaderTitle(&HSTRING::from(header_title.as_str()))?;
                settings.SetFooterUri(&HSTRING::new())?;
            }
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
    });
    if let Err(error) = printed {
        if error == super::CALLBACK_TIMED_OUT {
            // WebView2 may still hold the staged file, and `TempDir`'s drop fails
            // silently on a locked file, leaving the document in %TEMP%. Close the
            // window first so the print aborts, then remove what it wrote.
            let _ = window.close();
            if let Err(remove) = std::fs::remove_file(&target) {
                if remove.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("could not remove the staged PDF after a print timeout: {remove}");
                }
            }
        }
        return Err(error);
    }
    let bytes =
        std::fs::read(target).map_err(|error| format!("could not read printed PDF: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("WebView2 did not produce a valid PDF".into());
    }
    Ok(bytes)
}
