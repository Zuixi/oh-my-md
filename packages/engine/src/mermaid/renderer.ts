import {
  createMermaidSvgCache,
  type CachedMermaidSvg,
} from "../decorations/widgets/mermaidSvgCache"

export type MermaidTheme = "light" | "dark"

export interface RenderMermaidOptions {
  /** Explicit root SVG id. When omitted, a monotonic unique id is generated. */
  readonly id?: string
  /** Color theme for Mermaid's palette. Defaults to the document's `data-theme`. */
  readonly theme?: MermaidTheme
  /** Whether to read/write the shared SVG LRU cache (default `true`). */
  readonly useCache?: boolean
}

export interface RenderedMermaid {
  readonly id: string
  readonly svg: string
  readonly bindFunctions?: (element: Element) => void
}

const svgCache = createMermaidSvgCache()

let mermaidModulePromise: Promise<typeof import("mermaid").default> | null = null
let renderQueue: Promise<void> = Promise.resolve()
let lastConfiguredTheme: MermaidTheme | null = null
let idCounter = 0

type ThemeListener = (theme: MermaidTheme) => void
const themeListeners = new Set<ThemeListener>()
let themeObserver: MutationObserver | null = null
let observedTheme: MermaidTheme | null = null

function notifyThemeListeners(): void {
  const next = resolveDocumentMermaidTheme()
  if (next === observedTheme) return
  observedTheme = next
  for (const listener of [...themeListeners]) {
    listener(next)
  }
}

/**
 * Subscribe to `document.documentElement[data-theme]` light/dark transitions
 * through a single shared `MutationObserver` (created on first subscriber and
 * disconnected when the last subscriber unsubscribes).
 */
export function subscribeDocumentMermaidTheme(listener: ThemeListener): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {}
  }
  themeListeners.add(listener)
  if (!themeObserver) {
    observedTheme = resolveDocumentMermaidTheme()
    themeObserver = new MutationObserver(notifyThemeListeners)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    })
  }
  return () => {
    themeListeners.delete(listener)
    if (themeListeners.size === 0 && themeObserver) {
      themeObserver.disconnect()
      themeObserver = null
      observedTheme = null
    }
  }
}

function loadMermaid() {
  return mermaidModulePromise ??= import("mermaid").then(m => m.default)
}

export function nextMermaidId(prefix = "omd-mmd"): string {
  return `${prefix}-${++idCounter}`
}

export function resolveDocumentMermaidTheme(): MermaidTheme {
  if (typeof document === "undefined") return "light"
  return document.documentElement?.dataset?.theme === "dark" ? "dark" : "light"
}

function cacheKeyOf(src: string, theme: MermaidTheme): string {
  return `${theme}:${src}`
}

export function getCachedMermaidSvg(
  src: string,
  theme: MermaidTheme = resolveDocumentMermaidTheme(),
): CachedMermaidSvg | undefined {
  return svgCache.get(cacheKeyOf(src, theme))
}

export function clearMermaidSvgCache(): void {
  svgCache.clear()
  lastConfiguredTheme = null
}

/**
 * Mermaid frequently rejects parse/render failures with a plain object
 * `{ str, message, hash, error }` rather than an `Error` instance.
 * Normalize to a real `Error` so callers never render `[object Object]`.
 */
export function normalizeMermaidError(error: unknown): Error {
  if (error instanceof Error) return error
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; str?: unknown }
    if (typeof candidate.message === "string" && candidate.message) {
      return new Error(candidate.message)
    }
    if (typeof candidate.str === "string" && candidate.str) {
      return new Error(candidate.str)
    }
  }
  return new Error(String(error))
}

function cleanupMermaidScratchContainer(id: string): void {
  if (typeof document === "undefined") return
  // Mermaid creates a temporary `#d<id>` wrapper on `document.body` during
  // render and can leave it behind when parsing/rendering fails.
  const stray = document.getElementById(`d${id}`)
  if (stray && stray.parentElement === document.body) {
    stray.remove()
  }
}

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task)
  renderQueue = result.then(() => undefined, () => undefined)
  return result
}

/**
 * Single serialized Mermaid rendering pipeline shared by live-preview widgets,
 * the full-screen lightbox, and rich HTML/PDF export:
 * - Serializes `initialize` + `parse` + `render` so concurrent diagrams and
 *   alternating light/dark exports never race on Mermaid's global singleton.
 * - Enables `securityLevel: "strict"` and `suppressErrorRendering: true`,
 *   pre-validates with `mermaid.parse()` when available, and removes any stray
 *   `#d<id>` scratch container on failure.
 */
export async function renderMermaidSvg(
  src: string,
  options: RenderMermaidOptions = {},
): Promise<RenderedMermaid> {
  const theme = options.theme ?? resolveDocumentMermaidTheme()
  const useCache = options.useCache !== false
  const id = options.id ?? nextMermaidId()
  const key = cacheKeyOf(src, theme)

  if (useCache) {
    const cached = svgCache.get(key)
    if (cached) return { id: cached.id, svg: cached.svg }
  }

  return enqueueRender(async () => {
    if (useCache) {
      const cached = svgCache.get(key)
      if (cached) return { id: cached.id, svg: cached.svg }
    }

    const mermaid = await loadMermaid()
    if (lastConfiguredTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: theme === "dark" ? "dark" : "default",
      })
      lastConfiguredTheme = theme
    }

    try {
      if (typeof mermaid.parse === "function") {
        await mermaid.parse(src)
      }
      const rendered = await mermaid.render(id, src)
      if (useCache) {
        svgCache.set(key, { id, svg: rendered.svg })
      }
      return {
        id,
        svg: rendered.svg,
        bindFunctions: rendered.bindFunctions,
      }
    } catch (error) {
      throw normalizeMermaidError(error)
    } finally {
      cleanupMermaidScratchContainer(id)
    }
  })
}
