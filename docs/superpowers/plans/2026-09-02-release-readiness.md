# Three-Platform Release Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make v0.0.1 releasable as unsigned macOS Universal, Windows x64, and Linux x64 packages, with one validated Draft Release and accurate download documentation.

**Architecture:** Three OS jobs build and upload workflow artifacts; one Linux publish job downloads them, verifies the five package types, generates SHA256SUMS.txt, and creates one Draft Release. The dormant updater integration is replaced by a manual non-modal GitHub Releases notice while retaining the Check for Updates command.

**Tech Stack:** GitHub Actions, Tauri 2, React/Vitest, pnpm, Cargo.

**Spec:** Approved conversation decisions: matrix B; unsigned packages; v0.0.1; no automatic updates; human-only Draft publication.

## Tasks

### Task 1: Lock release workflow contract with a failing test
- Add `apps/desktop/test/releaseWorkflow.test.ts` asserting macOS/Windows/Linux jobs, fixed runners, Universal DMG, NSIS/WiX, AppImage/deb, tag-version validation, artifact aggregation, SHA256SUMS, complete-asset validation, and one Draft publish job.
- Run it and confirm failure against the Windows-only workflow.
- Replace `.github/workflows/release.yml` with the minimal four-job workflow and make the test pass.

### Task 2: Replace dormant updater behavior with download notice
- Change `App.updateCheck.test.tsx` first: manual Check for Updates shows the unavailable/download banner and opens `https://github.com/Zuixi/oh-my-md/releases/latest`; no startup check occurs.
- Confirm failure.
- Reuse `UpdateBanner` as a static notice; remove startup timer, updater service/dependencies/config/plugin, and obsolete updater tests.
- Run desktop tests.

### Task 3: Normalize v0.0.1 and public documentation
- Set all four version files and Cargo.lock local package to `0.0.1`; run version drift test.
- Update README/README-zh installation tables, unsigned warnings, platform-specific instructions, SEO title/CTA, export platform scope, and roadmap.
- Update CONTRIBUTING and manual QA release sections.
- Update the project release Skill so an unused target equal to the already-prepared current version is valid; keep lower/existing versions forbidden.

### Task 4: Full verification and review
- Run focused tests, `pnpm verify`, workflow syntax/static checks, and inspect the diff.
- Request code review and fix blocking findings.
