# Code Signing Policy

## Free Code Signing

Free code signing on Windows is provided by [SignPath.io](https://signpath.io/), using a certificate issued by the [SignPath Foundation](https://signpath.org/).

## Project Roles

- **Committers**: [@Zuixi](https://github.com/Zuixi) (and repository maintainers listed in GitHub repository settings)
- **Reviewers**: [@Zuixi](https://github.com/Zuixi)
- **Approvers**: [@Zuixi](https://github.com/Zuixi)

Only tagged release builds produced by the public GitHub Actions workflow (`.github/workflows/release.yml`) from commits on the `main` branch are submitted for release signing. All release signing requests require explicit approval by an authorized Approver in SignPath.

## Build & Release Integrity

- All signed binaries are built exclusively on GitHub-hosted runners via `.github/workflows/release.yml` (never from local developer machines).
- Third-party GitHub Actions used in the release workflow are pinned to immutable commit SHAs.
- Every release publishes deterministic `SHA256SUMS.txt` checksums alongside the release assets.
- In-app update packages are additionally verified with a minisign signature against the public key embedded in the application (`apps/desktop/src-tauri/tauri.conf.json`).

## Privacy Policy

`oh-my-md` is a local-first desktop Markdown editor. This program will **not** transfer any personal data, document contents, or telemetry to other networked systems unless specifically requested by the user or required for the explicit network features listed below:

1. **Update checks**: When checking for updates, the app fetches the static release manifest from `https://zuixi.github.io/oh-my-md/updates/stable/latest.json` and, only after explicit user confirmation, downloads the signed installer from GitHub Releases (`https://github.com/Zuixi/oh-my-md/releases/`).
2. **Remote images in user documents**: If a Markdown document explicitly references a remote `https://` image URL, the local WebView loads that image to render the preview.
3. **WebView2 runtime bootstrapper (Windows installer only)**: On Windows systems without Microsoft Edge WebView2 Runtime preinstalled, the NSIS installer downloads the official Microsoft WebView2 bootstrapper during installation.
4. **Opt-in diagnostics**: Diagnostic logging is disabled by default. If a user explicitly enables logging and exports a diagnostic bundle, the bundle is saved locally on disk (never uploaded automatically) and redacts paths, secrets, and document contents.

No user accounts, analytics, crash-reporting servers, or background cloud sync exist in `oh-my-md`.

## Security Reporting

See [SECURITY.md](./SECURITY.md) for our threat model, supported versions, and private vulnerability disclosure process via GitHub Security Advisories.
