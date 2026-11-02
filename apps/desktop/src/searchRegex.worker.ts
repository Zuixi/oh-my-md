type RegexWorkerRequest = {
  readonly id: number
  readonly revision: number
  readonly source: string
  readonly flags: string
  readonly text: string
}

type RegexWorkerResponse =
  | { readonly id: number; readonly revision: number; readonly match: { readonly from: number; readonly to: number } | null }
  | { readonly id: number; readonly revision: number; readonly error: string }

type RegexWorkerScope = {
  onmessage: ((event: MessageEvent<RegexWorkerRequest>) => void) | null
  postMessage: (response: RegexWorkerResponse) => void
}

const scope = self as unknown as RegexWorkerScope

function firstNonEmptyMatch(expression: RegExp, text: string): { from: number; to: number } | null {
  let result = expression.exec(text)
  while (result !== null && result[0].length === 0) {
    expression.lastIndex++
    result = expression.exec(text)
  }
  return result === null ? null : { from: result.index, to: result.index + result[0].length }
}

scope.onmessage = event => {
  const { id, revision, source, flags, text } = event.data
  try {
    const expressionFlags = flags.includes("g") ? flags : `${flags}g`
    const match = firstNonEmptyMatch(new RegExp(source, expressionFlags), text)
    scope.postMessage({ id, revision, match })
  } catch (error) {
    scope.postMessage({ id, revision, error: error instanceof Error ? error.message : String(error) })
  }
}
