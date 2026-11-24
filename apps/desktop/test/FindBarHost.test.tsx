import { Profiler } from "react"
import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FindBarHost } from "../src/FindBarHost"
import { createDocumentStore, type DocumentStore } from "../src/documentStore"
import { initLocale, setLocale } from "../src/i18n"
import type { FindReplaceHandle } from "../src/useFindReplace"

/** The Find bar's own state lives in `useFindReplace`; only what it renders matters here. */
function fakeFind(overrides: Partial<FindReplaceHandle> = {}): FindReplaceHandle {
  return {
    open: false,
    query: "alpha",
    replacement: "",
    caseSensitive: false,
    regexMode: false,
    wholeWord: false,
    replaceOpen: false,
    index: 0,
    openRef: { current: false },
    goRef: { current: () => undefined },
    closeRef: { current: () => undefined },
    setOpen: vi.fn(),
    setReplaceOpen: vi.fn(),
    close: vi.fn(),
    go: vi.fn(),
    replaceCurrent: vi.fn(),
    replaceEvery: vi.fn(),
    onQuery: vi.fn(),
    onReplacement: vi.fn(),
    onCaseSensitive: vi.fn(),
    onRegex: vi.fn(),
    onWholeWord: vi.fn(),
    ...overrides,
  }
}

function storeWith(text: string): DocumentStore {
  const store = createDocumentStore()
  store.setTabDoc(1, text)
  return store
}

/** Renders through a Profiler so "did this component commit" is observable. */
function renderHost(find: FindReplaceHandle, store: DocumentStore) {
  const commits = vi.fn()
  const view = render(
    <Profiler id="find-bar" onRender={commits}>
      <FindBarHost store={store} find={find} isSafeMode={() => false} />
    </Profiler>,
  )
  return { ...view, commits }
}

describe("FindBarHost document subscription", () => {
  afterEach(() => initLocale("en"))

  it("does not re-render a closed find bar when the document materializes", () => {
    setLocale("en")
    const store = storeWith("alpha beta")
    const { commits } = renderHost(fakeFind({ open: false }), store)
    commits.mockClear()

    act(() => { store.setTabDoc(1, "alpha beta alpha gamma") })

    expect(commits).not.toHaveBeenCalled()
    expect(screen.queryByRole("search")).toBeNull()
  })

  it("counts matches while open and re-counts on materialized edits", () => {
    setLocale("en")
    const store = storeWith("alpha beta alpha")
    const { commits } = renderHost(fakeFind({ open: true }), store)
    expect(screen.getByText("1 of 2")).toBeTruthy()

    act(() => { store.setTabDoc(1, "alpha") })

    expect(screen.getByText("1 of 1")).toBeTruthy()
    expect(commits).toHaveBeenCalled()
  })

  it("reads the current text when the bar opens after edits landed while closed", () => {
    setLocale("en")
    const store = storeWith("alpha")
    const { rerender } = renderHost(fakeFind({ open: false }), store)

    // Edits that arrive while closed are not observed...
    act(() => { store.setTabDoc(1, "alpha alpha alpha") })
    // ...but opening re-subscribes and counts the text that is current now.
    rerender(
      <Profiler id="find-bar" onRender={vi.fn()}>
        <FindBarHost store={store} find={fakeFind({ open: true })} isSafeMode={() => false} />
      </Profiler>,
    )

    expect(screen.getByText("1 of 3")).toBeTruthy()
  })
})
