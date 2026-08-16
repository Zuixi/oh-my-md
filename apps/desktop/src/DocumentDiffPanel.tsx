import { useT } from "./i18n"
import type { DiffHunk, DiffLine } from "./documentDiff"

export interface DocumentDiffPanelProps {
  readonly hunks: readonly DiffHunk[]
  readonly deleted: boolean
  readonly refreshed: boolean
  readonly onJump: (localLine: number) => void
  readonly onClose: () => void
}

function linePrefix(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "added":
      return "+"
    case "removed":
      return "-"
    case "context":
      return " "
  }
}

function formatLineNumber(line: DiffLine): string {
  const local = line.localLine ?? "-"
  const disk = line.diskLine ?? "-"
  return `${local}|${disk}`
}

function jumpLocalLine(hunk: DiffHunk): number {
  const changed = hunk.lines.find(line => line.localLine !== null && line.kind !== "context")
  return changed?.localLine ?? hunk.localStart
}

function DiffHunkView(props: {
  readonly hunk: DiffHunk
  readonly onJump: (localLine: number) => void
}) {
  const t = useT()
  const jumpLine = jumpLocalLine(props.hunk)

  return (
    <div className="document-diff-hunk">
      <div className="document-diff-hunk-header">
        <span>{`@@ local ${props.hunk.localStart}, disk ${props.hunk.diskStart} @@`}</span>
        <button
          type="button"
          className="document-diff-jump"
          onClick={() => props.onJump(jumpLine)}
        >
          {t("diff.goToLine", { line: jumpLine })}
        </button>
      </div>
      {props.hunk.lines.map((line, index) => (
        <div key={`${line.kind}-${index}-${line.text}`} className="document-diff-line">
          <span className="document-diff-line-numbers">{formatLineNumber(line)}</span>
          <span className="document-diff-line-prefix">{linePrefix(line.kind)}</span>
          <span className="document-diff-line-text">{line.text}</span>
        </div>
      ))}
    </div>
  )
}

export function DocumentDiffPanel(props: DocumentDiffPanelProps) {
  const t = useT()
  return (
    <section
      className="document-diff-panel"
      role="region"
      aria-label={t("diff.title")}
    >
      <div className="document-diff-panel-header">
        <span className="document-diff-panel-title">{t("diff.title")}</span>
        <button type="button" className="document-diff-close" onClick={props.onClose}>
          {t("button.close")}
        </button>
      </div>
      {props.deleted ? (
        <p className="document-diff-notice">{t("diff.deleted")}</p>
      ) : null}
      {props.refreshed ? (
        <p className="document-diff-notice document-diff-refreshed">{t("diff.refreshed")}</p>
      ) : null}
      <div className="document-diff-hunks">
        {props.hunks.map((hunk, index) => (
          <DiffHunkView key={`${hunk.localStart}-${hunk.diskStart}-${index}`} hunk={hunk} onJump={props.onJump} />
        ))}
      </div>
    </section>
  )
}