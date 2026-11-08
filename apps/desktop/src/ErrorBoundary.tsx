import React from "react"
import { describeThrown, reportFatal } from "./globalErrorHandlers"
import { t } from "./i18n"
import type { Logger } from "./logger"

export interface ErrorBoundaryProps {
  children: React.ReactNode
  logger: Logger
  onExportDiagnostics?: () => void
}

interface ErrorBoundaryState {
  failed: boolean
}

/**
 * Last-resort safety net for render-phase failures.
 *
 * It logs the error with its component stack, dispatches it immediately (see
 * `globalErrorHandlers`), and only then replaces the shell with a recovery
 * surface. It intentionally holds no document state: the last-known-good
 * document stays wherever it already is (on disk, or in the recovery drafts),
 * so this never overwrites it with something derived from the failed render.
 * Reload is the user's explicit, lossy escape hatch — unsaved in-memory edits
 * do not survive it.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // `error` is typed `Error`, but a component may throw any value at runtime;
    // `describeThrown` handles both without throwing.
    reportFatal(
      this.props.logger,
      "render",
      `react error boundary: ${describeThrown(error)}\n${info.componentStack ?? ""}`.trim(),
    )
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      // A class component cannot use the `useT()` hook, so this reads the
      // module-level `t`. Every user-visible string in this surface — the one
      // users see when the app is already broken — must be localized: a crash
      // that flips the UI back to English is exactly the wrong impression.
      <div role="alert" className="omd-error-boundary">
        <p>{t("error.boundary.title")}</p>
        <div className="omd-error-boundary-actions">
          <button type="button" onClick={this.handleExportDiagnostics}>
            {t("error.boundary.export")}
          </button>
          <button type="button" onClick={this.handleReload}>
            {t("error.boundary.reload")}
          </button>
        </div>
      </div>
    )
  }

  private handleExportDiagnostics = (): void => {
    try {
      this.props.onExportDiagnostics?.()
    } catch {
      // Export is best-effort; a throwing callback must not escape the handler.
    }
  }

  private handleReload = (): void => {
    try {
      window.location.reload()
    } catch {
      // Nothing left to try; the recovery surface stays up.
    }
  }
}
