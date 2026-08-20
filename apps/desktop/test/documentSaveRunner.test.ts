import { describe, expect, it, vi } from "vitest"
import type { EditorView } from "@codemirror/view"
import {
  createGuardedDocumentSaver,
  type DocumentSaveHost,
} from "../src/documentSaveRunner"
import { initialSaveState, type SaveStateByTab } from "../src/documentSaveState"
import {
  createFileSession,
  sessionSavedContents,
  sessionDirty,
  type EditorSession,
} from "../src/session"
import {
  createWorkspace,
  replaceTabSession,
  type Workspace,
} from "../src/workspace"
import type { NormalizationByTab } from "../src/normalizationState"
import type { SaveDocumentResult } from "../src/desktopServices"
import { versionFor } from "./fakeDisk"

const TAB_ID = 1
const PATH = "/notes/a.md"
const BASELINE = "disk baseline"

interface FakeEditor {
  readonly view: EditorView
  /** Swaps the doc object the way CM does on a doc-changing transaction. */
  readonly edit: (next: string) => void
  /** Flatten calls on state.doc — proxy for "the rope was re-materialized". */
  readonly flattenCalls: () => number
}

/** CM Text 语义的保真替身：doc 对象在创建时冻结其内容，文档变更换引用
 * （Text.replace 恒新建节点），选区类更新不动 —— documentSaveRunner 依此
 * 判定保存期间是否落过编辑。flatten 计数用于断言没有发生多余的 rope 展平。 */
function fakeEditor(initial: string): FakeEditor {
  const state: { doc: { toString(): string } } = {
    doc: { toString: () => initial },
  }
  let flattenCalls = 0
  const track = (value: string) => ({
    toString: () => {
      flattenCalls += 1
      return value
    },
  })
  state.doc = track(initial)
  const view = {
    state,
    dispatch: vi.fn(),
    focus: vi.fn(),
  } as unknown as EditorView
  return {
    view,
    edit: next => { state.doc = track(next) },
    flattenCalls: () => flattenCalls,
  }
}

interface RunnerFixture {
  readonly saveFile: ReturnType<typeof createGuardedDocumentSaver>
  readonly editor: FakeEditor
  readonly syncDoc: ReturnType<typeof vi.fn>
  readonly workspace: () => Workspace
  /** Gate the in-flight saveDocument call; resolves when the test lets it finish. */
  readonly pauseSave: () => { readonly finish: () => Promise<void> }
  readonly tab: () => EditorSession
}

function makeRunner(currentDoc: string): RunnerFixture {
  const editor = fakeEditor(currentDoc)
  const baselineVersion = versionFor(PATH, BASELINE)
  const tab = createFileSession(TAB_ID, PATH, BASELINE, baselineVersion)
  let workspace: Workspace = replaceTabSession(createWorkspace(), tab)
  const views = new Map<number, EditorView>([[TAB_ID, editor.view]])
  let saveStates: SaveStateByTab = { [TAB_ID]: initialSaveState() }
  let normalization: NormalizationByTab = {}
  const syncDoc = vi.fn()
  let gate: Promise<void> | null = null

  const host: DocumentSaveHost = {
    isOpening: () => false,
    getTab: () => workspace.tabs.find(item => item.id === TAB_ID),
    getView: () => editor.view,
    getContents: () => currentDoc,
    getNormalization: () => normalization,
    setNormalization: next => { normalization = next },
    getWorkspace: () => workspace,
    setWorkspace: next => { workspace = next },
    getViews: () => views,
    getSaveStates: () => saveStates,
    setSaveStates: next => { saveStates = next },
    pickSavePath: async () => null,
    saveDocument: async (_path, contents, _expected) => {
      if (gate) await gate
      const result: SaveDocumentResult = {
        status: "saved",
        version: versionFor(PATH, contents),
        durability: "durable",
      }
      return result
    },    readDocument: async () => ({ kind: "missing", requestedPath: PATH }),
    readDocumentVersion: async () => ({
      kind: "existing" as const,
      version: baselineVersion,
    }),
    allowDocumentAssets: async () => undefined,
    revealFolder: () => undefined,
    rememberRecent: () => undefined,
    syncDoc,
    clearRecovery: () => undefined,
    operationSeq: { current: 0 },
    enqueue: (_tabId, work) => work(),
    onDurabilityWarning: () => undefined,
    incrementFocusToken: () => undefined,
    logReadFailed: () => undefined,
    reportStatus: () => undefined,
  }
  return {
    saveFile: createGuardedDocumentSaver(host),
    editor,
    syncDoc,
    workspace: () => workspace,
    pauseSave: () => {
      let release!: () => void
      gate = new Promise<void>(resolve => { release = resolve })
      let finished = false
      return {
        finish: async () => {
          release()
          if (!finished) {
            finished = true
            // 等待队列里的 save 操作完整走完（enqueue 直通 work，但内部有多个 await）。
            await vi.waitFor(() => {
              expect(syncDoc).toHaveBeenCalled()
            })
          }
        },
      }
    },
    tab: () => workspace.tabs.find(item => item.id === TAB_ID)!,
  }
}

describe("createGuardedDocumentSaver save baseline", () => {
  it("reuses the saved snapshot string when no edit lands during the save", async () => {
    const fx = makeRunner("mine")
    const flattenBefore = fx.editor.flattenCalls()

    await fx.saveFile(TAB_ID, "explicit")

    // 快照物化一次（prepare 阶段），保存成功后没有再展平 rope —— syncDoc 拿到的
    // 是发给 Rust 的同一字符串，docsRef/savedContents 引用相等 → sessionDirty O(1)。
    expect(fx.editor.flattenCalls()).toBe(flattenBefore + 1)
    expect(fx.syncDoc).toHaveBeenCalledOnce()
    const [syncedDoc, syncedTab] = fx.syncDoc.mock.calls[0]
    expect(syncedTab).toBe(TAB_ID)
    expect(syncedDoc).toBe("mine")
    expect(syncedDoc).toBe(sessionSavedContents(fx.tab()))
    expect(sessionDirty(fx.tab(), syncedDoc)).toBe(false)
  })

  it("re-flattens the edited doc when an edit lands during the save", async () => {
    const fx = makeRunner("mine")
    const paused = fx.pauseSave()
    const saving = fx.saveFile(TAB_ID, "explicit")
    const flattenAtPause = fx.editor.flattenCalls()

    // 保存进行中用户继续打字：CM 换 Text 引用，旧快照绝不能覆盖新编辑。
    fx.editor.edit("mine + late edit")
    await paused.finish()
    await saving

    expect(fx.editor.flattenCalls()).toBe(flattenAtPause + 1)
    expect(fx.syncDoc).toHaveBeenCalledOnce()
    const [syncedDoc] = fx.syncDoc.mock.calls[0]
    expect(syncedDoc).toBe("mine + late edit")
    // 基线仍是已写盘的快照：tab 保持脏态（late edit 未保存）。
    expect(sessionSavedContents(fx.tab())).toBe("mine")
    expect(sessionDirty(fx.tab(), syncedDoc)).toBe(true)
  })
})
