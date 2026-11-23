//! HiDPI-safe persisted window geometry.
//!
//! Tauri's builder `position`/`inner_size` take **logical** pixels while
//! `outer_position`/`inner_size` report **physical** pixels. Mixing the two
//! doubled every restored window on 2x displays, and a shard saved on a
//! since-unplugged monitor restored fully offscreen. Every persisted bound now
//! records which unit it was captured in (`logical`), and restore converts and
//! clamps through pure functions that unit tests can drive without a runtime.

use serde::{Deserialize, Serialize};

/// Smallest logical window the editor restores to. A shard smaller than this
/// (hand-edited, or captured from a degenerate frame) is grown, not honored.
pub const MIN_WINDOW_WIDTH: u32 = 400;
pub const MIN_WINDOW_HEIGHT: u32 = 300;

/// Logical titlebar strip that must stay reachable on some monitor. A window
/// dragged almost entirely offscreen still has to be grabbable by the user.
pub const MIN_VISIBLE_WIDTH: i32 = 120;
pub const MIN_VISIBLE_HEIGHT: i32 = 80;

/// Capture floor only: rejects a degenerate frame size rather than encoding the
/// product minimum into the shard (restore enforces the real minimum).
const CAPTURE_MIN_DIMENSION_CSS: f64 = 320.0;

/// Persisted window geometry. `logical` distinguishes DIP pixels from the
/// physical pixels legacy shards stored; `serde(default)` consequently reads
/// those older shards as physical, which is exactly what they were.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub logical: bool,
}

impl WindowBounds {
    /// Builds bounds already expressed in logical (DIP) pixels.
    pub fn logical(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
            logical: true,
        }
    }

    /// Builds bounds captured as physical pixels (legacy shards, tests).
    #[cfg(test)]
    pub fn physical(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self {
            x,
            y,
            width,
            height,
            logical: false,
        }
    }
}

/// A monitor's usable rectangle in logical pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MonitorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl MonitorRect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }
}

fn usable_scale(scale: f64) -> f64 {
    // A monitor can report 0/NaN while waking from sleep; never divide by it.
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// Converts a physical shard to logical units; logical input passes through.
fn to_logical(bounds: WindowBounds, window_scale: f64) -> WindowBounds {
    if bounds.logical {
        return bounds;
    }
    let scale = usable_scale(window_scale);
    WindowBounds::logical(
        (f64::from(bounds.x) / scale).round() as i32,
        (f64::from(bounds.y) / scale).round() as i32,
        ((f64::from(bounds.width) / scale).round() as u32).max(1),
        ((f64::from(bounds.height) / scale).round() as u32).max(1),
    )
}

/// True when the window's titlebar strip (top-left `MIN_VISIBLE_*` rectangle)
/// lies fully inside `monitor`, i.e. the user can always grab and drag it.
fn titlebar_reachable(bounds: WindowBounds, monitor: &MonitorRect) -> bool {
    let width = f64::from(MIN_VISIBLE_WIDTH);
    let height = f64::from(MIN_VISIBLE_HEIGHT);
    let left = f64::from(bounds.x);
    let top = f64::from(bounds.y);
    let overlap_width = (left + width).min(monitor.x + monitor.width) - left.max(monitor.x);
    let overlap_height = (top + height).min(monitor.y + monitor.height) - top.max(monitor.y);
    overlap_width >= width && overlap_height >= height
}

/// Shrinks `bounds` to `monitor` and pins its origin inside that monitor.
fn clamp_to_monitor(bounds: WindowBounds, monitor: &MonitorRect) -> WindowBounds {
    // Keep the product minimum unless the monitor itself is smaller.
    let max_width = monitor.width.floor().max(1.0).min(f64::from(u32::MAX)) as u32;
    let max_height = monitor.height.floor().max(1.0).min(f64::from(u32::MAX)) as u32;
    let width = bounds
        .width
        .min(max_width)
        .max(MIN_WINDOW_WIDTH.min(max_width));
    let height = bounds
        .height
        .min(max_height)
        .max(MIN_WINDOW_HEIGHT.min(max_height));
    let max_x = monitor.x + monitor.width - f64::from(width);
    let max_y = monitor.y + monitor.height - f64::from(height);
    let x = f64::from(bounds.x)
        .clamp(monitor.x, max_x.max(monitor.x))
        .round() as i32;
    let y = f64::from(bounds.y)
        .clamp(monitor.y, max_y.max(monitor.y))
        .round() as i32;
    WindowBounds::logical(x, y, width, height)
}

/// Normalizes persisted geometry before it is applied to a builder or a live
/// window: legacy physical shards are converted with `window_scale`, the
/// product minimum is enforced, and a window whose titlebar strip reaches no
/// monitor is pulled back onto the first (primary) monitor.
pub fn normalize_and_clamp_bounds(
    bounds: WindowBounds,
    window_scale: f64,
    monitors: &[MonitorRect],
) -> WindowBounds {
    let logical = to_logical(bounds, window_scale);
    let grown = WindowBounds::logical(
        logical.x,
        logical.y,
        logical.width.max(MIN_WINDOW_WIDTH),
        logical.height.max(MIN_WINDOW_HEIGHT),
    );
    // No monitor data (headless test, permission denied): keep the geometry
    // rather than inventing a placement.
    let Some(primary) = monitors.first() else {
        return grown;
    };
    if monitors
        .iter()
        .any(|monitor| titlebar_reachable(grown, monitor))
    {
        return grown;
    }
    clamp_to_monitor(grown, primary)
}

/// Logical rectangles for every connected monitor, primary first so the
/// offscreen fallback has a deterministic target. Unreadable monitor data
/// degrades to an empty list (callers then keep the saved geometry).
pub fn monitor_rects<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<MonitorRect> {
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_rect(&monitor));
    let mut rects: Vec<MonitorRect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    if let Some(primary) = primary {
        match rects.iter().position(|rect| *rect == primary) {
            Some(index) => {
                let primary = rects.remove(index);
                rects.insert(0, primary);
            }
            None => rects.insert(0, primary),
        }
    }
    rects
}

fn monitor_rect(monitor: &tauri::Monitor) -> MonitorRect {
    let scale = usable_scale(monitor.scale_factor());
    let position = monitor.position();
    let size = monitor.size();
    MonitorRect::new(
        f64::from(position.x) / scale,
        f64::from(position.y) / scale,
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    )
}

/// Captures a live window's geometry in logical pixels. Minimized or
/// unqueryable windows report `None` so restore falls back to default
/// placement instead of persisting placeholder geometry.
pub fn capture_window_bounds(window: &tauri::WebviewWindow) -> Option<WindowBounds> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = usable_scale(window.scale_factor().unwrap_or(1.0));
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(WindowBounds::logical(
        (f64::from(position.x) / scale).round() as i32,
        (f64::from(position.y) / scale).round() as i32,
        (f64::from(size.width) / scale)
            .round()
            .max(CAPTURE_MIN_DIMENSION_CSS) as u32,
        (f64::from(size.height) / scale)
            .round()
            .max(CAPTURE_MIN_DIMENSION_CSS) as u32,
    ))
}

/// Restores persisted geometry on an existing window (the config-declared
/// `main` window), converting units and clamping an offscreen placement.
pub fn apply_bounds(window: &tauri::WebviewWindow, bounds: WindowBounds) {
    let scale = usable_scale(window.scale_factor().unwrap_or(1.0));
    let monitors: Vec<MonitorRect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(monitor_rect)
        .collect();
    let clamped = normalize_and_clamp_bounds(bounds, scale, &monitors);
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
        f64::from(clamped.x),
        f64::from(clamped.y),
    )));
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
        f64::from(clamped.width),
        f64::from(clamped.height),
    )));
}

/// Geometry for a window that does not exist yet: the primary monitor's scale
/// is the only one available for migrating a legacy physical shard.
pub fn builder_geometry<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    bounds: WindowBounds,
) -> (f64, f64, f64, f64) {
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| usable_scale(monitor.scale_factor()))
        .unwrap_or(1.0);
    let clamped = normalize_and_clamp_bounds(bounds, scale, &monitor_rects(app));
    (
        f64::from(clamped.x),
        f64::from(clamped.y),
        f64::from(clamped.width),
        f64::from(clamped.height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const FHD: MonitorRect = MonitorRect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };

    #[test]
    fn retina_capture_restores_without_doubling() {
        // 800x600 logical at (400,50) on a 2x display reports 1600x1200 at
        // (800,100) physical; capturing must store the logical values so a
        // restore under the same display reproduces the exact geometry.
        let captured = WindowBounds::logical(400, 50, 800, 600);
        let restored = normalize_and_clamp_bounds(captured, 2.0, &[FHD]);
        assert_eq!(restored, captured);
        // The builder receives logical values, so the physical frame after a
        // 2x rebuild is the original one — not 3200x2400.
        assert_eq!(restored.width * 2, 1600);
        assert_eq!(restored.height * 2, 1200);
    }

    #[test]
    fn legacy_physical_shard_is_converted_once_and_marked_logical() {
        let legacy = WindowBounds::physical(800, 100, 1600, 1200);
        let migrated = normalize_and_clamp_bounds(legacy, 2.0, &[FHD]);
        assert_eq!(migrated, WindowBounds::logical(400, 50, 800, 600));
        assert!(migrated.logical);
        // Conversion is idempotent: a second pass must not halve again.
        assert_eq!(normalize_and_clamp_bounds(migrated, 2.0, &[FHD]), migrated);
    }

    #[test]
    fn legacy_physical_shard_on_1x_scale_keeps_its_numbers() {
        let legacy = WindowBounds::physical(120, 90, 900, 700);
        assert_eq!(
            normalize_and_clamp_bounds(legacy, 1.0, &[FHD]),
            WindowBounds::logical(120, 90, 900, 700)
        );
    }

    #[test]
    fn a_zero_or_unknown_scale_never_divides_by_zero() {
        let legacy = WindowBounds::physical(200, 100, 800, 600);
        for scale in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                normalize_and_clamp_bounds(legacy, scale, &[FHD]),
                WindowBounds::logical(200, 100, 800, 600),
                "scale {scale} must fall back to 1.0"
            );
        }
    }

    #[test]
    fn unplugged_secondary_monitor_is_clamped_back_onto_the_primary() {
        // Saved at x=2500 while a 1920-wide monitor sat to the right; that
        // monitor is gone, so the titlebar strip is unreachable.
        let saved = WindowBounds::logical(2500, 120, 1000, 800);
        let clamped = normalize_and_clamp_bounds(saved, 1.0, &[FHD]);
        assert!(titlebar_reachable(clamped, &FHD), "must land on-screen");
        assert_eq!(clamped.x, 440, "pinned to the monitor's right edge");
        // An 800-tall window on a 900-tall monitor cannot keep y=120; it is
        // pulled down just enough to fit.
        assert_eq!(clamped.y, 100);
        assert!(clamped.width <= FHD.width as u32);
        assert!(clamped.height <= FHD.height as u32);
    }

    #[test]
    fn an_oversized_window_is_shrunk_to_the_monitor() {
        let saved = WindowBounds::logical(-5000, -5000, 6000, 4000);
        let clamped = normalize_and_clamp_bounds(saved, 1.0, &[FHD]);
        assert_eq!(clamped.width, 1440);
        assert_eq!(clamped.height, 900);
        assert_eq!((clamped.x, clamped.y), (0, 0));
    }

    #[test]
    fn negative_coordinates_on_a_left_monitor_are_kept() {
        let left = MonitorRect::new(-1920.0, 0.0, 1920.0, 1080.0);
        let saved = WindowBounds::logical(-1900, 40, 800, 600);
        assert_eq!(normalize_and_clamp_bounds(saved, 1.0, &[FHD, left]), saved);
    }

    #[test]
    fn a_window_spanning_two_monitors_keeps_its_titlebar_strip() {
        // Straddling the seam is fine as long as 120x80 of the titlebar lands
        // on some monitor.
        let right = MonitorRect::new(1440.0, 0.0, 1920.0, 1080.0);
        let saved = WindowBounds::logical(1300, 10, 900, 700);
        assert_eq!(normalize_and_clamp_bounds(saved, 1.0, &[FHD, right]), saved);
    }

    #[test]
    fn minimum_logical_size_is_enforced() {
        let tiny = WindowBounds::logical(10, 10, 40, 20);
        let grown = normalize_and_clamp_bounds(tiny, 1.0, &[FHD]);
        assert_eq!(
            (grown.width, grown.height),
            (MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        );
        // A 100x80 legacy physical shard at 2x becomes 50x40 → still grown.
        let legacy_tiny = WindowBounds::physical(10, 10, 100, 80);
        let grown = normalize_and_clamp_bounds(legacy_tiny, 2.0, &[FHD]);
        assert_eq!(
            (grown.width, grown.height),
            (MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        );
    }

    #[test]
    fn missing_monitor_data_keeps_saved_geometry() {
        let saved = WindowBounds::logical(3000, 2000, 800, 600);
        assert_eq!(normalize_and_clamp_bounds(saved, 1.0, &[]), saved);
    }

    #[test]
    fn bounds_serialize_logical_flag_with_camel_case_fields() {
        assert_eq!(
            serde_json::to_string(&WindowBounds::logical(1, 2, 3, 4)).unwrap(),
            r#"{"x":1,"y":2,"width":3,"height":4,"logical":true}"#
        );
        // Legacy shards have no `logical` field and must read as physical.
        let legacy: WindowBounds =
            serde_json::from_str(r#"{"x":1,"y":2,"width":3,"height":4}"#).unwrap();
        assert!(!legacy.logical);
    }
}
