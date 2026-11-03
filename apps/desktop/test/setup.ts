import { afterEach, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import { getGlobalLogger, setGlobalLogger, type Logger } from "../src/logger"

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

/**
 * Installs a global logger whose five level methods are spies, and restores the
 * previously installed logger after the current test.
 *
 * The real facade delivers in batches on a timer, so `console.*` is no longer a
 * synchronous proxy for "was this logged" — a test that asserts on logging must
 * observe the facade call itself. Call this inside the test that needs it.
 */
export function useSpyLogger(): Logger {
  const previous = getGlobalLogger()
  const spy: Logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    flush: vi.fn(async () => {}),
  }
  setGlobalLogger(spy)
  afterEach(() => setGlobalLogger(previous))
  return spy
}
