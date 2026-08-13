import { act, fireEvent, render, screen, waitFor, type RenderResult } from "@testing-library/react"
import { createElement } from "react"
import { expect, vi, type Mock } from "vitest"
import type { EditorView } from "@codemirror/view"
import {
  getPendingOrderedListNormalization,
  type NormalizationId,
  type OrderedListNormalizationNotice,
} from "@omd/engine"
import App, { type DesktopServices } from "../src/App"
import type { CreateEditorOptions, EditorDocumentUpdate } from "../src/Editor"

const NO_WATCH_MS = 0
/** Watch interval armed only for the duration of one faked external poll. */
const EXTERNAL_CHECK_MS = 5

export type EditorMock = {
  create: Mock<(parent: HTMLElement, options: CreateEditorOptions) => EditorView>
  reset: Mock<(view: EditorView, options: CreateEditorOptions) => void>
}

export interface FakeEditorHandle {
  readonly view: EditorView
  getOptions: () => CreateEditorOptions
  setContents: (contents: string) => void
  emit: (update: Omit<EditorDocumentUpdate, "tabId" | "documentId">) => void
}

export type HarnessServices = DesktopServices & Required<
  Pick<DesktopServices, "writeRecovery" | "confirmClose" | "confirmExternalChange">
>

export interface AppHarness {
  readonly services: HarnessServices
  renderApp: (props?: { autosaveMs?: number; watchMs?: number }) => RenderResult
  editorForTab: (tabId: number) => FakeEditorHandle
  allEditors: () => readonly FakeEditorHandle[]
  activateTab: (tabId: number) => void
  openIntoActive: (path: string, contents: string) => Promise<void>
  openInNewTab: (path: string, contents: string) => Promise<void>
  requestOpen: (path: string, contents: string) => Promise<void>
  emitPending: (tabId: number, id: NormalizationId) => void
  saveNormalization: (tabId: number) => Promise<void>
  failNextReset: (error: Error) => void
  requestCloseTab: (tabId: number) => void
  runExternalCheck: () => Promise<void>
}

export function normalizationId(value: number): NormalizationId {
  return value as NormalizationId
}

/**
 * Fake views own no StateField, so the notice each handle last emitted is looked up by the state
 * object that handle hands to the App.
 *
 * The test appendix specifies `Map<EditorView, notice>`; this indexes by state instead because the
 * App only ever asks `getPendingOrderedListNormalization(view.state)`, so a state key is what the
 * mocked engine call actually receives. Both hold one notice per fake view.
 */
const pendingByState = new WeakMap<object, () => OrderedListNormalizationNotice | null>()

function pendingNoticeFor(state: unknown): OrderedListNormalizationNotice | null {
  if (typeof state !== "object" || state === null) return null
  return pendingByState.get(state)?.() ?? null
}

/**
 * The test file owns `vi.mock("@omd/engine", ...)` so Vitest can hoist it; the harness only gives
 * that hoisted spy its per-view implementation. Importing this module from the mock factory would
 * deadlock, because it imports App, which imports the module being mocked.
 */
function installEnginePendingLookup(): void {
  vi.mocked(getPendingOrderedListNormalization).mockImplementation(state =>
    pendingNoticeFor(state),
  )
}

interface HandleRecord {
  readonly tabId: number
  readonly handle: FakeEditorHandle
  readonly contents: () => string
  readonly rebind: (options: CreateEditorOptions) => void
}

function notifyHost(
  options: CreateEditorOptions,
  update: Omit<EditorDocumentUpdate, "tabId" | "documentId">,
): void {
  if (options.onDocumentUpdate) {
    options.onDocumentUpdate({
      ...update,
      tabId: options.tabId,
      documentId: options.documentId,
    })
    return
  }
  if (update.docChanged) options.onDocChanged(update.doc)
}

function createHandleRecord(
  tabId: number,
  initial: CreateEditorOptions,
  onDestroy: (tabId: number) => void,
): HandleRecord {
  let contents = initial.doc
  let options = initial
  let pending: OrderedListNormalizationNotice | null = null
  const state = { doc: { toString: () => contents } }
  pendingByState.set(state, () => pending)
  const view = {
    state,
    dispatch: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(() => onDestroy(tabId)),
  } as unknown as EditorView

  const handle: FakeEditorHandle = {
    view,
    getOptions: () => options,
    setContents: value => { contents = value },
    emit: update => {
      contents = update.doc
      pending = update.pendingNormalization
      act(() => notifyHost(options, update))
    },
  }
  return {
    tabId,
    handle,
    contents: () => contents,
    rebind: next => { options = next; contents = next.doc },
  }
}

/**
 * Stand-in for the engine's live-preview renumbering, only so `emitPending` can report a document
 * that really changed. Production desktop code must keep asking the engine instead.
 *
 * It fakes one shape: flat ordered lists that start at 1 or higher and run over consecutive lines.
 * Shapes where it would disagree with the engine are rejected loudly rather than renumbered wrong.
 */
const ORDERED_MARKER = /^(\s*)(\d+)([.)])(\s)/
const NOT_IN_LIST = null
const FIRST_ORDERED_NUMBER = 1

interface FakeNormalization {
  readonly doc: string
  readonly rewrittenMarkers: number
}

function unsupportedFixture(shape: string): Error {
  return new Error(
    `appHarness cannot fake the engine's ordered-list renumbering for ${shape}. ` +
    "This is a limit of the test double, not of the engine: extend the double for that shape, " +
    "or drive a real editor instead of emitPending.",
  )
}

function nextExpectedNumber(current: number | typeof NOT_IN_LIST, raw: string): number {
  if (current !== NOT_IN_LIST) return current + 1
  const start = Number(raw)
  if (start < FIRST_ORDERED_NUMBER) throw unsupportedFixture("an ordered list starting at 0")
  return start
}

function normalizeOrderedMarkers(text: string): FakeNormalization {
  let expected: number | typeof NOT_IN_LIST = NOT_IN_LIST
  let blankLineSeen = false
  let rewrittenMarkers = 0
  const lines = text.split("\n").map(line => {
    const match = ORDERED_MARKER.exec(line)
    if (!match) {
      blankLineSeen = expected !== NOT_IN_LIST && line.trim() === ""
      if (!blankLineSeen) expected = NOT_IN_LIST
      return line
    }
    if (blankLineSeen) throw unsupportedFixture("an ordered list interrupted by a blank line")
    expected = nextExpectedNumber(expected, match[2])
    const marker = `${match[1]}${expected}${match[3]}${match[4]}`
    if (marker !== match[0]) rewrittenMarkers += 1
    return `${marker}${line.slice(match[0].length)}`
  })
  return { doc: lines.join("\n"), rewrittenMarkers }
}

function harnessServices(): HarnessServices {
  return {
    pickOpenPath: vi.fn(async () => null),
    pickSavePath: vi.fn(async () => null),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    allowDocumentAssets: vi.fn(async () => undefined),
    writeRecovery: vi.fn(async () => undefined),
    confirmDiscard: vi.fn(() => true),
    confirmClose: vi.fn(() => true),
    confirmExternalChange: vi.fn(() => true),
    reportError: vi.fn(),
  }
}

interface HarnessContext {
  readonly editor: EditorMock
  readonly services: HarnessServices
  readonly records: HandleRecord[]
  openTabIds: number[]
  rendered: RenderResult | null
  autosaveMs: number
  watchMs: number
}

function installEditorMock(context: HarnessContext): void {
  const { editor, records } = context
  editor.create.mockReset()
  editor.reset.mockReset()
  editor.create.mockImplementation((_parent, options) => {
    // Hosts that have not bound identity yet get the id App would have allocated for this tab.
    const tabId = options.tabId ?? records.length + 1
    const record = createHandleRecord(tabId, options, closed => {
      context.openTabIds = context.openTabIds.filter(id => id !== closed)
    })
    records.push(record)
    context.openTabIds = [...context.openTabIds, tabId]
    return record.handle.view
  })
  editor.reset.mockImplementation((view, options) => {
    recordForView(context, view).rebind(options)
  })
}

function recordForView(context: HarnessContext, view: EditorView): HandleRecord {
  const record = context.records.find(item => item.handle.view === view)
  if (!record) throw new Error("editor was reset before it was created")
  return record
}

function recordForTab(context: HarnessContext, tabId: number): HandleRecord {
  const record = context.records.find(item => item.tabId === tabId)
  if (!record) throw new Error(`no editor was created for tab ${tabId}`)
  return record
}

function appElement(context: HarnessContext, watchMs: number) {
  return createElement(App, {
    services: context.services,
    autosaveMs: context.autosaveMs,
    watchMs,
  })
}

function requireRendered(context: HarnessContext): RenderResult {
  if (!context.rendered) throw new Error("renderApp was not called")
  return context.rendered
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function activateTab(context: HarnessContext, tabId: number): void {
  const index = context.openTabIds.indexOf(tabId)
  if (index < 0) throw new Error(`tab ${tabId} is not open`)
  const button = document.querySelectorAll<HTMLButtonElement>(".tabbar .tab")[index]
  if (!button) throw new Error(`tab ${tabId} has no tab button`)
  fireEvent.click(button)
}

async function requestOpen(
  context: HarnessContext,
  path: string,
  contents: string,
): Promise<void> {
  vi.mocked(context.services.pickOpenPath).mockResolvedValueOnce(path)
  vi.mocked(context.services.readFile).mockResolvedValueOnce(contents)
  fireEvent.keyDown(window, { key: "o", metaKey: true })
  await waitFor(() => {
    expect(context.services.allowDocumentAssets).toHaveBeenCalledWith(path)
  })
  await settle()
}

async function openIntoActive(
  context: HarnessContext,
  path: string,
  contents: string,
): Promise<void> {
  await requestOpen(context, path, contents)
  await waitFor(() => expect(screen.getByText(path)).toBeTruthy())
}

async function openInNewTab(
  context: HarnessContext,
  path: string,
  contents: string,
): Promise<void> {
  const before = context.records.length
  fireEvent.keyDown(window, { key: "n", metaKey: true })
  await waitFor(() => expect(context.records.length).toBe(before + 1))
  await openIntoActive(context, path, contents)
}

function emitPending(context: HarnessContext, tabId: number, id: NormalizationId): void {
  const record = recordForTab(context, tabId)
  const normalized = normalizeOrderedMarkers(record.contents())
  record.handle.emit({
    doc: normalized.doc,
    docChanged: true,
    pendingNormalization: { id, markerCount: normalized.rewrittenMarkers },
  })
}

/**
 * Drives exactly one poll of the App's external-change watcher. The interval is armed by a
 * rerender and disarmed again straight after, and time is faked so a slow machine cannot slip a
 * second poll into the window.
 */
async function runExternalCheck(context: HarnessContext): Promise<void> {
  const rendered = requireRendered(context)
  const alreadyFaked = vi.isFakeTimers()
  if (!alreadyFaked) vi.useFakeTimers()
  rendered.rerender(appElement(context, EXTERNAL_CHECK_MS))
  await act(async () => { await vi.advanceTimersByTimeAsync(EXTERNAL_CHECK_MS) })
  rendered.rerender(appElement(context, context.watchMs))
  if (!alreadyFaked) vi.useRealTimers()
  await settle()
}

export function createAppHarness(editor: EditorMock): AppHarness {
  const context: HarnessContext = {
    editor,
    services: harnessServices(),
    records: [],
    openTabIds: [],
    rendered: null,
    autosaveMs: 0,
    watchMs: NO_WATCH_MS,
  }
  installEditorMock(context)
  installEnginePendingLookup()

  return {
    services: context.services,
    renderApp: (props = {}) => {
      context.autosaveMs = props.autosaveMs ?? 0
      context.watchMs = props.watchMs ?? NO_WATCH_MS
      context.rendered = render(appElement(context, context.watchMs))
      return context.rendered
    },
    editorForTab: tabId => recordForTab(context, tabId).handle,
    allEditors: () => context.records.map(record => record.handle),
    activateTab: tabId => activateTab(context, tabId),
    openIntoActive: (path, contents) => openIntoActive(context, path, contents),
    openInNewTab: (path, contents) => openInNewTab(context, path, contents),
    requestOpen: (path, contents) => requestOpen(context, path, contents),
    emitPending: (tabId, id) => emitPending(context, tabId, id),
    saveNormalization: async tabId => {
      activateTab(context, tabId)
      fireEvent.click(screen.getByRole("button", { name: "Save normalization" }))
      await settle()
    },
    failNextReset: error => {
      context.editor.reset.mockImplementationOnce(() => { throw error })
    },
    requestCloseTab: tabId => {
      activateTab(context, tabId)
      fireEvent.keyDown(window, { key: "w", metaKey: true })
    },
    runExternalCheck: () => runExternalCheck(context),
  }
}
