import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { installGlobalErrorHandlers } from "../src/globalErrorHandlers"
import { ErrorBoundary } from "../src/ErrorBoundary"
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

  it("offers Export Diagnostics and Reload actions", () => {
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
