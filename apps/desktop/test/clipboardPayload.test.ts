import { describe, expect, it, vi } from "vitest"
import {
  payloadFromDataTransfer,
  readClipboardPayload,
  type SystemClipboardReader,
} from "../src/clipboardPayload"

function item(entries: Readonly<Record<string, Blob | Error>>): ClipboardItem {
  return {
    types: Object.keys(entries),
    presentationStyle: "unspecified",
    getType: vi.fn(async (type: string) => {
      const value = entries[type]
      if (value instanceof Error) throw value
      return value
    }),
  }
}

function reader(items: readonly ClipboardItem[], text = ""): SystemClipboardReader {
  return { read: vi.fn(async () => items), readText: vi.fn(async () => text) }
}

describe("clipboard payload", () => {
  it("captures DOM flavors synchronously without associating files to HTML nodes", () => {
    const transfer = {
      files: [
        new File(["a"], "a.png", { type: "image/png" }),
        new File(["x"], "x.txt", { type: "text/plain" }),
      ],
      getData: (type: string) => type === "text/html" ? "<b>x</b>" : type === "text/plain" ? "x" : "",
    } as unknown as DataTransfer
    expect(payloadFromDataTransfer(transfer)).toMatchObject({
      plainText: "x",
      html: "<b>x</b>",
      source: "dom-event",
      diagnostics: [],
    })
    expect(payloadFromDataTransfer(transfer).images.map(file => file.name)).toEqual(["a.png"])
  })

  it("reads HTML, text and images once in stable item order", async () => {
    const first = item({
      "image/png": new Blob(["a"], { type: "image/png" }),
      "text/html": new Blob(["<b>x</b>"], { type: "text/html" }),
    })
    const second = item({
      "image/webp": new Blob(["b"], { type: "image/webp" }),
      "text/plain": new Blob(["x"], { type: "text/plain" }),
    })
    const out = await readClipboardPayload(reader([first, second]))
    expect(out).toMatchObject({ plainText: "x", html: "<b>x</b>", source: "async-clipboard", diagnostics: [] })
    expect(out.images.map(file => file.type)).toEqual(["image/png", "image/webp"])
    expect(first.getType).toHaveBeenCalledTimes(2)
    expect(second.getType).toHaveBeenCalledTimes(2)
  })

  it("falls back to readText after rich read rejection", async () => {
    const source: SystemClipboardReader = {
      read: vi.fn(async () => { throw new Error("denied") }),
      readText: vi.fn(async () => "plain"),
    }
    await expect(readClipboardPayload(source)).resolves.toEqual({
      plainText: "plain",
      html: null,
      images: [],
      source: "async-clipboard",
      diagnostics: ["richReadFailed"],
    })
  })

  it("aggregates unavailable flavors without inventing image identity", async () => {
    const source = reader([
      item({
        "text/html": new Error("unavailable"),
        "text/plain": new Blob(["plain"], { type: "text/plain" }),
        "image/png": new Error("unavailable"),
      }),
    ])
    await expect(readClipboardPayload(source)).resolves.toEqual({
      plainText: "plain",
      html: null,
      images: [],
      source: "async-clipboard",
      diagnostics: ["flavorUnavailable"],
    })
  })

  it("keeps genuine plain-only and empty clipboards silent", async () => {
    await expect(readClipboardPayload(reader([item({
      "text/plain": new Blob(["plain"], { type: "text/plain" }),
    })]))).resolves.toMatchObject({ plainText: "plain", diagnostics: [] })
    await expect(readClipboardPayload(reader([], ""))).resolves.toEqual({
      plainText: "",
      html: null,
      images: [],
      source: "async-clipboard",
      diagnostics: [],
    })
  })
})
