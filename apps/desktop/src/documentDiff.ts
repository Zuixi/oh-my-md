const DIFF_CONTEXT_LINES = 3
const MAX_DIFF_MATRIX_LINES = 2000

export type DiffLineKind = "context" | "added" | "removed"

export interface DiffLine {
  readonly kind: DiffLineKind
  readonly text: string
  readonly localLine: number | null
  readonly diskLine: number | null
}

export interface DiffHunk {
  readonly localStart: number
  readonly diskStart: number
  readonly lines: readonly DiffLine[]
}

function splitDocumentLines(text: string): readonly string[] {
  if (text.length === 0) {
    return []
  }
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text
  if (withoutTrailingNewline.length === 0) {
    return []
  }
  return withoutTrailingNewline.split("\n")
}

function contextLine(
  text: string,
  localLine: number,
  diskLine: number,
): DiffLine {
  return { kind: "context", text, localLine, diskLine }
}

function removedLine(text: string, diskLine: number): DiffLine {
  return { kind: "removed", text, localLine: null, diskLine }
}

function addedLine(text: string, localLine: number): DiffLine {
  return { kind: "added", text, localLine, diskLine: null }
}

function buildReplacementHunk(
  localLines: readonly string[],
  diskLines: readonly string[],
): DiffHunk {
  const lines: DiffLine[] = []
  for (let index = 0; index < diskLines.length; index += 1) {
    lines.push(removedLine(diskLines[index], index + 1))
  }
  for (let index = 0; index < localLines.length; index += 1) {
    lines.push(addedLine(localLines[index], index + 1))
  }
  return {
    localStart: localLines.length > 0 ? 1 : 1,
    diskStart: diskLines.length > 0 ? 1 : 1,
    lines,
  }
}

function buildLcsTable(
  localLines: readonly string[],
  diskLines: readonly string[],
): readonly (readonly number[])[] {
  const rowCount = localLines.length + 1
  const columnCount = diskLines.length + 1
  const table = Array.from({ length: rowCount }, () =>
    Array<number>(columnCount).fill(0),
  )

  for (let localIndex = localLines.length - 1; localIndex >= 0; localIndex -= 1) {
    for (let diskIndex = diskLines.length - 1; diskIndex >= 0; diskIndex -= 1) {
      if (localLines[localIndex] === diskLines[diskIndex]) {
        table[localIndex][diskIndex] =
          table[localIndex + 1][diskIndex + 1] + 1
      } else {
        table[localIndex][diskIndex] = Math.max(
          table[localIndex + 1][diskIndex],
          table[localIndex][diskIndex + 1],
        )
      }
    }
  }

  return table
}

function diffMiddleLines(
  localLines: readonly string[],
  diskLines: readonly string[],
  localOffset: number,
  diskOffset: number,
): readonly DiffLine[] {
  const table = buildLcsTable(localLines, diskLines)
  const lines: DiffLine[] = []
  let localIndex = 0
  let diskIndex = 0

  while (localIndex < localLines.length || diskIndex < diskLines.length) {
    if (
      localIndex < localLines.length &&
      diskIndex < diskLines.length &&
      localLines[localIndex] === diskLines[diskIndex]
    ) {
      lines.push(
        contextLine(
          localLines[localIndex],
          localOffset + localIndex + 1,
          diskOffset + diskIndex + 1,
        ),
      )
      localIndex += 1
      diskIndex += 1
      continue
    }

    if (
      diskIndex < diskLines.length &&
      (localIndex === localLines.length ||
        table[localIndex][diskIndex + 1] >= table[localIndex + 1][diskIndex])
    ) {
      lines.push(
        removedLine(diskLines[diskIndex], diskOffset + diskIndex + 1),
      )
      diskIndex += 1
      continue
    }

    lines.push(addedLine(localLines[localIndex], localOffset + localIndex + 1))
    localIndex += 1
  }

  return lines
}

function stripMatchingAffixes(
  localLines: readonly string[],
  diskLines: readonly string[],
): {
  readonly prefixLines: readonly DiffLine[]
  readonly localMiddle: readonly string[]
  readonly diskMiddle: readonly string[]
  readonly suffixLines: readonly DiffLine[]
  readonly localPrefixLength: number
  readonly diskPrefixLength: number
} {
  let localStart = 0
  let diskStart = 0
  while (
    localStart < localLines.length &&
    diskStart < diskLines.length &&
    localLines[localStart] === diskLines[diskStart]
  ) {
    localStart += 1
    diskStart += 1
  }

  let localEnd = localLines.length
  let diskEnd = diskLines.length
  while (
    localEnd > localStart &&
    diskEnd > diskStart &&
    localLines[localEnd - 1] === diskLines[diskEnd - 1]
  ) {
    localEnd -= 1
    diskEnd -= 1
  }

  const prefixLines = localLines.slice(0, localStart).map((text, index) =>
    contextLine(text, index + 1, index + 1),
  )
  const suffixLines = localLines.slice(localEnd).map((text, index) =>
    contextLine(
      text,
      localEnd + index + 1,
      diskEnd + index + 1,
    ),
  )

  return {
    prefixLines,
    localMiddle: localLines.slice(localStart, localEnd),
    diskMiddle: diskLines.slice(diskStart, diskEnd),
    suffixLines,
    localPrefixLength: localStart,
    diskPrefixLength: diskStart,
  }
}

function hunkStartLine(
  lines: readonly DiffLine[],
  side: "localLine" | "diskLine",
): number {
  return lines.find(line => line[side] !== null)?.[side] ?? 1
}

function groupIntoHunks(lines: readonly DiffLine[]): readonly DiffHunk[] {
  const changedIndices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].kind !== "context") {
      changedIndices.push(index)
    }
  }

  if (changedIndices.length === 0) {
    return []
  }

  const ranges: Array<{ start: number; end: number }> = changedIndices.map(
    index => ({
      start: Math.max(0, index - DIFF_CONTEXT_LINES),
      end: Math.min(lines.length - 1, index + DIFF_CONTEXT_LINES),
    }),
  )

  ranges.sort((left, right) => left.start - right.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end)
      continue
    }
    merged.push({ ...range })
  }

  return merged.map(range => {
    const hunkLines = lines.slice(range.start, range.end + 1)
    return {
      localStart: hunkStartLine(hunkLines, "localLine"),
      diskStart: hunkStartLine(hunkLines, "diskLine"),
      lines: hunkLines,
    }
  })
}

export function unifiedDiff(local: string, disk: string): readonly DiffHunk[] {
  if (local === disk) {
    return []
  }

  const localLines = splitDocumentLines(local)
  const diskLines = splitDocumentLines(disk)
  const {
    prefixLines,
    localMiddle,
    diskMiddle,
    suffixLines,
    localPrefixLength,
    diskPrefixLength,
  } = stripMatchingAffixes(localLines, diskLines)

  if (
    localMiddle.length > MAX_DIFF_MATRIX_LINES ||
    diskMiddle.length > MAX_DIFF_MATRIX_LINES
  ) {
    return [buildReplacementHunk(localLines, diskLines)]
  }

  const middleLines = diffMiddleLines(
    localMiddle,
    diskMiddle,
    localPrefixLength,
    diskPrefixLength,
  )
  return groupIntoHunks([...prefixLines, ...middleLines, ...suffixLines])
}
