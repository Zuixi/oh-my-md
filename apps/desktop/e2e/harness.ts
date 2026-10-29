// E2E harness: mounts the real desktop editor (src/Editor.ts + styles.css) in a
// plain browser page — no React App, no Tauri IPC. The visual-regression class we
// keep shipping (zero-height elements, container seams, collapsed rows) is invisible
// to happy-dom, which has no layout engine; only a real browser layout can see it.
// Playwright loads /e2e/harness.html?doc=<encodeURIComponent(markdown)>&theme=light|dark
import "../src/styles.css"
import { undo } from "@codemirror/commands"
import { createEditor } from "../src/Editor"
// Spike-only: the retained controller count lives in the engine's internal table
// widget module, never in the supported barrel (see the plan's Task 5).
import { activeTableInputControllerCountForTest } from "@omd/engine/src/decorations/widgets/table"
import type { Text } from "@codemirror/state"
import { buildSearchFixture, type SearchFixture } from "../bench/searchFixtures"
import { findNextMatch, findPreviousMatch, type SearchRequest } from "../src/currentDocumentSearch"
import { startSearchCount, type SearchCount, type SearchCountJob, type SearchScheduler } from "../src/searchCountJob"

type RegexWorkerRequest = {
  readonly id: number
  readonly revision: number
  readonly source: string
  readonly flags: string
  readonly text: string
}

type RegexWorkerResponse =
  | { readonly id: number; readonly revision: number; readonly match: { readonly from: number; readonly to: number } | null }
  | { readonly id: number; readonly revision: number; readonly error: string }

type SearchSpikeHandle = {
  readonly run: (source: string, flags: string, text: string) => Promise<RegexWorkerResponse>
  readonly setRevision: (revision: number) => void
  readonly pending: () => number
  readonly accepted: () => readonly RegexWorkerResponse[]
  readonly discarded: () => readonly RegexWorkerResponse[]
  readonly terminate: () => void
  readonly terminated: () => boolean
}

type SearchSpikeFixtureName = "normal-100m" | "dense-100m"

type SearchSpikeFixtureInfo = {
  readonly name: string
  readonly length: number
  readonly lines: number
}

type SearchSpikeNavigation = {
  readonly ms: number
  readonly from: number
  readonly to: number
  readonly cursorWindows: number
  readonly earliestSearchedOffset: number
}

type SearchSpikeCountResult = {
  readonly count: number
  readonly complete: boolean
  readonly elapsedMs: number
  readonly publishes: number
}

type SearchSpikeCancellation = {
  readonly cancellationMs: number
  readonly publishedBefore: number
  readonly publishedAfter: number
  readonly stalePublish: boolean
  readonly cancelled: boolean
}

type SearchSpikeGuards = {
  readonly stringifyCalls: number
  readonly wholeDocumentSliceCalls: number
  readonly largestSliceChars: number
  readonly iterRangeCalls: number
  readonly matchArraysRetained: number
  readonly countPublishes: number
}

/**
 * Table direct-edit memory spike driver (`?tableMemorySpike=1`, opt-in). It owns the
 * fixture bytes and drives tight, bounded control/experiment cycles in-page because
 * 1,000 Playwright round-trips per sample point would not be practical.
 */
type TableAuditSnapshot = {
  readonly doc: string | null
  readonly docLength: number | null
  readonly docEqualsFixture: boolean | null
  readonly inputCount: number
  readonly controllerCount: number
}

type TableAuditMode = "control" | "experiment"

type TableAuditHelper = {
  readonly fixture: string
  readonly runControl: (cycles: number) => Promise<void>
  readonly runExperiment: (cycles: number) => Promise<void>
  readonly snapshot: () => TableAuditSnapshot
  readonly destroy: () => void
}

type SearchSpikeFixtures = {
  readonly build: (name: SearchSpikeFixtureName) => SearchSpikeFixtureInfo
  readonly navigate: (direction: "next" | "previous", anchor: number) => SearchSpikeNavigation
  readonly count: (options: { readonly cap: number; readonly sliceMs?: number }) => Promise<SearchSpikeCountResult>
  readonly cancelCount: () => SearchSpikeCancellation
  readonly release: () => void
  readonly guards: () => SearchSpikeGuards
}

declare global {
  interface Window {
    __view: ReturnType<typeof createEditor>
    __harnessErrors: string[]
    __docChangeCount: number
    __docText: () => string
    __startSearchSpike?: (revision: number) => SearchSpikeHandle
    __searchSpike?: SearchSpikeHandle
    __searchSpikeFixtures?: SearchSpikeFixtures
    __tableDirectEditAudit?: TableAuditHelper
  }
}

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"

// `apBrackets` / `apQuotes` / `apMarkdown` let a spec construct the editor with one
// auto-pair toggle off (`?apQuotes=0`). Absent params keep the shipped defaults
// (`DEFAULT_AUTO_PAIR`, all true), so every existing spec is unaffected.
const autoPair = {
  brackets: params.get("apBrackets") !== "0",
  quotes: params.get("apQuotes") !== "0",
  markdownSyntax: params.get("apMarkdown") !== "0",
}

const host = document.createElement("div")
host.className = "editor-host"
document.body.replaceChildren(host)

window.__harnessErrors = []
window.__docChangeCount = 0
window.__docText = () => window.__view.state.doc.toString()
window.__view = createEditor(host, {
  doc: params.get("doc") ?? "",
  tabId: 1,
  documentId: 1,
  getDocPath: () => null,
  getDocumentId: () => 1,
  autoPair,
  experimentalTableDirectEdit: params.get("tableDirectEdit") === "1",
  onDocumentUpdate: update => {
    if (update.docChanged) window.__docChangeCount++
  },
  onError: message => { window.__harnessErrors.push(message) },
})
// Default caret sits at the document end (rendered-block territory), and the
// view owns focus so keyboard-driven specs can type without clicking first.
window.__view.dispatch({ selection: { anchor: window.__view.state.doc.length } })
window.__view.focus()

if (params.get("searchSpike") === "1") {
  window.__startSearchSpike = initialRevision => {
    const worker = new Worker(new URL("../src/searchRegex.worker.ts", import.meta.url), { type: "module" })
    const accepted: RegexWorkerResponse[] = []
    const discarded: RegexWorkerResponse[] = []
    const resolvers = new Map<number, (response: RegexWorkerResponse) => void>()
    let nextId = 0
    let revision = initialRevision
    let isTerminated = false

    worker.onmessage = (event: MessageEvent<RegexWorkerResponse>) => {
      const response = event.data
      const resolve = resolvers.get(response.id)
      resolvers.delete(response.id)
      if (response.revision !== revision) {
        discarded.push(response)
        return
      }
      accepted.push(response)
      resolve?.(response)
    }

    const handle: SearchSpikeHandle = {
      run: (source, flags, text) => {
        const request: RegexWorkerRequest = { id: nextId++, revision, source, flags, text }
        return new Promise<RegexWorkerResponse>(resolve => {
          resolvers.set(request.id, resolve)
          worker.postMessage(request)
        })
      },
      setRevision: next => { revision = next },
      pending: () => resolvers.size,
      accepted: () => accepted,
      discarded: () => discarded,
      terminate: () => {
        isTerminated = true
        worker.terminate()
      },
      terminated: () => isTerminated,
    }

    window.__searchSpike = handle
    return handle
  }
}

if (params.get("searchSpike") === "1") {
  const round = (value: number): number => Number(value.toFixed(3))
  const searchRequest: SearchRequest = {
    query: "needle",
    caseSensitive: false,
    regexp: false,
    wholeWord: false,
    revision: 7,
  }
  const browserScheduler: SearchScheduler = {
    now: () => performance.now(),
    schedule: run => {
      const handle = setTimeout(run, 0)
      return () => clearTimeout(handle)
    },
  }

  let fixture: SearchFixture | null = null
  let guardedDoc: Text | null = null
  let ranges: (readonly [number, number])[] = []
  let counters = { stringifyCalls: 0, wholeDocumentSliceCalls: 0, largestSliceChars: 0, iterRangeCalls: 0 }
  let active: { readonly job: SearchCountJob; readonly publishes: SearchCount[] } | null = null

  function resetCounters(): void {
    counters = { stringifyCalls: 0, wholeDocumentSliceCalls: 0, largestSliceChars: 0, iterRangeCalls: 0 }
  }

  function guard(doc: Text): Text {
    const length = doc.length
    return new Proxy(doc, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== "function") return value
        if (property === "toString") {
          return () => {
            counters.stringifyCalls += 1
            return target.toString()
          }
        }
        if (property === "sliceString") {
          return (from: number, to: number, lineSep?: string) => {
            if (length > 0 && from === 0 && to === length) counters.wholeDocumentSliceCalls += 1
            counters.largestSliceChars = Math.max(counters.largestSliceChars, to - from)
            return target.sliceString(from, to, lineSep)
          }
        }
        if (property === "iterRange") {
          return (from: number, to?: number) => {
            counters.iterRangeCalls += 1
            ranges.push([from, to ?? length])
            return target.iterRange(from, to)
          }
        }
        return value.bind(target)
      },
    })
  }

  function currentDoc(): Text {
    if (guardedDoc === null) throw new Error("build a search spike fixture first")
    return guardedDoc
  }

  function release(): void {
    active?.job.cancel()
    active = null
    fixture = null
    guardedDoc = null
    ranges = []
    resetCounters()
  }

  function build(name: SearchSpikeFixtureName): SearchSpikeFixtureInfo {
    release()
    const built = buildSearchFixture(name)
    fixture = built
    guardedDoc = guard(built.text)
    return { name: built.name, length: built.text.length, lines: built.text.lines }
  }

  function navigate(direction: "next" | "previous", anchor: number): SearchSpikeNavigation {
    const doc = currentDoc()
    const firstRange = ranges.length
    const started = performance.now()
    const match = direction === "next"
      ? findNextMatch(doc, searchRequest, anchor)
      : findPreviousMatch(doc, searchRequest, anchor)
    const ms = performance.now() - started
    const opened = ranges.slice(firstRange)
    return {
      ms: round(ms),
      from: match ? match.from : -1,
      to: match ? match.to : -1,
      cursorWindows: opened.length,
      earliestSearchedOffset: opened.length === 0 ? anchor : Math.min(...opened.map(range => range[0])),
    }
  }

  function count(options: { readonly cap: number; readonly sliceMs?: number }): Promise<SearchSpikeCountResult> {
    const doc = currentDoc()
    const publishes: SearchCount[] = []
    const started = performance.now()
    return new Promise<SearchSpikeCountResult>(resolve => {
      const job = startSearchCount(
        doc,
        searchRequest,
        browserScheduler,
        published => {
          publishes.push(published)
          resolve({
            count: published.count,
            complete: published.complete,
            elapsedMs: round(performance.now() - started),
            publishes: publishes.length,
          })
        },
        { cap: options.cap, sliceMs: options.sliceMs ?? 4 },
      )
      active = { job, publishes }
    })
  }

  function cancelCount(): SearchSpikeCancellation {
    if (active === null) {
      return { cancellationMs: 0, publishedBefore: 0, publishedAfter: 0, stalePublish: false, cancelled: false }
    }
    const publishedBefore = active.publishes.length
    const started = performance.now()
    active.job.cancel()
    const cancellationMs = performance.now() - started
    const publishedAfter = active.publishes.length
    return {
      cancellationMs: round(cancellationMs),
      publishedBefore,
      publishedAfter,
      stalePublish: publishedAfter !== publishedBefore,
      cancelled: active.job.cancelled,
    }
  }

  function guards(): SearchSpikeGuards {
    return {
      ...counters,
      matchArraysRetained: 0,
      countPublishes: active === null ? 0 : active.publishes.length,
    }
  }

  window.__searchSpikeFixtures = { build, navigate, count, cancelCount, release, guards }
}

const TABLE_AUDIT_INPUT_CLASS = "omd-table-cell-input"
/** Committed cell value; only needs to differ from the fixture cell ("A"). */
const TABLE_AUDIT_COMMIT_VALUE = "19"
/**
 * 块 widget 的表格 DOM 在 `toDOM` 之后的微任务里才渲染（BlockWidget 的 `start()`）。
 * 有限次微任务让 1,000 次循环无需定时器，也不需要忙等。
 */
const TABLE_AUDIT_RENDER_TICKS = 64

function createTableAudit(
  view: ReturnType<typeof createEditor>,
  fixture: string,
): TableAuditHelper {
  let destroyed = false

  const liveView = () => {
    if (destroyed) throw new Error("table audit: the view is already destroyed")
    return view
  }
  const docText = () => liveView().state.doc.toString()
  const countInputs = () => document.querySelectorAll(`.${TABLE_AUDIT_INPUT_CLASS}`).length

  const tableRoot = (): HTMLElement => {
    const root = document.querySelector<HTMLElement>(".omd-table")
    if (!root) throw new Error("table audit: expected a rendered .omd-table")
    return root
  }

  // 每轮都重新查询：widget/输入框节点会轮换（pass-1 复用、undo 回放、关闭重渲染）。
  const cellElement = (): HTMLElement => {
    const cell = tableRoot().querySelector<HTMLElement>("thead th, tbody td")
    if (!cell) throw new Error("table audit: expected a rendered table cell")
    return cell
  }

  const inputElement = (): HTMLInputElement => {
    const found = document.querySelector<HTMLInputElement>(`.${TABLE_AUDIT_INPUT_CLASS}`)
    if (!found) throw new Error("table audit: expected a live .omd-table-cell-input")
    return found
  }

  const expectControllers = (expected: number, stage: string) => {
    const actual = activeTableInputControllerCountForTest()
    if (actual !== expected) {
      throw new Error(`table audit: ${stage} expected ${expected} live table input controller(s), got ${actual}`)
    }
  }

  const expectFixture = (stage: string) => {
    if (docText() !== fixture) {
      throw new Error(`table audit: ${stage} did not leave the document byte-identical to the fixture`)
    }
  }

  /** 两种模式唯一共用的入口：预览单元格的 mousedown。 */
  const pressCell = () => {
    cellElement().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))
  }

  /** 控制组：预览格 mousedown 进源码，外层选区回文末重新挂载预览。 */
  const controlCycle = async (): Promise<void> => {
    pressCell()
    if (document.querySelector(".omd-table") !== null) {
      throw new Error("table audit: control cell mousedown did not enter source")
    }
    liveView().dispatch({ selection: { anchor: liveView().state.doc.length } })
    const root = document.querySelector<HTMLElement>(".omd-table")
    if (!root) throw new Error("table audit: control did not remount the preview")
    for (let tick = 0; tick < TABLE_AUDIT_RENDER_TICKS && !root.querySelector("th, td"); tick++) {
      await Promise.resolve()
    }
    if (!root.querySelector("th, td")) throw new Error("table audit: control preview cell did not render")
    expectControllers(0, "control cycle")
  }

  /**
   * 实验组：格 mousedown 开输入框 → 一次输入提交改掉该格 → 外层 undo 还原成逐字节相同的
   * fixture（输入框必须仍存活）→ Escape 关闭。
   */
  const experimentCycle = (): void => {
    pressCell()
    expectControllers(1, "experiment cell mousedown")
    const input = inputElement()
    input.value = TABLE_AUDIT_COMMIT_VALUE
    input.dispatchEvent(new Event("input", { bubbles: true }))
    if (docText() === fixture) throw new Error("table audit: experiment commit did not change the document")
    undo(liveView())
    expectFixture("experiment undo")
    expectControllers(1, "experiment undo")
    if (countInputs() !== 1) throw new Error("table audit: experiment undo dropped the live cell input")
    inputElement().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    if (countInputs() !== 0) throw new Error("table audit: experiment Escape left a live cell input")
    expectControllers(0, "experiment Escape")
  }

  const run = async (mode: TableAuditMode, cycles: number): Promise<void> => {
    if (!Number.isInteger(cycles) || cycles < 0) throw new Error(`table audit: bad cycle count ${cycles}`)
    liveView()
    for (let cycle = 0; cycle < cycles; cycle++) {
      if (mode === "control") await controlCycle()
      else experimentCycle()
    }
    expectFixture(`${mode} batch of ${cycles}`)
  }

  return {
    fixture,
    runControl: cycles => run("control", cycles),
    runExperiment: cycles => run("experiment", cycles),
    snapshot: () => {
      const doc = destroyed ? null : docText()
      return {
        doc,
        docLength: doc === null ? null : doc.length,
        docEqualsFixture: doc === null ? null : doc === fixture,
        inputCount: countInputs(),
        controllerCount: activeTableInputControllerCountForTest(),
      }
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      view.destroy()
    },
  }
}

// Opt-in only: every other harness URL keeps its exact previous surface.
if (params.get("tableMemorySpike") === "1") {
  window.__tableDirectEditAudit = createTableAudit(window.__view, window.__view.state.doc.toString())
}
