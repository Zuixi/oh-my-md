import { afterEach, describe, expect, it, vi } from "vitest"
import { errorMessage, toDocumentCommandError } from "../src/desktopServices"
import type { LogRecord } from "../src/logger"

const { invoke, revealItemInDir, toast } = vi.hoisted(() => ({
  invoke: vi.fn(),
  revealItemInDir: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }))
vi.mock("react-toastify", () => ({ toast }))

import { defaultServices } from "../src/desktopServices"
import { useSpyLogger } from "./setup"

describe("desktop document IPC", () => {
  it("normalizes a typed rust rejection", () => {
    expect(toDocumentCommandError({ code: "permissionDenied", message: "cannot write" }))
      .toEqual({ code: "permissionDenied", message: "cannot write" })
  })

  it("falls back to internal for unknown rejections", () => {
    expect(toDocumentCommandError(new Error("boom")))
      .toEqual({ code: "internal", message: "boom" })
    expect(toDocumentCommandError({ code: "notARealCode" }).code).toBe("internal")
  })
})

describe("setMenuLocale", () => {
  it("invokes set_menu_locale with locale", async () => {
    invoke.mockResolvedValueOnce(undefined)
    await defaultServices.setMenuLocale?.("zh")
    expect(invoke).toHaveBeenCalledWith("set_menu_locale", { locale: "zh" })
  })
})

describe("appBuildDate", () => {
  it("invokes app_build_date", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce("2026-11-24")
    await expect(defaultServices.appBuildDate?.()).resolves.toBe("2026-11-24")
    expect(invoke).toHaveBeenCalledWith("app_build_date")
  })
})

describe("listSystemFonts", () => {
  it("invokes list_system_fonts with no arguments", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce(["Arial", "Menlo"])
    await expect(defaultServices.listSystemFonts?.()).resolves.toEqual(["Arial", "Menlo"])
    expect(invoke).toHaveBeenCalledWith("list_system_fonts")
  })

  it("resolves null when the invoke rejects", async () => {
    invoke.mockRejectedValueOnce(new Error("font enumeration failed"))
    await expect(defaultServices.listSystemFonts?.()).resolves.toBeNull()
  })
})

describe("revealInFinder", () => {
  const MACOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
  const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

  /** happy-dom 的默认 UA 是 X11(→ linux)，平台分支用例必须显式钉住 UA 再还原。 */
  async function withUserAgent(userAgent: string, run: () => Promise<void>): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(window.navigator, "userAgent")
    Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true })
    try {
      await run()
    } finally {
      if (original) Object.defineProperty(window.navigator, "userAgent", original)
      else delete (window.navigator as { userAgent?: string }).userAgent
    }
  }

  it("delegates to the official plugin-opener binding with the path", async () => {
    revealItemInDir.mockResolvedValueOnce(undefined)
    invoke.mockClear()
    await defaultServices.revealInFinder?.("/tmp/notes.md")
    expect(revealItemInDir).toHaveBeenCalledWith("/tmp/notes.md")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("hands the Windows shell a backslash path (the plugin can then simplify \\\\?\\…)", async () => {
    await withUserAgent(WINDOWS_UA, async () => {
      revealItemInDir.mockClear()
      revealItemInDir.mockResolvedValueOnce(undefined)
      await defaultServices.revealInFinder?.("//?/E:/note/中文 文档.md")
      expect(revealItemInDir).toHaveBeenCalledWith("\\\\?\\E:\\note\\中文 文档.md")
    })
  })

  it("leaves non-Windows paths untouched", async () => {
    await withUserAgent(MACOS_UA, async () => {
      revealItemInDir.mockClear()
      revealItemInDir.mockResolvedValueOnce(undefined)
      await defaultServices.revealInFinder?.("//?/notes/doc.md")
      expect(revealItemInDir).toHaveBeenCalledWith("//?/notes/doc.md")
    })
  })
})

describe("tree edit IPC", () => {
  it("normalizes extended-length paths returned by create/rename commands", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce("\\\\?\\C:\\notes\\untitled-2.md")
    await expect(defaultServices.createMarkdown?.("C:\\notes", "untitled-2.md"))
      .resolves.toBe("C:\\notes\\untitled-2.md")
    expect(invoke).toHaveBeenCalledWith(
      "create_markdown", { dir: "C:\\notes", name: "untitled-2.md" })

    invoke.mockResolvedValueOnce("\\\\?\\C:\\notes\\untitled-folder")
    await expect(defaultServices.createDir?.("C:\\notes", "untitled-folder"))
      .resolves.toBe("C:\\notes\\untitled-folder")
    expect(invoke).toHaveBeenCalledWith(
      "create_dir", { dir: "C:\\notes", name: "untitled-folder" })

    invoke.mockResolvedValueOnce("\\\\?\\C:\\notes\\ideas")
    await expect(defaultServices.renamePath?.("C:\\notes\\untitled-folder", "ideas"))
      .resolves.toBe("C:\\notes\\ideas")
    expect(invoke).toHaveBeenCalledWith(
      "rename_path", { from: "C:\\notes\\untitled-folder", toName: "ideas" })
  })

  it("leaves POSIX results untouched", async () => {
    invoke.mockResolvedValueOnce("/notes/a.md")
    await expect(defaultServices.createMarkdown?.("/notes", "a.md")).resolves.toBe("/notes/a.md")
  })

  it("rebases symlink-resolved results onto the caller's directory form", async () => {
    // macOS canonicalizes /tmp to /private/tmp and /var to /private/var; a
    // Linux workspace opened through a symlink behaves the same way.
    invoke.mockResolvedValueOnce("/private/tmp/notes/a.md")
    await expect(defaultServices.createMarkdown?.("/tmp/notes", "a.md"))
      .resolves.toBe("/tmp/notes/a.md")

    invoke.mockResolvedValueOnce("/private/var/folders/x/notes/untitled-folder")
    await expect(defaultServices.createDir?.("/var/folders/x/notes", "untitled-folder"))
      .resolves.toBe("/var/folders/x/notes/untitled-folder")

    invoke.mockResolvedValueOnce("/private/tmp/notes/ideas")
    await expect(defaultServices.renamePath?.("/tmp/notes/drafts", "ideas"))
      .resolves.toBe("/tmp/notes/ideas")
  })
})

describe("logRecords", () => {
  it("invokes log_frontend with the record batch", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce(undefined)
    const records: LogRecord[] = [{ level: "warn", target: "save", message: "retrying" }]
    await defaultServices.logRecords?.(records)
    expect(invoke).toHaveBeenCalledWith("log_frontend", { records })
  })
})

describe("export diagnostics", () => {
  /** The one pre-export notice. OK proceeds; paths stay collapsed either way. */
  function answerNotice(proceed: boolean) {
    const confirm = vi.spyOn(window, "confirm")
    confirm.mockReturnValueOnce(proceed)
    return confirm
  }

  afterEach(() => {
    vi.restoreAllMocks()
    invoke.mockReset()
  })

  it("asks once, names the contents, and always exports collapsed paths", async () => {
    invoke.mockReset()
    invoke.mockResolvedValueOnce("/tmp/omd.zip").mockResolvedValueOnce(undefined)
    const confirm = answerNotice(true)

    await defaultServices.exportDiagnostics?.()

    // Exactly one question, and it names the bundle's contents rather than
    // being a bare "are you sure". There is deliberately no second question:
    // the full-paths opt-in is a checkbox the spec asks for, and an unlabelled
    // `window.confirm` whose OK means "include" is a privacy hazard, so the
    // export ships collapsed until that checkbox exists.
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatch(/diagnostics/i)
    expect(confirm.mock.calls[0][0]).toMatch(/log/i)
    expect(confirm.mock.calls[0][0]).toMatch(/path/i)
    expect(invoke).toHaveBeenNthCalledWith(1, "pick_export_path", {
      format: "zip",
      defaultPath: "oh-my-md-diagnostics.zip",
      filterLabel: expect.any(String),
    })
    expect(invoke).toHaveBeenNthCalledWith(2, "export_diagnostics", {
      path: "/tmp/omd.zip",
      includeFullPaths: false,
    })
  })

  it("exports nothing when the notice is declined", async () => {
    answerNotice(false)

    await defaultServices.exportDiagnostics?.()

    // No destination is chosen and nothing is invoked: a declined notice must
    // not leave the user holding a save dialog.
    expect(invoke).not.toHaveBeenCalled()
  })

  it("exports nothing when the save dialog is cancelled", async () => {
    invoke.mockResolvedValueOnce(null)
    answerNotice(true)

    await defaultServices.exportDiagnostics?.()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith("pick_export_path", {
      format: "zip",
      defaultPath: "oh-my-md-diagnostics.zip",
      filterLabel: expect.any(String),
    })
  })
})

describe("native pickers", () => {
  afterEach(() => {
    invoke.mockReset()
    localStorage.clear()
  })

  it("runs the open dialog in Rust and returns the picked path", async () => {
    invoke.mockResolvedValueOnce("/notes/a.md")
    await expect(defaultServices.pickOpenPath()).resolves.toBe("/notes/a.md")
    expect(invoke).toHaveBeenCalledWith("pick_open_markdown", { filterLabel: expect.any(String) })
  })

  it("resolves null when the user cancels, in every picker", async () => {
    invoke.mockResolvedValue(null)
    await expect(defaultServices.pickOpenPath()).resolves.toBeNull()
    await expect(defaultServices.pickSavePath()).resolves.toBeNull()
    await expect(defaultServices.pickFolder?.()).resolves.toBeNull()
    await expect(defaultServices.pickCssPath?.()).resolves.toBeNull()
    await expect(defaultServices.pickExportPath?.("pdf", "/notes/a.md")).resolves.toBeNull()
  })

  it("asks Rust for the save dialog, the folder picker, and the CSS picker", async () => {
    invoke.mockResolvedValueOnce("/notes/b.md")
    await defaultServices.pickSavePath()
    expect(invoke).toHaveBeenCalledWith("pick_save_markdown", { filterLabel: expect.any(String) })

    invoke.mockResolvedValueOnce("/notes")
    await defaultServices.pickFolder?.()
    expect(invoke).toHaveBeenCalledWith("pick_workspace_folder")

    invoke.mockResolvedValueOnce("/notes/theme.css")
    await defaultServices.pickCssPath?.()
    expect(invoke).toHaveBeenCalledWith("pick_custom_css", { filterLabel: expect.any(String) })
  })

  it("hands the export dialog its format, default path, and filter", async () => {
    invoke.mockResolvedValueOnce("/notes/a.png")
    await expect(defaultServices.pickExportPath?.("png", "/notes/a.md")).resolves.toBe("/notes/a.png")
    expect(invoke).toHaveBeenCalledWith("pick_export_path", {
      format: "png",
      defaultPath: "/notes/a.png",
      filterLabel: "PNG",
    })

    invoke.mockResolvedValueOnce("export.html")
    await defaultServices.pickExportPath?.("html")
    expect(invoke).toHaveBeenCalledWith("pick_export_path", {
      format: "html",
      defaultPath: "export.html",
      filterLabel: "HTML",
    })
  })
})

describe("recent files", () => {
  const LEGACY_KEY = "omd.recent-files"

  afterEach(() => {
    invoke.mockReset()
    localStorage.clear()
  })

  it("reads the persisted list from Rust", async () => {
    invoke.mockResolvedValueOnce(["/notes/a.md", "/notes/b.md"])
    await expect(defaultServices.loadRecents?.()).resolves.toEqual(["/notes/a.md", "/notes/b.md"])
    expect(invoke).toHaveBeenCalledWith("get_recent_files")
  })

  it("keeps an authoritative empty answer instead of reviving stored paths", async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["/etc/passwd"]))
    invoke.mockResolvedValueOnce([])

    await expect(defaultServices.loadRecents?.()).resolves.toEqual([])
    // The stale mirror is gone, so it cannot come back through a later read.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it("falls back to the legacy list only when the command is unavailable", async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(["/notes/legacy.md"]))
    invoke.mockRejectedValueOnce(new Error("command not found"))

    await expect(defaultServices.loadRecents?.()).resolves.toEqual(["/notes/legacy.md"])
  })

  it("degrades to an empty list when both sources fail", async () => {
    localStorage.setItem(LEGACY_KEY, "{not json")
    invoke.mockRejectedValueOnce(new Error("command not found"))

    await expect(defaultServices.loadRecents?.()).resolves.toEqual([])
  })

  it("persists through Rust and only mirrors on refusal", async () => {
    invoke.mockResolvedValueOnce(undefined)
    await defaultServices.saveRecents?.(["/notes/a.md"])
    expect(invoke).toHaveBeenCalledWith("save_recent_files", { paths: ["/notes/a.md"] })
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()

    invoke.mockRejectedValueOnce(new Error("recent path was not authorized"))
    await defaultServices.saveRecents?.(["/etc/passwd"])
    expect(localStorage.getItem(LEGACY_KEY)).toBe(JSON.stringify(["/etc/passwd"]))
  })
})

describe("toast notifications", () => {
  it("reports errors through toast.error with the 8s autoClose", () => {
    defaultServices.reportError("Save failed: disk full")
    expect(toast.error).toHaveBeenCalledWith(
      "Save failed: disk full",
      { autoClose: 8000 },
    )
  })

  it("records handled failures once as warnings and preserves the toast", () => {
    const logger = useSpyLogger()
    defaultServices.reportError("Save failed: disk full")
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("ui", "Save failed: disk full")
    expect(logger.error).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith("Save failed: disk full", { autoClose: 8000 })
  })

  it("notifies success through toast.success with the 3s autoClose", () => {
    defaultServices.notifySuccess?.("Created notes.md")
    expect(toast.success).toHaveBeenCalledWith(
      "Created notes.md",
      { autoClose: 3000 },
    )
  })
})

describe("update capability (automatic updates)", () => {
  it("invokes update_capability and returns the platform capability", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ check: true, install: true })
    await expect(defaultServices.updateCapability?.()).resolves.toEqual({
      check: true,
      install: true,
    })
    expect(invoke).toHaveBeenCalledWith("update_capability")
  })

  it("returns a check-only capability for manual-install platforms", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ check: true, install: false, reason: "manualPackage" })
    await expect(defaultServices.updateCapability?.()).resolves.toEqual({
      check: true,
      install: false,
      reason: "manualPackage",
    })
  })
})

describe("prepare update restart (automatic updates)", () => {
  it("invokes prepare_update_restart and returns a ready flush outcome", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ kind: "ready" })
    await expect(defaultServices.prepareUpdateRestart?.()).resolves.toEqual({ kind: "ready" })
    expect(invoke).toHaveBeenCalledWith("prepare_update_restart")
  })

  it("surfaces a timedOut session-flush outcome", async () => {
    invoke.mockClear()
    invoke.mockResolvedValueOnce({ kind: "timedOut" })
    await expect(defaultServices.prepareUpdateRestart?.()).resolves.toEqual({ kind: "timedOut" })
  })
})

// A failed save/open reaches the user and the log through this one function.
// Rendering a typed Rust rejection as `[object Object]` used to throw away the
// only reason the record existed for.
describe("errorMessage", () => {
  it("keeps the underlying reason of a typed command error", () => {
    expect(errorMessage("Open failed", { code: "permissionDenied", message: "Access denied (os error 5)" }))
      .toBe("Open failed: Access denied (os error 5)")
  })

  it("keeps an Error's message and a plain string", () => {
    expect(errorMessage("Save failed", new Error("disk full"))).toBe("Save failed: disk full")
    expect(errorMessage("Save failed", "disk full")).toBe("Save failed: disk full")
  })

  it("never prints [object Object] or stringifies an unknown value", () => {
    const message = errorMessage("Save failed", { unexpected: true, secret: "FAKE" })
    expect(message).not.toContain("[object Object]")
    expect(message).not.toContain("FAKE")
    expect(message).toBe("Save failed: unrecognized error")
  })

  it("omits the separator when there is no detail", () => {
    expect(errorMessage("Save failed", "")).toBe("Save failed")
  })
})
