export interface ClipboardPayload {
  readonly plainText: string
  readonly html: string | null
  readonly images: readonly File[]
  readonly source: "dom-event" | "async-clipboard"
  readonly diagnostics: readonly ("richReadFailed" | "flavorUnavailable")[]
}

export interface SystemClipboardReader {
  read(): Promise<readonly ClipboardItem[]>
  readText(): Promise<string>
}

export const systemClipboardReader: SystemClipboardReader = {
  read: () => navigator.clipboard.read(),
  readText: () => navigator.clipboard.readText(),
}

export function payloadFromDataTransfer(data: DataTransfer): ClipboardPayload {
  const images = Array.from(data.files ?? []).filter(file => file.type.startsWith("image/"))
  for (const item of Array.from(data.items ?? [])) {
    if (!item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (file && !images.includes(file)) images.push(file)
  }
  return {
    plainText: data.getData("text/plain"),
    html: data.getData("text/html") || null,
    images,
    source: "dom-event",
    diagnostics: [],
  }
}

export async function readClipboardPayload(reader: SystemClipboardReader): Promise<ClipboardPayload> {
  let items: readonly ClipboardItem[]
  try {
    items = await reader.read()
  } catch {
    return {
      plainText: await reader.readText(),
      html: null,
      images: [],
      source: "async-clipboard",
      diagnostics: ["richReadFailed"],
    }
  }

  let plainText: string | null = null
  let html: string | null = null
  const images: File[] = []
  let flavorUnavailable = false

  for (const item of items) {
    for (const type of item.types) {
      if (type === "text/html" && html === null) {
        try {
          html = await (await item.getType(type)).text()
        } catch {
          flavorUnavailable = true
        }
      } else if (type === "text/plain" && plainText === null) {
        try {
          plainText = await (await item.getType(type)).text()
        } catch {
          flavorUnavailable = true
        }
      } else if (type.startsWith("image/")) {
        try {
          const blob = await item.getType(type)
          images.push(new File([blob], "clipboard-image", { type: blob.type || type }))
        } catch {
          flavorUnavailable = true
        }
      }
    }
  }

  if (plainText === null) {
    try {
      plainText = await reader.readText()
    } catch {
      plainText = ""
      flavorUnavailable = true
    }
  }

  return {
    plainText,
    html: html || null,
    images,
    source: "async-clipboard",
    diagnostics: flavorUnavailable ? ["flavorUnavailable"] : [],
  }
}
