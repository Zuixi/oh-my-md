# Security Policy

## Local-First Privacy & Trust Model

oh-my-md is designed as a pure local desktop application:

- **Your files stay on your disk.** oh-my-md does not require an account, does not send telemetry, and never uploads your Markdown documents.
- **Opt-in diagnostics.** Diagnostic logging is **off by default**. A fresh installation creates no log directory and writes no log files until you explicitly enable it in **Settings → Logging**.
- **Redacted support bundles.** Exported diagnostic `.zip` bundles never include document contents, version snapshots, or update signing keys. Home directories, `file:///` URLs, structured path fields, and secret-shaped tokens (`*_KEY`, `*_TOKEN`, `*_PASSWORD`, `Authorization:`) are redacted at export time.
- **Safe HTML & Markdown rendering.** Complex HTML tables (`<table>`) are validated through a closed-whitelist parser (no `innerHTML`, URL policy enforced); arbitrary HTML blocks and scripts are never executed in preview or export.
- **Guarded filesystem boundaries.** Native Rust commands canonicalize paths, enforce workspace/document asset scopes, validate image magic bytes and size limits, and reject path traversal and unexpected symlink swaps on save.
- **Minisign-verified updates.** Although installer packages are currently unsigned (see [README.md](./README.md#unsigned-package-warning)), every in-app update bundle is signed with the project's minisign private key and verified against the bundled public key before installation. A signature failure stops the update and never falls back to an unverified URL.

## Contributor Security Contract

The contributor-facing target contract for filesystem authority is documented
in [`docs/superpowers/specs/2026-11-24-security-model-design.md`](./docs/superpowers/specs/2026-11-24-security-model-design.md):
Rust owns document/workspace identity and paths, native user actions mint
capabilities, and every IO operation resolves through one authority layer.
New IPC commands must follow that model; do not add a renderer-supplied path as
authority. The spec records the interim per-window implementation and migration
phases.

## Supported Versions

Security fixes are shipped on the latest `0.1.x` release line. Older releases do not receive backports.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report security issues privately using [GitHub Security Advisories](https://github.com/Zuixi/oh-my-md/security/advisories/new) on this repository. Include:

- A clear description of the vulnerability and its impact
- Reproduction steps or a minimal proof of concept
- Your OS and oh-my-md version

We will acknowledge receipt and coordinate a fix before public disclosure.
