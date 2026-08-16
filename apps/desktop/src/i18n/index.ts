import { useSyncExternalStore, useMemo } from "react"
import { en } from "./messages/en"
import { zh } from "./messages/zh"

export type Locale = "en" | "zh"
export type StoredLocale = "auto" | Locale

const messages: Record<Locale, Record<string, string>> = { en, zh }

export type MenuLocaleSetter = (locale: Locale) => void | Promise<void>

let current: Locale = "en"
let listeners = new Set<() => void>()
let menuSetter: MenuLocaleSetter = () => {}

export function resolveLocale(stored: StoredLocale): Locale {
  if (stored === "en" || stored === "zh") return stored
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en"
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en"
}

function emit(): void {
  for (const fn of listeners) fn()
}

export function getLocale(): Locale {
  return current
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function initLocale(stored: StoredLocale, setMenuLocale?: MenuLocaleSetter): Locale {
  if (setMenuLocale) menuSetter = setMenuLocale
  current = resolveLocale(stored)
  void notifyMenu()
  return current
}

export function setLocale(stored: StoredLocale): Locale {
  current = resolveLocale(stored)
  emit()
  void notifyMenu()
  return current
}

function notifyMenu(): Promise<void> {
  return Promise.resolve(menuSetter(current)).catch(e => {
    // Menu rebuild failures are not on the document-correctness path; do not block the webview.
    console.warn("[i18n] set_menu_locale failed", e)
  })
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    params[k] !== undefined ? String(params[k]) : `{${k}}`)
}

export function t(key: string, params?: Record<string, string | number>): string {
  const table = messages[current]
  const template = table[key]
  if (template === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`)
    return key
  }
  return interpolate(template, params)
}

function useT(): (key: string, params?: Record<string, string | number>) => string {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale)
  return useMemo(() => {
    const table = messages[locale]
    return (key: string, params?: Record<string, string | number>) => {
      const template = table[key]
      if (template === undefined) {
        if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`)
        return key
      }
      return interpolate(template, params)
    }
  }, [locale])
}

export { useT }

export const localeOptions: { value: StoredLocale; key: string }[] = [
  { value: "auto", key: "settings.language.auto" },
  { value: "en", key: "settings.language.en" },
  { value: "zh", key: "settings.language.zh" },
]
