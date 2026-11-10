import { redo, selectAll, undo } from "@codemirror/commands"
import { EditorView } from "@codemirror/view"
import {
  applyToggle,
} from "@omd/engine"
import type { Dispatch, RefObject, SetStateAction } from "react"
import { exportDiagnostics, openLogFolder } from "./appDiagnosticsActions"
import { exportCurrent, loadCustomCss, type ExportRenderOptions } from "./appExportActions"
import { pastePlainText } from "./pastePlainText"
import { pasteFromSystemClipboard, type ClipboardPasteOptions } from "./clipboardPaste"
import { systemClipboardReader } from "./clipboardPayload"
import { makeExportImageResolver } from "./exportImages"
import { pickAndInsertImage, type ImagePasteOptions } from "./imagePaste"
import { sessionPath, type EditorSession } from "./session"
import type { Workspace } from "./workspace"
import type { DocumentOpen } from "./documentOpen"
import type { DocumentSaveAppBridge } from "./documentSaveAppBridge"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { DesktopServices } from "./desktopServices"
import type { UpdateCoordinator } from "./updateCoordinator"
import type { FindReplaceHandle } from "./useFindReplace"
import type { WorkspaceSearchState } from "./useWorkspaceSearch"
import type { AppCommand } from "./commands"
import { formatCommandEntries } from "./formatCommandEntries"
import { shortcutFor } from "./shortcuts"
import { toggleTheme, type AppTheme } from "./theme"

/** 命令表工厂的宿主访问器（plan P5）。字段名与 App 现有闭包变量一一对应；
 * 命令数组本就每次渲染重建，ctx 也随渲染重建即可，不要用 ref 冻结。 */
export interface AppCommandsContext {
  readonly services: DesktopServices
  readonly t: (key: string, params?: Record<string, string | number>) => string
  readonly viewRef: RefObject<EditorView | null>
  readonly sessionRef: RefObject<EditorSession>
  readonly workspaceRef: RefObject<Workspace>
  readonly tabById: (id: number) => EditorSession | undefined
  readonly openFile: () => Promise<void>
  readonly saveFile: DocumentSaveAppBridge["saveFile"]
  readonly newTab: () => void
  readonly chooseFolder: () => Promise<void>
  readonly openCoordinator: DocumentOpen
  readonly findReplace: FindReplaceHandle
  readonly search: WorkspaceSearchState
  readonly requestCloseTab: (id: number) => void
  readonly clearRecents: () => void
  readonly openVersionHistory: () => Promise<void>
  readonly setTheme: Dispatch<SetStateAction<AppTheme>>
  readonly setCustomCss: Dispatch<SetStateAction<string>>
  readonly setFocusMode: Dispatch<SetStateAction<boolean>>
  readonly setSettingsOpen: Dispatch<SetStateAction<boolean>>
  readonly setSidebarOpen: Dispatch<SetStateAction<boolean>>
  readonly setOutlineOpen: Dispatch<SetStateAction<boolean>>
  readonly setTypewriter: Dispatch<SetStateAction<boolean>>
  readonly setAboutOpen: Dispatch<SetStateAction<boolean>>
  readonly customCss: string
  readonly exportOptions: () => ExportRenderOptions
  readonly showTransientStatus: (message: string) => void
  readonly updateCoordinatorRef: RefObject<UpdateCoordinator | null>
  readonly pasteOptions: (tabId: number, documentId: number) => ClipboardPasteOptions
  readonly imageInsertOptions: (tabId: number, documentId: number) => ImagePasteOptions
  readonly documentScaleRegistry: DocumentScaleRegistry
}

export function buildAppCommands(ctx: AppCommandsContext): AppCommand[] {
  const {
    services, t,
    viewRef, sessionRef, workspaceRef, tabById,
    openFile, saveFile, newTab, chooseFolder, openCoordinator,
    findReplace, search,
    requestCloseTab, clearRecents, openVersionHistory,
    setTheme, setCustomCss, setFocusMode, setSettingsOpen, setSidebarOpen,
    setOutlineOpen, setTypewriter, setAboutOpen,
    customCss, exportOptions, showTransientStatus, updateCoordinatorRef,
    pasteOptions, imageInsertOptions, documentScaleRegistry,
  } = ctx

  const runEditorCommand = (command: (view: EditorView) => boolean): (() => void) => () => {
    const view = viewRef.current
    if (view) try { command(view) } catch { /* mock views */ }
  }

  /** Menu copy/cut read the editor selection into the system clipboard; cut
   * deletes only after the write succeeds. Best-effort — clipboard access can
   * fail in restricted webviews, and the native Ctrl+C/X path stays primary. */
  const runClipboardCopy = (cut: boolean): (() => void) => () => {
    const view = viewRef.current
    if (!view) return
    let text = ""
    let from = 0
    let to = 0
    try {
      const selection = view.state.selection.main
      from = selection.from
      to = selection.to
      text = view.state.sliceDoc(from, to)
    } catch {
      return // mock views
    }
    const write = navigator.clipboard?.writeText(text)
    if (!write) return
    void write.then(
      () => {
        if (!cut || text === "") return
        try { view.dispatch({ changes: { from, to, insert: "" } }) } catch { /* mock views */ }
      },
      () => undefined,
    )
  }

  /** Menu paste delegates to pastePlainText so the caret lands after the
   * pasted text and an empty clipboard no-ops instead of deleting the
   * selection. Best-effort — the native Ctrl/Cmd-V path stays primary. */
  const runClipboardPaste = (): (() => void) => () => {
    const view = viewRef.current
    if (!view) return
    const active = sessionRef.current
    void pasteFromSystemClipboard(
      view,
      systemClipboardReader,
      pasteOptions(active.id, active.documentId),
    )
  }

  const insertImage = () => {
    const view = viewRef.current
    const active = sessionRef.current
    if (!view) return
    // 只读档（HUGE）不可变：不弹文件选择器（imagePaste 侧 state.readOnly 兜底再拦）。
    if (documentScaleRegistry.isReadOnly(active.id)) return
    void pickAndInsertImage(view, imageInsertOptions(active.id, active.documentId))
  }

  return [
    { id: "open", label: t("cmd.label.open"), shortcut: shortcutFor("open"), run: () => void openFile() },
    { id: "quick-open", label: t("cmd.label.quick-open"), shortcut: shortcutFor("quick-open"), run: () => void openCoordinator.openQuickOpen() },
    { id: "save", label: t("cmd.label.save"), shortcut: shortcutFor("save"), run: () => void saveFile(workspaceRef.current.activeId, "explicit") },
    { id: "save-as", label: t("cmd.label.save-as"), shortcut: shortcutFor("save-as"), run: () => void saveFile(workspaceRef.current.activeId, "explicit", true) },
    { id: "folder", label: t("cmd.label.folder"), run: () => void chooseFolder() },
    { id: "tab", label: t("cmd.label.tab"), shortcut: shortcutFor("tab"), run: newTab },
    { id: "new-window", label: t("cmd.label.newWindow"), shortcut: shortcutFor("new-window"), run: () => { void services.createNewWindow?.() } },
    { id: "close", label: t("cmd.label.close"), shortcut: shortcutFor("close"), run: () => requestCloseTab(workspaceRef.current.activeId) },
    { id: "theme", label: t("cmd.label.theme"), run: () => setTheme(current => toggleTheme(current)) },
    { id: "css", label: t("cmd.label.css"), run: () => void loadCustomCss(services, setCustomCss) },
    { id: "focus", label: t("cmd.label.focus"), run: () => setFocusMode(on => !on) },
    { id: "preferences", label: t("cmd.label.preferences"), shortcut: shortcutFor("preferences"), run: () => setSettingsOpen(true) },
    { id: "sidebar", label: t("cmd.label.sidebar"), shortcut: shortcutFor("sidebar"), run: () => setSidebarOpen(open => !open) },
    { id: "outline", label: t("cmd.label.outline"), shortcut: shortcutFor("outline"), run: () => setOutlineOpen(open => !open) },
    { id: "typewriter", label: t("cmd.label.typewriter"), run: () => setTypewriter(on => !on) },
    { id: "source", label: t("cmd.label.source"), shortcut: shortcutFor("source"), run: () => {
      const view = viewRef.current
      if (!view) return
      try {
        view.dispatch(applyToggle(view.state))
      } catch { /* mock views */ }
    } },
    ...formatCommandEntries(t, runEditorCommand),
    { id: "insert-image", label: t("cmd.label.insert-image"), run: insertImage },
    { id: "undo", label: t("cmd.label.undo"), shortcut: shortcutFor("undo"), run: runEditorCommand(undo) },
    { id: "redo", label: t("cmd.label.redo"), shortcut: shortcutFor("redo"), run: runEditorCommand(redo) },
    { id: "cut", label: t("cmd.label.cut"), shortcut: shortcutFor("cut"), run: runClipboardCopy(true) },
    { id: "copy", label: t("cmd.label.copy"), shortcut: shortcutFor("copy"), run: runClipboardCopy(false) },
    { id: "paste", label: t("cmd.label.paste"), shortcut: shortcutFor("paste"), run: runClipboardPaste() },
    { id: "pastePlainText", label: t("cmd.label.pastePlainText"), shortcut: shortcutFor("pastePlainText"), run: () => {
      const view = viewRef.current
      const active = sessionRef.current
      if (view) void pastePlainText(view, pasteOptions(active.id, active.documentId))
    } },
    { id: "select-all", label: t("cmd.label.select-all"), shortcut: shortcutFor("select-all"), run: runEditorCommand(selectAll) },
    { id: "find", label: t("cmd.label.find"), shortcut: shortcutFor("find"), run: () => {
      findReplace.setOpen(true)
      findReplace.setReplaceOpen(false)
    } },
    { id: "search", label: t("cmd.label.search"), shortcut: shortcutFor("search"), run: () => search.setOpen(true) },
    ...(["html", "pdf", "png"] as const).map(kind => ({
      id: kind === "png" ? "export-image" : `export-${kind}`,
      label: t(kind === "png" ? "cmd.label.export-image" : `cmd.label.export-${kind}`),
      run: () => {
        const tab = tabById(workspaceRef.current.activeId)
        const docPath = tab ? sessionPath(tab) : null
        const renderOptions = exportOptions()
        void exportCurrent(
          services,
          viewRef.current,
          kind,
          { resolveImageSrc: makeExportImageResolver(() => docPath) },
          customCss,
          showTransientStatus,
          renderOptions,
        )
      },
    })),
    { id: "clear-recents", label: t("cmd.label.clear-recents"), run: clearRecents },
    { id: "check-updates", label: t("cmd.label.check-updates"), run: () => { void updateCoordinatorRef.current?.check("manual") } },
    { id: "export-diagnostics", label: t("cmd.label.export-diagnostics"), run: () => void exportDiagnostics(services) },
    { id: "open-log-folder", label: t("cmd.label.open-log-folder"), run: () => void openLogFolder(services) },
    { id: "history", label: t("cmd.label.history"), run: () => void openVersionHistory() },
    { id: "quit", label: t("cmd.label.quit"), run: () => void services.quitApp?.() },
    { id: "about", label: t("cmd.label.about"), run: () => setAboutOpen(true) },
  ]
}
