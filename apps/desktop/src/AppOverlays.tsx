import { AboutDialog } from "./AboutDialog"
import { CommandPalette } from "./CommandPalette"
import type { AppCommand } from "./commands"
import type { DesktopServices } from "./desktopServices"
import type { DocumentOpen, QuickOpenState } from "./documentOpen"
import type { LogStateView } from "./logging"
import { OpeningOverlay } from "./OpeningOverlay"
import { QuickOpenModal } from "./QuickOpenModal"
import { SettingsModal } from "./SettingsModal"
import type { UserSettings } from "./settings"
import type { SnapshotHistory } from "./useSnapshotHistory"
import { VersionHistoryModal } from "./VersionHistoryModal"

/**
 * Modal layer: the opening overlay, command palette, quick open, version
 * history, settings, and about. Kept in one place so `App` describes state
 * transitions rather than dialog markup.
 */
export function AppOverlays(props: {
  readonly services: DesktopServices
  readonly openCoordinator: DocumentOpen
  readonly openingLabel: string | null
  readonly openingProgress: { bytesRead: number; byteLength: number } | null
  readonly paletteOpen: boolean
  readonly commands: AppCommand[]
  readonly onClosePalette: () => void
  readonly quickOpen: QuickOpenState
  readonly folder: string | null
  readonly onChooseRecent: (path: string) => void
  readonly history: SnapshotHistory
  readonly settingsOpen: boolean
  readonly settings: UserSettings
  readonly logState: LogStateView | null
  readonly onSaveSettings: (next: UserSettings) => void
  readonly onCloseSettings: () => void
  readonly onRestartForLogging: () => void
  readonly aboutOpen: boolean
  readonly onCloseAbout: () => void
}) {
  const { history } = props
  return (
    <>
      {props.openingLabel !== null ? (
        <OpeningOverlay
          label={props.openingLabel}
          progress={props.openingProgress}
          onCancel={props.openCoordinator.cancelOpening}
        />
      ) : null}
      {props.paletteOpen ? (
        <CommandPalette commands={props.commands} onClose={props.onClosePalette} />
      ) : null}
      {props.quickOpen.open ? (
        <QuickOpenModal
          files={props.quickOpen.files}
          folder={props.folder}
          truncated={props.quickOpen.truncated}
          loading={props.quickOpen.loading}
          onChoose={props.onChooseRecent}
          onClose={props.openCoordinator.closeQuickOpen}
        />
      ) : null}
      {history.state.open ? (
        <VersionHistoryModal
          path={history.state.path}
          entries={history.state.entries}
          loading={history.state.loading}
          onRestore={history.restoreCopy}
          onRestoreInPlace={history.restoreInPlace}
          onClear={history.clear}
          onClose={history.close}
        />
      ) : null}
      <SettingsModal
        isOpen={props.settingsOpen}
        settings={props.settings}
        onSave={props.onSaveSettings}
        onClose={props.onCloseSettings}
        listSystemFonts={props.services.listSystemFonts}
        logState={props.logState}
        openUrl={url => { void props.services.openExternal?.(url) }}
        onRestartToApplyLogging={props.onRestartForLogging}
      />
      <AboutDialog
        isOpen={props.aboutOpen}
        services={props.services}
        onClose={props.onCloseAbout}
      />
    </>
  )
}
