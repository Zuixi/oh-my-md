import { afterEach, describe, expect, it } from "vitest"
import { en } from "../src/i18n/messages/en"
import { zh } from "../src/i18n/messages/zh"
import { initLocale, setLocale } from "../src/i18n"

/**
 * Guards the two hand-maintained catalogs against drift. A key that exists in
 * only one language renders the raw key in the other (`t` falls back to the key
 * name), and a placeholder that exists in only one language renders as literal
 * `{name}` — both are silent in production, so the domain test owns them.
 */

const PLACEHOLDER = /\{(\w+)\}/g

function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map(match => match[1] ?? "").sort()
}

afterEach(() => {
  initLocale("en")
})

describe("i18n catalog parity", () => {
  it("declares exactly the same keys in both catalogs", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it("uses the same placeholders in both catalogs", () => {
    const mismatched = Object.keys(en).filter(key =>
      placeholders(en[key] ?? "").join(",") !== placeholders(zh[key] ?? "").join(","))
    expect(mismatched).toEqual([])
  })

  it("never ships an empty label", () => {
    const empty = [...Object.keys(en), ...Object.keys(zh)].filter(key =>
      (en[key] ?? "").trim() === "" || (zh[key] ?? "").trim() === "")
    expect(empty).toEqual([])
  })

  it("keeps <html lang> in step with the active locale", () => {
    setLocale("zh")
    expect(document.documentElement.lang).toBe("zh-CN")
    setLocale("en")
    expect(document.documentElement.lang).toBe("en")
    initLocale("zh")
    expect(document.documentElement.lang).toBe("zh-CN")
  })
})
