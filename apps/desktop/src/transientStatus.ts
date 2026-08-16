/** Shared transient-status timer for the save and normalization status lines. */
export const TRANSIENT_STATUS_MS = 4000

export function createTransientStatusNotifier(
  setMessage: (value: string | null) => void,
  timerRef: { readonly current: number | null },
  setTimer: (id: number | null) => void,
): (message: string) => void {
  return message => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    setMessage(message)
    setTimer(window.setTimeout(() => {
      setMessage(null)
      setTimer(null)
    }, TRANSIENT_STATUS_MS))
  }
}
