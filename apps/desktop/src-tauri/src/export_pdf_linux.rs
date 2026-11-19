use crate::export::export_page::{self, PageSetup};
use gtk::{PageOrientation, PageSetup as GtkPageSetup, PaperSize, PrintSettings, Unit};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use tauri::WebviewWindow;
use webkit2gtk::{PrintOperation, PrintOperationExt, SettingsExt, WebViewExt};

const PRINT_TIMEOUT: Duration = Duration::from_secs(120);
const MM_PER_INCH: f64 = 25.4;

struct ActivePrint {
    _op: PrintOperation,
    _dir: Arc<tempfile::TempDir>,
}

pub(super) fn print_pdf(window: &WebviewWindow, page: &PageSetup) -> Result<Vec<u8>, String> {
    let native = export_page::native_page(page);
    let directory = Arc::new(
        tempfile::tempdir().map_err(|error| format!("could not stage PDF export: {error}"))?,
    );
    let target = directory.path().join("export.pdf");
    let uri = tauri::Url::from_file_path(&target)
        .map_err(|()| "could not build file URI for staged PDF".to_string())?
        .to_string();

    let signal_dir = Arc::clone(&directory);
    let printed = super::with_view(window, PRINT_TIMEOUT, move |view, tx| {
        if let Some(settings) = view.settings() {
            settings.set_print_backgrounds(native.print_backgrounds);
        }
        let print_settings = PrintSettings::new();
        print_settings.set_printer("Print to File");
        print_settings.set("output-file-format", Some("pdf"));
        print_settings.set("output-uri", Some(&uri));

        let paper = PaperSize::new_custom(
            "omd-custom",
            "omd-custom",
            native.width_in * MM_PER_INCH,
            native.height_in * MM_PER_INCH,
            Unit::Mm,
        );
        let page_setup = GtkPageSetup::new();
        page_setup.set_paper_size(&paper);
        page_setup.set_orientation(if native.landscape {
            PageOrientation::Landscape
        } else {
            PageOrientation::Portrait
        });
        page_setup.set_top_margin(native.margin_top_in * MM_PER_INCH, Unit::Mm);
        page_setup.set_bottom_margin(native.margin_bottom_in * MM_PER_INCH, Unit::Mm);
        page_setup.set_left_margin(native.margin_left_in * MM_PER_INCH, Unit::Mm);
        page_setup.set_right_margin(native.margin_right_in * MM_PER_INCH, Unit::Mm);

        let op = PrintOperation::new(&view);
        op.set_print_settings(&print_settings);
        op.set_page_setup(&page_setup);

        let active = Rc::new(RefCell::new(Some(ActivePrint {
            _op: op.clone(),
            _dir: signal_dir,
        })));
        let finished_active = Rc::clone(&active);
        let finished_tx = tx.clone();
        op.connect_finished(move |_| {
            if finished_active.borrow_mut().take().is_some() {
                let _ = finished_tx.send(Ok(()));
            }
        });

        let failed_active = Rc::clone(&active);
        op.connect_failed(move |_, error| {
            if failed_active.borrow_mut().take().is_some() {
                let _ = tx.send(Err(format!("WebKitGTK PDF printing failed: {error}")));
            }
        });

        op.print();
    });

    if let Err(error) = printed {
        if error == super::CALLBACK_TIMED_OUT {
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
        std::fs::read(&target).map_err(|error| format!("could not read printed PDF: {error}"))?;
    let tail = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(1024)..]);
    if !bytes.starts_with(b"%PDF-") || !tail.trim_end().ends_with("%%EOF") {
        return Err("WebKitGTK did not produce a valid PDF".into());
    }
    Ok(bytes)
}
