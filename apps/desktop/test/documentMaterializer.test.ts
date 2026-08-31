import { describe, expect, it, vi } from "vitest"
import { createDocumentMaterializer } from "../src/documentMaterializer"

describe("document materializer", () => {
  it("coalesces queued tabs and materializes latest text once", () => {
    const callbacks = new Map<number, () => void>()
    let timerId = 0
    const text = new Map([[1, "latest"]])
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: id => text.get(id) ?? null,
      materialize,
      setTimer: callback => {
        callbacks.set(++timerId, callback)
        return timerId
      },
      clearTimer: id => { callbacks.delete(id) },
    })

    subject.queue(1)
    subject.queue(1)
    expect(callbacks.size).toBe(1)
    callbacks.values().next().value?.()
    expect(materialize).toHaveBeenCalledOnce()
    expect(materialize).toHaveBeenCalledWith(1, "latest")
  })

  it("flushes and discards individual tabs safely", () => {
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: id => `doc-${id}`,
      materialize,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    })
    subject.queue(1)
    subject.queue(2)
    subject.discard(2)
    subject.flushTab(1)
    expect(materialize).toHaveBeenCalledWith(1, "doc-1")
    expect(materialize).not.toHaveBeenCalledWith(2, "doc-2")
  })

  it("flushes synchronously when delayMs is 0, without touching the timer", () => {
    const setTimer = vi.fn(() => 1)
    const clearTimer = vi.fn()
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 0,
      readViewText: () => "sync",
      materialize,
      setTimer,
      clearTimer,
    })
    subject.queue(1)
    expect(setTimer).not.toHaveBeenCalled()
    expect(materialize).toHaveBeenCalledWith(1, "sync")
    expect(subject.hasPending(1)).toBe(false)
  })

  it("drops a pending tab without materializing when its view text is missing", () => {
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: () => null,
      materialize,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    })
    subject.queue(1)
    subject.flush()
    expect(materialize).not.toHaveBeenCalled()
    expect(subject.hasPending(1)).toBe(false)
  })

  it("flushTab does not flush unrelated pending tabs or cancel the trailing timer", () => {
    const clearTimer = vi.fn()
    const materialize = vi.fn()
    const text = new Map([[1, "one"], [2, "two"]])
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: id => text.get(id) ?? null,
      materialize,
      setTimer: () => 7,
      clearTimer,
    })
    subject.queue(1)
    subject.queue(2)
    subject.flushTab(1)
    expect(materialize).toHaveBeenCalledOnce()
    expect(materialize).toHaveBeenCalledWith(1, "one")
    expect(clearTimer).not.toHaveBeenCalled()
    expect(subject.hasPending(2)).toBe(true)
  })

  it("flushTab is a no-op for a tab with nothing pending", () => {
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: () => "text",
      materialize,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    })
    subject.flushTab(1)
    expect(materialize).not.toHaveBeenCalled()
  })

  it("destroy clears the pending timer and drops all pending tabs", () => {
    const clearTimer = vi.fn()
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: () => "text",
      materialize,
      setTimer: () => 42,
      clearTimer,
    })
    subject.queue(1)
    subject.queue(2)
    subject.destroy()
    expect(clearTimer).toHaveBeenCalledWith(42)
    expect(subject.hasPending(1)).toBe(false)
    expect(subject.hasPending(2)).toBe(false)
    // A stray flush after destroy must not resurrect materialization.
    subject.flush()
    expect(materialize).not.toHaveBeenCalled()
  })

  it("ignores queue after destroy so a stray update cannot re-arm the timer", () => {
    const setTimer = vi.fn(() => 9)
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: () => "text",
      materialize,
      setTimer,
      clearTimer: vi.fn(),
    })
    subject.destroy()
    subject.queue(1)
    expect(setTimer).not.toHaveBeenCalled()
    expect(subject.hasPending(1)).toBe(false)
    subject.flush()
    expect(materialize).not.toHaveBeenCalled()
  })

  it("ignores queue after destroy in synchronous mode", () => {
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 0,
      readViewText: () => "sync",
      materialize,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    })
    subject.destroy()
    subject.queue(1)
    expect(materialize).not.toHaveBeenCalled()
  })

  it("hasPending reflects queue/discard/flush transitions", () => {
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: () => "text",
      materialize: vi.fn(),
      setTimer: () => 1,
      clearTimer: vi.fn(),
    })
    expect(subject.hasPending(1)).toBe(false)
    subject.queue(1)
    expect(subject.hasPending(1)).toBe(true)
    subject.discard(1)
    expect(subject.hasPending(1)).toBe(false)
    subject.queue(1)
    subject.flush()
    expect(subject.hasPending(1)).toBe(false)
  })

  it("only schedules one trailing timer while a flush is pending", () => {
    const setTimer = vi.fn(() => 5)
    const subject = createDocumentMaterializer({
      delayMs: 250,
      readViewText: () => "text",
      materialize: vi.fn(),
      setTimer,
      clearTimer: vi.fn(),
    })
    subject.queue(1)
    subject.queue(2)
    subject.queue(3)
    expect(setTimer).toHaveBeenCalledOnce()
  })
})
