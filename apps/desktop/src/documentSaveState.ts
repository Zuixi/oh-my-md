export interface DocumentVersion {
  readonly resolvedPath: string
  readonly fingerprint: string
}

export interface ExistingDiskSnapshot {
  readonly requestedPath: string
  readonly contents: string
  readonly version: DocumentVersion
}

export type SaveLifecycle =
  | { readonly kind: "idle" }
  | {
      readonly kind: "saving"
      readonly operationId: number
      readonly snapshot: string
    }
  | { readonly kind: "saveFailed"; readonly message: string }

export type DiskDivergence =
  | { readonly kind: "none" }
  | {
      readonly kind: "externalChanged"
      readonly disk: ExistingDiskSnapshot
    }
  | {
      readonly kind: "contentConflict"
      readonly localSnapshot: string
      readonly disk: ExistingDiskSnapshot
    }
  | { readonly kind: "deletedExternally"; readonly localSnapshot: string }
  | {
      readonly kind: "createdAtMissingTarget"
      readonly localSnapshot: string
      readonly disk: ExistingDiskSnapshot
    }
  | { readonly kind: "pathChanged"; readonly localSnapshot: string }
  | { readonly kind: "unexpectedSymlinkAtTarget"; readonly localSnapshot: string }

export interface DocumentSaveState {
  readonly lifecycle: SaveLifecycle
  readonly divergence: DiskDivergence
  readonly ioGeneration: number
}

export type SaveStateByTab = Readonly<Record<number, DocumentSaveState | undefined>>

export function initialSaveState(): DocumentSaveState {
  return {
    lifecycle: { kind: "idle" },
    divergence: { kind: "none" },
    ioGeneration: 0,
  }
}

export function tabSaveState(states: SaveStateByTab, tabId: number): DocumentSaveState {
  return states[tabId] ?? initialSaveState()
}

export function updateTabSaveState(
  states: SaveStateByTab,
  tabId: number,
  state: DocumentSaveState,
): SaveStateByTab {
  return { ...states, [tabId]: state }
}

export function removeTabSaveState(states: SaveStateByTab, tabId: number): SaveStateByTab {
  if (!states[tabId]) return states
  const { [tabId]: removed, ...rest } = states
  return rest
}

export function beginSave(
  state: DocumentSaveState,
  operationId: number,
  snapshot: string,
): DocumentSaveState {
  return {
    ...state,
    lifecycle: { kind: "saving", operationId, snapshot },
    ioGeneration: state.ioGeneration + 1,
  }
}

export function completeSave(
  state: DocumentSaveState,
  operationId: number,
): DocumentSaveState {
  if (state.lifecycle.kind !== "saving" || state.lifecycle.operationId !== operationId) {
    return state
  }
  return {
    ...state,
    lifecycle: { kind: "idle" },
    ioGeneration: state.ioGeneration + 1,
  }
}

export function failSave(
  state: DocumentSaveState,
  operationId: number,
  message: string,
): DocumentSaveState {
  if (state.lifecycle.kind !== "saving" || state.lifecycle.operationId !== operationId) {
    return state
  }
  return {
    ...state,
    lifecycle: { kind: "saveFailed", message },
    ioGeneration: state.ioGeneration + 1,
  }
}

export function applyDivergence(
  state: DocumentSaveState,
  divergence: Exclude<DiskDivergence, { kind: "none" }>,
): DocumentSaveState {
  return {
    ...state,
    divergence,
    ioGeneration: state.ioGeneration + 1,
  }
}

export function clearDivergence(state: DocumentSaveState): DocumentSaveState {
  if (state.divergence.kind === "none") return state
  return { ...state, divergence: { kind: "none" } }
}

export function clearSaveFailed(state: DocumentSaveState): DocumentSaveState {
  if (state.lifecycle.kind !== "saveFailed") return state
  return { ...state, lifecycle: { kind: "idle" } }
}

export function isFreshObservation(state: DocumentSaveState, generation: number): boolean {
  return state.lifecycle.kind !== "saving" && state.ioGeneration === generation
}
