import { describe, expect, it } from "vitest"
import { BoundedLru } from "../src/cache/boundedLru"

const cache = () =>
  new BoundedLru<string, string>({
    maxEntries: 2,
    maxSize: 10,
    sizeOf: (value) => value.length,
  })

describe("BoundedLru", () => {
  it("evicts the least recently used entry by count", () => {
    const subject = cache()
    subject.set("a", "aa")
    subject.set("b", "bb")
    expect(subject.get("a")).toBe("aa")
    subject.set("c", "cc")
    expect(subject.get("b")).toBeUndefined()
    expect(subject.get("a")).toBe("aa")
    expect(subject.get("c")).toBe("cc")
  })

  it("evicts by retained size and does not retain an oversize value", () => {
    const subject = cache()
    subject.set("a", "123456")
    subject.set("b", "123456")
    expect(subject.get("a")).toBeUndefined()
    expect(subject.retainedSize).toBe(6)
    subject.set("huge", "12345678901")
    expect(subject.get("huge")).toBeUndefined()
    expect(subject.entryCount).toBe(1)
  })

  it("updates retained size when replacing a key", () => {
    const subject = cache()
    subject.set("a", "12")
    subject.set("a", "12345")
    expect(subject.entryCount).toBe(1)
    expect(subject.retainedSize).toBe(5)
  })

  it("rejects invalid constructor limits", () => {
    expect(
      () =>
        new BoundedLru<string, string>({
          maxEntries: 0,
          maxSize: 10,
          sizeOf: (value) => value.length,
        }),
    ).toThrow("maxEntries must be a positive integer")
    expect(
      () =>
        new BoundedLru<string, string>({
          maxEntries: 1,
          maxSize: 0,
          sizeOf: (value) => value.length,
        }),
    ).toThrow("maxSize must be a positive finite number")
    expect(
      () =>
        new BoundedLru<string, string>({
          maxEntries: 1,
          maxSize: 1.5,
          sizeOf: (value) => value.length,
        }),
    ).not.toThrow()
  })
})
