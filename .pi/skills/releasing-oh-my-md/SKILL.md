---
name: releasing-oh-my-md
description: Use when preparing, tagging, pushing, monitoring, or validating an oh-my-md GitHub Release from source, including three-platform desktop packages.
---

# Releasing oh-my-md

A release is immutable: **one version = one tag = one commit = one package-hash set**. Run each gate in order and stop on any failure.

## 1. Validate the argument

Require exactly one argument matching `^[0-9]+\.[0-9]+\.[0-9]+$`. Do not infer or increment it. Otherwise print `/skill:releasing-oh-my-md X.Y.Z` and stop. Set `VERSION=X.Y.Z` and `TAG=vX.Y.Z` only after validation.

## 2. Detect new preparation or local continuation

Immediately after argument validation, inspect local, remote, and GitHub state. There are only two valid starting states:

- **New preparation:** local `refs/tags/$TAG` does not exist. Continue through the normal preflight below, which must also reject an existing remote tag or GitHub Release.
- **Prepared local continuation:** a local **annotated** `TAG` exists, while the remote tag and GitHub Release do not. Accept this state only if all of these fresh checks pass:
  - the tree is clean, including untracked files, and the branch is `main`;
  - `HEAD` equals the tag's peeled commit (`refs/tags/$TAG^{}`);
  - `HEAD` is exactly one commit ahead of local `origin/main`, local `origin/main` equals `refs/heads/main` from `git ls-remote origin`, and there is no divergence;
  - the exact `HEAD` subject is `chore: prepare v$VERSION release`;
  - all four version files equal `VERSION`;
  - `git diff-tree --no-commit-id --name-only -r HEAD` contains only reviewed release paths: `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`, `CHANGELOG.md`, and optionally `apps/desktop/src-tauri/Cargo.lock`.

Any mixture or failed continuation check is a hard stop. In particular, never treat an arbitrary commit/tag as prepared state. For a valid continuation, record the peeled commit SHA, skip release-file preparation and local commit/tag creation, and go to the verification gate. Evidence from an earlier invocation is stale: rerun `pnpm verify` on this exact clean tagged commit before accepting push confirmation.

## 3. Read-only preflight for a new preparation

Before changing files, gather fresh evidence and require all of these:

- `git remote get-url origin` identifies `Zuixi/oh-my-md`.
- `git branch --show-current` is `main`.
- `git status --porcelain` is empty, including untracked files.
- Local `HEAD` equals both `refs/heads/main` from `git ls-remote origin` and local `origin/main`.
- `gh auth status` succeeds and `.github/workflows/release.yml` exists.
- The versions in `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, and `apps/desktop/src-tauri/tauri.conf.json` agree.
- `VERSION` is strictly greater than that current version by numeric semver comparison.
- `git rev-parse -q --verify "refs/tags/$TAG"` finds nothing; `git ls-remote --exit-code --tags origin "refs/tags/$TAG"` finds nothing; `gh release view "$TAG"` finds no Release.

An invalid/equal/lower/used version, dirty tree, wrong branch, divergence, auth failure, disagreement, or missing workflow is a **hard stop**. Report evidence and affected paths. Never auto-stash, clean, reset, discard, commit, switch branches, delete/move tags, or otherwise repair state. A pushed version is consumed; source or workflow changes require a greater version. Only an unchanged tagged commit with a transient runner failure may be manually rerun.

## 4. Prepare existing release files (new preparation only)

Run exactly:

```sh
pnpm release:version "$VERSION"
pnpm release:changelog
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Then inspect `git status --short` and `git diff`. Require all four version-bearing files to contain `VERSION`, `Cargo.lock` to record the local `omd` version when applicable, `CHANGELOG.md` to contain the release, and user-facing README files not to claim an obsolete hard-coded version. If a command fails or unexpected files change, stop and report modified paths; do not repair or absorb them.

## 5. Verification gate

Run a fresh:

```sh
pnpm verify
```

For a continuation, first recheck that the tree is clean and `HEAD` still equals the annotated tag's peeled commit; run verification at that exact commit. Failure or any resulting tree change is a hard stop: report the failed command, relevant output, and modified files. Do **not** commit, tag, or push. Claim only checks shown by output; this repository has no global lint/format command, so never claim lint or formatting passed.

## 6. Local commit and annotated tag (new preparation only)

Review the final diff. Stage each reviewed release path explicitly, for example `git add package.json apps/desktop/package.json apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/tauri.conf.json CHANGELOG.md`, adding `apps/desktop/src-tauri/Cargo.lock` only if reviewed and changed. Never use `git add .`, `git add -A`, globs, or wildcard staging. Stop if any unstaged or untracked change is unexpected.

Inspect `git diff --cached`, then run:

```sh
git commit -m "chore: prepare v$VERSION release"
git rev-parse -q --verify "refs/tags/$TAG"  # must still find nothing
git tag -a "$TAG" -m "oh-my-md $TAG"
```

Record the release commit SHA and verify the annotated tag peels to that exact commit. Before asking to push, show: version/tag, commit SHA, committed file list, successful `pnpm verify` evidence, the macOS Universal `.dmg`, Windows x64 `-setup.exe` and `.msi`, Linux x64 `.AppImage` and `.deb` matrix, and the warning that pushing consumes the version permanently.

## 7. Version-bound push-confirmation gate

Stop and request this phrase with the actual tag substituted:

```text
确认推送 vX.Y.Z
```

The user's message may contain other text, but it must contain the literal `确认推送 $TAG` delimited on both sides by the start/end of the string, whitespace, or punctuation. Match the escaped full tag and require the boundary after its final digit, so `确认推送 v0.0.20` cannot authorize `v0.0.2`. “继续”, “好的”, “确认”, or any differently versioned/general approval is insufficient.

Immediately before accepting that authorization, re-read Git and remote state: require a clean tree; `HEAD` equal to the recorded commit and annotated tag's peeled commit; the exact subject and committed-file allowlist from Section 2; local `origin/main` still equal to remote `main` and exactly one commit behind `HEAD`; and no remote `TAG` or GitHub Release. For a continuation, require the fresh successful `pnpm verify` from this invocation on that exact commit. Never trust stale conversation or verification evidence.

Only after all checks and the version-bound phrase are present, run without force:

```sh
git push origin main
git push origin "$TAG"
```

If either fails—including main succeeding but tag failing—report the partial state and stop. No destructive recovery, tag recreation, or force push.

## 8. Monitor the exact workflow run

Use `gh run list --workflow release.yml --event push --json databaseId,headBranch,headSha,status,conclusion,url,createdAt` and select the run whose `headBranch` is exactly `TAG` and `headSha` is the recorded commit. Never choose merely “the latest” run. Watch that run with `gh run watch RUN_ID --exit-status` and inspect failures with `gh run view RUN_ID --log-failed`.

On failure, report the run URL and failed job/step, and classify whether it appears transient or needs a source/workflow change. Do not rerun automatically. A human may manually rerun a transient failure only for the unchanged tagged commit; a fix requires a new version.

## 9. Validate the Draft Release

Re-read current state with `gh release view "$TAG" --json tagName,isDraft,name,body,url,assets`. Do not create another Release if one already exists. Require:

- exact tag `TAG`, Draft state, and title containing `VERSION`;
- body stating macOS and Windows packages are unsigned;
- at least one asset matching each pattern: `*.dmg`, `*-setup.exe`, `*.msi`, `*.AppImage`, `*.deb`;
- an asset named exactly `SHA256SUMS.txt`.

Match suffixes/patterns, not complete generated filenames. Wrong tag/state, missing notice/checksum, or any missing platform package is failed validation—not partial success. Report the inventory and stop; never mutate release state to conceal a mismatch.

## 10. Human QA and publication handoff

Provide the workflow URL, existing Draft URL, complete asset inventory, and download/checksum instructions (`sha256sum -c SHA256SUMS.txt` on Linux, `shasum -a 256 -c SHA256SUMS.txt` on macOS, and `Get-FileHash -Algorithm SHA256` comparison on Windows). Ask a human to smoke-test:

- macOS Universal `.dmg`: install/launch on Intel and Apple Silicon where available; record Gatekeeper behavior.
- Windows x64: install/launch both NSIS and MSI; record SmartScreen behavior.
- Linux x64: launch the AppImage and install/launch the `.deb`.

Only a human may click **Publish release**. Never publish, change visibility, or mark the release latest automatically.

## Red flags — stop

| Rationalization or action | Required response |
| --- | --- |
| “Replace the old release/tag after this fix” or `gh release delete` | Refuse; the version is consumed. Use a greater version. |
| “The local tag proves the old verification passed” | Refuse; validate continuation state and rerun `pnpm verify` on the exact clean tagged commit. |
| “CI can be the verification gate” after failed `pnpm verify` | Refuse; no commit, tag, or push. |
| Generic “继续” or a different/prefix version in the confirmation | Refuse; require a boundary-delimited literal `确认推送 $TAG` after fresh identity checks. |
| “Create/publish a Draft” without rereading state | Revalidate first; never duplicate or publish it. |
| Missing one platform is “good enough” | Validation failed; require the full matrix and `SHA256SUMS.txt`. |
| `git add .`, `git add -A`, wildcard staging, force flags, tag deletion/movement, silent stash/reset | Forbidden. Stop and preserve user and release state. |

Never claim success without fresh command/API evidence.
