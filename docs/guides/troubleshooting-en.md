# Logging & Troubleshooting

> [English](./troubleshooting-en.md) · [简体中文](./troubleshooting.md)

oh-my-md can write local diagnostic logs and export a redacted support bundle (`.zip`) when you need to report a bug. For architecture details, see [docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md](../superpowers/specs/2026-10-03-logging-and-diagnostics-design.md).

## Logging Is Off by Default

Diagnostic logging is **opt-in and disabled by default**. A fresh install creates no log directory and writes no log files.

- To investigate an issue: open **Settings → Logging**, enable **Diagnostic logging**, click **Restart to apply**, reproduce the issue, and export a diagnostics bundle.
- Disabling logging and restarting stops new writes; existing log files are not deleted automatically (use **Open Log Folder** if you want to remove them).
- **Verbose logging** (`Debug` level) is only active when diagnostic logging is enabled.
- Even with logging off, **Export Diagnostics…** still works and captures app version, OS/WebView info, settings, and session state (with paths redacted), though it will not have save/conflict history, uncaught error stacks, or previous-exit markers.

## Where Log Files Live

A single rotating log file (`oh-my-md.log`, 2 MiB max per file, 5 local-time archives) collects both Rust and WebView records:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Logs/md.ohmy.desktop/` |
| Windows | `%LOCALAPPDATA%\md.ohmy.desktop\logs\` |
| Linux | `$XDG_DATA_HOME/md.ohmy.desktop/logs/` (defaults to `~/.local/share/md.ohmy.desktop/logs/`) |

Open the active log directory directly from the app:
- **macOS:** App menu (`oh-my-md`) → **Open Log Folder**
- **Windows / Linux:** **Help → Open Log Folder**
- **Command Palette (`⇧⌘P`):** `Open Log Folder`

If the standard log directory is not writable at startup, oh-my-md degrades cleanly to `<temp_dir>/oh-my-md-<pid>.log` (or disables logging) without ever crashing startup, and surfaces the degraded status in **Settings → Logging**.

## Enabling Verbose Logging

Resolution order (highest priority first):
1. **`OMD_LOG` environment variable** (for maintainers): single level name such as `OMD_LOG=debug`, `OMD_LOG=trace`, `OMD_LOG=info`, or `OMD_LOG=off` (temporarily disables logging).
2. **Settings → Enable verbose logging** (`Debug` level, takes effect on next launch).
3. Build default (`Debug` in dev builds, `Info` in release builds).

## Exporting a Diagnostics Bundle

Open **oh-my-md → Export Diagnostics…** (macOS), **Help → Export Diagnostics…** (Windows/Linux), or **Export Diagnostics** in the Command Palette (`⇧⌘P`).

The exported `.zip` includes:
- `manifest.json` — format version, app version, OS/arch, effective log level, per-file size + BLAKE3 hash, `previous_exit` summary, and `skipped_logs` (if any log file was unreadable)
- `version.txt`, `os.txt`, `environment.txt`
- `diagnostics.txt` and individual `oh-my-md*.log` files (redacted)
- `settings.json` and `session.json` (redacted)

**Never included:** document contents, version snapshots, or update signing private keys. Home paths, `file:///` URLs, structured path fields, and secret-shaped tokens (`*_KEY`, `*_TOKEN`, `*_PASSWORD`, `Authorization:`) are automatically redacted on export.

## Reading Session Markers (`previous_exit`)

When logging is enabled, oh-my-md writes lifecycle markers so crashes can be distinguished from clean exits:
- `session start pid=<pid> version=<ver> mode=<release|debug>` — written at startup
- `session exit intent=<reason>` — written immediately when quit is requested, before flushing
- `session end clean=true` — written at event-loop exit

| Markers after last `session start` | Outcome |
| --- | --- |
| `session end clean=true` | Clean exit |
| `session exit intent=…` without `session end` | Quit interrupted (e.g., OS shutdown timeout) |
| Neither | Abnormal termination (crash / SIGKILL) |
| No `session start` in range (or logging was off) | Unknown |

## Tips When Reporting an Issue

1. Check **Settings → Logging** to see whether logging is degraded; include that note if so.
2. For reproducible bugs, enable **Diagnostic logging** + **Verbose logging**, restart, reproduce once, and export the `.zip`.
3. Attach the `.zip` to a [GitHub Issue](https://github.com/Zuixi/oh-my-md/issues/new) along with what happened, what you expected, and roughly when it occurred.
