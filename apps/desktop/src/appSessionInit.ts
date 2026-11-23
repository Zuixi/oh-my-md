/**
 * One-shot startup sequence actions (App split plan P4).
 *
 * Three async flows that run once per mount, in the order the App mount
 * effect orchestrates them: settings load → per-window session shard
 * restore → main-gated draft-recovery prompt. The orchestration (pendingOpen
 * precedence, initLocale, main-window gating) stays in App.tsx — these are
 * just the bodies, injected with the host accessors they actually use.
 *
 * Host contract (documentOpen.ts precedent): modules must not capture stale
 * render closures, so every piece of App state is reached through a
 * getter/ref indirection (`*Ref.current` wiring lives in App).
 */
import type { AutoPairOptions } from "@omd/engine"
import {
  createSession, lazyFileSession, openSession, recoveryKey, sessionPath,
  type EditorSession,
} from "./session"
import type { RecoveryDraft } from "./recoveryAdoption"
import {
  activeSession, addTab, focusTab, openFolder, replaceTabSession, replaceTabs,
  type Workspace,
} from "./workspace"
import type { HotExitTabEntry, SavedSessionState } from "./sessionRestore"
import { DEFAULT_SETTINGS, sameAutoPair, type UserSettings } from "./settings"
import type { DesktopServices } from "./desktopServices"
import { getGlobalLogger } from "./logger"
import { keyField, pathField } from "./logPath"
import { clearRecoveryRecord } from "./recoveryCleanup"
import type { DocumentScaleRegistry } from "./documentScaleRegistry"
import type { AppTheme } from "./theme"
import { t } from "./i18n"

/** 启动序列的宿主访问器：仅列出三个流程实际用到的成员（宁少勿多）。 */
export interface AppSessionInitHost {
  readonly services: DesktopServices
  /** 档位登记（会话恢复主 tab 的字节数）。 */
  readonly documentScaleRegistry: DocumentScaleRegistry
  /** loadInitialSettings / restoreDraft 的卸载后写保护。 */
  isMounted(): boolean
  /** 热应用到已挂载 view（App 的 applySpellcheck/applyAutoPair，只碰 viewsRef）。 */
  applySpellcheck(on: boolean): void
  applyAutoPair(next: AutoPairOptions): void
  /** settingsRef 读写 + setSettings/setTheme 提交。 */
  getSettingsState(): UserSettings
  commitSettings(next: UserSettings): void
  commitTheme(theme: AppTheme): void
  /** workspaceRef 读取与提交（restoreSavedSession 重建工作区）。 */
  getWorkspace(): Workspace
  commitWorkspace(next: Workspace): void
  /** docsRef 读写（惰性 tab 占位、恢复后的 syncDoc）。 */
  getContents(tabId: number): string
  setContents(tabId: number, contents: string): void
  /** 主 tab 装载（经 resetTabDocumentRef 转发，防过期闭包）。 */
  resetTabDocument(session: EditorSession, contents: string): boolean
  /** Loads the tab holding `path` if the session restored it lazily, so its
   *  disk baseline/version exists before the draft is mounted. A failed load
   *  leaves it lazy and adoption falls back to a new tab. */
  ensureDraftTarget(path: string): Promise<void>
  /** Mounts one recovered draft (its matching tab, the pristine untitled tab,
   *  or a new tab) and returns the id of the tab that now holds it, or `null`
   *  when it could not be mounted (the record is kept). */
  adoptRecovery(draft: RecoveryDraft): number | null
  syncDoc(value: string, tabId: number): void
  /** 恢复成功标记（可选；仅测试/旧调用方使用）。 */
  markSessionRestored?(): void
}

export async function loadInitialSettings(host: AppSessionInitHost): Promise<UserSettings> {
  const { services } = host
  if (!services.getSettings) return DEFAULT_SETTINGS
  try {
    const saved = await services.getSettings()
    if (saved) {
      if (host.isMounted()) {
        if (saved.spellcheck !== host.getSettingsState().spellcheck) {
          host.applySpellcheck(saved.spellcheck)
        }
        if (!sameAutoPair(saved.autoPair, host.getSettingsState().autoPair)) {
          host.applyAutoPair(saved.autoPair)
        }
        host.commitSettings(saved)
        host.commitTheme(saved.theme)
      }
      return saved
    }
  } catch {
    /* tolerate settings read failure */
  }
  return DEFAULT_SETTINGS
}

export async function restoreSavedSession(
  host: AppSessionInitHost,
): Promise<ReadonlySet<string>> {
  const claimedRecoveryKeys = new Set<string>()
  const { services, documentScaleRegistry } = host
  if (!services.getSessionState) return claimedRecoveryKeys
  try {
    const state = await services.getSessionState()
    if (!state) return claimedRecoveryKeys
    const hotExitTabs = state.hotExitTabs ?? []
    if (!state.folder && state.openPaths.length === 0 && hotExitTabs.length === 0) {
      return claimedRecoveryKeys
    }

    if (state.folder) {
      // 恢复的路径可能已被移动/删除（或换机恢复）：先用真实列举验证再采纳。
      // 失效会话整体丢弃并提示一次——绝不带着死路径进入工作区，让后续每次
      // 交互都重复报同一个错。
      try {
        // Authorization MUST precede the listing: `list_dir` only serves
        // directories this window was granted, so a fire-and-forget grant
        // would make every restored workspace look missing.
        await services.allowWorkspaceDir?.(state.folder)
        await services.listDir?.(state.folder)
      } catch {
        services.reportError(t("error.workspaceFolderMissing"))
        return claimedRecoveryKeys
      }
      host.commitWorkspace(openFolder(host.getWorkspace(), state.folder))
    }

    if (hotExitTabs.length > 0) {
      await restoreHotExitTabs(host, state, hotExitTabs, claimedRecoveryKeys)
      return claimedRecoveryKeys
    }

    if (state.openPaths.length > 0) {
      // Spec 05b：只整读 active（或第一个）路径，其余 tab 惰性占位、
      // 首次激活时再读（loadLazyTab）——避免启动时 N×大文件整读 + IPC 风暴。
      // 主路径经 resetTabDocument 装载：view 拿到内容并应用档位策略
      // （直接写 docsRef 的旧路径会把已挂载的空 view 留在屏幕上）。
      const primary = state.activePath && state.openPaths.includes(state.activePath)
        ? state.activePath
        : state.openPaths[0]
      const ordered = [primary, ...state.openPaths.filter(path => path !== primary)]
      let activeTabId = host.getWorkspace().activeId
      let firstTabOpened = false

      for (const path of ordered) {
        if (firstTabOpened) {
          host.commitWorkspace(
            addTab(host.getWorkspace(), lazyFileSession(host.getWorkspace().nextId, path)),
          )
          continue
        }
        // primary 不可读时按序补位一次，成功后其余全部惰性。
        try {
          const snapshot = await services.readDocument(path)
          if (snapshot.kind === "missing") continue
          await services.allowDocumentAssets(path)
          const updated = openSession(host.getWorkspace().tabs[0], snapshot)
          host.setContents(updated.id, snapshot.contents)
          if (snapshot.stats) documentScaleRegistry.setBytes(updated.id, snapshot.stats.byteLength)
          if (!host.resetTabDocument(updated, snapshot.contents)) {
            host.commitWorkspace(replaceTabSession(host.getWorkspace(), updated))
          }
          firstTabOpened = true
          activeTabId = updated.id
        } catch {
          /* skip unreadable files */
        }
      }

      if (firstTabOpened) {
        const focused = focusTab(host.getWorkspace(), activeTabId)
        host.commitWorkspace(focused)
        const active = activeSession(focused)
        host.syncDoc(host.getContents(active.id), active.id)
      }
    }
  } catch {
    /* tolerate session restore failure */
  }
  return claimedRecoveryKeys
}

interface RestoredHotExitTab {
  readonly tab: EditorSession
  readonly contents: string
  /** Recovery record this tab's contents came from, when the tab was dirty. */
  readonly draftKey: string | null
}

/**
 * Rebuilds the window exactly as it was closed: every file tab in its original
 * order, every dirty untitled tab, the active tab, and the unsaved buffers
 * themselves. Nothing here prompts — a Hot Exit is a normal quit, so its
 * drafts are claimed rather than offered as crash orphans.
 */
async function restoreHotExitTabs(
  host: AppSessionInitHost,
  state: SavedSessionState,
  entries: readonly HotExitTabEntry[],
  claimedRecoveryKeys: Set<string>,
): Promise<void> {
  const drafts = await readHotExitDrafts(host.services, entries)
  const activeIndex = state.activeTabIndex ?? 0
  const workspace = host.getWorkspace()
  // Reuse the pristine scratch tab's id for the first entry so the mounted view
  // keeps its host element; the remaining entries take fresh ids.
  const firstTabId = workspace.tabs[0]?.id ?? 1
  let nextTabId = Math.max(workspace.nextId, firstTabId + 1)
  const restored: RestoredHotExitTab[] = []
  let activeTabId: number | undefined

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const draft = entry.recoveryKey !== null ? drafts.get(entry.recoveryKey) ?? null : null
    const tabId = restored.length === 0 ? firstTabId : nextTabId++
    const tab = await materializeHotExitTab(host, entry, draft, index === activeIndex, tabId)
    if (!tab) continue
    restored.push(tab)
    if (index === activeIndex) activeTabId = tab.tab.id
  }
  if (restored.length === 0) return

  host.commitWorkspace(replaceTabs(workspace, restored.map(item => item.tab), activeTabId))
  for (const item of restored) {
    host.setContents(item.tab.id, item.contents)
    // A reused tab id keeps the view created before the restore: it still holds
    // the pre-restore document identity and must be rebuilt from the restored
    // buffer. Other tabs get their view from ensureViews once the workspace
    // commits; resetTabDocument is a no-op for those.
    host.resetTabDocument(item.tab, item.contents)
  }
  const active = activeSession(host.getWorkspace())
  host.syncDoc(host.getContents(active.id), active.id)

  for (const item of restored) {
    if (item.draftKey !== null) {
      await claimHotExitDraft(host, item, claimedRecoveryKeys)
    }
  }
}

async function readHotExitDrafts(
  services: DesktopServices,
  entries: readonly HotExitTabEntry[],
): Promise<ReadonlyMap<string, { contents: string }>> {
  const drafts = new Map<string, { contents: string }>()
  if (!services.readRecovery) return drafts
  for (const entry of entries) {
    const key = entry.recoveryKey
    if (key === null || drafts.has(key)) continue
    try {
      const record = await services.readRecovery(key)
      if (record.contents !== "") drafts.set(key, { contents: record.contents })
    } catch {
      // A transient read failure degrades that tab to its disk baseline; the
      // record stays on disk for the crash-recovery prompt.
    }
  }
  return drafts
}

/**
 * Opens one Hot Exit tab. A clean file tab is read eagerly only when it is the
 * active tab (the pre-`ensureViews` window needs its text); the rest stay lazy
 * exactly like a legacy restore. A dirty buffer always needs its disk baseline
 * first, because that baseline is what makes the adopted buffer dirty again.
 */
async function materializeHotExitTab(
  host: AppSessionInitHost,
  entry: HotExitTabEntry,
  draft: { readonly contents: string } | null,
  eager: boolean,
  tabId: number,
): Promise<RestoredHotExitTab | null> {
  const { services, documentScaleRegistry } = host
  if (entry.kind === "file" && entry.path !== null) {
    if (draft === null && !eager) {
      return { tab: lazyFileSession(tabId, entry.path), contents: "", draftKey: null }
    }
    try {
      const snapshot = await services.readDocument(entry.path)
      if (snapshot.kind !== "missing") {
        await services.allowDocumentAssets(entry.path)
        const tab = openSession(createSession(tabId), snapshot)
        if (snapshot.stats) documentScaleRegistry.setBytes(tab.id, snapshot.stats.byteLength)
        return {
          tab,
          contents: draft?.contents ?? snapshot.contents,
          draftKey: draft ? entry.recoveryKey : null,
        }
      }
    } catch {
      /* fall through to the draft-only fallback */
    }
    // The file is gone or unreadable: keep the buffer rather than lose it.
    if (draft === null) return null
    return { tab: createSession(tabId), contents: draft.contents, draftKey: entry.recoveryKey }
  }
  if (draft === null) return null
  return { tab: createSession(tabId), contents: draft.contents, draftKey: entry.recoveryKey }
}

/**
 * Keeps a claimed Hot Exit draft durable under the tab's own recovery key so
 * closing without saving still tracks it, then retires the record it came from.
 * Equal keys already are that copy and are kept (the `restoreDrafts` rule).
 */
async function claimHotExitDraft(
  host: AppSessionInitHost,
  item: RestoredHotExitTab,
  claimedRecoveryKeys: Set<string>,
): Promise<void> {
  const { services } = host
  const sourceKey = item.draftKey
  if (sourceKey === null) return
  claimedRecoveryKeys.add(sourceKey)
  const key = recoveryKey(item.tab)
  if (key === sourceKey) return
  try {
    await services.writeRecovery?.(key, sessionPath(item.tab), item.contents)
    claimedRecoveryKeys.add(key)
    await discardRecovery(services, sourceKey)
  } catch {
    // The source record stays the durable copy; the record is offered again
    // only when its own read succeeds next launch.
    getGlobalLogger().warn("recovery", `could not re-arm hot exit draft ${keyField(key)}`)
  }
}

/**
 * Deletes one record without letting a cleanup failure abort the loop. The
 * draft is already resolved (declined, empty, or mounted), so a failed delete
 * only means it is offered once more next launch; skipping the remaining
 * records would strand the user's other drafts.
 */
async function discardRecovery(services: DesktopServices, key: string): Promise<void> {
  await clearRecoveryRecord(services, key)
}

/**
 * Keeps an adopted draft durable under the tab's own key. The mounted content
 * is memory-only, so the source record may only be deleted once an equivalent
 * record exists under the key `recoveryWriter` will use from now on; when the
 * keys already match the existing record is that copy and must be kept.
 * `draftPath` is the envelope's recorded path: when the path's own tab could
 * not be loaded and adoption fell back to an untitled tab, the path is still
 * the draft's identity and the re-armed record must carry it, or the next
 * launch could no longer return the draft to its file tab.
 * Returns `true` when the old record may be deleted.
 */
async function rearmDraft(
  services: DesktopServices, recordKey: string, tab: EditorSession, contents: string,
  draftPath: string | null,
): Promise<boolean> {
  const key = recoveryKey(tab)
  if (key === recordKey) return false
  const write = services.writeRecovery
  if (!write) return false
  try {
    await write(key, draftPath ?? sessionPath(tab), contents)
    return true
  } catch {
    getGlobalLogger().warn("recovery", `could not re-arm draft ${keyField(key)}`)
    // The source record stays the durable copy.
    return false
  }
}

/**
 * Offers **every** recovery record, not just the first one. A record is
 * deleted only after the user declines it or after its draft has been
 * mounted and re-armed under the tab's key; a transient read failure keeps it
 * for the next launch.
 */
export async function restoreDrafts(
  host: AppSessionInitHost,
  claimedRecoveryKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  const { services } = host
  const records = await services.listRecoveries?.() ?? []
  if (!services.readRecovery) return
  for (const record of records) {
    // A Hot Exit already restored this buffer as a live tab; offering it again
    // would duplicate the user's work behind a crash prompt.
    if (claimedRecoveryKeys.has(record.key)) continue
    if (!services.confirmRestore?.(record.label)) {
      await discardRecovery(services, record.key)
      continue
    }
    let contents: string
    let path: string | null
    try {
      ({ contents, path } = await services.readRecovery(record.key))
    } catch {
      continue
    }
    if (contents === "") {
      await discardRecovery(services, record.key)
      continue
    }
    // A lazy tab must know its disk baseline before the draft replaces its
    // content: otherwise its persistence stays "not read" and the next
    // activation would refetch the file over the draft, after this record is gone.
    if (path !== null) {
      // A failed lazy load must not abort the remaining records: adoption then
      // simply falls back to a new tab (the draft is never lost).
      try {
        await host.ensureDraftTarget(path)
      } catch {
        getGlobalLogger().warn("recovery", `could not load draft target ${pathField(path)}`)
      }
    }
    if (!host.isMounted()) return
    const tabId = host.adoptRecovery({ key: record.key, path, contents })
    if (tabId === null) continue
    const tab = host.getWorkspace().tabs.find(item => item.id === tabId)
    if (tab && await rearmDraft(services, record.key, tab, contents, path)) {
      await discardRecovery(services, record.key)
    }
  }
}
