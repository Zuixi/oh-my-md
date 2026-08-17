import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

afterEach(() => cleanup())

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub

// Node 25 exposes an experimental file-backed globalThis.localStorage that
// warns on access without --localstorage-file, and the happy-dom environment
// wires window.localStorage to that same Node object. Tests need a real web
// Storage, so install an in-memory one on both globals.
const memoryStorage = (): Storage => {
  const store = new Map<string, string>()
  return {
    get length() { return store.size },
    clear() { store.clear() },
    getItem(key) { return store.has(key) ? store.get(key)! : null },
    key(index) { return [...store.keys()][index] ?? null },
    removeItem(key) { store.delete(key) },
    setItem(key, value) { store.set(key, String(value)) },
  } as Storage
}
const storage = memoryStorage()
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
Object.defineProperty(window, "localStorage", { value: storage, configurable: true })
