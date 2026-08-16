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
import type {
  DocumentCommandError,
  SaveDocumentResult,
} from "../src/desktopServices"
import type { CreateEditorOptions, EditorDocumentUpdate } from "../src/Editor"
import {
  makeFakeDisk,
  versionFor,
  type DiskFixture,
  type FakeDisk,
  type SaveDocumentOverride,
} from "./fakeDisk"
import { DEFAULT_SETTINGS } from "../src/settings"

const NO_WATCH_MS = 0
/** Watch interval armed only for the duration of one faked external poll. */
const WATCH_POLL_MS = 5

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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
  Pick<
    DesktopServices,
    | "writeRecovery"
    | "confirmClose"
    | "confirmDelete"
    | "confirmExternalChange"
    | "revealInFinder"
    | "clearRecovery"
    | "createMarkdown"
    | "createDir"
    | "renamePath"
    | "deletePath"
  >
>

export interface AppHarness {
  readonly services: HarnessServices
  seedFile: (path: string, contents: string) => void
  disk: (path: string) => DiskFixture
  renderApp: (props?: { autosaveMs?: number; watchMs?: number }) => RenderResult
  editorForTab: (tabId: number) => FakeEditorHandle
  allEditors: () => readonly FakeEditorHandle[]
  activateTab: (tabId: number) => void
  openIntoActive: (path: string, contents: string) => Promise<void>
  openInNewTab: (path: string, contents: string) => Promise<void>
  openFileTab: (path: string, contents: string) => Promise<void>
  requestOpen: (path: string, contents: string) => Promise<void>
  emitPending: (tabId: number, id: NormalizationId) => void
  saveNormalization: (tabId: number) => Promise<void>
  saveActive: () => Promise<void>
  failNextReset: (error: Error) => void
  requestCloseTab: (tabId: number) => void
  runExternalCheck: () => Promise<void>
  runWatcher: () => Promise<void>
  nextSaveResult: (result: SaveDocumentResult) => void
  failNextSave: (error: DocumentCommandError) => void
  pauseNextSave: () => { promise: Promise<void>; resolve: (value: void) => void; reject: (reason?: unknown) => void }
}

export function normalizationId(value: number): NormalizationId {
  return value as NormalizationId
}

export { versionFor }

/** The TopBar breadcrumb shows the basename in .topbar-file; dirty adds a dot labeled "Unsaved". */
export function expectPathShown(path: string, opts: { dirty?: boolean } = {}): void {
  const name = path === "unnamed" ? "unnamed" : path.replace(/\\/g, "/").split("/").pop()!
  expect(screen.getByText(name, { selector: ".topbar-file" })).toBeTruthy()
  if (opts.dirty) expect(screen.getByLabelText("Unsaved")).toBeTruthy()
  else expect(screen.queryByLabelText("Unsaved")).toBeNull()
}

const pendingByState = new WeakMap<object, () => OrderedListNormalizationNotice | null>()

function pendingNoticeFor(state: unknown): OrderedListNormalizationNotice | null {
  if (typeof state !== "object" || state === null) return null
  return pendingByState.get(state)?.() ?? null
}

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
  options.onDocumentUpdate({
    ...update,
    tabId: options.tabId,
    documentId: options.documentId,
  })
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
    rebind: next => {
      options = next
      contents = next.doc
      pending = null
    },
  }
}

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

interface HarnessContext {
  readonly editor: EditorMock
  readonly fakeDisk: FakeDisk
  services: HarnessServices
  readonly records: HandleRecord[]
  saveOverride: SaveDocumentOverride | null
  savePauseQueue: Array<ReturnType<typeof deferred<void>>>
  openTabIds: number[]
  rendered: RenderResult | null
  autosaveMs: number
  watchMs: number
}

let lastMountedApp: RenderResult | null = null

function unmountLastMountedApp(): void {
  lastMountedApp?.unmount()
  lastMountedApp = null
}

export function resetMountedApps(): void {
  unmountLastMountedApp()
}

async function invokeSaveDocument(
  context: HarnessContext,
  path: string,
  contents: string,
  expected: import("../src/desktopServices").ExpectedDocumentVersion,
): Promise<SaveDocumentResult> {
  const pause = context.savePauseQueue.shift()
  if (pause) {
    await pause.promise
  }
  if (context.saveOverride) {
    const override = context.saveOverride
    context.saveOverride = null
    if (override.kind === "error") throw override.error
    return override.result
  }
  return context.fakeDisk.saveDocument(path, contents, expected)
}

function harnessServices(context: HarnessContext): HarnessServices {
  const { fakeDisk } = context
  return {
    pickOpenPath: vi.fn(async () => null),
    pickSavePath: vi.fn(async () => null),
    readDocument: vi.fn(async path => fakeDisk.readDocument(path)),
    readDocumentVersion: vi.fn(async path => fakeDisk.readDocumentVersion(path)),
    saveDocument: vi.fn(async (path, contents, expected) =>
      invokeSaveDocument(context, path, contents, expected)),
    readFile: vi.fn(async path => {
      const snapshot = fakeDisk.readDocument(path)
      if (snapshot.kind === "missing") throw new Error(`missing file: ${path}`)
      return snapshot.contents
    }),
    writeFile: vi.fn(async (path, contents) => {
      fakeDisk.seed(path, contents)
    }),
    allowDocumentAssets: vi.fn(async () => undefined),
    allowWorkspaceDir: vi.fn(async () => undefined),
    createMarkdown: vi.fn(async (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`),
    createDir: vi.fn(async (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`),
    renamePath: vi.fn(async (from: string, toName: string) => {
      const parts = from.replace(/\\/g, "/").split("/")
      parts[parts.length - 1] = toName
      return parts.join("/")
    }),
    deletePath: vi.fn(async () => undefined),
    writeRecovery: vi.fn(async () => undefined),
    confirmDiscard: vi.fn(() => true),
    confirmClose: vi.fn(() => true),
    confirmDelete: vi.fn(() => true),
    confirmExternalChange: vi.fn(() => true),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    saveSettings: vi.fn(async () => undefined),
    getSessionState: vi.fn(async () => null),
    saveSessionState: vi.fn(async () => undefined),
    reportError: vi.fn(),
    revealInFinder: vi.fn(async () => undefined),
    clearRecovery: vi.fn(async () => undefined),
  }
}

function installEditorMock(context: HarnessContext): void {
  const { editor, records } = context
  editor.create.mockReset()
  editor.reset.mockReset()
  editor.create.mockImplementation((_parent, options) => {
    const record = createHandleRecord(options.tabId, options, closed => {
      context.openTabIds = context.openTabIds.filter(id => id !== closed)
    })
    records.push(record)
    context.openTabIds = [...context.openTabIds, options.tabId]
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
  const button = document.querySelectorAll<HTMLButtonElement>(".topbar-tabs .tab")[index]
  if (!button) throw new Error(`tab ${tabId} has no tab button`)
  fireEvent.click(button)
}

async function requestOpen(
  context: HarnessContext,
  path: string,
  contents: string,
): Promise<void> {
  context.fakeDisk.seed(path, contents)
  vi.mocked(context.services.pickOpenPath).mockResolvedValueOnce(path)
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
  await waitFor(() => expectPathShown(path))
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

async function openFileTab(
  context: HarnessContext,
  path: string,
  contents: string,
): Promise<void> {
  context.fakeDisk.seed(path, contents)
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

async function runWatcherPoll(context: HarnessContext): Promise<void> {
  const rendered = requireRendered(context)
  const alreadyFaked = vi.isFakeTimers()
  if (!alreadyFaked) vi.useFakeTimers()
  try {
    rendered.rerender(appElement(context, WATCH_POLL_MS))
    await act(async () => { await vi.advanceTimersByTimeAsync(WATCH_POLL_MS) })
    rendered.rerender(appElement(context, context.watchMs))
    await settle()
  } finally {
    if (!alreadyFaked) vi.useRealTimers()
  }
}

async function saveActive(_context: HarnessContext): Promise<void> {
  fireEvent.keyDown(window, { key: "s", metaKey: true })
  await settle()
  await act(async () => { await Promise.resolve() })
}

export function createAppHarness(editor: EditorMock): AppHarness {
  const fakeDisk = makeFakeDisk()
  const context: HarnessContext = {
    editor,
    fakeDisk,
    services: {} as HarnessServices,
    records: [],
    saveOverride: null,
    savePauseQueue: [],
    openTabIds: [],
    rendered: null,
    autosaveMs: 0,
    watchMs: NO_WATCH_MS,
  }
  context.services = harnessServices(context)
  installEditorMock(context)
  installEnginePendingLookup()

  return {
    services: context.services,
    seedFile: (path, contents) => { fakeDisk.seed(path, contents) },
    disk: path => fakeDisk.disk(path),
    renderApp: (props = {}) => {
      unmountLastMountedApp()
      context.rendered?.unmount()
      context.autosaveMs = props.autosaveMs ?? 0
      context.watchMs = props.watchMs ?? NO_WATCH_MS
      context.rendered = render(appElement(context, context.watchMs))
      lastMountedApp = context.rendered
      return context.rendered
    },
    editorForTab: tabId => recordForTab(context, tabId).handle,
    allEditors: () => context.records.map(record => record.handle),
    activateTab: tabId => activateTab(context, tabId),
    openIntoActive: (path, contents) => openIntoActive(context, path, contents),
    openInNewTab: (path, contents) => openInNewTab(context, path, contents),
    openFileTab: (path, contents) => openFileTab(context, path, contents),
    requestOpen: (path, contents) => requestOpen(context, path, contents),
    emitPending: (tabId, id) => emitPending(context, tabId, id),
    saveNormalization: async tabId => {
      activateTab(context, tabId)
      fireEvent.click(screen.getByRole("button", { name: "Save normalization" }))
      await settle()
    },
    saveActive: () => saveActive(context),
    failNextReset: error => {
      context.editor.reset.mockImplementationOnce(() => { throw error })
    },
    requestCloseTab: tabId => {
      activateTab(context, tabId)
      fireEvent.keyDown(window, { key: "w", metaKey: true })
    },
    runExternalCheck: () => runWatcherPoll(context),
    runWatcher: () => runWatcherPoll(context),
    nextSaveResult: result => {
      context.saveOverride = { kind: "result", result }
    },
    failNextSave: error => {
      context.saveOverride = { kind: "error", error }
    },
    pauseNextSave: () => {
      const gate = deferred<void>()
      context.savePauseQueue.push(gate)
      return gate
    },
  }
}
