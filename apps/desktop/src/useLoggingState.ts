/**
 * React binding for the resolved logging destination.
 *
 * Separate from `logging.ts` on purpose: that module is pure policy (flush
 * timing, startup-failure records) and is imported by the IPC layer, while this
 * one owns a hook and therefore React. Mixing the two forced every non-React
 * consumer to pull React into its module graph.
 */
import { useEffect, useState } from "react"
import type { DesktopServices } from "./desktopServices"
import { getGlobalLogger } from "./logger"
import type { LogStateView } from "./logging"

/** The resolved destination is fixed for this process. Ignore stale answers
 * after unmount; a failed query must not present a made-up log folder. */
export function useLoggingState(
  services: Pick<DesktopServices, "getLogState">,
  ready: boolean,
): LogStateView | null {
  const [state, setState] = useState<LogStateView | null>(null)
  useEffect(() => {
    if (!ready) return
    let active = true
    void services.getLogState?.()
      .then(next => { if (active) setState(next) })
      .catch(() => { getGlobalLogger().warn("logging", "log state unavailable") })
    return () => { active = false }
  }, [services, ready])
  return state
}
