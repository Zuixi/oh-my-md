import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useWorkspaceSearch } from "../src/useWorkspaceSearch"
import type { SearchHit } from "../src/SearchPanel"
import type { SearchResponse } from "../src/desktopServices"

function hit(text: string): SearchHit {
  return { path: "/notes/doc.md", line: 1, text, start: 0, end: text.length }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("useWorkspaceSearch", () => {
  it("does not search before the debounce elapses", () => {
    vi.useFakeTimers()
    try {
      const search = vi.fn().mockResolvedValue({ hits: [], truncated: false } satisfies SearchResponse)
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError: vi.fn(),
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(199) })
      expect(search).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(search).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps only the newest request result", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const second = deferred<SearchResponse>()
      const search = vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError: vi.fn(),
        debounceMs: 200,
      }))

      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { result.current.setQuery("b") })
      act(() => { vi.advanceTimersByTime(200) })

      await act(async () => {
        second.resolve({ hits: [hit("new")], truncated: false })
        first.resolve({ hits: [hit("old")], truncated: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.hits.map(item => item.text)).toEqual(["new"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores a stale result reported after the query changed again", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const search = vi.fn().mockReturnValueOnce(first.promise)
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError: vi.fn(),
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      // Query changes again before the in-flight request resolves; the
      // second debounce has not elapsed yet so `search` was only called once.
      act(() => { result.current.setQuery("ab") })
      await act(async () => {
        first.resolve({ hits: [hit("stale")], truncated: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.hits).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears hits and stops searching when closed", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const search = vi.fn().mockReturnValueOnce(first.promise)
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError: vi.fn(),
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { result.current.setOpen(false) })
      expect(result.current.hits).toEqual([])
      expect(result.current.truncated).toBe(false)

      await act(async () => {
        first.resolve({ hits: [hit("late")], truncated: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.hits).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears hits when the query becomes empty", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const search = vi.fn().mockReturnValueOnce(first.promise)
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError: vi.fn(),
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { result.current.setQuery("") })
      expect(result.current.hits).toEqual([])

      await act(async () => {
        first.resolve({ hits: [hit("late")], truncated: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.hits).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("clears hits when the folder becomes null", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const search = vi.fn().mockReturnValueOnce(first.promise)
      const { result, rerender } = renderHook(
        (props: { folder: string | null }) => useWorkspaceSearch({
          folder: props.folder,
          search,
          reportError: vi.fn(),
          debounceMs: 200,
        }),
        { initialProps: { folder: "/notes" as string | null } },
      )
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      rerender({ folder: null })
      expect(result.current.hits).toEqual([])

      await act(async () => {
        first.resolve({ hits: [hit("late")], truncated: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.hits).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-searches when only case sensitivity changes, invalidating the old request", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const second = deferred<SearchResponse>()
      const search = vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError: vi.fn(),
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { result.current.setCaseSensitive(true) })
      act(() => { vi.advanceTimersByTime(200) })

      await act(async () => {
        second.resolve({ hits: [hit("case-sensitive")], truncated: false })
        first.resolve({ hits: [hit("case-insensitive")], truncated: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(search).toHaveBeenNthCalledWith(2, "/notes", "a", true)
      expect(result.current.hits.map(item => item.text)).toEqual(["case-sensitive"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("clear() resets query and results and invalidates the in-flight request", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const search = vi.fn().mockReturnValueOnce(first.promise)
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError: vi.fn(),
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { result.current.clear() })
      expect(result.current.query).toBe("")
      expect(result.current.hits).toEqual([])
      expect(result.current.truncated).toBe(false)

      await act(async () => {
        first.resolve({ hits: [hit("late")], truncated: false })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(result.current.hits).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("reports a search error through reportError", async () => {
    vi.useFakeTimers()
    try {
      const failure = new Error("boom")
      const search = vi.fn().mockRejectedValueOnce(failure)
      const reportError = vi.fn()
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError,
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(reportError).toHaveBeenCalledWith(failure)
    } finally {
      vi.useRealTimers()
    }
  })

  it("ignores an error from a request superseded by a newer query", async () => {
    vi.useFakeTimers()
    try {
      const failure = new Error("boom")
      const first = deferred<SearchResponse>()
      const search = vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce({ hits: [hit("fresh")], truncated: false })
      const reportError = vi.fn()
      const { result } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError,
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { result.current.setQuery("ab") })
      await act(async () => {
        vi.advanceTimersByTime(200)
        await Promise.resolve()
        await Promise.resolve()
      })
      await act(async () => {
        first.reject(failure)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(reportError).not.toHaveBeenCalled()
      expect(result.current.hits.map(item => item.text)).toEqual(["fresh"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops applying a result or error after unmount", async () => {
    vi.useFakeTimers()
    try {
      const first = deferred<SearchResponse>()
      const search = vi.fn().mockReturnValueOnce(first.promise)
      const reportError = vi.fn()
      const { result, unmount } = renderHook(() => useWorkspaceSearch({
        folder: "/notes",
        search,
        reportError,
        debounceMs: 200,
      }))
      act(() => {
        result.current.setOpen(true)
        result.current.setQuery("a")
      })
      act(() => { vi.advanceTimersByTime(200) })
      unmount()

      await act(async () => {
        first.reject(new Error("boom"))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(reportError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
