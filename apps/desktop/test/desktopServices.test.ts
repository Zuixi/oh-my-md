import { describe, expect, it, vi } from "vitest"
import { toDocumentCommandError } from "../src/desktopServices"

const { invoke, revealItemInDir, toast } = vi.hoisted(() => ({
  invoke: vi.fn(),
  revealItemInDir: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() },
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }))
vi.mock("react-toastify", () => ({ toast }))

import { defaultServices } from "../src/desktopServices"

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

describe("toast notifications", () => {
  it("reports errors through toast.error with the 8s autoClose", () => {
    defaultServices.reportError("Save failed: disk full")
    expect(toast.error).toHaveBeenCalledWith(
      "Save failed: disk full",
      { autoClose: 8000 },
    )
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
