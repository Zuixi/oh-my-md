use super::dispatch::dispatch_after;
use super::{ExportDelegate, ExportWarning, RenderOutput};
use crate::export::export_page::{self, PageSetup};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSPaperOrientation, NSPrintHeaderAndFooter, NSPrintInfo, NSPrintJobDisposition,
    NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode,
};
use objc2_foundation::{
    MainThreadMarker, NSCopying, NSMutableDictionary, NSNumber, NSObject, NSObjectProtocol, NSSize,
    NSString, NSURL,
};
use objc2_web_kit::WKWebView;
use std::cell::RefCell;
use std::os::raw::c_void;
use std::path::PathBuf;

pub(super) const PRINT_TIMEOUT_SECS: u64 = 120;
const POINTS_PER_INCH: f64 = 72.0;

struct PrintJob {
    delegate: Retained<ExportDelegate>,
    warning: Option<ExportWarning>,
    _temp_dir: tempfile::TempDir,
    target: PathBuf,
}

pub(super) struct PrintRunIvars {
    job: RefCell<Option<PrintJob>>,
}

struct CompleteState {
    delegate: Retained<ExportDelegate>,
    result: Result<RenderOutput, String>,
}

unsafe extern "C" fn complete_trampoline(context: *mut c_void) {
    let state = unsafe { Box::from_raw(context as *mut CompleteState) };
    state.delegate.finish_print(state.result);
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = PrintRunIvars]
    pub(super) struct PrintRunDelegate;

    unsafe impl NSObjectProtocol for PrintRunDelegate {}

    impl PrintRunDelegate {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn print_operation_did_run(
            &self,
            _operation: &NSPrintOperation,
            success: bool,
            _context_info: *mut c_void,
        ) {
            let job = self.ivars().job.borrow_mut().take();
            unpark_print_delegate(self);
            let Some(job) = job else {
                return;
            };
            let result = if !success {
                Err("macOS PDF printing did not complete".into())
            } else {
                read_validated_pdf(&job.target).map(|bytes| RenderOutput {
                    bytes,
                    warning: job.warning,
                })
            };
            let ctx = Box::into_raw(Box::new(CompleteState {
                delegate: job.delegate,
                result,
            })) as *mut c_void;
            dispatch_after(0, ctx, complete_trampoline);
        }
    }
);

thread_local! {
    static LIVE_PRINT_DELEGATES: RefCell<Vec<Retained<PrintRunDelegate>>> =
        const { RefCell::new(Vec::new()) };
}

impl PrintRunDelegate {
    fn create(mtm: MainThreadMarker, job: PrintJob) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(PrintRunIvars {
            job: RefCell::new(Some(job)),
        });
        unsafe { msg_send![super(this), init] }
    }
}

fn unpark_print_delegate(delegate: &PrintRunDelegate) {
    LIVE_PRINT_DELEGATES.with(|live| {
        live.borrow_mut()
            .retain(|item| !std::ptr::eq(&**item, delegate));
    });
}

fn build_print_info(
    page: &PageSetup,
    target: &std::path::Path,
) -> Result<Retained<NSPrintInfo>, String> {
    let target_str = target
        .to_str()
        .ok_or_else(|| "staged PDF path is not valid UTF-8".to_string())?;
    let native = export_page::native_page(page);
    let shared_dict = unsafe { NSPrintInfo::sharedPrintInfo().dictionary() };
    let dict = NSMutableDictionary::dictionaryWithDictionary(&shared_dict);
    let url = NSURL::fileURLWithPath(&NSString::from_str(target_str));
    unsafe {
        let disposition_key: &ProtocolObject<dyn NSCopying> =
            ProtocolObject::from_ref(NSPrintJobDisposition);
        let url_key: &ProtocolObject<dyn NSCopying> = ProtocolObject::from_ref(NSPrintJobSavingURL);
        let hf_key: &ProtocolObject<dyn NSCopying> =
            ProtocolObject::from_ref(NSPrintHeaderAndFooter);
        dict.setObject_forKey(
            &*(NSPrintSaveJob as *const _ as *const AnyObject),
            disposition_key,
        );
        dict.setObject_forKey(&*(&*url as *const _ as *const AnyObject), url_key);
        let hf = NSNumber::new_bool(native.header_footer);
        dict.setObject_forKey(&*(&*hf as *const _ as *const AnyObject), hf_key);
    }
    let print_info = unsafe { NSPrintInfo::initWithDictionary(NSPrintInfo::alloc(), &dict) };
    print_info.setPaperSize(NSSize::new(
        native.width_in * POINTS_PER_INCH,
        native.height_in * POINTS_PER_INCH,
    ));
    print_info.setOrientation(if native.landscape {
        NSPaperOrientation::Landscape
    } else {
        NSPaperOrientation::Portrait
    });
    print_info.setTopMargin(native.margin_top_in * POINTS_PER_INCH);
    print_info.setBottomMargin(native.margin_bottom_in * POINTS_PER_INCH);
    print_info.setLeftMargin(native.margin_left_in * POINTS_PER_INCH);
    print_info.setRightMargin(native.margin_right_in * POINTS_PER_INCH);
    print_info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    print_info.setHorizontallyCentered(false);
    print_info.setVerticallyCentered(false);
    Ok(print_info)
}

fn read_validated_pdf(target: &std::path::Path) -> Result<Vec<u8>, String> {
    let bytes =
        std::fs::read(target).map_err(|error| format!("could not read printed PDF: {error}"))?;
    let tail = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(1024)..]);
    if !bytes.starts_with(b"%PDF-") || !tail.trim_end().ends_with("%%EOF") {
        return Err("macOS did not produce a valid PDF".into());
    }
    Ok(bytes)
}

pub(super) fn print_pdf(
    delegate: Retained<ExportDelegate>,
    webview: Retained<WKWebView>,
    warning: Option<ExportWarning>,
) {
    if !delegate.is_pending() || delegate.cancel_requested() {
        return;
    }
    let mtm = MainThreadMarker::new().expect("PDF print must run on the main thread");
    let window = match delegate.window_clone() {
        Some(window) => window,
        None => {
            delegate.complete(Err("export window closed before printing".into()));
            return;
        }
    };
    let temp_dir = match tempfile::tempdir() {
        Ok(dir) => dir,
        Err(error) => {
            delegate.complete(Err(format!("could not stage PDF export: {error}")));
            return;
        }
    };
    let target = temp_dir.path().join("export.pdf");
    let print_info = match build_print_info(delegate.page_setup(), &target) {
        Ok(info) => info,
        Err(error) => {
            delegate.complete(Err(error));
            return;
        }
    };
    let op = unsafe { webview.printOperationWithPrintInfo(&print_info) };
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    let header_title = &delegate.page_setup().header_title;
    if !header_title.is_empty() {
        op.setJobTitle(Some(&NSString::from_str(header_title)));
    }

    let run_delegate = PrintRunDelegate::create(
        mtm,
        PrintJob {
            delegate: delegate.clone(),
            warning,
            _temp_dir: temp_dir,
            target,
        },
    );
    delegate.set_printing(true);
    LIVE_PRINT_DELEGATES.with(|live| live.borrow_mut().push(run_delegate.clone()));

    let delegate_obj: &AnyObject = &run_delegate;
    unsafe {
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &window,
            Some(delegate_obj),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }
}
