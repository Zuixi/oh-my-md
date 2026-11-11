import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  EXPORT_IMAGE_FETCH_TIMEOUT_MS,
  EXPORT_MAX_IMAGE_BYTES,
  EXPORT_MAX_TOTAL_IMAGE_BYTES,
  ExportImageError,
  makeExportImageResolver,
  resolveDocRelativePath,
} from "../src/exportImages"

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path.replace(/^\//, "")}`,
}))

function imageResponse(bytes: number, type = "image/png"): Response {
  return new Response(new Blob([new Uint8Array(bytes)], { type }))
}

describe("resolveDocRelativePath", () => {
  it("joins a relative image against the document directory", () => {
    expect(resolveDocRelativePath("/docs/note.md", "assets/pic.png")).toBe(
      "/docs/assets/pic.png",
    )
  })

  it("keeps POSIX and Windows absolute paths", () => {
    expect(resolveDocRelativePath("/docs/note.md", "/tmp/pic.png")).toBe("/tmp/pic.png")
    expect(resolveDocRelativePath("C:\\docs\\note.md", "D:/pic.png")).toBe("D:/pic.png")
  })

  it("normalizes a Windows document directory before joining", () => {
    expect(resolveDocRelativePath("C:\\docs\\note.md", "assets/pic.png")).toBe(
      "C:/docs/assets/pic.png",
    )
  })

  it("keeps a Windows UNC image path absolute", () => {
    expect(resolveDocRelativePath("C:\\docs\\note.md", "\\\\server\\share\\pic.png")).toBe(
      "\\\\server\\share\\pic.png",
    )
  })

  it("passes through data, http and asset URLs", () => {
    for (const src of [
      "data:image/png;base64,AAAA",
      "https://example.com/a.png",
      "http://example.com/a.png",
      "asset://localhost/a.png",
    ]) {
      expect(resolveDocRelativePath("/docs/note.md", src)).toBe(src)
    }
  })
})

describe("makeExportImageResolver", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("inlines a local image as a data URL and caches the read", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(4))
    vi.stubGlobal("fetch", fetchMock)
    const resolve = makeExportImageResolver(() => "/docs/note.md")
    const first = await resolve("assets/pic.png")
    const second = await resolve("assets/pic.png")
    expect(first).toMatch(/^data:image\/png;base64,/)
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      "asset://localhost/docs/assets/pic.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("leaves data and remote images untouched", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const resolve = makeExportImageResolver(() => "/docs/note.md")
    await expect(resolve("data:image/png;base64,AAAA")).resolves.toBe(
      "data:image/png;base64,AAAA",
    )
    await expect(resolve("https://example.com/a.png")).resolves.toBe(
      "https://example.com/a.png",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a relative image when the document has no path", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const resolve = makeExportImageResolver(() => null)
    await expect(resolve("assets/pic.png")).rejects.toBeInstanceOf(ExportImageError)
    await expect(resolve("assets/pic.png")).rejects.toMatchObject({
      code: "no-document-path",
      src: "assets/pic.png",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("inlines a UNC image even without a document path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(4))
    vi.stubGlobal("fetch", fetchMock)
    const resolve = makeExportImageResolver(() => null)
    await expect(resolve("\\\\server\\share\\pic.png")).resolves.toMatch(/^data:image\/png;base64,/)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("server")
  })

  it("inlines an absolute image even without a document path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(4))
    vi.stubGlobal("fetch", fetchMock)
    const resolve = makeExportImageResolver(() => null)
    await expect(resolve("/tmp/pic.png")).resolves.toMatch(/^data:image\/png;base64,/)
    expect(fetchMock).toHaveBeenCalledWith(
      "asset://localhost/tmp/pic.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("rejects a failed read with a tagged error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    const resolve = makeExportImageResolver(() => "/docs/note.md")
    await expect(resolve("assets/missing.png")).rejects.toMatchObject({
      code: "read-failed",
      src: "assets/missing.png",
    })
    await expect(resolve("assets/missing.png")).rejects.toThrow(/failed to read image/)
  })

  it("times out a hung image read instead of holding the export forever", async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"))
            })
          }),
        ),
      )
      const resolve = makeExportImageResolver(() => "/docs/note.md")
      const pending = resolve("assets/hang.png")
      const assertion = expect(pending).rejects.toMatchObject({
        code: "timeout",
        src: "assets/hang.png",
      })
      await vi.advanceTimersByTimeAsync(EXPORT_IMAGE_FETCH_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("rejects a network-level read failure with a tagged error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed to fetch")))
    const resolve = makeExportImageResolver(() => "/docs/note.md")
    await expect(resolve("assets/pic.png")).rejects.toMatchObject({
      code: "read-failed",
      src: "assets/pic.png",
    })
  })

  it("rejects a non-image response with a tagged error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(imageResponse(4, "text/plain")))
    const resolve = makeExportImageResolver(() => "/docs/note.md")
    await expect(resolve("assets/not-image.png")).rejects.toMatchObject({
      code: "not-image",
      src: "assets/not-image.png",
    })
    await expect(resolve("assets/not-image.png")).rejects.toThrow(/not an image/)
  })

  it("rejects an image over the per-image cap with a tagged error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(imageResponse(EXPORT_MAX_IMAGE_BYTES + 1)),
    )
    const resolve = makeExportImageResolver(() => "/docs/note.md")
    await expect(resolve("assets/huge.png")).rejects.toMatchObject({
      code: "too-large",
      src: "assets/huge.png",
    })
    await expect(resolve("assets/huge.png")).rejects.toThrow(/too large/)
  })

  it("rejects a document whose images exceed the total cap with a tagged error", async () => {
    const perImage = Math.floor(EXPORT_MAX_TOTAL_IMAGE_BYTES / 3) + 1
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => imageResponse(perImage)))
    const resolve = makeExportImageResolver(() => "/docs/note.md")
    await resolve("assets/a.png")
    await resolve("assets/b.png")
    await expect(resolve("assets/c.png")).rejects.toMatchObject({
      code: "total-too-large",
      src: "assets/c.png",
    })
    await expect(resolve("assets/c.png")).rejects.toThrow(/too large/)
  })
})
