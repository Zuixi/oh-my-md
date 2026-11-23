use super::*;

/// Builds a pure runtime-fact input; every field mirrors what the
/// `update_capability` command assembles at runtime.
fn capability_runtime(
    debug: bool,
    platform: UpdatePlatform,
    bundle_type: Option<tauri::utils::config::BundleType>,
    inside_macos_app: bool,
) -> UpdateCapabilityRuntime {
    UpdateCapabilityRuntime {
        debug,
        platform,
        bundle_type,
        inside_macos_app,
    }
}

#[test]
fn update_capability_policy_matches_product_table() {
    let full = UpdateCapability {
        check: true,
        install: true,
        reason: None,
    };
    let check_only = |reason| UpdateCapability {
        check: true,
        install: false,
        reason: Some(reason),
    };
    let disabled = |reason| UpdateCapability {
        check: false,
        install: false,
        reason: Some(reason),
    };

    use tauri::utils::config::BundleType;
    let cases: Vec<(UpdateCapabilityRuntime, UpdateCapability)> = vec![
        // Packaged macOS application (.app): yes / yes
        (
            capability_runtime(false, UpdatePlatform::MacOs, Some(BundleType::App), true),
            full,
        ),
        // Windows NSIS install: yes / yes
        (
            capability_runtime(
                false,
                UpdatePlatform::Windows,
                Some(BundleType::Nsis),
                false,
            ),
            full,
        ),
        // Windows MSI install: yes / no (open Release)
        (
            capability_runtime(false, UpdatePlatform::Windows, Some(BundleType::Msi), false),
            check_only(UpdateCapabilityReason::ManualPackage),
        ),
        // Linux AppImage: yes / yes
        (
            capability_runtime(
                false,
                UpdatePlatform::Linux,
                Some(BundleType::AppImage),
                false,
            ),
            full,
        ),
        // Linux deb package: yes / no (open Release)
        (
            capability_runtime(false, UpdatePlatform::Linux, Some(BundleType::Deb), false),
            check_only(UpdateCapabilityReason::ManualPackage),
        ),
        // Linux rpm package: yes / no (open Release)
        (
            capability_runtime(false, UpdatePlatform::Linux, Some(BundleType::Rpm), false),
            check_only(UpdateCapabilityReason::ManualPackage),
        ),
        // Development build: no / no
        (
            capability_runtime(true, UpdatePlatform::MacOs, Some(BundleType::App), true),
            disabled(UpdateCapabilityReason::Development),
        ),
        // Unpackaged macOS binary: no / no
        (
            capability_runtime(false, UpdatePlatform::MacOs, Some(BundleType::App), false),
            disabled(UpdateCapabilityReason::Unsupported),
        ),
        // Unknown platform: no / no (fail closed)
        (
            capability_runtime(false, UpdatePlatform::Other, None, false),
            disabled(UpdateCapabilityReason::Unsupported),
        ),
    ];

    for (runtime, expected) in cases {
        assert_eq!(
            update_capability_policy(&runtime),
            expected,
            "policy mismatch for {runtime:?}"
        );
    }
}

#[test]
fn runtime_bundle_type_distinguishes_actual_nsis_from_actual_msi() {
    // Root-cause regression for the MSI gap: `bundle.targets: "all"`
    // expands to NSIS on Windows, so the old configured-target inference
    // reported install=true for actual MSI installations. The policy must
    // key only on the runtime bundle type, which the bundler patches into
    // the installed binary — Nsis when installed from the NSIS setup exe,
    // Msi when installed from an MSI.
    use tauri::utils::config::BundleType;

    let nsis = capability_runtime(
        false,
        UpdatePlatform::Windows,
        Some(BundleType::Nsis),
        false,
    );
    assert_eq!(
        update_capability_policy(&nsis),
        UpdateCapability {
            check: true,
            install: true,
            reason: None,
        }
    );

    let msi = capability_runtime(false, UpdatePlatform::Windows, Some(BundleType::Msi), false);
    assert_eq!(
        update_capability_policy(&msi),
        UpdateCapability {
            check: true,
            install: false,
            reason: Some(UpdateCapabilityReason::ManualPackage),
        }
    );
}

#[test]
fn runtime_bundle_type_distinguishes_appimage_from_deb_and_rpm() {
    // Actual runtime bundle types decide on Linux too: an AppImage install
    // gets auto-update, while deb/rpm installs stay check-only. The old
    // implementation consulted configured targets plus the APPIMAGE env
    // var; the runtime bundle type alone is decisive.
    use tauri::utils::config::BundleType;

    let appimage = capability_runtime(
        false,
        UpdatePlatform::Linux,
        Some(BundleType::AppImage),
        false,
    );
    assert_eq!(
        update_capability_policy(&appimage),
        UpdateCapability {
            check: true,
            install: true,
            reason: None,
        }
    );

    for bundle in [BundleType::Deb, BundleType::Rpm] {
        let runtime = capability_runtime(false, UpdatePlatform::Linux, Some(bundle.clone()), false);
        assert_eq!(
            update_capability_policy(&runtime),
            UpdateCapability {
                check: true,
                install: false,
                reason: Some(UpdateCapabilityReason::ManualPackage),
            },
            "installed Linux bundle {bundle:?} must be check-only"
        );
    }
}

#[test]
fn policy_keys_only_on_runtime_bundle_type_not_configured_targets() {
    // The old inference read `bundle.targets` ("all" → [nsis] on Windows),
    // which cannot tell an actual MSI install from an NSIS one — any mixed
    // or "all" configured-target combination made the MSI row report
    // install=true. The runtime input now carries only the detected bundle
    // type; configured targets are no longer part of the policy at all.
    // This pins that contract: for a given installed artifact, the
    // capability is decided by the artifact alone.
    use tauri::utils::config::BundleType;

    for bundle in [BundleType::Nsis, BundleType::Msi] {
        let install_expectation = matches!(&bundle, BundleType::Nsis);
        let runtime =
            capability_runtime(false, UpdatePlatform::Windows, Some(bundle.clone()), false);
        let capability = update_capability_policy(&runtime);
        assert!(capability.check);
        assert_eq!(
            capability.install, install_expectation,
            "install for Windows must follow the detected bundle type only"
        );
    }
}

#[test]
fn update_capability_policy_windows_without_runtime_bundle_type_fails_closed() {
    // Unpatched binary (dev build / plain exe) on Windows: no recognized
    // bundle type → no / no.
    let runtime = capability_runtime(false, UpdatePlatform::Windows, None, false);
    assert_eq!(
        update_capability_policy(&runtime),
        UpdateCapability {
            check: false,
            install: false,
            reason: Some(UpdateCapabilityReason::Unsupported),
        }
    );
}

#[test]
fn update_capability_policy_linux_without_runtime_bundle_type_fails_closed() {
    let runtime = capability_runtime(false, UpdatePlatform::Linux, None, false);
    assert_eq!(
        update_capability_policy(&runtime),
        UpdateCapability {
            check: false,
            install: false,
            reason: Some(UpdateCapabilityReason::Unsupported),
        }
    );
}

#[test]
fn update_capability_policy_serializes_camel_case_fields_and_reasons() {
    // Multi-word reason values and absent-None must match the TS interface
    // (`reason?: "development" | "manualPackage" | "unsupported"`).
    let manual = UpdateCapability {
        check: true,
        install: false,
        reason: Some(UpdateCapabilityReason::ManualPackage),
    };
    assert_eq!(
        serde_json::to_string(&manual).unwrap(),
        r#"{"check":true,"install":false,"reason":"manualPackage"}"#
    );
    assert_eq!(
        serde_json::to_string(&UpdateCapability {
            check: false,
            install: false,
            reason: Some(UpdateCapabilityReason::Development),
        })
        .unwrap(),
        r#"{"check":false,"install":false,"reason":"development"}"#
    );
    // None must omit the field (optional in TS), never send null.
    assert_eq!(
        serde_json::to_string(&UpdateCapability {
            check: true,
            install: true,
            reason: None,
        })
        .unwrap(),
        r#"{"check":true,"install":true}"#
    );
}

#[test]
fn prepare_update_restart_result_serializes_camel_case_variants() {
    // The tag + variant names must serialize exactly to the TS union
    // `{ kind: "ready" } | { kind: "timedOut" }`.
    assert_eq!(
        serde_json::to_string(&PrepareUpdateRestartResult::Ready).unwrap(),
        r#"{"kind":"ready"}"#
    );
    assert_eq!(
        serde_json::to_string(&PrepareUpdateRestartResult::TimedOut).unwrap(),
        r#"{"kind":"timedOut"}"#
    );
}
