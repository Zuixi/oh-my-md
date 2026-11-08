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
  advanceDocumentIdentity, lazyFileSession, openSession,
  type EditorSession,
} from "./session"
import {
  activeSession, addTab, focusTab, openFolder, replaceTabSession,
  type Workspace,
} from "./workspace"
import { DEFAULT_SETTINGS, sameAutoPair, type UserSettings } from "./settings"
import type { DesktopServices } from "./desktopServices"
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
  syncDoc(value: string, tabId: number): void
  /** sessionRef 读取（草稿恢复推进文档身份）。 */
  getActiveSession(): EditorSession
  /** 恢复成功标记（sessionRestoredRef 写）。 */
  markSessionRestored(): void
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

export async function restoreSavedSession(host: AppSessionInitHost): Promise<boolean> {
  const { services, documentScaleRegistry } = host
  if (!services.getSessionState) return false
  try {
    const state = await services.getSessionState()
    if (!state || (!state.folder && state.openPaths.length === 0)) return false

    if (state.folder) {
      // 恢复的路径可能已被移动/删除（或换机恢复）：先用真实列举验证再采纳。
      // 失效会话整体丢弃并提示一次——绝不带着死路径进入工作区，让后续每次
      // 交互都重复报同一个错。
      if (services.listDir) {
        try {
          await services.listDir(state.folder)
        } catch {
          services.reportError(t("error.workspaceFolderMissing"))
          return false
        }
      }
      host.commitWorkspace(openFolder(host.getWorkspace(), state.folder))
      void services.allowWorkspaceDir?.(state.folder)
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
        host.markSessionRestored()
        return true
      }
    }
  } catch {
    /* tolerate session restore failure */
  }
  return false
}

export async function restoreDraft(host: AppSessionInitHost): Promise<void> {
  const { services } = host
  const records = await services.listRecoveries?.() ?? []
  const first = records[0]
  if (!first || !services.readRecovery) return
  if (!services.confirmRestore?.(first.label)) {
    await services.clearRecovery?.(first.key)
    return
  }
  const contents = await services.readRecovery(first.key)
  if (!host.isMounted()) return
  host.resetTabDocument(advanceDocumentIdentity(host.getActiveSession()), contents)
}
