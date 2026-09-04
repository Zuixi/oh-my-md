# Automatic Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship signed, user-controlled stable-channel updates for packaged macOS, Windows NSIS, and Linux AppImage builds, with safe manual routing for Windows MSI/Linux deb and protected stable promotion/withdrawal.

**Architecture:** A desktop-owned `updateCoordinator` keeps the Tauri `Update` resource private and publishes a serializable state machine to React. Pure readiness classification reuses existing save/conflict/normalization state, while Rust supplies packaged-install capability and an update-specific non-destructive session-flush result. Release CI creates signed immutable candidate artifacts; separate protected Pages workflows promote or withdraw the stable manifest without rebuilding binaries.

**Tech Stack:** React 19, strict TypeScript, Vitest, Tauri 2.11, Rust 1.87, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`, GitHub Actions, GitHub Pages, minisign.

**Spec:** `docs/superpowers/specs/2026-09-03-automatic-updates-design.md`

## Global Constraints

- Platform code signing/notarization remains deferred; updater minisign verification is mandatory and cannot be bypassed.
- Reuse the existing updater public key and `TAURI_SIGNING_PRIVATE_KEY`; never read, print, rewrite, or commit private-key contents.
- Startup checks run once after exactly 8 seconds only in a packaged, update-check-capable application; they never download silently.
- Automatic installation is allowed only for packaged macOS app, Windows NSIS, and Linux AppImage. Windows MSI and Linux deb/other package are check-only and open the immutable GitHub Release.
- Remote release notes render as plain text, never injected HTML.
- Installation is blocked by dirty documents, any divergence, save failure, active save, pending normalization, or open operation.
- Pending editor materialization is flushed before readiness is evaluated.
- Update session-flush timeout aborts installation and keeps the app running; ordinary quit keeps its existing timeout-and-finish behavior.
- Final confirmation is a separate `readyToInstall` state; only `install()` invokes the platform installer.
- Windows updater `install()` may terminate the process without resolving; all safety work must happen first.
- Static stable endpoint: `https://zuixi.github.io/oh-my-md/updates/stable/latest.json` over HTTPS only.
- Release artifacts and tags are immutable. Promotion is strictly increasing; withdrawal restores the previous known-good manifest and never downgrades installed clients.
- Canonical Linux updater artifact is Tauri 2.11's raw `.AppImage` plus `.sig`; the same AppImage is the human package.
- No beta channel, forced update, silent download/install, custom update server, delta patching, or downloaded-bundle persistence in this plan.
- Follow TDD: every production behavior starts with a focused failing test and observed expected failure.
- Do not grow `App.tsx` with updater internals; orchestration belongs in focused desktop modules.

---

## File Structure

### New desktop modules

- `apps/desktop/src/updateRestartReadiness.ts` — pure classifier from workspace/save/normalization/open snapshots to deterministic blocker rows.
- `apps/desktop/src/updateAdapter.ts` — narrow wrapper around official Tauri updater/process APIs; owns raw plugin event conversion.
- `apps/desktop/src/updateCoordinator.ts` — update state machine, concurrency, capability routing, download progress, readiness, and installation ordering.

### New tests

- `apps/desktop/test/updateRestartReadiness.test.ts`
- `apps/desktop/test/updateAdapter.test.ts`
- `apps/desktop/test/updateCoordinator.test.ts`
- `apps/desktop/test/UpdateBanner.test.tsx`
- `apps/desktop/test/updateWorkflows.test.ts`
- `apps/desktop/test/fixtures/update-manifest/` — deterministic empty artifact fixtures created inside tests; do not commit binaries.

### New release tooling

- `scripts/update-manifest.mjs` — generate/validate candidate manifests, verify immutable URLs and signatures, and build stable status/history files.
- `.github/workflows/promote-update.yml`
- `.github/workflows/withdraw-update.yml`

### Existing integration points

- `apps/desktop/src/App.tsx`, `UpdateBanner.tsx`, `desktopServices.ts`, `constants.ts`, i18n messages, and `styles.css`.
- `apps/desktop/src-tauri/src/session_flush.rs`, `src/lib.rs`, `Cargo.toml`, `tauri.conf.json`, and capability permissions.
- `.github/workflows/release.yml` and release workflow tests.
- `README.md`, `README-zh.md`, `CONTRIBUTING.md`, `docs/manual-qa.md`, and `apps/desktop/AGENTS.md`.

---

### Task 1: Pure Update Restart Readiness

**Files:**
- Create: `apps/desktop/src/updateRestartReadiness.ts`
- Create: `apps/desktop/test/updateRestartReadiness.test.ts`

**Interfaces:**
- Consumes: `Workspace` and `baseName` from `workspace.ts`, `sessionDirty` from `session.ts`, `SaveStateByTab`/`tabSaveState` from `documentSaveState.ts`, and `NormalizationByTab` from `normalizationState.ts`.
- Produces:

```ts
export type UpdateBlockReason =
  | "dirtyDocument"
  | "saveConflict"
  | "saveFailed"
  | "pendingNormalization"
  | "openOperation"
  | "activeSave"

export interface UpdateBlockedTab {
  readonly tabId: number
  readonly displayName: string
  readonly reason: UpdateBlockReason
}

export interface UpdateReadinessInput {
  readonly workspace: Workspace
  readonly contentsByTab: ReadonlyMap<number, string>
  readonly saveStates: SaveStateByTab
  readonly normalization: NormalizationByTab
  readonly opening: boolean
}

export interface UpdateRestartReadiness {
  readonly ready: boolean
  readonly reasons: readonly UpdateBlockedTab[]
}

export function updateRestartReadiness(input: UpdateReadinessInput): UpdateRestartReadiness
```

Blocker precedence per tab is exactly:

```text
saveConflict → saveFailed → activeSave → pendingNormalization → dirtyDocument
```

A global open operation adds one `openOperation` row for the active tab after per-tab rows, unless that exact tab/reason already exists. Any non-`none` divergence is `saveConflict`. Use existing tab labels/basenames and never expose full paths.

- [ ] **Step 1: Write the failing classifier tests**

Cover one green-ready case, each blocker, precedence, deterministic workspace-tab order, untitled display name, non-active dirty tabs, and active-tab open operation. Example:

```ts
it("prioritizes conflict over dirty and normalization for one tab", () => {
  const result = updateRestartReadiness({
    workspace: workspaceWithFile("/tmp/draft.md"),
    contentsByTab: new Map([[1, "changed"]]),
    saveStates: { 1: { lifecycle: "idle", divergence: "contentConflict" } },
    normalization: { 1: pendingNormalization() },
    opening: false,
  })
  expect(result).toEqual({
    ready: false,
    reasons: [{ tabId: 1, displayName: "draft.md", reason: "saveConflict" }],
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @omd/desktop exec vitest run test/updateRestartReadiness.test.ts
```

Expected: FAIL because `updateRestartReadiness.ts` does not exist.

- [ ] **Step 3: Implement the minimum pure classifier**

Iterate `workspace.tabs`, choose the first matching blocker by the required precedence, then append the active open-operation blocker. Return `{ ready: reasons.length === 0, reasons }`. Do not initiate saves or mutate state.

- [ ] **Step 4: Run focused and desktop tests**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateRestartReadiness.test.ts
pnpm --filter @omd/desktop test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/updateRestartReadiness.ts apps/desktop/test/updateRestartReadiness.test.ts
git commit -m "feat: classify update restart blockers"
```

---

### Task 2: Rust Install Capability and Non-destructive Update Flush

**Files:**
- Modify: `apps/desktop/src-tauri/src/session_flush.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/desktopServices.ts`
- Modify: `apps/desktop/test/desktopServices.test.ts`
- Modify: `apps/desktop/test/crossLayerConstants.test.ts` only if a new shared timeout/event constant is introduced.

**Interfaces:**
- Produces Rust/IPC payloads:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FlushOutcome { Acknowledged, TimedOut }

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PrepareUpdateRestartResult { Ready, TimedOut }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCapability {
    check: bool,
    install: bool,
    reason: Option<UpdateCapabilityReason>,
}
```

```ts
export interface UpdateCapability {
  readonly check: boolean
  readonly install: boolean
  readonly reason?: "development" | "manualPackage" | "unsupported"
}

export type PrepareUpdateRestartResult = { readonly kind: "ready" } | { readonly kind: "timedOut" }
```

- `DesktopServices` gains `updateCapability()` and `prepareUpdateRestart()`.
- Packaged policy: macOS app yes/yes; NSIS yes/yes; MSI yes/no; AppImage yes/yes; deb/rpm/other packaged Linux yes/no; debug/unpackaged/unknown no/no.
- `prepare_update_restart` emits the existing `session-flush` event, waits on the same `FlushGate`, and returns timeout instead of forcing exit.

- [ ] **Step 1: Write failing Rust outcome/policy/serialization tests**

Add tests proving ack and timeout are distinguishable, normal quit callbacks still run for both outcomes, capability policy follows the table, and JSON fields/variants are camelCase.

- [ ] **Step 2: Run Rust tests and verify RED**

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml session_flush
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml update_capability
```

Expected: FAIL because outcomes, policy, and commands do not exist.

- [ ] **Step 3: Change `FlushGate::begin` minimally**

Change the callback signature to `FnOnce(FlushOutcome)`. Determine outcome from `recv_timeout`. Existing quit/window/exit call sites accept `_outcome` and preserve current behavior. Keep `flushed` semantics unchanged for ordinary exit.

- [ ] **Step 4: Add capability and update restart commands**

Use Tauri bundle type/runtime facts and `cfg!(debug_assertions)`; do not inspect user-agent strings. Register both commands in `generate_handler!`. The update restart command must return `TimedOut` without closing or restarting the app.

- [ ] **Step 5: Write failing TypeScript invoke-contract tests**

Assert exact command names and returned types through mocked `invoke`:

```ts
expect(invoke).toHaveBeenCalledWith("update_capability")
expect(invoke).toHaveBeenCalledWith("prepare_update_restart")
```

- [ ] **Step 6: Add the two `DesktopServices` methods and run tests**

```bash
pnpm --filter @omd/desktop exec vitest run test/desktopServices.test.ts
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/session_flush.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/desktopServices.ts apps/desktop/test/desktopServices.test.ts apps/desktop/test/crossLayerConstants.test.ts
git commit -m "feat: gate update restart on safe session flush"
```

---

### Task 3: Restore Official Tauri Updater Integration and Adapter

**Files:**
- Create: `apps/desktop/src/updateAdapter.ts`
- Create: `apps/desktop/test/updateAdapter.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/Cargo.lock`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Modify: `apps/desktop/test/tauriConfig.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts
export type AdapterDownloadEvent =
  | { readonly kind: "started"; readonly total?: number }
  | { readonly kind: "progress"; readonly chunkLength: number }
  | { readonly kind: "finished" }

export interface AdapterUpdate {
  readonly currentVersion: string
  readonly version: string
  readonly notes: string
  readonly publishedAt?: string
  download(onEvent: (event: AdapterDownloadEvent) => void): Promise<void>
  install(): Promise<void>
  close(): Promise<void>
}

export interface UpdateAdapter {
  check(): Promise<AdapterUpdate | null>
  relaunch(): Promise<void>
}

export function createTauriUpdateAdapter(): UpdateAdapter
```

The adapter maps plugin events exactly: `Started.data.contentLength`, cumulative work remains coordinator-owned, `Progress.data.chunkLength`, and `Finished`. It dynamically imports official plugins so browser tests do not require Tauri IPC. It never calls raw plugin invoke strings.

Configuration uses the previously shipped public key:

```text
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEUxNEIyRDIyNUExRTY5QgpSV1NiNXFFbDBySVVEaWFnYi9SWU1nWW1Wb2V5U3VMd2FscnQvQ0ZmU2wyQkVPMHhFWjE1ZVluTwo=
```

Endpoint is the exact Pages stable URL. Set `bundle.createUpdaterArtifacts` to `true`. Add least-privilege updater check/download/install permissions and process restart permission; do not grant updater downgrade behavior.

- [ ] **Step 1: Write failing adapter tests**

Mock official modules and test null check, metadata projection, all event mappings, install, relaunch, and close.

- [ ] **Step 2: Run adapter test and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateAdapter.test.ts
```

Expected: FAIL because module/dependencies do not exist.

- [ ] **Step 3: Add dependencies and minimal adapter**

```bash
pnpm --filter @omd/desktop add @tauri-apps/plugin-updater@^2 @tauri-apps/plugin-process@^2
```

Add Rust plugins and register them. Implement only the declared adapter methods.

- [ ] **Step 4: Replace negative config tests with secure positive tests**

Assert exact HTTPS endpoint, exact public key, `createUpdaterArtifacts: true`, plugin registration, and required permissions. Assert insecure transport flags and `allowDowngrades` are absent.

- [ ] **Step 5: Run focused tests and builds**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateAdapter.test.ts test/tauriConfig.test.ts
pnpm --filter @omd/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/updateAdapter.ts apps/desktop/test/updateAdapter.test.ts apps/desktop/package.json pnpm-lock.yaml apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/capabilities/default.json apps/desktop/test/tauriConfig.test.ts
git commit -m "feat: restore signed Tauri updater integration"
```

---

### Task 4: Update Coordinator State Machine

**Files:**
- Create: `apps/desktop/src/updateCoordinator.ts`
- Create: `apps/desktop/test/updateCoordinator.test.ts`

**Interfaces:**

```ts
export type UpdateSource = "startup" | "manual"
export type UpdateFailureKind = "network" | "manifest" | "signature" | "download" | "platformUnsupported" | "flushTimeout" | "install" | "unknown"
export type UpdateStage = "check" | "download" | "readiness" | "install"

export interface AvailableUpdate {
  readonly version: string
  readonly notes: string
  readonly publishedAt?: string
}

export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking"; readonly source: UpdateSource }
  | { readonly kind: "available"; readonly update: AvailableUpdate; readonly installSupported: boolean }
  | { readonly kind: "downloading"; readonly update: AvailableUpdate; readonly downloaded: number; readonly total?: number }
  | { readonly kind: "downloaded"; readonly update: AvailableUpdate }
  | { readonly kind: "blocked"; readonly update: AvailableUpdate; readonly reasons: readonly UpdateBlockedTab[] }
  | { readonly kind: "readyToInstall"; readonly update: AvailableUpdate }
  | { readonly kind: "installing"; readonly update: AvailableUpdate }
  | { readonly kind: "failed"; readonly stage: UpdateStage; readonly failure: UpdateFailureKind; readonly retryable: boolean }
```

```ts
export interface UpdateCoordinatorDependencies {
  readonly updater: UpdateAdapter
  readonly capability: () => Promise<UpdateCapability>
  readonly flushPendingEdits: () => void
  readonly checkRestartReadiness: () => UpdateRestartReadiness
  readonly prepareRestart: () => Promise<PrepareUpdateRestartResult>
  readonly openReleasePage: () => Promise<void>
  readonly reportManualFailure: (failure: UpdateFailureKind) => void
  readonly notifyLatest: () => void
  readonly isWindows: () => boolean
  readonly classifyError: (error: unknown, stage: UpdateStage) => UpdateFailureKind
}

export function createUpdateCoordinator(dependencies: UpdateCoordinatorDependencies): UpdateCoordinator
```

Rules:

- Startup check failure publishes `idle` and no user callback.
- Manual no-update calls `notifyLatest` then publishes `idle`.
- Check-only capability publishes `available` with `installSupported: false`; `download()` opens Release instead of plugin download.
- Download accumulates chunk lengths and keeps the same private handle.
- `requestInstall()` flushes pending edits, classifies readiness, awaits update-specific flush, then enters `readyToInstall`.
- `install()` enters `installing`; on non-Windows await adapter install then relaunch; on Windows call install without depending on resolution.
- Dispose/handle replacement calls `close()` best-effort and suppresses late publications.
- Repeated operations while an operation is active are no-ops.

- [ ] **Step 1: Write failing transition tests**

Cover all states, startup/manual differences, no update, check-only routing, progress accumulation, duplicate suppression, every readiness result, flush timeout, final-confirmation separation, Windows fire-and-exit semantics, non-Windows relaunch ordering, error classification, close, and disposal.

- [ ] **Step 2: Run focused test and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateCoordinator.test.ts
```

Expected: FAIL because coordinator does not exist.

- [ ] **Step 3: Implement the smallest state machine**

Use one listener set, one private adapter handle, one disposed flag, and one operation guard. Do not add persistence, channels, retries, backoff, or cancellation.

- [ ] **Step 4: Run focused and desktop tests**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateCoordinator.test.ts
pnpm --filter @omd/desktop test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/updateCoordinator.ts apps/desktop/test/updateCoordinator.test.ts
git commit -m "feat: coordinate user-controlled application updates"
```

---

### Task 5: Update Banner and App Safety Integration

**Files:**
- Modify: `apps/desktop/src/UpdateBanner.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/constants.ts`
- Modify: `apps/desktop/src/i18n/messages/en.ts`
- Modify: `apps/desktop/src/i18n/messages/zh.ts`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/test/appHarness.ts`
- Replace behavior in: `apps/desktop/test/App.updateCheck.test.tsx`
- Create: `apps/desktop/test/UpdateBanner.test.tsx`

**Interfaces:**
- `UpdateBanner` consumes `UpdateState` and callbacks for download, view release, dismiss/hide, request install, confirm install, and focus blocked tab.
- `App.tsx` creates one coordinator per mounted app, subscribes once, schedules one 8-second startup check, and disposes on cleanup.
- App readiness dependencies use existing refs: `workspaceRef`, `docsRef`, `saveStateRef`, `normalizationRef`, `openingRef`, and `materializer.flush()`.
- Blocked-tab navigation uses existing workspace activation.

- [ ] **Step 1: Write failing `UpdateBanner` component tests**

Assert plain-text notes, available/check-only/downloading/downloaded/blocked/ready-to-install/failed renderings, progress, actions, and no `dangerouslySetInnerHTML` behavior.

- [ ] **Step 2: Run component tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/UpdateBanner.test.tsx
```

Expected: FAIL against the current static notice component.

- [ ] **Step 3: Implement state-driven banner and translations**

Keep existing shared `.update-banner` container behavior and add only update-specific child classes. Do not alter `LargeDocBanner` geometry.

- [ ] **Step 4: Rewrite App update integration tests first**

Cover:

- startup check after 8 seconds and not before;
- manual check from command palette;
- startup failure remains silent;
- manual current/error feedback;
- explicit download only;
- check-only Release routing;
- dirty/conflict/saveFailed/saving/normalization/open blockers;
- materializer flush revealing a last edit before readiness;
- blocked-tab navigation;
- timeout keeps app mounted;
- final confirmation before install;
- cleanup disposal.

Extend `appHarness` with narrow update service fakes rather than mocking plugin modules in every App test.

- [ ] **Step 5: Run App tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/App.updateCheck.test.tsx
```

Expected: FAIL because App still uses the static notice.

- [ ] **Step 6: Wire the coordinator into `App.tsx`**

Remove `showUpdateNotice` and `showUpdateDownloadNotice`. Instantiate adapter/coordinator through desktop-owned dependencies, subscribe to state, schedule startup, and route command/banner callbacks. Keep window listeners stable and do not duplicate save semantics.

- [ ] **Step 7: Run desktop verification**

```bash
pnpm --filter @omd/desktop exec vitest run test/UpdateBanner.test.tsx test/App.updateCheck.test.tsx
pnpm --filter @omd/desktop test
pnpm --filter @omd/desktop build
```

Expected: all pass. Existing unrelated React `act(...)` warnings may remain, but new tests must not add warnings.

- [ ] **Step 8: Run Playwright only if shared banner geometry changed**

```bash
pnpm --filter @omd/desktop test:e2e
```

Expected: pass. Skip only when the diff leaves shared layout geometry unchanged; record that decision in the task report.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/UpdateBanner.tsx apps/desktop/src/App.tsx apps/desktop/src/constants.ts apps/desktop/src/i18n/messages/en.ts apps/desktop/src/i18n/messages/zh.ts apps/desktop/src/styles.css apps/desktop/test/appHarness.ts apps/desktop/test/App.updateCheck.test.tsx apps/desktop/test/UpdateBanner.test.tsx
git commit -m "feat: add safe automatic update interaction"
```

---

### Task 6: Candidate Manifest Tool and Signed Release Artifacts

**Files:**
- Create: `scripts/update-manifest.mjs`
- Create: `apps/desktop/test/updateManifest.test.ts`
- Modify: `.github/workflows/release.yml`
- Modify: `apps/desktop/test/releaseWorkflow.test.ts`
- Modify: `package.json` only if a named script makes the tested CLI clearer.

**Interfaces:**

CLI generation:

```bash
node scripts/update-manifest.mjs candidate \
  --version 0.1.1 \
  --tag v0.1.1 \
  --assets release-assets \
  --output release-assets/latest.json
```

CLI validation:

```bash
node scripts/update-manifest.mjs validate \
  --manifest release-assets/latest.json \
  --version 0.1.1 \
  --tag v0.1.1 \
  --assets release-assets
```

The tool finds actual filenames instead of guessing Tauri naming. It requires exactly one macOS updater tarball/signature, one NSIS executable/signature, and one AppImage tarball/signature. It writes both Darwin architecture entries to the Universal tarball, reads `.sig` text verbatim, uses immutable `https://github.com/Zuixi/oh-my-md/releases/download/v<tag>/...` URLs, and writes an RFC3339 date supplied by `--pub-date` or `SOURCE_DATE_EPOCH` for deterministic tests.

- [ ] **Step 1: Write failing manifest CLI tests**

Create temporary zero-content named fixtures during tests. Cover valid generation, actual filename mapping, signature text, both Darwin keys, exact-tag URLs, strict version/tag match, missing/duplicate assets, empty signature, mutable URL rejection, and checksum inclusion expectations.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateManifest.test.ts
```

Expected: FAIL because the script does not exist.

- [ ] **Step 3: Implement the minimum Node standard-library CLI**

Use `node:fs`, `node:path`, `node:url`, and `JSON.stringify`. Add no dependency and no generic framework.

- [ ] **Step 4: Write failing release workflow contract tests**

Replace the old “no update metadata” assertion. Require signing env only in platform jobs, updater globs, candidate generation/validation, checksum coverage including `latest.json` and `.sig`, and one Draft action. Assert the publish job itself has no signing secret.

- [ ] **Step 5: Update release workflow minimally**

Each platform build job receives the signing key/password, uploads updater artifacts and signatures, and keeps ordinary installers. The aggregate job runs the tested manifest script before checksums and Draft creation. Manual dispatch still creates workflow artifacts only.

- [ ] **Step 6: Run focused tests**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateManifest.test.ts test/releaseWorkflow.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/update-manifest.mjs apps/desktop/test/updateManifest.test.ts .github/workflows/release.yml apps/desktop/test/releaseWorkflow.test.ts package.json
git commit -m "ci: publish signed updater candidates"
```

---

### Task 7: Protected Stable Promotion and Withdrawal

**Files:**
- Extend: `scripts/update-manifest.mjs`
- Create: `.github/workflows/promote-update.yml`
- Create: `.github/workflows/withdraw-update.yml`
- Create: `apps/desktop/test/updateWorkflows.test.ts`
- Extend: `apps/desktop/test/updateManifest.test.ts`

**Interfaces:**

Additional CLI operations:

```bash
node scripts/update-manifest.mjs promote \
  --candidate latest.json \
  --current-site current-site \
  --release-url https://github.com/Zuixi/oh-my-md/releases/tag/v0.1.1 \
  --workflow-run "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --output-site site

node scripts/update-manifest.mjs withdraw \
  --current-site current-site \
  --output-site site
```

Promotion verifies strict increase and writes:

```text
site/updates/stable/latest.json
site/updates/stable/history/<version>.json
site/updates/stable/status.json
site/.nojekyll
```

Withdrawal reads `status.json.previousVersion`, requires its history entry, restores it as `latest.json`, preserves all history, and records the withdrawal/current version. Missing/invalid previous state is a hard failure.

Signature verification in workflow uses a pinned minisign installation or a bounded Rust verifier using the same public key; no private key is available to promotion/withdrawal.

- [ ] **Step 1: Write failing promotion/withdrawal CLI tests**

Cover first promotion, increasing promotion, equal/lower rejection, history preservation, previous version recording, valid withdrawal, missing previous/history hard stops, and no mutation of candidate input.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateManifest.test.ts
```

Expected: FAIL because promote/withdraw operations do not exist.

- [ ] **Step 3: Implement promote/withdraw using the same focused CLI**

Copy the complete existing site tree before changing stable files. Serialize deterministic JSON. Do not add a database, state branch, or service.

- [ ] **Step 4: Write failing workflow contract tests**

Assert both workflows:

- are `workflow_dispatch` only;
- use strict version input for promotion;
- use `environment: stable-updates` for approval;
- serialize with the same concurrency group and `cancel-in-progress: false`;
- use `contents: read`, `pages: write`, `id-token: write` only;
- download/verify a public non-Draft, non-prerelease exact Release;
- never receive signing secrets and never run `tauri build`;
- deploy full Pages content with pinned Pages actions;
- retry-fetch the public `latest.json` and compare its SHA-256;
- withdrawal never calls release/tag mutation commands.

- [ ] **Step 5: Implement both workflows**

Use `gh release view/download` or GitHub API with exact tag checks, decode the committed public key into a temporary file, verify updater artifacts against their decoded signatures, run the tested CLI, upload the complete Pages artifact, deploy, and verify the endpoint with bounded retry/backoff. Required reviewers remain a documented repository-setting prerequisite.

- [ ] **Step 6: Run workflow/tool tests**

```bash
pnpm --filter @omd/desktop exec vitest run test/updateManifest.test.ts test/updateWorkflows.test.ts test/releaseWorkflow.test.ts
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/update-manifest.mjs apps/desktop/test/updateManifest.test.ts apps/desktop/test/updateWorkflows.test.ts .github/workflows/promote-update.yml .github/workflows/withdraw-update.yml
git commit -m "ci: control stable update promotion"
```

---

### Task 8: Documentation, Manual QA, and Release Prerequisites

**Files:**
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/manual-qa.md`
- Modify: `apps/desktop/AGENTS.md`
- Modify: `.pi/skills/releasing-oh-my-md/SKILL.md`
- Modify: `docs/superpowers/specs/2026-09-01-releasing-oh-my-md-skill-design.md` if the release validation contract changes.

**Interfaces:**
- Public docs say `0.0.1` requires manual upgrade and `0.1.0+` introduces updater capability.
- Release guidance separates Draft publication from protected stable promotion.
- Repository settings prerequisites explicitly list Pages source = GitHub Actions and required reviewers on `stable-updates`.
- Key runbook states existing key reuse, secret names, second encrypted offline backup requirement, and loss/compromise recovery without exposing key material.
- Release skill validates updater artifacts, candidate manifest, and stable promotion but still never publishes a Draft or promotes without an explicit human action.

- [ ] **Step 1: Write/update any doc contract assertions first**

If existing workflow/release tests parse docs or release skill wording, make the exact new assertions fail before editing docs. Do not add brittle prose snapshots solely to test documentation.

- [ ] **Step 2: Update user and contributor documentation**

Document supported matrix:

| Package | Automatic install |
| --- | --- |
| macOS app from DMG | yes |
| Windows NSIS | yes |
| Windows MSI | manual |
| Linux AppImage | yes |
| Linux deb | manual |

Keep unsigned Gatekeeper/SmartScreen guidance. Explain that minisign updater trust is active despite unsigned platform packages.

- [ ] **Step 3: Update manual QA**

Add executable checks for startup/manual behavior, no silent download, every blocker, flush timeout, final confirmation, platform package routing, invalid-signature rejection, artifact-only release run, protected promotion, endpoint verification, withdrawal, and higher-version recovery.

- [ ] **Step 4: Update permanent agent/release rules**

Record updater ownership, official-plugin requirement, MSI/deb check-only rule, immutable promotion/withdrawal boundary, and no-private-key rule. Do not add a known-gotcha unless implementation proved a recurring trap.

- [ ] **Step 5: Run doc-related and focused contract checks**

```bash
pnpm --filter @omd/desktop exec vitest run test/releaseWorkflow.test.ts test/updateWorkflows.test.ts test/tauriConfig.test.ts test/versionSync.test.ts

git diff --check
```

Expected: all pass and no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add README.md README-zh.md CONTRIBUTING.md docs/manual-qa.md apps/desktop/AGENTS.md .pi/skills/releasing-oh-my-md/SKILL.md docs/superpowers/specs/2026-09-01-releasing-oh-my-md-skill-design.md
git commit -m "docs: document stable automatic updates"
```

---

### Task 9: Full Verification and Artifact-only Workflow Readiness

**Files:**
- Modify only files required by verified failures.
- Do not push tags, publish Releases, deploy Pages, or change GitHub Environment settings in this task.

**Interfaces:**
- Consumes all previous tasks.
- Produces a locally verified branch and an explicit list of external release prerequisites still requiring a maintainer.

- [ ] **Step 1: Run formatting and repository verification**

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
pnpm verify
pnpm --filter @omd/desktop test:e2e
```

Expected: zero failures. Do not claim lint passed; the repository has no global lint command.

- [ ] **Step 2: Run focused updater contracts again**

```bash
pnpm --filter @omd/desktop exec vitest run \
  test/updateRestartReadiness.test.ts \
  test/updateAdapter.test.ts \
  test/updateCoordinator.test.ts \
  test/UpdateBanner.test.tsx \
  test/App.updateCheck.test.tsx \
  test/updateManifest.test.ts \
  test/releaseWorkflow.test.ts \
  test/updateWorkflows.test.ts \
  test/tauriConfig.test.ts
```

Expected: all pass.

- [ ] **Step 3: Validate workflow YAML and clean tree**

Use an installed YAML parser if already available through the workspace; otherwise parse with Ruby/Python standard YAML only if present. Do not add a dependency for this check.

```bash
git diff --check
git status --short
git log --oneline origin/main..HEAD
```

Expected: no uncommitted changes after any required fix commit.

- [ ] **Step 4: Record external prerequisites in the implementation report**

Explicitly report, without performing them:

- configure GitHub Pages source to GitHub Actions;
- create `stable-updates` Environment and required reviewers;
- verify `TAURI_SIGNING_PRIVATE_KEY` matches the committed public key using an artifact-only workflow;
- create the second encrypted offline private-key backup;
- run `release.yml` manually and inspect real updater filenames/Universal content;
- run three-platform installation QA before stable promotion.

- [ ] **Step 5: Commit any verification-only fixes**

If verification required changes, stage only those paths and use a conventional root-cause subject. If no changes were required, do not create an empty commit.
