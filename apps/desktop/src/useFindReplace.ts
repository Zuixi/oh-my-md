import { useRef, useState, type RefObject } from "react"
import type { EditorView } from "@codemirror/view"
import type { Text } from "@codemirror/state"
import {
  buildReplaceAll,
  findNextMatch,
  findPreviousMatch,
  replaceCurrentSpec,
  type SearchMatch,
  type SearchRequest,
} from "./currentDocumentSearch"
import {
  collectMatches,
  nextIndex,
  prevIndex,
  replaceAll,
  type FindQuery,
} from "./findReplace"

/**
 * App 侧状态注入：查找替换从不按值捕获编辑器/文档，一律经 getter 读当前 ref，
 * 这样 hook 内的函数与 ref 镜像（goFindRef/closeFindRef）在最新渲染下始终一致。
 */
export interface FindReplaceHost {
  /** 当前活动 editor view；宿主尚未挂载时为 null。 */
  getView(): EditorView | null
  /** App 物化的文档文本 —— mock view 读 doc 抛错时的兜底来源。 */
  getDoc(): string
  /** Spec 05 渲染档位门控（App 的 documentScaleRegistry 评估结果）。 */
  isActiveSafeMode(): boolean
}

export interface FindReplaceHandle {
  readonly open: boolean
  readonly query: string
  readonly replacement: string
  readonly caseSensitive: boolean
  readonly regexMode: boolean
  readonly wholeWord: boolean
  readonly replaceOpen: boolean
  readonly index: number
  /** 最新回调 ref：App 的全局 keydown effect（空依赖）经此读当前闭包。 */
  readonly openRef: RefObject<boolean>
  readonly goRef: RefObject<(direction: "next" | "prev") => void>
  readonly closeRef: RefObject<() => void>
  setOpen(open: boolean): void
  setReplaceOpen(open: boolean): void
  close(): void
  go(direction: "next" | "prev"): void
  replaceCurrent(): void
  replaceEvery(): void
  onQuery(query: string): void
  onReplacement(value: string): void
  onCaseSensitive(value: boolean): void
  onRegex(value: boolean): void
  onWholeWord(value: boolean): void
}

/**
 * 查找/替换的单一持有者：8 个 state、镜像 ref、安全模式全文搜索走
 * currentDocumentSearch，常规路径走 findReplace 的字符串扫描。
 */
export function useFindReplace(options: FindReplaceHost): FindReplaceHandle {
  const { getView, getDoc, isActiveSafeMode } = options
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState("")
  const [findReplace, setFindReplace] = useState("")
  const [findCase, setFindCase] = useState(false)
  const [findRegexMode, setFindRegexMode] = useState(false)
  const [findWholeWord, setFindWholeWord] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [findIndex, setFindIndex] = useState(-1)
  const findOpenRef = useRef(false)
  findOpenRef.current = findOpen
  const findQueryRef = useRef(findQuery)
  findQueryRef.current = findQuery
  const findReplaceRef = useRef(findReplace)
  findReplaceRef.current = findReplace
  const findCaseRef = useRef(findCase)
  findCaseRef.current = findCase
  const findRegexModeRef = useRef(findRegexMode)
  findRegexModeRef.current = findRegexMode
  const findWholeWordRef = useRef(findWholeWord)
  findWholeWordRef.current = findWholeWord
  const findIndexRef = useRef(findIndex)
  findIndexRef.current = findIndex
  const activeFindMatchRef = useRef<SearchMatch | null>(null)
  const findRevisionRef = useRef(0)

  function closeFind() {
    setFindOpen(false)
    setReplaceOpen(false)
    try { getView()?.focus() } catch { /* mock views */ }
  }

  function currentFindQuery(): FindQuery {
    return {
      query: findQueryRef.current,
      caseSensitive: findCaseRef.current,
      regex: findRegexModeRef.current,
      wholeWord: findWholeWordRef.current,
    }
  }

  function currentSearchRequest(revision = findRevisionRef.current): SearchRequest {
    return {
      query: findQueryRef.current,
      caseSensitive: findCaseRef.current,
      regexp: findRegexModeRef.current,
      wholeWord: findWholeWordRef.current,
      revision,
    }
  }

  function realTextDoc(view: EditorView | null): Text | null {
    if (!view) return null
    try {
      const candidate = view.state.doc
      return typeof candidate.sliceString === "function" ? candidate : null
    } catch {
      return null
    }
  }

  function goFind(direction: "next" | "prev") {
    const view = getView()
    const query = findQueryRef.current
    if (!view || query === "") return
    const textDoc = realTextDoc(view)
    if (textDoc && isActiveSafeMode()) {
      const request = currentSearchRequest()
      const current = activeFindMatchRef.current
      const sel = view.state.selection.main
      const match = direction === "next"
        ? findNextMatch(
            textDoc,
            request,
            current && current.revision === request.revision ? current.to : sel.to,
          )
        : findPreviousMatch(
            textDoc,
            request,
            current && current.revision === request.revision ? current.from : sel.from,
          )
      activeFindMatchRef.current = match
      if (!match) {
        setFindIndex(-1)
        return
      }
      try {
        view.dispatch({
          selection: { anchor: match.from, head: match.to },
          scrollIntoView: true,
        })
      } catch { /* mock views */ }
      return
    }
    let doc: string
    try { doc = view.state.doc.toString() } catch { doc = getDoc() }
    const matches = collectMatches(doc, currentFindQuery())
    if (matches.length === 0) {
      activeFindMatchRef.current = null
      setFindIndex(-1)
      return
    }
    const index = direction === "next"
      ? nextIndex(matches.length, findIndexRef.current)
      : prevIndex(matches.length, findIndexRef.current)
    const match = matches[index]
    activeFindMatchRef.current = {
      from: match.from,
      to: match.to,
      revision: findRevisionRef.current,
    }
    try {
      view.dispatch({
        selection: { anchor: match.from, head: match.to },
        scrollIntoView: true,
      })
    } catch { /* mock views */ }
    setFindIndex(index)
  }

  function replaceCurrent() {
    const view = getView()
    const query = findQueryRef.current
    if (!view || query === "") return
    const textDoc = realTextDoc(view)
    if (textDoc && isActiveSafeMode()) {
      const request = currentSearchRequest()
      const spec = replaceCurrentSpec(
        view.state,
        request,
        activeFindMatchRef.current,
        findReplaceRef.current,
      )
      if (!spec) return
      findRevisionRef.current += 1
      activeFindMatchRef.current = null
      try { view.dispatch(spec) } catch { /* mock views */ }
      return
    }
    let doc: string
    try { doc = view.state.doc.toString() } catch { doc = getDoc() }
    const matches = collectMatches(doc, currentFindQuery())
    if (matches.length === 0) return

    const index = findIndexRef.current >= 0 && findIndexRef.current < matches.length
      ? findIndexRef.current
      : 0
    const match = matches[index]
    const replacement = findReplaceRef.current
    findRevisionRef.current += 1
    activeFindMatchRef.current = null
    try {
      view.dispatch({
        changes: { from: match.from, to: match.to, insert: replacement },
        selection: { anchor: match.from, head: match.from + replacement.length },
        scrollIntoView: true,
      })
    } catch { /* mock views */ }
  }

  function replaceEvery() {
    const view = getView()
    const query = findQueryRef.current
    if (!view || query === "") return
    const textDoc = realTextDoc(view)
    if (textDoc && isActiveSafeMode()) {
      const result = buildReplaceAll(textDoc, currentSearchRequest(), findReplaceRef.current)
      if (!result) return
      findRevisionRef.current += 1
      activeFindMatchRef.current = null
      try { view.dispatch({ changes: result.changes }) } catch { /* mock views */ }
      return
    }
    let doc: string
    try { doc = view.state.doc.toString() } catch { doc = getDoc() }
    const next = replaceAll(doc, currentFindQuery(), findReplaceRef.current)
    if (next === doc) return
    findRevisionRef.current += 1
    activeFindMatchRef.current = null
    try {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: next } })
    } catch { /* mock views */ }
  }

  const goFindRef = useRef(goFind)
  const closeFindRef = useRef(closeFind)
  goFindRef.current = goFind
  closeFindRef.current = closeFind

  return {
    open: findOpen,
    query: findQuery,
    replacement: findReplace,
    caseSensitive: findCase,
    regexMode: findRegexMode,
    wholeWord: findWholeWord,
    replaceOpen,
    index: findIndex,
    openRef: findOpenRef,
    goRef: goFindRef,
    closeRef: closeFindRef,
    setOpen: setFindOpen,
    setReplaceOpen,
    close: closeFind,
    go: goFind,
    replaceCurrent,
    replaceEvery,
    onQuery: query => {
      findRevisionRef.current += 1
      activeFindMatchRef.current = null
      setFindQuery(query)
      setFindIndex(-1)
    },
    onReplacement: setFindReplace,
    onCaseSensitive: value => {
      findRevisionRef.current += 1
      activeFindMatchRef.current = null
      setFindCase(value)
      setFindIndex(-1)
    },
    onRegex: value => {
      findRevisionRef.current += 1
      activeFindMatchRef.current = null
      setFindRegexMode(value)
      setFindIndex(-1)
    },
    onWholeWord: value => {
      findRevisionRef.current += 1
      activeFindMatchRef.current = null
      setFindWholeWord(value)
      setFindIndex(-1)
    },
  }
}
