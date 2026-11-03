import React from "react";
import ReactDOM from "react-dom/client";
import { ToastContainer } from "react-toastify";
// Import order matters: the toast stylesheet comes first so styles.css
// `.Toastify` overrides can win ties at equal specificity.
import "react-toastify/dist/ReactToastify.css";
import App from "./App";
import { defaultServices } from "./desktopServices";
import { ErrorBoundary } from "./ErrorBoundary";
import { exportDiagnostics } from "./appDiagnosticsActions";
import { installGlobalErrorHandlers } from "./globalErrorHandlers";
import { createLogger, setGlobalLogger } from "./logger";

// Boot order is deliberate (Task 7) and must stay this way.
//
// `getGlobalLogger()` falls back to a logger whose transport throws records
// away, so the real logger has to be installed before anything can log. The
// imported modules above do not log while they evaluate; every call below is a
// top-level statement, so it runs before React mounts and before any handler
// or render can fail.
const logger = createLogger({
  now: () => Date.now(),
  send: async (records) => {
    // Rejects by design when IPC is unavailable: the facade swallows the
    // failed batch and counts it as drops rather than surfacing it.
    await defaultServices.logRecords?.(records);
  },
});
setGlobalLogger(logger);
// A packaged build has no devtools, so uncaught errors and rejections have no
// other channel; install the last-chance handlers before the first render.
installGlobalErrorHandlers(logger);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary
      logger={logger}
      onExportDiagnostics={() => {
        // Same path as the palette command: flush, export, and report a failure
        // through the toast layer (a sibling of this boundary, so it still
        // renders when the shell is gone).
        void exportDiagnostics(defaultServices)
      }}
    >
      <App />
    </ErrorBoundary>
    {/* Production-only mount: tests render <App /> without toasts (spec 2026-08-20). */}
    <ToastContainer
      position="bottom-right"
      newestOnTop
      limit={3}
      pauseOnHover
      closeButton
      draggable={false}
    />
  </React.StrictMode>,
);
