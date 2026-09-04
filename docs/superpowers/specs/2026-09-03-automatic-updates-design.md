# Automatic Updates Design

**Date:** 2026-09-03

**Status:** Approved in chat

**Scope:** Signed, user-controlled stable-channel updates for packaged oh-my-md desktop applications

## 1. Goal

Add reliable automatic update discovery, download, verification, and installation without waiting for Apple Developer or Windows Authenticode approval.

The first production path uses Tauri 2's official updater and complete updater bundles. Binary-delta updates remain a measured follow-up: they may optimize downloads later, but must never replace complete-package fallback, minisign verification, or the platform installer.

## 2. Decisions

- Platform code signing and notarization are deferred until external account approval is available.
- Tauri updater minisign signatures are mandatory. They are independent of Apple and Microsoft code-signing certificates.
- The application checks for updates eight seconds after startup, but never downloads silently.
- The user explicitly confirms download, then separately confirms restart and installation.
- Installation is blocked while any document is dirty, conflicted, save-failed, pending ordered-list normalization, opening, or actively saving.
- There is one `stable` channel. There are no beta/nightly channels, forced updates, or automatic downgrades.
- macOS, Windows, and Linux AppImage installations support automatic installation.
- Linux deb and unknown Linux installations discover updates but open the GitHub Release for manual package-manager installation.
- A GitHub Release and eligibility for automatic update are separate decisions. Release publication does not automatically promote a version to `stable`.
- Stable promotion and withdrawal use protected manual workflows and a static GitHub Pages endpoint. No application server or database is introduced.
- The initial updater downloads complete bundles. Differential updates proceed only after measurements justify their complexity.

## 3. Non-goals

The initial implementation does not provide:

- Apple notarization, Developer ID signing, or Windows Authenticode signing;
- silent download or silent installation;
- forced minimum versions;
- downgrade installation;
- beta, nightly, staged, or percentage rollouts;
- a custom update service;
- resumable download UI or a cancellation promise unsupported by Tauri;
- persistence of partially or fully downloaded updater bundles across application restarts;
- custom binary patching in an installed application directory;
- automatic updating for deb installations.

## 4. Trust Model

### 4.1 Platform trust versus updater trust

Unsigned platform packages may still trigger Gatekeeper or SmartScreen. Tauri updater trust is separate: every updater artifact is signed by a project-owned minisign private key, and the application embeds the matching public key.

Signature verification cannot be bypassed. A signature failure must stop installation and direct the user to the official GitHub Releases page.

### 4.2 Key storage

Generate one Tauri updater key pair. Store:

- the public key in `apps/desktop/src-tauri/tauri.conf.json`;
- the private key in the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret;
- its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` when the key is password-protected;
- at least two encrypted offline recovery copies under maintainer control.

The existing updater trust root is reused: its public key previously shipped in repository configuration, `TAURI_SIGNING_PRIVATE_KEY` already exists in GitHub Actions, and the local recovery key is permission-restricted. This implementation never reads or rewrites the private-key contents. Before promoting the first updater-capable release, maintainers must create and verify the second encrypted offline backup; replacing this trust root requires a separately approved migration.

The private key must never enter repository files, `.env`, logs, caches, workflow artifacts, Releases, or diagnostic archives. Pull-request workflows must not receive the secrets.

Losing the private key prevents existing clients from trusting future updates. If the key is suspected compromised, withdraw the stable manifest, remove the secret, stop promotion, publish an advisory, and require a manually installed release carrying a new trust root unless an old-key-signed transition release remains possible.

### 4.3 Immutable artifacts

One version maps to one tag, commit, and package hash set. Never move a tag, overwrite a published asset, or reuse a version. A source or workflow fix requires a higher version.

## 5. Release Architecture

```text
Tag release workflow
  ├── macOS Universal DMG + updater tarball + signature
  ├── Windows x64 NSIS/MSI + updater signature
  ├── Linux x64 AppImage/deb + updater signature
  ├── candidate latest.json
  ├── SHA256SUMS.txt
  └── Draft GitHub Release
             │
             ▼ human package QA and Publish
Public immutable GitHub Release
             │
             ▼ protected manual stable promotion
GitHub Pages stable/latest.json
             │
             ▼ HTTPS + Tauri minisign verification
Packaged desktop client
```

The first updater-capable public version should be `0.1.0`. Existing `0.0.1` installations require one manual upgrade. From `0.1.0` onward, higher versions can use the updater.

## 6. Update Endpoint and Manifest

The stable endpoint is:

```text
https://zuixi.github.io/oh-my-md/updates/stable/latest.json
```

Production uses HTTPS and must not enable Tauri's insecure transport option.

The manifest follows Tauri 2's static JSON schema:

```json
{
  "version": "0.1.1",
  "notes": "Bug fixes and reliability improvements.",
  "pub_date": "2026-09-10T10:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "url": "https://github.com/Zuixi/oh-my-md/releases/download/v0.1.1/oh-my-md.app.tar.gz",
      "signature": "<contents of the .sig file>"
    },
    "darwin-aarch64": {
      "url": "https://github.com/Zuixi/oh-my-md/releases/download/v0.1.1/oh-my-md.app.tar.gz",
      "signature": "<contents of the .sig file>"
    },
    "windows-x86_64": {
      "url": "https://github.com/Zuixi/oh-my-md/releases/download/v0.1.1/oh-my-md-setup.exe",
      "signature": "<contents of the .sig file>"
    },
    "linux-x86_64": {
      "url": "https://github.com/Zuixi/oh-my-md/releases/download/v0.1.1/oh-my-md.AppImage",
      "signature": "<contents of the .sig file>"
    }
  }
}
```

Requirements:

- `version` is strict SemVer and equals the release tag without `v`.
- `pub_date` is RFC 3339.
- `signature` contains signature text, not a URL.
- Both macOS architecture keys point to the same verified Universal updater artifact.
- URLs point to immutable assets under the exact version tag, never `latest` or a branch.
- The Windows automatic-update entry uses the NSIS updater artifact. MSI remains a manual/managed deployment package.
- The Linux automatic-update entry uses Tauri 2.11's canonical raw `.AppImage` updater artifact and its `.sig` file; the same AppImage is the human-download package.
- Release notes are treated as remote plain text and are never injected as HTML.

Pages also retains auditable copies:

```text
updates/stable/latest.json
updates/stable/history/<version>.json
updates/stable/status.json
```

The client consumes only `latest.json`. `status.json` records channel, version, promotion time, Release URL, manifest SHA-256, workflow run, and previous stable version.

## 7. Release Workflow Changes

Set `bundle.createUpdaterArtifacts` to `true`, restore the updater dependencies and permissions, and configure the public key and stable endpoint.

The tag workflow receives updater signing secrets only in package-building jobs. It continues creating ordinary install packages and additionally requires:

| Platform | Updater assets |
| --- | --- |
| macOS Universal | `.app.tar.gz`, `.app.tar.gz.sig` |
| Windows x64 | NSIS updater executable and `.sig` |
| Linux x64 | `.AppImage`, `.AppImage.sig` |

Before creating the Draft Release, CI verifies:

1. the tag equals the Tauri version;
2. all five human-install package patterns exist;
3. all three updater artifact classes exist;
4. every updater artifact has a non-empty signature;
5. the macOS artifact is Universal;
6. candidate-manifest platform keys, versions, URLs, and signatures are complete;
7. every URL points to the current immutable tag;
8. `SHA256SUMS.txt` covers installers, updater artifacts, signatures, and the candidate manifest.

The candidate manifest ships as a Release asset but is not automatically published to the stable endpoint.

## 8. Stable Promotion and Withdrawal

### 8.1 Promotion

Add a manual `promote-update.yml` workflow with an exact `x.y.z` input. It uses a protected `stable-updates` GitHub Environment with required reviewers.

The workflow does not rebuild or sign binaries. It:

1. verifies that the exact GitHub Release exists, is public, and is neither Draft nor prerelease;
2. downloads its candidate manifest, updater artifacts, and signatures;
3. verifies package completeness, version, immutable URLs, signatures, and SHA-256 checksums;
4. requires the candidate version to be greater than the current stable version;
5. writes immutable history and status files;
6. atomically deploys the candidate as `updates/stable/latest.json` through GitHub Pages;
7. fetches the public endpoint and verifies the deployed manifest hash.

Use minimum workflow permissions: `contents: read`, `pages: write`, and `id-token: write`.

### 8.2 Withdrawal

Add a protected manual `withdraw-update.yml` workflow. It restores the previous known-good stable manifest and writes a new status record. It does not delete or edit a Release, move a tag, replace assets, or instruct clients to downgrade.

Withdrawal prevents new discovery. It cannot cancel a download already in progress, invalidate a bundle already downloaded into a running process, or repair installations already upgraded. A defective installed version requires a higher fixed release.

## 9. Client Architecture

### 9.1 Ownership

Desktop React owns update orchestration and user-visible state. Tauri's updater plugin owns manifest fetch, download, signature verification, platform installation, and relaunch integration. Rust exposes only narrow host facts and reuses the existing session-flush gate.

Do not grow the update state machine directly inside `App.tsx`. Add a focused `updateCoordinator.ts`; `App.tsx` supplies document readiness and renders its state.

### 9.2 Public state projection

```ts
type UpdateSource = "startup" | "manual"
type UpdateStage = "check" | "download" | "readiness" | "install"
type UpdateFailureKind =
  | "network"
  | "manifest"
  | "signature"
  | "download"
  | "platformUnsupported"
  | "flushTimeout"
  | "install"
  | "unknown"

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking"; source: UpdateSource }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "downloading"; update: AvailableUpdate; downloaded: number; total?: number }
  | { kind: "downloaded"; update: AvailableUpdate }
  | { kind: "blocked"; update: AvailableUpdate; reasons: UpdateBlockedTab[] }
  | { kind: "readyToInstall"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate }
  | { kind: "failed"; stage: UpdateStage; failure: UpdateFailureKind; retryable: boolean }

interface AvailableUpdate {
  version: string
  notes: string
  publishedAt?: string
}
```

The Tauri `Update` handle remains private to the coordinator. It must not be copied into React state.

### 9.3 Coordinator interface

```ts
interface UpdateCoordinator {
  subscribe(listener: (state: UpdateState) => void): () => void
  check(source: UpdateSource): Promise<void>
  download(): Promise<void>
  requestInstall(): Promise<void>
  install(): Promise<void>
  dismiss(): void
  dispose(): void
}
```

The coordinator receives narrow dependencies rather than reading React refs:

```ts
interface UpdateCoordinatorDependencies {
  updater: UpdateAdapter
  flushPendingEdits(): void
  checkRestartReadiness(): UpdateRestartReadiness
  prepareRestart(): Promise<"ready" | "timedOut">
  openReleasePage(): Promise<void>
  reportManualFailure(failure: UpdateFailureKind): void
  notifyLatest(): void
}
```

`requestInstall()` calls `flushPendingEdits()` synchronously before `checkRestartReadiness()`. It requests the Rust session-flush gate only after readiness succeeds.

### 9.4 Concurrency

- At most one check is active.
- At most one download is active.
- Installation starts only from `downloaded`.
- Repeated commands while checking/downloading/installing do not create parallel work.
- Hiding a banner does not cancel a download.
- Locale or tab changes do not destroy the private update handle.
- Disposal prevents late state publication.
- Update failures never clear editor content or initiate exit.

## 10. Startup and Manual Checks

- Schedule one startup check eight seconds after application initialization.
- Disable updater work in development/test and unpackaged binaries.
- A startup-check failure becomes a structured log entry with no user notification.
- Manual checking always provides a result:
  - update found: show available state;
  - no update: notify that the application is current;
  - failure: show a retryable user message where appropriate.
- The existing **Check for Updates…** command calls `check("manual")`.
- If the current Linux installation cannot self-install, update discovery still shows the version and opens its GitHub Release instead of downloading an AppImage over a deb installation.

## 11. User Interaction

Use the existing non-modal update-banner region rather than adding a new modal system.

### 11.1 Available

Show version and plain-text notes with:

- **Download update**
- **View release notes**
- **Later**

### 11.2 Downloading

Show bytes and percentage when total size is known, with **Hide**. Do not promise cancellation or resumability.

### 11.3 Downloaded

Show:

- **Restart and install**
- **Later**

Downloaded state lasts for the process lifetime. A later process may check and download again.

### 11.4 Blocked

List affected tabs and reasons, preserving document names but no full paths. Provide **View first problem document** and **Dismiss**. Do not offer force quit, discard-all, overwrite, automatic normalization acceptance, or recovery-only installation.

### 11.5 Final confirmation

After readiness and session flush succeed, enter `readyToInstall` and show a final confirmation stating that installation closes and restarts oh-my-md and that all documents are saved. Only the separate `install()` action invokes installation. On Windows, updater installation terminates the process and the NSIS installer relaunches it, so all safety checks and confirmation must precede the call; macOS and AppImage call Tauri process relaunch after installation resolves.

## 12. Document-Safety Gate

```ts
type UpdateBlockReason =
  | "dirtyDocument"
  | "saveConflict"
  | "saveFailed"
  | "pendingNormalization"
  | "openOperation"
  | "activeSave"

interface UpdateBlockedTab {
  tabId: number
  displayName: string
  reason: UpdateBlockReason
}

interface UpdateRestartReadiness {
  ready: boolean
  reasons: UpdateBlockedTab[]
}
```

Before restart:

1. flush the document materializer so the latest CodeMirror edits reach session state;
2. derive readiness from existing session, normalization, open-operation, and save-state sources;
3. if blocked, remain running and present reasons;
4. if ready, request the existing session-flush protocol;
5. if flush times out, abort installation and keep the application running;
6. after explicit final confirmation, install and relaunch.

The update flow must not duplicate Markdown save semantics or bypass guarded save. Unlike ordinary OS-driven quit, update installation must not force exit after the existing two-second flush timeout.

Rust may add a narrow update-specific command that reuses `FlushGate` events and acknowledgements but returns an explicit result:

```rust
enum PrepareUpdateRestartResult {
    Ready,
    TimedOut,
}
```

Any multi-word IPC fields require Rust serialized-JSON assertions.

## 13. Install Capability

The application needs one platform-owned capability result rather than scattered UA/path checks:

```ts
interface UpdateCapability {
  check: boolean
  install: boolean
  reason?: "development" | "manualPackage" | "unsupported"
}
```

Expected policy:

| Runtime | Check | Install |
| --- | ---: | ---: |
| Packaged macOS application | yes | yes |
| Windows NSIS installation | yes | yes |
| Windows MSI installation | yes | no; open Release |
| Linux AppImage (`APPIMAGE` is present) | yes | yes |
| Linux deb/other package | yes | no; open Release |
| Development/unpackaged binary | no | no |
| Unknown | no | no |

MSI is deliberately check-only: a generic `windows-x86_64` manifest entry would otherwise let an MSI installation consume the NSIS updater and mix installer ownership.

Unknown environments fail closed. Platform branching stays in `apps/desktop/src/platform.ts` or Rust `cfg!(target_os = …)` as appropriate.

## 14. Error Policy

Classify dependency errors into stable product categories; do not expose raw updater internals.

| Failure | Startup behavior | Manual behavior |
| --- | --- | --- |
| Network unavailable | log, return idle | retryable message |
| No update | return idle | current-version notification |
| Invalid manifest | log, return idle | generic update failure |
| Invalid signature | never install; high-priority log | verification failure + official Release link |
| No platform artifact | log, return idle | manual Release link |
| Download failure | n/a | retain retry action |
| Session flush timeout | n/a | abort install; continue editing |
| Installation failure | n/a | remain running when possible; Release link |

Never fall back from signature failure to an unverified URL or expose an override button.

## 15. Differential Update Roadmap

### 15.1 Measurement gate

First report per-platform complete artifact sizes and adjacent-version change ratios in release CI. Do not add user telemetry merely to justify differential updates.

Proceed only if one of these is demonstrated:

- updater artifacts regularly exceed roughly 80–100 MB;
- user evidence shows complete downloads are a material problem;
- adjacent-version patches reduce transfer size by at least 50%;
- release frequency makes complete transfers operationally expensive.

### 15.2 Preferred first experiment

Evaluate AppImage zsync as the first bounded experiment because it is an established AppImage mechanism. It must preserve an equivalent final minisign trust boundary; otherwise retain Tauri full updates.

### 15.3 General delta contract

If measurements justify a cross-platform layer, deltas are optional download optimizations bound to one exact source version and one exact target version. At most generate `N-1 → N`, and add `N-2 → N` only when usage evidence justifies it. Do not create all historical pairs or patch chains.

A delta is offered only when it is less than 70% of the complete artifact. The client:

1. verifies the local baseline identity;
2. downloads the patch into a temporary directory;
3. validates the patch SHA-256;
4. rebuilds a complete target updater artifact outside the installation directory;
5. validates the target SHA-256;
6. validates the rebuilt artifact with the Tauri minisign public key;
7. hands the complete verified artifact to the normal installation path.

Any failure deletes temporary output and falls back to the official complete artifact. Never patch a running installation in place.

## 16. Testing

### 16.1 TypeScript

Add focused tests for:

- every coordinator state transition;
- startup versus manual error visibility;
- duplicate check/download/install suppression;
- progress projection and hidden-banner behavior;
- signature/install failure handling;
- install-capability routing;
- dirty, conflict, save-failed, normalization, open, and active-save blockers;
- materializer flush before readiness;
- timeout abort without relaunch;
- safe install/relaunch ordering;
- plain-text release notes rendering;
- stale async completion after disposal.

### 16.2 Rust

Test:

- install capability on cfg-selected platform paths using pure policy inputs where possible;
- `APPIMAGE` recognition without mutating unrelated global platform behavior;
- update-specific flush success and timeout;
- IPC camelCase serialization for multi-word payloads.

### 16.3 Workflow contracts

Extend release workflow tests and add promotion/withdrawal contract tests for:

- signing secrets limited to release package jobs;
- updater artifact and `.sig` requirements;
- complete static manifest platform matrix;
- immutable tag URLs;
- candidate manifest and checksum coverage;
- Draft-only tag workflow behavior;
- protected manual promotion/withdrawal;
- promotion from public non-prerelease Release only;
- strictly increasing stable version;
- public endpoint post-deploy verification;
- no rebuilding or signing during promotion;
- no tag/asset mutation during withdrawal.

### 16.4 Manual QA

Update `docs/manual-qa.md` with:

- first manual upgrade from `0.0.1` to the updater-capable release;
- startup and manual checks;
- download progress and Later behavior;
- each document-safety blocker;
- session-flush timeout simulation;
- macOS Universal update on Apple Silicon and Intel where available;
- Windows NSIS update and MSI/manual behavior;
- AppImage replacement and deb manual flow;
- unsigned Gatekeeper/SmartScreen behavior;
- stable promotion, endpoint inspection, withdrawal, and higher-version recovery;
- minisign rejection using a deliberately invalid candidate in a non-production test channel or local fixture.

Before release, run `pnpm verify`, relevant Playwright checks if visual geometry changes, the release workflow in artifact-only mode, and platform installation smoke tests.

## 17. Documentation

Update:

- `README.md` and `README-zh.md`: supported automatic-update matrix, unsigned platform warnings, and first manual upgrade requirement;
- `CONTRIBUTING.md`: key setup, candidate Release, protected promotion, withdrawal, and immutable-version procedure;
- `docs/manual-qa.md`: update verification matrix;
- root/domain `AGENTS.md` only if permanent ownership or recurring constraints change;
- known-gotchas only after a reusable trap is verified in implementation.

## 18. Delivery Milestones

### M1: Official complete-bundle updater

Restore Tauri updater integration, implement the coordinator and safety gate, produce signed updater artifacts and a candidate manifest, and support manual update checks. This milestone is testable without exposing startup checks to production users.

### M2: Stable control plane

Add protected promotion and withdrawal workflows, GitHub Pages history/status deployment, endpoint verification, and enable the eight-second startup check. M1 and M2 may share a branch but remain independently reviewable commits.

### M3: Differential feasibility report

This is a separate follow-up project and implementation plan. Report artifact sizes and offline zsync/bsdiff experiments without changing the production client.

### M4: Optional delta path

Implement only after M3's gate is met. Full updater bundles, final minisign verification, and automatic fallback remain mandatory.

## 19. Acceptance Criteria

The feature is ready when:

- packaged `0.1.0+` clients trust only updater bundles signed by the configured minisign key;
- a protected stable manifest controls update visibility independently from GitHub Release publication;
- startup checks are silent on failure and never download without consent;
- manual checks provide a useful result;
- macOS, Windows NSIS, and AppImage users can explicitly download, verify, and install a higher stable version;
- deb and unsupported Linux installations are directed to the immutable Release instead of being replaced;
- dirty, conflicted, failed, normalizing, opening, or saving documents prevent restart installation;
- session-flush timeout aborts update installation without closing the app;
- invalid manifests or signatures never reach installation;
- withdrawal stops new discovery without mutating artifacts or causing downgrade;
- automated tests, workflow contract tests, and platform smoke checks pass;
- differential updating remains disabled until its measurement gate is met.
