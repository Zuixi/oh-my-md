use super::{
    ExportFormat, ExportSpec, ExportWarning, RenderOutput, EXPORT_MIN_HEIGHT_CSS,
    EXPORT_TIMEOUT_SECS,
};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, ClassType, DefinedClass, MainThreadOnly, Message};
use objc2_app_kit::{
    NSBackingStoreType, NSBitmapImageFileType, NSBitmapImageRep, NSColor, NSDeviceRGBColorSpace,
    NSGraphicsContext, NSImage, NSRectFill, NSWindow, NSWindowStyleMask,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{
    MainThreadMarker, NSData, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSPoint,
    NSRect, NSSize, NSString,
};
use objc2_web_kit::{
    WKNavigation, WKNavigationDelegate, WKPDFConfiguration, WKWebView, WKWebViewConfiguration,
};
use std::cell::RefCell;
use std::os::raw::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const OFFSCREEN_X: f64 = -20_000.0;
const OFFSCREEN_Y: f64 = -20_000.0;
/// How long to wait for `window.__omdExportReady` before exporting anyway.
const READY_TIMEOUT: Duration = Duration::from_secs(5);
const READY_POLL_MS: u64 = 100;
/// Cancel is cooperative and checked on the main queue; 50 ms keeps the
/// offscreen window from lingering perceptibly after the user clicks Cancel.
const CANCEL_POLL_MS: u64 = 50;
/// Error reported by every timeout path so the caller sees one stable message.
const EXPORT_TIMEOUT_MESSAGE: &str = "export timed out";
/// One-shot deadline after which a parked offscreen export is closed and
/// rejected. It matches the previous channel timeout, so the cleanup does not
/// shorten the time a legitimate large export may take. Strictly shorter than
/// `EXPORT_CHANNEL_BACKSTOP` so this cleanup normally wins; otherwise a page
/// that never finishes navigating would leave its hidden window and delegate
/// parked for the life of the process.
const EXPORT_CLEANUP_MS: u64 = EXPORT_TIMEOUT_SECS * 1_000;
/// Extra time for the main-queue cleanup message to arrive before the blocking
/// channel wait gives up. The backstop only fires if the main queue never ran.
const EXPORT_BACKSTOP_GRACE_SECS: u64 = 2;
const EXPORT_CHANNEL_BACKSTOP: Duration =
    Duration::from_secs(EXPORT_TIMEOUT_SECS + EXPORT_BACKSTOP_GRACE_SECS);

#[path = "export_native_dispatch.rs"]
mod dispatch;

use dispatch::dispatch_after;

struct PollState {
    delegate: Retained<ExportDelegate>,
    webview: Retained<WKWebView>,
    deadline: Instant,
}

unsafe extern "C" fn poll_trampoline(ctx: *mut c_void) {
    let state = unsafe { Box::from_raw(ctx as *mut PollState) };
    poll_ready(*state);
}

fn schedule_poll(state: PollState, delay_ms: u64) {
    let context = Box::into_raw(Box::new(state)) as *mut c_void;
    dispatch_after(delay_ms, context, poll_trampoline);
}

struct TimeoutState {
    delegate: Retained<ExportDelegate>,
}

unsafe extern "C" fn timeout_trampoline(context: *mut c_void) {
    let state = unsafe { Box::from_raw(context as *mut TimeoutState) };
    state.delegate.fail_if_pending(EXPORT_TIMEOUT_MESSAGE);
}

struct ExportIvars {
    window: RefCell<Option<Retained<NSWindow>>>,
    webview: RefCell<Option<Retained<WKWebView>>>,
    format: ExportFormat,
    spec: ExportSpec,
    tx: RefCell<Option<mpsc::Sender<Result<RenderOutput, String>>>>,
    cancel: Arc<AtomicBool>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ExportIvars]
    struct ExportDelegate;

    unsafe impl NSObjectProtocol for ExportDelegate {}

    unsafe impl WKNavigationDelegate for ExportDelegate {
        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish_navigation(&self, webview: &WKWebView, _navigation: Option<&WKNavigation>) {
            let deadline = Instant::now() + READY_TIMEOUT;
            poll_ready(PollState {
                delegate: self.retain(),
                webview: webview.retain(),
                deadline,
            });
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail_navigation(
            &self,
            _webview: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            self.complete(Err(error.localizedDescription().to_string()));
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(
            &self,
            _webview: &WKWebView,
            _navigation: Option<&WKNavigation>,
            error: &NSError,
        ) {
            self.complete(Err(error.localizedDescription().to_string()));
        }
    }
);

thread_local! {
    static LIVE_EXPORTS: RefCell<Vec<Retained<ExportDelegate>>> = RefCell::new(Vec::new());
}

pub(crate) async fn render(
    app: AppHandle,
    html: String,
    spec: ExportSpec,
    format: ExportFormat,
    cancel: Arc<AtomicBool>,
) -> Result<RenderOutput, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || begin(html, spec, format, tx, cancel))
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(EXPORT_CHANNEL_BACKSTOP)
            .map_err(|_| EXPORT_TIMEOUT_MESSAGE.to_string())
    })
    .await
    .map_err(|error| error.to_string())??
}

fn begin(
    html: String,
    spec: ExportSpec,
    format: ExportFormat,
    tx: mpsc::Sender<Result<RenderOutput, String>>,
    cancel: Arc<AtomicBool>,
) {
    let fail = tx.clone();
    if let Err(error) = start(html, spec, format, tx, cancel) {
        let _ = fail.send(Err(error));
    }
}

fn start(
    html: String,
    spec: ExportSpec,
    format: ExportFormat,
    tx: mpsc::Sender<Result<RenderOutput, String>>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(super::export_cancel::EXPORT_CANCELLED.into());
    }
    let mtm = MainThreadMarker::new().ok_or("export must run on the main thread")?;
    let window = make_window(mtm, spec);
    let webview = make_webview(mtm, spec);
    window.setContentView(Some(webview.as_super()));
    window.orderFront(None);
    let delegate = ExportDelegate::create(mtm, window, webview.clone(), format, spec, tx, cancel);
    // Park (and arm the cleanup deadline) before navigation can report anything,
    // so every completion path finds a live `LIVE_EXPORTS` entry to remove.
    park(delegate.clone());
    unsafe { webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    unsafe { webview.loadHTMLString_baseURL(&NSString::from_str(&html), None) };
    Ok(())
}

fn make_window(mtm: MainThreadMarker, spec: ExportSpec) -> Retained<NSWindow> {
    let rect = CGRect::new(
        CGPoint::new(OFFSCREEN_X, OFFSCREEN_Y),
        CGSize::new(spec.width_css, EXPORT_MIN_HEIGHT_CSS),
    );
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window
}

fn make_webview(mtm: MainThreadMarker, spec: ExportSpec) -> Retained<WKWebView> {
    let frame = CGRect::new(
        CGPoint::ZERO,
        CGSize::new(spec.width_css, EXPORT_MIN_HEIGHT_CSS),
    );
    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &configuration) }
}

impl ExportDelegate {
    fn create(
        mtm: MainThreadMarker,
        window: Retained<NSWindow>,
        webview: Retained<WKWebView>,
        format: ExportFormat,
        spec: ExportSpec,
        tx: mpsc::Sender<Result<RenderOutput, String>>,
        cancel: Arc<AtomicBool>,
    ) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(ExportIvars {
            window: RefCell::new(Some(window)),
            webview: RefCell::new(Some(webview)),
            format,
            spec,
            tx: RefCell::new(Some(tx)),
            cancel,
        });
        unsafe { msg_send![super(this), init] }
    }

    /// Completion for the scheduled cleanup deadline. A finished export has
    /// already taken its sender, so a late timer must not send, close or unpark
    /// a second time.
    fn fail_if_pending(&self, message: &str) {
        if self.is_pending() {
            self.complete(Err(message.to_string()));
        }
    }

    fn is_pending(&self) -> bool {
        self.ivars().tx.borrow().is_some()
    }

    fn cancel_requested(&self) -> bool {
        self.ivars().cancel.load(Ordering::SeqCst)
    }

    fn complete(&self, result: Result<RenderOutput, String>) {
        // The sender is the one-shot latch: only the first completion may send,
        // detach the webview, close the window and unpark. Every later path
        // (scheduled timeout, in-flight poll block, duplicate navigation error)
        // is a no-op.
        let Some(tx) = take_pending(&self.ivars().tx) else {
            return;
        };
        if let Some(webview) = self.ivars().webview.borrow_mut().take() {
            unsafe { webview.setNavigationDelegate(None) };
        }
        if let Some(window) = self.ivars().window.borrow_mut().take() {
            window.close();
        }
        unpark(self);
        let _ = tx.send(result);
    }
}

/// Takes the one-shot completion sender; `None` means another path already
/// completed this export, which makes every later completion a no-op.
fn take_pending<T>(slot: &RefCell<Option<T>>) -> Option<T> {
    slot.borrow_mut().take()
}

/// Registers the delegate as live and arms the cleanup deadline. The dispatch
/// keeps its own reference to the delegate until the timer fires, so a normal
/// completion can safely drop the `LIVE_EXPORTS` entry first.
fn park(delegate: Retained<ExportDelegate>) {
    LIVE_EXPORTS.with(|live| live.borrow_mut().push(delegate.clone()));
    let cancel_delegate = delegate.clone();
    let context = Box::into_raw(Box::new(TimeoutState { delegate })) as *mut c_void;
    dispatch_after(EXPORT_CLEANUP_MS, context, timeout_trampoline);
    schedule_cancel_poll(cancel_delegate);
}

struct CancelPollState {
    delegate: Retained<ExportDelegate>,
}

unsafe extern "C" fn cancel_trampoline(context: *mut c_void) {
    let state = unsafe { Box::from_raw(context as *mut CancelPollState) };
    if state.delegate.cancel_requested() {
        state
            .delegate
            .fail_if_pending(super::export_cancel::EXPORT_CANCELLED);
        return;
    }
    if state.delegate.is_pending() {
        schedule_cancel_poll(state.delegate);
    }
}

fn schedule_cancel_poll(delegate: Retained<ExportDelegate>) {
    let context = Box::into_raw(Box::new(CancelPollState { delegate })) as *mut c_void;
    dispatch_after(CANCEL_POLL_MS, context, cancel_trampoline);
}

fn unpark(delegate: &ExportDelegate) {
    LIVE_EXPORTS.with(|live| {
        live.borrow_mut()
            .retain(|item| !std::ptr::eq(&**item, delegate));
    });
}

fn poll_ready(state: PollState) {
    let script = NSString::from_str("window.__omdExportReady === true");
    let eval_view = state.webview.clone();
    let block = RcBlock::new(move |value: *mut AnyObject, _error: *mut NSError| {
        let ready = js_bool(value);
        if ready {
            after_ready(state.delegate.clone(), state.webview.clone(), None);
        } else if state.deadline <= Instant::now() {
            after_ready(
                state.delegate.clone(),
                state.webview.clone(),
                Some(ExportWarning {
                    code: "partial-render".into(),
                    detail: Some(
                        "the export page did not finish loading fonts or images within 5 s".into(),
                    ),
                }),
            );
        } else {
            schedule_poll(
                PollState {
                    delegate: state.delegate.clone(),
                    webview: state.webview.clone(),
                    deadline: state.deadline,
                },
                READY_POLL_MS,
            );
        }
    });
    unsafe { eval_view.evaluateJavaScript_completionHandler(&script, Some(&block)) };
}

fn after_ready(
    delegate: Retained<ExportDelegate>,
    webview: Retained<WKWebView>,
    partial: Option<ExportWarning>,
) {
    let spec = delegate.ivars().spec;
    let script = NSString::from_str(&super::measure_export_script(
        EXPORT_MIN_HEIGHT_CSS,
        1_000_000.0,
    ));
    let eval_view = webview.clone();
    let block = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
        if let Some(message) = ns_error(error) {
            delegate.complete(Err(message));
            return;
        }
        let measured = js_number(value).unwrap_or(EXPORT_MIN_HEIGHT_CSS);
        let (height, clamp_warning) = spec.clamp_height_css_for(measured, delegate.ivars().format);
        let warning = clamp_warning.or_else(|| partial.clone());
        resize_and_capture(delegate.clone(), webview.clone(), height, warning);
    });
    unsafe { eval_view.evaluateJavaScript_completionHandler(&script, Some(&block)) };
}

fn resize_and_capture(
    delegate: Retained<ExportDelegate>,
    webview: Retained<WKWebView>,
    height: f64,
    warning: Option<ExportWarning>,
) {
    let spec = delegate.ivars().spec;
    let size = CGSize::new(spec.width_css, height);
    if let Some(window) = delegate.ivars().window.borrow().as_ref() {
        window.setFrame_display(
            CGRect::new(CGPoint::new(OFFSCREEN_X, OFFSCREEN_Y), size),
            true,
        );
    }
    webview.setFrame(CGRect::new(CGPoint::ZERO, size));
    match delegate.ivars().format {
        ExportFormat::Pdf => capture_pdf(delegate, webview, warning),
        ExportFormat::Png => capture_png(delegate, webview, warning),
    }
}

fn capture_pdf(
    delegate: Retained<ExportDelegate>,
    webview: Retained<WKWebView>,
    warning: Option<ExportWarning>,
) {
    let config = unsafe { WKPDFConfiguration::new(main_thread()) };
    unsafe { config.setRect(webview.bounds()) };
    let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
        delegate.complete(pdf_bytes(data, error).map(|bytes| RenderOutput {
            bytes,
            warning: warning.clone(),
        }));
    });
    unsafe { webview.createPDFWithConfiguration_completionHandler(Some(&config), &block) };
}

fn capture_png(
    delegate: Retained<ExportDelegate>,
    webview: Retained<WKWebView>,
    warning: Option<ExportWarning>,
) {
    let spec = delegate.ivars().spec;
    let size = webview.bounds().size;
    let config = unsafe { WKPDFConfiguration::new(main_thread()) };
    unsafe { config.setRect(webview.bounds()) };
    let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
        let result = pdf_bytes(data, error)
            .and_then(|pdf| rasterize_pdf_to_png_scaled(&pdf, size.width, size.height, spec.scale));
        delegate.complete(result.map(|bytes| RenderOutput {
            bytes,
            warning: warning.clone(),
        }));
    });
    unsafe { webview.createPDFWithConfiguration_completionHandler(Some(&config), &block) };
}

fn rasterize_pdf_to_png_scaled(
    pdf: &[u8],
    width_css: f64,
    height_css: f64,
    scale: f64,
) -> Result<Vec<u8>, String> {
    if !pdf.starts_with(b"%PDF") {
        return Err("PDF export did not produce a PDF".into());
    }
    let width = (width_css * scale).round().max(1.0) as isize;
    let height = (height_css * scale).round().max(1.0) as isize;
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            width,
            height,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }
    .ok_or("failed to allocate export bitmap")?;
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)
        .ok_or("failed to create export graphics context")?;
    let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(pdf))
        .ok_or("failed to rasterize exported PDF")?;
    let rect = NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(width as f64, height as f64),
    );
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    NSColor::whiteColor().setFill();
    NSRectFill(rect);
    image.drawInRect(rect);
    NSGraphicsContext::restoreGraphicsState_class();

    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("failed to encode PNG")?;
    let bytes = png.to_vec();
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok(bytes)
    } else {
        Err("image export did not produce PNG".into())
    }
}

fn pdf_bytes(data: *mut NSData, error: *mut NSError) -> Result<Vec<u8>, String> {
    if let Some(message) = ns_error(error) {
        return Err(message);
    }
    let bytes = ns_data_bytes(data).ok_or("PDF export produced no data")?;
    if bytes.starts_with(b"%PDF") {
        Ok(bytes)
    } else {
        Err("PDF export did not produce a PDF".into())
    }
}

fn main_thread() -> MainThreadMarker {
    MainThreadMarker::new().expect("export capture runs on the main thread")
}

fn ns_data_bytes(data: *mut NSData) -> Option<Vec<u8>> {
    if data.is_null() {
        return None;
    }
    Some(unsafe { &*data }.to_vec())
}

fn ns_error(error: *mut NSError) -> Option<String> {
    if error.is_null() {
        return None;
    }
    Some(unsafe { &*error }.localizedDescription().to_string())
}

fn js_number(value: *mut AnyObject) -> Option<f64> {
    if value.is_null() {
        return None;
    }
    unsafe { &*value }
        .downcast_ref::<NSNumber>()
        .map(NSNumber::doubleValue)
}

fn js_bool(value: *mut AnyObject) -> bool {
    if value.is_null() {
        return false;
    }
    unsafe { &*value }
        .downcast_ref::<NSNumber>()
        .map(|n| n.as_bool())
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "export_native_tests.rs"]
mod tests;
