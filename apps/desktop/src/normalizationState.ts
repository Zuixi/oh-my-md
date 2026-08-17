import type { NormalizationId, OrderedListNormalizationNotice } from "@omd/engine"

export type NormalizationAction = "idle" | "saving" | "reverting"

export interface TabNormalizationState {
  readonly notice: OrderedListNormalizationNotice
  readonly action: NormalizationAction
}

/**
 * Transient per-tab projection of the engine's pending notice. The engine
 * StateField stays the single source of truth; this only drives React
 * rendering and scheduling, so it must never be spread or mutated directly.
 */
export type NormalizationByTab = Readonly<
  Record<number, TabNormalizationState | undefined>
>

function sameNotice(
  a: OrderedListNormalizationNotice,
  b: OrderedListNormalizationNotice,
): boolean {
  return a.id === b.id && a.markerCount === b.markerCount
}

export function projectNormalizationNotice(
  state: NormalizationByTab,
  tabId: number,
  notice: OrderedListNormalizationNotice | null,
): NormalizationByTab {
  if (!notice) return clearTabNormalization(state, tabId)
  const current = state[tabId]
  if (current && sameNotice(current.notice, notice)) return state
  return { ...state, [tabId]: { notice, action: current?.action ?? "idle" } }
}

export function setNormalizationAction(
  state: NormalizationByTab,
  tabId: number,
  expectedId: NormalizationId,
  action: Exclude<NormalizationAction, "idle">,
): NormalizationByTab {
  const current = state[tabId]
  if (!current || current.notice.id !== expectedId || current.action !== "idle") return state
  return { ...state, [tabId]: { notice: current.notice, action } }
}

export function resyncNormalizationIdle(
  state: NormalizationByTab,
  tabId: number,
  freshNotice: OrderedListNormalizationNotice | null,
): NormalizationByTab {
  if (!freshNotice) return clearTabNormalization(state, tabId)
  return { ...state, [tabId]: { notice: freshNotice, action: "idle" } }
}

export function clearTabNormalization(
  state: NormalizationByTab,
  tabId: number,
): NormalizationByTab {
  if (!state[tabId]) return state
  const { [tabId]: removed, ...rest } = state
  return rest
}
