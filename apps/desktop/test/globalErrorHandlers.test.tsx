import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { describeThrown, installGlobalErrorHandlers } from "../src/globalErrorHandlers"
import { ErrorBoundary } from "../src/ErrorBoundary"
import { initLocale } from "../src/i18n"
import type { Logger } from "../src/logger"

interface FakeLogger {
  logger: Logger
  /** Every record's message, in dispatch order. */
  calls: string[]
  flushes: () => number
}

function fakeLogger(): FakeLogger {
  const calls: string[] = []
  let flushes = 0
  const logger: Logger = {
    error: (_target: string, message: string) => { calls.push(message) },
    warn: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    flush: async () => { flushes += 1 },
  }
  return { logger, calls, flushes: () => flushes }
}

let uninstallers: Array<() => void> = []

/** Installs and registers cleanup, so a failing assertion cannot leak listeners
 *  into the next test and make it double-report. */
function install(logger: Logger): () => void {
  const uninstall = installGlobalErrorHandlers(logger, window)
  uninstallers.push(uninstall)
  return uninstall
}

afterEach(() => {
  for (const uninstall of uninstallers) uninstall()
  uninstallers = []
})

function dispatchError(message: string, error: unknown): void {
  window.dispatchEvent(new ErrorEvent("error", { message, error }))
}

/**
 * happy-dom 16 has no `PromiseRejectionEvent` constructor, so rejections are
 * dispatched as a plain `Event` carrying the `reason` the handler reads — the
 * same shape the real webview delivers.
 */
function dispatchRejection(reason: unknown): void {
  const event = new Event("unhandledrejection")
  Object.assign(event, { promise: Promise.resolve(), reason })
  window.dispatchEvent(event)
}

describe("global error handlers", () => {
  it("forwards window errors with their stack and flushes immediately", () => {
    const { logger, calls, flushes } = fakeLogger()
    install(logger)
    const thrown = new Error("boom")
    dispatchError("boom", thrown)
    expect(calls.some(message => message.includes("boom"))).toBe(true)
    const stack = thrown.stack ?? ""
    expect(stack.length).toBeGreaterThan(0)
    expect(calls.some(message => message.includes(stack))).toBe(true)
    // Dispatch is immediate: the record must not wait for the 250 ms timer.
    expect(flushes()).toBeGreaterThan(0)
  })

  it("falls back to the source position when no Error object is attached", () => {
    const { logger, calls } = fakeLogger()
    install(logger)
    // A cross-origin script error: `error` is null, the position is all there is.
    window.dispatchEvent(
      new ErrorEvent("error", { message: "Script error.", filename: "app.js", lineno: 12, colno: 3 }),
    )
    expect(calls.some(message => message.includes("app.js:12:3"))).toBe(true)
  })

  it("forwards unhandled rejections", () => {
    const { logger, calls } = fakeLogger()
    install(logger)
    dispatchRejection(new Error("rejected"))
    expect(calls.some(message => message.includes("rejected"))).toBe(true)
  })

  it("does not register twice", () => {
    const { logger, calls } = fakeLogger()
    const first = installGlobalErrorHandlers(logger, window)
    const second = installGlobalErrorHandlers(logger, window)
    uninstallers.push(first)
    dispatchError("once", new Error("once"))
    expect(calls.filter(message => message.includes("once"))).toHaveLength(1)
    second()
    first()
  })

  it("stops reporting once uninstalled", () => {
    const { logger, calls } = fakeLogger()
    const uninstall = install(logger)
    dispatchError("before", new Error("before"))
    uninstall()
    dispatchError("after", new Error("after"))
    dispatchRejection(new Error("after rejection"))
    expect(calls.some(message => message.includes("before"))).toBe(true)
    expect(calls.some(message => message.includes("after"))).toBe(false)
  })

  it("handles non-Error rejection reasons without throwing", () => {
    const { logger, calls } = fakeLogger()
    install(logger)
    const circular: Record<string, unknown> = { code: 7 }
    circular.self = circular
    expect(() => {
      dispatchRejection("plain string")
      dispatchRejection(circular)
      dispatchRejection(undefined)
    }).not.toThrow()
    expect(calls.some(message => message.includes("plain string"))).toBe(true)
    // A circular object cannot be JSON-serialized; it must still be reported.
    expect(calls).toHaveLength(3)
    expect(calls.every(message => message.includes("unhandled rejection"))).toBe(true)
  })

  it("reports a revoked Proxy rejection reason instead of throwing", () => {
    const { logger, calls } = fakeLogger()
    install(logger)
    // Any trap on a revoked Proxy throws; `instanceof` invokes [[GetPrototypeOf]]
    // and used to be the first unguarded step in `describeThrown`.
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    expect(() => dispatchRejection(proxy)).not.toThrow()
    expect(calls).toHaveLength(1)
    expect(calls.some(message => message.includes("unhandled rejection"))).toBe(true)
  })

  it("reports a revoked Proxy on an error event instead of throwing", () => {
    const { logger, calls } = fakeLogger()
    install(logger)
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    expect(() => dispatchError("boom", proxy)).not.toThrow()
    expect(calls).toHaveLength(1)
    expect(calls.some(message => message.includes("uncaught: boom"))).toBe(true)
  })

  it("reports a Proxy-wrapped Error whose property reads throw", () => {
    const { logger, calls } = fakeLogger()
    install(logger)
    // `instanceof Error` passes (the target is an Error, and the default
    // [[GetPrototypeOf]] forwards to it); reading `.message` is what throws.
    const hostile = new Proxy(new Error("hidden"), {
      get: () => { throw new Error("get trap exploded") },
    })
    expect(() => dispatchError("boom", hostile)).not.toThrow()
    expect(() => dispatchRejection(hostile)).not.toThrow()
    expect(calls).toHaveLength(2)
    expect(calls.some(message => message.includes("uncaught: boom"))).toBe(true)
  })

  it("never throws into the listener when the logger itself throws", () => {
    const hostile: Logger = {
      error: () => { throw new Error("logger exploded") },
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      flush: () => Promise.reject(new Error("flush exploded")),
    }
    install(hostile)
    expect(() => {
      dispatchError("boom", new Error("boom"))
      dispatchRejection(new Error("nope"))
    }).not.toThrow()
  })

  it("swallows a rejected immediate flush", () => {
    const logger: Logger = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      flush: () => Promise.reject(new Error("flush exploded")),
    }
    install(logger)
    expect(() => dispatchError("boom", new Error("boom"))).not.toThrow()
  })
})

describe("error boundary", () => {
  /** React 19 reports every caught render error through `console.error` by
   *  default; silencing it keeps the suite output pristine — the boundary is
   *  the unit under test, not React's reporter. */
  function silenceReactReporter(): () => void {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    return () => spy.mockRestore()
  }

  it("logs the error, flushes, and renders a recovery surface", () => {
    const { logger, calls, flushes } = fakeLogger()
    const restore = silenceReactReporter()
    try {
      const Boom = () => { throw new Error("render failed") }
      render(
        <ErrorBoundary logger={logger}>
          <Boom />
        </ErrorBoundary>,
      )
    } finally {
      restore()
    }
    expect(calls.some(message => message.includes("render failed"))).toBe(true)
    expect(flushes()).toBeGreaterThan(0)
    expect(screen.getByRole("alert")).toBeTruthy()
  })

  it("renders its recovery surface when a commit-phase lifecycle throws a revoked Proxy", () => {
    const { logger, calls } = fakeLogger()
    const restore = silenceReactReporter()
    // A revoked `Proxy` makes every trap throw. React's render loop reads
    // `thrownValue.then` from a *render-phase* throw, so React itself dies
    // there before any boundary can see it (verified: react-dom
    // `handleThrow`). The commit-phase path delivers the raw value straight to
    // `componentDidCatch`, which is the blank-window case this module owns.
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    class Boom extends React.Component {
      componentDidMount(): void { throw proxy }
      render(): React.ReactNode { return null }
    }
    try {
      render(
        <ErrorBoundary logger={logger}>
          <Boom />
        </ErrorBoundary>,
        // React's default `onCaughtError` reads `.environmentName` off the
        // rejected value, which throws for a revoked `Proxy` and escapes as an
        // uncaught exception. The boundary is the unit under test, not that
        // reporter.
        { onCaughtError: () => {} },
      )
    } finally {
      restore()
    }
    // A throw inside `componentDidCatch` has no boundary above it: React would
    // tear down the root, so the user would get a blank window instead of this
    // surface — the one thing the boundary exists to prevent.
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(calls.some(message => message.includes("react error boundary"))).toBe(true)
  })

  it("renders its recovery surface for a Proxy-wrapped Error whose reads throw", () => {
    const { logger, calls } = fakeLogger()
    const restore = silenceReactReporter()
    // `instanceof Error` passes and React's own `thrownValue.then` probe
    // survives (the trap throws only for `message`/`stack`), but the property
    // read inside `componentDidCatch` throws.
    const target = new Error("hidden")
    const hostile = new Proxy(target, {
      get: (inner, property, receiver) => {
        if (property === "message" || property === "stack") {
          throw new Error("get trap exploded")
        }
        return Reflect.get(inner, property, receiver)
      },
    })
    const Boom = () => { throw hostile }
    try {
      render(
        <ErrorBoundary logger={logger}>
          <Boom />
        </ErrorBoundary>,
        // Same reason as above: React's default reporter reads the value it is
        // told about.
        { onCaughtError: () => {} },
      )
    } finally {
      restore()
    }
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(calls.some(message => message.includes("react error boundary"))).toBe(true)
  })

  it("offers Export Diagnostics and Reload actions, localized", () => {
    const { logger } = fakeLogger()
    const onExportDiagnostics = vi.fn()
    const restore = silenceReactReporter()
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {})
    try {
      const Boom = () => { throw new Error("render failed") }
      render(
        <ErrorBoundary logger={logger} onExportDiagnostics={onExportDiagnostics}>
          <Boom />
        </ErrorBoundary>,
      )
      fireEvent.click(screen.getByRole("button", { name: "Export Diagnostics" }))
      expect(onExportDiagnostics).toHaveBeenCalledTimes(1)
      fireEvent.click(screen.getByRole("button", { name: "Reload" }))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      reload.mockRestore()
      restore()
    }
  })

  // The crash surface is the last thing a user sees before deciding to trust the
  // app again; an English-only copy there is a visible defect for zh locales.
  it("localizes the recovery surface", () => {
    const { logger } = fakeLogger()
    const restore = silenceReactReporter()
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {})
    try {
      initLocale("zh")
      const Boom = () => { throw new Error("render failed") }
      render(<ErrorBoundary logger={logger}><Boom /></ErrorBoundary>)
      expect(screen.getByText("编辑器遇到了意外错误。")).toBeTruthy()
      expect(screen.getByRole("button", { name: "导出诊断信息" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy()
    } finally {
      initLocale("en")
      reload.mockRestore()
      restore()
    }
  })

  it("renders its children while nothing has failed", () => {
    const { logger, calls } = fakeLogger()
    render(
      <ErrorBoundary logger={logger}>
        <p>safe document</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText("safe document")).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})

// The export flow promises the bundle contains no document content. A rejected
// value that is not an Error used to be serialized with `JSON.stringify`, which
// put whatever the object held — a document body, a token — straight into the
// log and then past the export redactor, which only knows about paths and
// secret-shaped assignments.
describe("thrown values keep detail without carrying payloads", () => {
  const sensitive = {
    documentText: "PRIVATE_DOCUMENT_FIXTURE",
    access_token: "FAKE_SECRET_FIXTURE",
    nested: { body: "PRIVATE_DOCUMENT_FIXTURE" },
  }

  it("describes a thrown object by shape, never by value", () => {
    const detail = describeThrown(sensitive)
    expect(detail).not.toContain("PRIVATE_DOCUMENT_FIXTURE")
    expect(detail).not.toContain("FAKE_SECRET_FIXTURE")
    // The shape is what makes it diagnosable.
    expect(detail).toContain("Object")
    expect(detail).toContain("documentText")
    expect(detail).toContain("access_token")
  })

  it("keeps the message of a wrapped Error so a rejection stays explainable", () => {
    const value = { code: "permissionDenied", cause: new Error("Access denied (os error 5)") }
    const detail = describeThrown(value)
    expect(detail).toContain("Access denied (os error 5)")
    expect(detail).toContain("code")
  })

  it("does not call toJSON on a thrown object", () => {
    let called = false
    const value = {
      documentText: "PRIVATE_DOCUMENT_FIXTURE",
      toJSON() {
        called = true
        return "PRIVATE_DOCUMENT_FIXTURE"
      },
    }
    const detail = describeThrown(value)
    expect(called).toBe(false)
    expect(detail).not.toContain("PRIVATE_DOCUMENT_FIXTURE")
  })

  it("bounds the formatting work instead of serializing a huge payload", () => {
    const value = { big: "x".repeat(1_000_000) }
    const started = Date.now()
    const detail = describeThrown(value)
    expect(detail.length).toBeLessThan(1_000)
    expect(Date.now() - started).toBeLessThan(200)
  })
})

// Production-shaped containers are described by size, not enumerated: an error
// handler that spends 20-25 ms building a million key strings is a jank spike
// exactly when the webview is already unwell. The queue's length cap cannot
// help, because formatting happens before the cap is consulted.
describe("describing containers stays cheap", () => {
  const budgetMs = 5

  const measure = (fn: () => string): { text: string; ms: number } => {
    fn() // warm up
    const started = performance.now()
    const text = fn()
    return { text, ms: performance.now() - started }
  }

  it("describes a million-element array by length", () => {
    const array = Array.from({ length: 1_000_000 }, (_, index) => index)
    const { text, ms } = measure(() => describeThrown(array))
    expect(text).toBe("Array(1000000)")
    expect(ms).toBeLessThan(budgetMs)
  })

  it("describes a large Map and Set by size", () => {
    const map = new Map(Array.from({ length: 200_000 }, (_, index) => [`k${index}`, index] as const))
    const set = new Set(Array.from({ length: 200_000 }, (_, index) => index))
    expect(describeThrown(map)).toBe("Map(200000)")
    expect(describeThrown(set)).toBe("Set(200000)")
    expect(measure(() => describeThrown(map)).ms).toBeLessThan(budgetMs)
  })
})
