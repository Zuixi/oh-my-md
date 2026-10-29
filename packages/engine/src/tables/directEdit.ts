import { invertedEffects, isolateHistory } from "@codemirror/commands"
import {
  Annotation,
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state"
import { replaceTableCell } from "./edit"
import type { TableCellData } from "./model"
import { normalizeTableForFirstEdit } from "./normalize"
import { tableAt, type TableContext } from "./navigate"

export interface TableEditTarget {
  readonly tableFrom: number
  readonly tableTo: number
  readonly row: number
  readonly column: number
  readonly source: string
}

export interface TableEditSession {
  readonly target: TableEditTarget
  readonly revision: number
  readonly composing: boolean
  readonly hasCommittedInput: boolean
  /** The next table input opens a new outer history group. */
  readonly isolateNext: boolean
}

export const suppressOrderedRenumberForTableEdit = Annotation.define<boolean>()

const beginEdit = StateEffect.define<TableEditTarget>()
const setComposition = StateEffect.define<boolean>()
const closeEdit = StateEffect.define<null>()
const commitInput = StateEffect.define<null>()

/**
 * History effect: the session snapshot an undo/redo of one table input replays.
 * Its positions belong to the document the snapshot was taken in, so it maps
 * like any other positional effect and survives unrelated document changes.
 */
const restoreSession = StateEffect.define<TableEditSession>({
  map: (session, changes) => ({ ...session, target: mapSnapshotTarget(session.target, changes) }),
})

const MAP_TABLE_START_ASSOC = -1
const MAP_TABLE_END_ASSOC = 1

function mapTarget(target: TableEditTarget, changes: ChangeDesc): TableEditTarget {
  return {
    ...target,
    tableFrom: changes.mapPos(target.tableFrom, MAP_TABLE_START_ASSOC),
    tableTo: changes.mapPos(target.tableTo, MAP_TABLE_END_ASSOC),
  }
}

function mapSnapshotTarget(target: TableEditTarget, changes: ChangeDesc): TableEditTarget {
  // Changes strictly before the table shift both endpoints by the same delta.
  // Changes overlapping the table (e.g. an undo/redo of a cell edit inside the
  // table) keep `tableFrom` at the table start (`assoc = 1`) and map `tableTo`
  // to the new table end (`assoc = 1`).
  let touchesTable = false
  changes.iterChangedRanges((fromA, toA) => {
    if (toA > target.tableFrom && fromA < target.tableTo) touchesTable = true
  })
  return {
    ...target,
    tableFrom: changes.mapPos(target.tableFrom, touchesTable ? 1 : MAP_TABLE_START_ASSOC),
    tableTo: changes.mapPos(target.tableTo, MAP_TABLE_END_ASSOC),
  }
}

function cellIn(table: TableContext, row: number, column: number): TableCellData | null {
  const cells = row === 0 ? table.data.header.cells : table.data.rows[row - 1]?.cells
  if (!cells || column < 0 || column >= table.data.header.cells.length) return null
  return cells[column] ?? null
}

function mapSession(session: TableEditSession, tr: Transaction): TableEditSession | null {
  if (!tr.docChanged) return session
  const { target } = session
  const { tableFrom, tableTo } = mapTarget(target, tr.changes)
  const table = tableAt(tr.state, tableFrom)
  if (!table || table.from !== tableFrom || table.to !== tableTo) return null
  if (!cellIn(table, target.row, target.column)) return null
  const committed = tr.effects.some((effect) => effect.is(commitInput))
  if (!committed && table.source !== target.source) return null
  return {
    ...session,
    target: { ...target, tableFrom, tableTo, source: table.source },
  }
}

/** A selection-only transaction that lands on the table unmounts its widget. */
function selectionTouchesTable(tr: Transaction, target: TableEditTarget): boolean {
  return tr.state.selection.ranges.some(
    range => range.from <= target.tableTo && range.to >= target.tableFrom,
  )
}

/**
 * Beginning a cell in the table that is already open retargets the session: the
 * table already committed its first (whole-table) input, so the next cell must
 * keep range-based editing instead of normalizing the table again.
 */
function beginSession(session: TableEditSession | null, target: TableEditTarget): TableEditSession {
  const sameTable = session !== null
    && session.target.tableFrom === target.tableFrom
    && session.target.tableTo === target.tableTo
  return {
    target,
    revision: sameTable ? session.revision : 0,
    composing: false,
    hasCommittedInput: sameTable ? session.hasCommittedInput : false,
    isolateNext: true,
  }
}

/** Drops a replayed snapshot whose table no longer matches the live document. */
function restoredSession(state: EditorState, session: TableEditSession): TableEditSession | null {
  const { target } = session
  const table = tableAt(state, target.tableFrom)
  if (!table || table.from !== target.tableFrom || table.to !== target.tableTo) return null
  if (table.source !== target.source) return null
  return cellIn(table, target.row, target.column) ? session : null
}

function updateSession(
  session: TableEditSession | null,
  tr: Transaction,
): TableEditSession | null {
  let next = session ? mapSession(session, tr) : null
  if (session && !tr.docChanged && tr.selection && selectionTouchesTable(tr, session.target)) {
    next = null
  }
  let restored: TableEditSession | null = null
  for (const effect of tr.effects) {
    if (effect.is(restoreSession)) {
      restored = effect.value
    } else if (effect.is(beginEdit)) {
      next = beginSession(next, effect.value)
    } else if (!next) {
      continue
    } else if (effect.is(setComposition)) {
      next = { ...next, composing: effect.value }
    } else if (effect.is(closeEdit)) {
      next = null
    } else if (effect.is(commitInput)) {
      next = {
        ...next,
        hasCommittedInput: true,
        revision: next.revision + 1,
        isolateNext: false,
      }
    }
  }
  // A replayed snapshot only counts while a session was live when the history
  // event was built: undoing a table edit after the user closed the session
  // must not resurrect the input.
  if (restored) {
    const valid = session ? restoredSession(tr.state, restored) : null
    next = valid
      ? { ...valid, revision: (session?.revision ?? 0) + 1 }
      : null
  }
  return next
}

const tableEditSession = StateField.define<TableEditSession | null>({
  create: () => null,
  update: updateSession,
})

/** True for the history effect that replays a table session snapshot. */
export function isTableSessionRestore(
  effect: StateEffect<unknown>,
): effect is StateEffect<TableEditSession> {
  return effect.is(restoreSession)
}

/**
 * Undoing one table input must restore the session it started from and redoing
 * must restore the session it produced. Both are the interrupting transaction's
 * start state, with the active cell pinned to the replayed edit's cell when a
 * later cell switch intervened; the replayed effect is also how `orderedRenumber`
 * recognizes an undo/redo of a table edit.
 */
const tableSessionHistory = invertedEffects.of(tr => {
  const session = tr.startState.field(tableEditSession, false) ?? null
  if (!session) return []
  const replayed = tr.effects.find(isTableSessionRestore)
  if (!replayed && tr.annotation(suppressOrderedRenumberForTableEdit) !== true) return []
  if (!replayed) return [restoreSession.of(session)]
  const targetFrom = replayed.value.target.tableFrom
  const table = tableAt(tr.startState, targetFrom)
  const target = table && table.from === targetFrom
    ? {
        tableFrom: table.from,
        tableTo: table.to,
        row: replayed.value.target.row,
        column: replayed.value.target.column,
        source: table.source,
      }
    : {
        ...session.target,
        row: replayed.value.target.row,
        column: replayed.value.target.column,
      }
  return [restoreSession.of({
    ...session,
    hasCommittedInput: replayed.value.hasCommittedInput,
    target,
  })]
})

export const experimentalTableDirectEdit: Extension = [tableEditSession, tableSessionHistory]

export function getTableEditSession(state: EditorState): TableEditSession | null {
  return state.field(tableEditSession, false) ?? null
}

export function beginTableEdit(target: TableEditTarget): StateEffect<TableEditTarget> {
  return beginEdit.of(target)
}

export function setTableComposition(composing: boolean): StateEffect<boolean> {
  return setComposition.of(composing)
}

export function closeTableEdit(): StateEffect<null> {
  return closeEdit.of(null)
}

export function tableCellInputSpec(
  state: EditorState,
  value: string,
  kind: "typing" | "composition",
): TransactionSpec | null {
  const session = getTableEditSession(state)
  if (!session) return null
  const { target } = session
  const table = tableAt(state, target.tableFrom)
  if (!table || table.from !== target.tableFrom || table.to !== target.tableTo) return null
  if (table.source !== target.source) return null
  const cell = cellIn(table, target.row, target.column)
  if (!cell) return null

  const annotations = [
    Transaction.userEvent.of(kind === "composition" ? "input.type.compose" : "input.type"),
    suppressOrderedRenumberForTableEdit.of(true),
  ]
  const isolated = session.isolateNext
    ? [...annotations, isolateHistory.of("before")]
    : annotations
  const effects = commitInput.of(null)

  if (!session.hasCommittedInput) {
    const normalized = normalizeTableForFirstEdit(
      table.source,
      table.data,
      target.row,
      target.column,
      value,
    )
    if (!normalized) return null
    return {
      changes: { from: table.from, to: table.to, insert: normalized.source },
      annotations: isolated,
      effects,
    }
  }

  const change = replaceTableCell(table.source, cell, value)
  if (!change) return null
  return {
    changes: {
      from: table.from + change.from,
      to: table.from + change.to,
      insert: change.insert,
    },
    annotations: isolated,
    effects,
  }
}
