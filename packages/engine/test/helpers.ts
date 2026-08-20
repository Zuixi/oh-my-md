import { EditorState, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { forceParsing, syntaxTree } from "@codemirror/language"
import { markdownLanguageSupport } from "../src/parse/markdown"
import { drainPendingLiveBuild, livePreviewField } from "../src/decorations/build"

// ensureSyntaxTree alone does not finish parsing large documents without an
// EditorView: @codemirror/language's ParseWorker only schedules background work
// via requestIdle/setTimeout when a view is attached, so a detached state's
// tree stops at the synchronous initial parse (~3k chars). Under CPU load even
// that varies, which made tree-dependent tests flaky. When the initial parse
// is incomplete, mount a temporary view and forceParsing to completion — the
// advanced tree lives on view.state, which survives view.destroy().
//
// 渐进装饰（pending 模型）：livePreviewField.create 只构建光标附近种子，
// 大文档剩余区间记入 pending。挂临时视图同步排空（drainPendingLiveBuild 只
// dispatch liveBuildChunk，不推进解析 —— 解析仍由上面的 forceParsing 负责），
// 测试拿到的仍是“全量装饰”状态；无 live 扩展的用例零影响。
export function makeState(doc: string, extra: Extension[] = []) {
  const state = EditorState.create({ doc, extensions: [markdownLanguageSupport(), ...extra] })
  const treeComplete = syntaxTree(state).length >= state.doc.length
  const live = state.field(livePreviewField, false)
  if (treeComplete && (!live || live.pending.length === 0)) return state
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({ state, parent })
  if (!treeComplete) forceParsing(view, state.doc.length, 10000)
  if (view.state.field(livePreviewField, false)) drainPendingLiveBuild(view)
  const complete = view.state
  view.destroy()
  parent.remove()
  return complete
}
