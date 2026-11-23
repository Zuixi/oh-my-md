//! Automatic updates: install capability policy plus the non-destructive
//! update flush.
//!
//! The coordinator (Task 4/5) asks Rust for one platform-owned capability
//! result instead of scattering UA/path checks, and for a session-flush round
//! that must NOT force exit (spec §10/§12/§13): a timed-out update flush aborts
//! the install and keeps the app running, unlike an OS-driven quit.

use tauri::{Emitter, Manager};

/// Platform family the policy keys on. Derived from `cfg!(target_os)` at the
/// command site so the pure policy function stays testable on any host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpdatePlatform {
    MacOs,
    Windows,
    Linux,
    Other,
}

/// Why an update path is restricted. Serializes camelCase to match the TS
/// union `reason?: "development" | "manualPackage" | "unsupported"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateCapabilityReason {
    /// A debug/unpackaged build — never show the updater.
    Development,
    /// Check works, but the user installs manually from the Release page
    /// (MSI, deb, rpm and other packaged Linux never consume an installer
    /// updater that would mix ownership).
    ManualPackage,
    /// Unknown platform or an unpackaged release binary; fail closed.
    Unsupported,
}

/// Wire payload for `update_capability`; the reason enum values need
/// camelCase and None must be omitted (optional in TS), guarded by the
/// serialization tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCapability {
    check: bool,
    install: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<UpdateCapabilityReason>,
}

/// The update flush reports whether the webview acked in time; it never
/// forces exit or restart. Serializes to `{ kind: "ready" | "timedOut" }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PrepareUpdateRestartResult {
    Ready,
    TimedOut,
}

/// Pure policy inputs assembled by the `update_capability` command. Every
/// platform/installer row of the spec §13 table is a distinct combination,
/// so the policy tests pin the full table on any host.
#[derive(Debug)]
struct UpdateCapabilityRuntime {
    debug: bool,
    platform: UpdatePlatform,
    /// The actual runtime bundle type reported by
    /// `tauri::utils::platform::bundle_type()`: `None` means the process is
    /// not running from a recognized bundle artifact (dev build, plain
    /// binary, unknown). Configured `bundle.targets` are deliberately not
    /// part of the policy — `"all"` expands to NSIS on Windows, so the
    /// configured set cannot tell an actual MSI install from an NSIS one.
    bundle_type: Option<tauri::utils::config::BundleType>,
    /// macOS runtime fact: the process runs from a `.app` bundle. Kept
    /// separate because on macOS `bundle_type()` falls back to `App` even
    /// for unpackaged binaries and therefore cannot distinguish them.
    inside_macos_app: bool,
}

fn current_platform() -> UpdatePlatform {
    if cfg!(target_os = "macos") {
        UpdatePlatform::MacOs
    } else if cfg!(target_os = "windows") {
        UpdatePlatform::Windows
    } else if cfg!(target_os = "linux") {
        UpdatePlatform::Linux
    } else {
        UpdatePlatform::Other
    }
}

/// macOS runtime fact: the updater can only replace an installation that came
/// from a bundle, so a bare release binary is unpackaged and fails closed.
fn inside_macos_app_bundle() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    std::env::current_exe()
        .ok()
        .map(|exe| exe.to_string_lossy().contains(".app/Contents/MacOS/"))
        .unwrap_or(false)
}

/// Install-capability policy per spec §13. Pure: every platform/installer
/// row is a distinct input combination, so tests pin the full table on any
/// host without touching Tauri globals. Windows/Linux key on the actual
/// runtime bundle type (the marker the bundler patches into the installed
/// binary) — never on configured `bundle.targets`, which cannot distinguish
/// an MSI install from an NSIS one under `targets: "all"`.
fn update_capability_policy(runtime: &UpdateCapabilityRuntime) -> UpdateCapability {
    if runtime.debug {
        return UpdateCapability {
            check: false,
            install: false,
            reason: Some(UpdateCapabilityReason::Development),
        };
    }
    let full = UpdateCapability {
        check: true,
        install: true,
        reason: None,
    };
    let check_only = UpdateCapability {
        check: true,
        install: false,
        reason: Some(UpdateCapabilityReason::ManualPackage),
    };
    let unsupported = UpdateCapability {
        check: false,
        install: false,
        reason: Some(UpdateCapabilityReason::Unsupported),
    };
    use tauri::utils::config::BundleType;
    match runtime.platform {
        UpdatePlatform::MacOs => {
            if runtime.inside_macos_app {
                full
            } else {
                unsupported
            }
        }
        UpdatePlatform::Windows => match &runtime.bundle_type {
            // Actual installer type: only an NSIS install may auto-update;
            // an actual MSI install must stay check-only so the user grabs
            // installers from the Release page (spec §13 MSI ruling).
            Some(BundleType::Nsis) => full,
            Some(BundleType::Msi) => check_only,
            // Unknown artifact (dev build, plain exe): fail closed.
            _ => unsupported,
        },
        UpdatePlatform::Linux => match &runtime.bundle_type {
            Some(BundleType::AppImage) => full,
            // Deb/rpm and other packaged Linux consume installers manually.
            Some(BundleType::Deb) | Some(BundleType::Rpm) => check_only,
            _ => unsupported,
        },
        UpdatePlatform::Other => unsupported,
    }
}

#[tauri::command]
pub(crate) fn update_capability(_app: tauri::AppHandle) -> UpdateCapability {
    let runtime = UpdateCapabilityRuntime {
        debug: cfg!(debug_assertions),
        platform: current_platform(),
        // Actual artifact the process runs from: the bundler patches a
        // bundle-type marker into each artifact's binary, so an MSI install
        // reports Msi and an NSIS install reports Nsis regardless of how
        // `bundle.targets` was configured.
        bundle_type: tauri::utils::platform::bundle_type(),
        inside_macos_app: inside_macos_app_bundle(),
    };
    update_capability_policy(&runtime)
}

#[tauri::command]
pub(crate) async fn prepare_update_restart(app: tauri::AppHandle) -> PrepareUpdateRestartResult {
    let gate = app.state::<crate::session_flush::FlushGate>();
    if gate.in_progress() {
        // Another flush round is in flight (e.g. an OS-driven quit). Never
        // steal or perturb it; fail closed so the update flow aborts.
        return PrepareUpdateRestartResult::TimedOut;
    }
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let targets = crate::app_lifecycle::all_window_labels(&app);
    let started = gate.begin(
        crate::session_flush::SESSION_FLUSH_TIMEOUT,
        &targets,
        move |outcome| {
            // Update rounds never exit or restart the app: report the outcome
            // and let the caller decide. A timeout must leave the editor open.
            let _ = done_tx.send(outcome);
        },
    );
    if !started {
        return PrepareUpdateRestartResult::TimedOut;
    }
    // Register the round before emitting: an ack racing an unregistered
    // round would no-op and stall the flush until the timeout.
    for label in &targets {
        let _ = app.emit_to(label, crate::session_flush::SESSION_FLUSH_EVENT, ());
    }

    // Async so the webview's session_flush_ack IPC can still be processed
    // while this command waits on the gate.
    let result = tauri::async_runtime::spawn_blocking(move || {
        match done_rx.recv_timeout(crate::session_flush::SESSION_FLUSH_TIMEOUT) {
            Ok(crate::session_flush::FlushOutcome::Acknowledged) => {
                PrepareUpdateRestartResult::Ready
            }
            Ok(crate::session_flush::FlushOutcome::TimedOut) | Err(_) => {
                PrepareUpdateRestartResult::TimedOut
            }
        }
    })
    .await
    .unwrap_or(PrepareUpdateRestartResult::TimedOut);

    // This round kept the app running, so it must not leave the one-shot
    // "already flushed" marker behind — otherwise the next ordinary quit
    // would skip its own flush and lose the session snapshot.
    gate.consume_flushed();
    // A quit that arrived while this round was in flight was queued; run it
    // now that the round finished instead of leaving it waiting forever.
    crate::app_lifecycle::drain_flush_followup(&app);
    result
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod tests;
