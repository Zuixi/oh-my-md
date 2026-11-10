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
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::AppHandle;

const OFFSCREEN_X: f64 = -20_000.0;
const OFFSCREEN_Y: f64 = -20_000.0;
/// How long to wait for `window.__omdExportReady` before exporting anyway.
const READY_TIMEOUT: Duration = Duration::from_secs(5);
const READY_POLL_MS: u64 = 100;

// GCD FFI — dispatch_after_f avoids block ABI complexity.
use std::os::raw::c_void;

type DispatchQueueT = *mut c_void;
type DispatchTimeT = u64;
type DispatchFunctionT = unsafe extern "C" fn(*mut c_void);

const DISPATCH_TIME_NOW: DispatchTimeT = 0;
const NSEC_PER_MSEC: i64 = 1_000_000;

extern "C" {
    // dispatch_get_main_queue() is a C macro expanding to (&_dispatch_main_q);
    // the linkable symbol is the global queue object itself.
    static _dispatch_main_q: c_void;
    fn dispatch_time(when: DispatchTimeT, delta: i64) -> DispatchTimeT;
    fn dispatch_after_f(
        when: DispatchTimeT,
        queue: DispatchQueueT,
        context: *mut c_void,
        work: DispatchFunctionT,
    );
}

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
    let ctx = Box::into_raw(Box::new(state)) as *mut c_void;
    unsafe {
        let when = dispatch_time(DISPATCH_TIME_NOW, (delay_ms as i64) * NSEC_PER_MSEC);
        let queue = (&raw const _dispatch_main_q).cast_mut().cast::<c_void>();
        dispatch_after_f(when, queue, ctx, poll_trampoline);
    }
}

struct ExportIvars {
    window: RefCell<Option<Retained<NSWindow>>>,
    webview: RefCell<Option<Retained<WKWebView>>>,
    format: ExportFormat,
    spec: ExportSpec,
    tx: RefCell<Option<mpsc::Sender<Result<RenderOutput, String>>>>,
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
) -> Result<RenderOutput, String> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || begin(html, spec, format, tx))
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(EXPORT_TIMEOUT_SECS))
            .map_err(|_| "export timed out".to_string())
    })
    .await
    .map_err(|error| error.to_string())??
}

fn begin(
    html: String,
    spec: ExportSpec,
    format: ExportFormat,
    tx: mpsc::Sender<Result<RenderOutput, String>>,
) {
    let fail = tx.clone();
    if let Err(error) = start(html, spec, format, tx) {
        let _ = fail.send(Err(error));
    }
}

fn start(
    html: String,
    spec: ExportSpec,
    format: ExportFormat,
    tx: mpsc::Sender<Result<RenderOutput, String>>,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("export must run on the main thread")?;
    let window = make_window(mtm, spec);
    let webview = make_webview(mtm, spec);
    window.setContentView(Some(webview.as_super()));
    window.orderFront(None);
    let delegate = ExportDelegate::create(mtm, window, webview.clone(), format, spec, tx);
    unsafe { webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    unsafe { webview.loadHTMLString_baseURL(&NSString::from_str(&html), None) };
    park(delegate);
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
    ) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(ExportIvars {
            window: RefCell::new(Some(window)),
            webview: RefCell::new(Some(webview)),
            format,
            spec,
            tx: RefCell::new(Some(tx)),
        });
        unsafe { msg_send![super(this), init] }
    }

    fn complete(&self, result: Result<RenderOutput, String>) {
        let tx = self.ivars().tx.borrow_mut().take();
        if let Some(webview) = self.ivars().webview.borrow_mut().take() {
            unsafe { webview.setNavigationDelegate(None) };
        }
        if let Some(window) = self.ivars().window.borrow_mut().take() {
            window.close();
        }
        unpark(self);
        if let Some(tx) = tx {
            let _ = tx.send(result);
        }
    }
}

fn park(delegate: Retained<ExportDelegate>) {
    LIVE_EXPORTS.with(|live| live.borrow_mut().push(delegate));
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
mod tests {
    use super::*;

    const TINY_PDF: &[u8] = b"%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 40] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 31 >>
stream
BT /F1 12 Tf 8 16 Td (Hi) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000239 00000 n 
0000000320 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
390
%%EOF
";

    fn png_size(png: &[u8]) -> (u32, u32) {
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        (
            u32::from_be_bytes(png[16..20].try_into().unwrap()),
            u32::from_be_bytes(png[20..24].try_into().unwrap()),
        )
    }

    #[test]
    fn rasterize_pdf_to_png_is_one_to_one_at_scale_one() {
        let png =
            rasterize_pdf_to_png_scaled(TINY_PDF, 80.0, 40.0, 1.0).expect("pdf should rasterize");
        assert_eq!(png_size(&png), (80, 40));
    }

    #[test]
    fn rasterize_pdf_to_png_honors_retina_scale() {
        let png =
            rasterize_pdf_to_png_scaled(TINY_PDF, 80.0, 40.0, 2.0).expect("pdf should rasterize");
        assert_eq!(png_size(&png), (160, 80));
    }

    #[test]
    fn rasterize_pdf_to_png_rejects_non_pdf() {
        assert!(rasterize_pdf_to_png_scaled(b"not-a-pdf", 80.0, 40.0, 1.0).is_err());
    }

    #[test]
    fn ready_timeout_is_five_seconds() {
        assert_eq!(READY_TIMEOUT, Duration::from_secs(5));
    }

    #[test]
    fn ready_poll_interval_is_one_hundred_ms() {
        assert_eq!(READY_POLL_MS, 100);
    }
}
