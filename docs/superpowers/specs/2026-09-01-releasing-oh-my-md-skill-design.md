# releasing-oh-my-md Project Skill Design

**Date:** 2026-09-01  
**Status:** Approved in chat; awaiting written-spec review  
**Scope:** Project-local Pi skill for preparing and publishing immutable oh-my-md releases

## Goal

Create a project-local Agent Skill at `.pi/skills/releasing-oh-my-md/SKILL.md` that guides an agent through releasing oh-my-md from source. The skill prepares and verifies a release, creates the local release commit and annotated tag, requires exact user confirmation before pushing, monitors the three-platform GitHub Actions workflow, validates the resulting Draft Release, and hands final publication back to a human.

The intended invocation is:

```text
/skill:releasing-oh-my-md 0.0.2
```

The first release is `0.0.1`. The skill accepts only strict `x.y.z` versions. It does not support a fourth numeric segment, prerelease identifiers, or build metadata in this initial implementation.

## Location and Discovery

The skill lives in the repository:

```text
.pi/skills/releasing-oh-my-md/SKILL.md
```

Project-local placement keeps the workflow versioned with oh-my-md, makes it available to every maintainer working in a trusted checkout, and avoids exposing project-specific rules in unrelated repositories.

The frontmatter is:

```yaml
---
name: releasing-oh-my-md
description: Use when preparing, tagging, pushing, monitoring, or validating an oh-my-md GitHub Release from source, including three-platform desktop packages.
---
```

## Release Contract

A published release is immutable:

```text
one version = one tag = one commit = one set of package hashes
```

After `v0.0.1` is pushed, any source change requires a higher version such as `0.0.2`. The skill must never move, overwrite, force-push, or reuse an existing tag. A transient GitHub runner failure may rerun the same workflow for the unchanged tagged commit; a source or workflow fix requires a new patch version.

The release matrix is:

| Platform | Architecture | Packages | Updater artifacts |
| --- | --- | --- | --- |
| macOS | Universal: Intel x86_64 + Apple Silicon arm64 | `.dmg` | `.app.tar.gz`, `.app.tar.gz.sig` |
| Windows | x64 | NSIS `.exe`, WiX `.msi` | NSIS `-setup.exe.sig` (NSIS auto-installs; MSI is check-only/manual) |
| Linux | x64 | `.AppImage`, `.deb` | `.AppImage`, `.AppImage.sig` (AppImage auto-installs; deb is check-only/manual) |

Version `0.0.1` packages are unsigned and upgrade manually; the first updater-capable public version is `0.1.0`. Each package job additionally emits minisign-signed updater artifacts (`.app.tar.gz` + `.app.tar.gz.sig` on macOS, `*-setup.exe.sig` on Windows, `.AppImage` + `.AppImage.sig` on Linux), and the `publish` job attaches the candidate updater manifest `latest.json` to the Draft.

Stable-channel automatic updates are separate from this release workflow. The Draft is explicitly promoted to `https://zuixi.github.io/oh-my-md/updates/stable/latest.json` only by the protected manual `stable-updates` workflow (required reviewers; Pages source = GitHub Actions is an external repository setting), never by this skill.

## Skill Workflow

### 1. Validate the request

The skill requires exactly one strict version argument matching:

```regex
^[0-9]+\.[0-9]+\.[0-9]+$
```

If the argument is absent or invalid, it prints the expected invocation and stops. It does not infer or auto-increment a version.

### 2. Run read-only preflight checks

Before modifying files, the agent verifies:

- The checkout is the `Zuixi/oh-my-md` repository.
- The current branch is `main`.
- The working tree is clean, including untracked files.
- `origin/main` exists and local `main` is synchronized with it.
- `gh auth status` succeeds.
- `.github/workflows/release.yml` exists.
- The requested version exactly equals the already-prepared synchronized `tauri.conf.json` version; a lower or different version is rejected.
- The four version-bearing files currently agree.
- Neither local nor remote contains `vX.Y.Z`.
- GitHub has no Release for `vX.Y.Z`.

Any failed check stops the workflow. The agent must not stash, discard, commit, reset, switch branches, delete tags, or otherwise repair the repository automatically.

### 3. Prepare release files

The agent executes the existing project commands:

```sh
pnpm release:version X.Y.Z
pnpm release:changelog
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Because the requested version must already equal the synchronized source version, the version command is idempotent; it validates rather than increments the prepared target.

It then verifies:

- `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, and `apps/desktop/src-tauri/tauri.conf.json` all contain `X.Y.Z`.
- `Cargo.lock` records the local `omd` package version when applicable.
- `CHANGELOG.md` contains the new release.
- No user-facing README claims an obsolete hard-coded release version.

If preparation fails, the skill stops before commit or tag creation and reports the modified files for human recovery.

### 4. Verify the source release

Run the repository-wide release gate:

```sh
pnpm verify
```

The skill must report only checks evidenced by command output. The repository has no global lint or format command, so it must not claim lint or formatting passed.

A failed verification stops the workflow. No commit, tag, or push is allowed after failure.

### 5. Create the local release commit and tag

The agent inspects the diff and stages only reviewed release files. It must not use `git add .`, `git add -A`, force flags, or wildcard staging that can capture unrelated files.

Expected release metadata:

```sh
git commit -m "chore: prepare vX.Y.Z release"
git tag -a vX.Y.Z -m "oh-my-md vX.Y.Z"
```

Before tagging, the agent rechecks that the tag does not exist. Before push confirmation, it displays:

- Release version and tag
- Release commit SHA
- Staged/committed file list
- Verification result
- The macOS, Windows, and Linux package matrix
- The warning that a pushed version is consumed and must not be reused

### 6. Require exact push confirmation

The agent must stop and request this exact confirmation:

```text
确认推送 vX.Y.Z
```

Only a user message containing that exact versioned phrase authorizes:

```sh
git push origin main
git push origin vX.Y.Z
```

Generic approval such as “继续”, “好的”, or “确认” is insufficient. The skill never force-pushes. If `main` push succeeds but tag push fails, it reports the partial state and stops instead of attempting destructive recovery.

Because an agent session may not safely resume across a separate invocation, the skill must record enough state in its response—commit SHA and tag—to let a follow-up invocation verify that the local release commit/tag are exactly the prepared ones before accepting confirmation. It must never trust a stale conversational assertion without checking Git.

### 7. Monitor GitHub Actions

After a successful tag push, use `gh` to identify the Release workflow run for the exact tag and monitor it to completion. Do not select “the latest run” without matching the tag and workflow.

On failure, report:

- Run URL
- Failed job and step when available
- Whether the failure appears transient or requires a source/workflow change

The skill may recommend manually rerunning an unchanged transient failure, but it does not automatically rerun jobs, delete tags, move tags, create a replacement tag, or alter source.

### 8. Validate the Draft Release

When the workflow succeeds, verify that the GitHub Release:

- Uses tag `vX.Y.Z`.
- Is a Draft, not published.
- Has a title containing `X.Y.Z`.
- Contains at least one `.dmg`.
- Contains at least one `-setup.exe`.
- Contains at least one `.msi`.
- Contains at least one `.AppImage`.
- Contains at least one `.deb`.
- Contains `SHA256SUMS.txt`.
- Contains `latest.json` (the candidate updater manifest) and at least one each of `.app.tar.gz`, `.app.tar.gz.sig`, `-setup.exe.sig`, `.AppImage`, `.AppImage.sig`.
- States that macOS and Windows packages are unsigned.

Artifact matching is suffix/pattern based; exact Tauri-generated filenames are not hard-coded. The candidate manifest is additionally validated with the tested repo CLI (`node scripts/update-manifest.mjs validate --manifest <latest.json> --version X.Y.Z --tag vX.Y.Z --assets <dir>`) for strict-semver version, RFC 3339 `pub_date`, the four platform keys, exact-tag immutable URLs, and non-empty signatures.

A missing package, missing checksum, missing updater set, wrong tag, or non-Draft state is a failed release validation. The skill must not describe a partial Release as complete, and the candidate manifest is not treated as a promoted stable update.

### 9. Hand off manual QA and publication

The final response includes:

- GitHub Actions run URL
- Draft Release URL
- Asset list
- Checksum verification commands
- macOS Universal/Gatekeeper smoke checks
- Windows NSIS/MSI/SmartScreen smoke checks
- Linux AppImage/deb smoke checks
- A reminder that only a human may click **Publish release**

The skill never publishes a Draft Release, edits release visibility, or marks a release as latest. Stable-channel promotion and withdrawal are a separate protected handoff: after the human publishes, the manual `promote-update.yml` / `withdraw-update.yml` workflows (behind required reviewers on the `stable-updates` environment; Pages source = GitHub Actions is a repository setting, not automated) move the candidate to the stable endpoint. The skill never runs or schedules those workflows and never accesses the updater signing private key (`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are GitHub Actions secrets confined to package-building jobs).

## Safety Rules

The following are hard stops:

- Dirty or untracked working tree
- Branch other than `main`
- Divergence from `origin/main`
- Invalid, lower, different, existing, or reused version
- Failed version synchronization
- Failed changelog generation
- Failed `pnpm verify`
- Missing exact push confirmation
- Partial platform build
- Non-Draft or incomplete Release

Forbidden commands and behaviors include:

- `git add .` / `git add -A`
- `git push --force` / `--force-with-lease`
- `git tag -f`
- deleting or moving an existing release tag
- auto-publishing a GitHub Release
- auto-running stable promotion/withdrawal for the user
- accessing or reproducing the updater signing private key
- silently discarding or stashing user changes
- claiming success without fresh command/API evidence

## Skill Testing Strategy

Skill creation follows the `writing-skills` RED–GREEN–REFACTOR process.

### Baseline scenarios without the skill

Use fresh bounded release scenarios to establish whether an agent naturally:

1. Continues with a dirty working tree.
2. Reuses an existing `0.0.1` version or moves its tag.
3. Commits after `pnpm verify` fails.
4. Pushes after generic approval without exact versioned confirmation.
5. Treats a Release missing one platform as successful.
6. Publishes the Draft automatically.
7. Uses `git add .` and captures unrelated files.

Document the baseline failures and rationalizations before writing `SKILL.md`.

### Verification with the skill

Run the same scenarios with the candidate skill loaded. Passing behavior requires the agent to stop at the correct gate, preserve unrelated work, and report the exact recovery path without destructive actions.

The initial implementation is documentation-only: one `SKILL.md`, no helper script. Existing project scripts, Git, `gh`, and GitHub Actions already provide the required mechanisms. Add a helper only if testing proves agents cannot reliably execute a repeated mechanical check from concise instructions.

## Files Changed by Implementation

Initial implementation creates only:

```text
.pi/skills/releasing-oh-my-md/SKILL.md
```

The broader three-platform release workflow and README changes are separate implementation work. This skill describes and enforces the approved release contract; it must check that the required workflow exists rather than pretending missing release infrastructure is already complete.
