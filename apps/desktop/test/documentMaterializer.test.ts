import { describe, expect, it, vi } from "vitest"
import { createDocumentMaterializer } from "../src/documentMaterializer"

interface Clock {
  now(): number
  set(value: number): void
  advance(ms: number): void
}

/** Manual clock: the debounce decisions are all differences of `now()` readings. */
function makeClock(): Clock {
  let current = 0
  return {
    now: () => current,
    set: value => { current = value },
    advance: ms => { current += ms },
  }
}

/**
 * Timer queue that mirrors real timer semantics: a firing callback observes the
 * timer's own due instant, and timers armed while firing are considered in the
 * same advance. Without that, "materializes 250 ms after the last keystroke"
 * could not be asserted.
 */
function makeTimers(clock: Clock) {
  const entries = new Map<number, { at: number; callback: () => void }>()
  let nextId = 0
  return {
    setTimer: (callback: () => void, ms: number) => {
      const id = ++nextId
      entries.set(id, { at: clock.now() + ms, callback })
      return id
    },
    clearTimer: (id: number) => { entries.delete(id) },
    /** Advances the clock, firing every timer that falls due on the way. */
    advance: (ms: number) => {
      const target = clock.now() + ms
      // Bounded so a pathological re-arm loop fails the test instead of hanging.
      for (let guard = 0; guard < 500; guard++) {
        const due = [...entries.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        entries.delete(due[0])
        clock.set(due[1].at)
        due[1].callback()
      }
      clock.set(target)
    },
    /** Callback registered for the single armed timer, if any. */
    pending: () => [...entries.values()].map(entry => entry.callback),
  }
}

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

  it("reset re-arms a destroyed instance for the StrictMode second setup", () => {
    const materialize = vi.fn()
    const subject = createDocumentMaterializer({
      delayMs: 0,
      readViewText: () => "after-reset",
      materialize,
      setTimer: () => 1,
      clearTimer: vi.fn(),
    })
    subject.destroy()
    subject.queue(1)
    expect(materialize).not.toHaveBeenCalled()
    subject.reset()
    subject.queue(1)
    expect(materialize).toHaveBeenCalledWith(1, "after-reset")
  })
})

describe("trailing debounce with a max wait", () => {
  function setup(maxWaitMs?: number) {
    const clock = makeClock()
    const timers = makeTimers(clock)
    const flushes: number[] = []
    const subject = createDocumentMaterializer({
      delayMs: 250,
      maxWaitMs,
      now: clock.now,
      readViewText: () => "typing",
      materialize: () => { flushes.push(clock.now()) },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    return { clock, timers, subject, flushes }
  }

  it("does not materialize at 250 ms while keystrokes keep arriving", () => {
    const { timers, subject, flushes } = setup()
    // Eight keystrokes 50 ms apart: four debounce windows, zero rope flattens.
    for (let index = 0; index < 8; index++) {
      subject.queue(1)
      timers.advance(50)
    }
    expect(flushes).toEqual([])
    expect(subject.hasPending(1)).toBe(true)
    // One burst still costs exactly one armed timer at a time.
    expect(timers.pending()).toHaveLength(1)
  })

  it("materializes delayMs after typing stops", () => {
    const { timers, subject, flushes } = setup()
    for (let index = 0; index < 4; index++) {
      subject.queue(1)
      timers.advance(50)
    }
    // Last keystroke at 150 ms; the deferred timer must not fire at 250 ms.
    timers.advance(50)
    expect(flushes).toEqual([])
    timers.advance(100)
    expect(flushes).toEqual([])
    timers.advance(100)
    expect(flushes).toEqual([400])
  })

  it("flushes once maxWaitMs is reached even when typing never pauses", () => {
    const { timers, subject, flushes } = setup(1_000)
    for (let index = 0; index < 40 && flushes.length === 0; index++) {
      subject.queue(1)
      timers.advance(50)
    }
    expect(flushes).toHaveLength(1)
    expect(flushes[0]).toBeLessThanOrEqual(1_000)
    expect(subject.hasPending(1)).toBe(false)
  })

  it("flushes immediately when the timer callback runs without waiting", () => {
    const { timers, subject, flushes } = setup()
    subject.queue(1)
    subject.queue(1)
    // A unit test firing the callback synchronously: the timer never waited, so
    // the debounce may not defer again (that would look like a stall).
    timers.pending()[0]?.()
    expect(flushes).toEqual([0])
  })
})
