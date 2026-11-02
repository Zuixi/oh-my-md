/**
 * Smart Paste URL policy（plan 02 Task 2）。
 *
 * Link 与 Image href/src 的唯一 URL 闸门。允许的 `data:image/*` 提取在
 * normalizer 中先于本函数完成，因此到达这里的任何 `data:` 一律拒绝。
 *
 * 规则：
 * - 先解码一次 HTML entity（`&colon;`、`&#x61;` 之类），再去掉首尾 ASCII
 *   空白和控制字符，最后做 scheme 分类；scheme 比较不区分大小写。
 * - 如果去掉控制字符改变了 scheme 区段（`java\tscript:`），整值拒绝 ——
 *   不能把被拆开的 scheme “修复”成合法 scheme。
 * - 只允许 http / https（Link 额外允许 mailto），以及无 scheme 的相对路径、
 *   绝对路径、协议相对 `//host` 和（仅 Link）fragment。
 * - 返回去掉控制字符后的安全值，或 null；不要求 `URL` 构造器。
 */

const LEADING_WS = /^[ \t\n\r\f]+/
const TRAILING_WS = /[ \t\n\r\f]+$/
const CONTROL = /[\u0000-\u001F\u007F]/g
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
const BARE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  colon: ":",
  tab: "\t",
  newline: "\n",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
}

const ALLOWED_SCHEMES: Readonly<Record<"link" | "image", ReadonlySet<string>>> = {
  link: new Set(["http", "https", "mailto"]),
  image: new Set(["http", "https"]),
}

function decodeEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X"
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

function schemeOf(value: string): string | null {
  const match = SCHEME.exec(value)
  return match ? match[1].toLowerCase() : null
}

/** Scheme 区段 percent 解码后的样子；用于 `%6aavascript:` 这类混淆。 */
function decodedScheme(value: string, colon: number): string | null {
  if (colon <= 0) return null
  try {
    const decoded = decodeURIComponent(value.slice(0, colon))
    return BARE_SCHEME.test(decoded) ? decoded.toLowerCase() : null
  } catch {
    return null
  }
}

function firstPathDelimiter(value: string): number {
  const match = /[/?#]/.exec(value)
  return match ? match.index : -1
}

export function normalizePasteUrl(value: string, kind: "link" | "image"): string | null {
  const trimmed = decodeEntities(value).replace(LEADING_WS, "").replace(TRAILING_WS, "")
  const stripped = trimmed.replace(CONTROL, "")
  if (stripped === "") return null

  const colon = stripped.indexOf(":")
  // 去控制字符改变了 scheme 区段 → 被拆分/混淆的 scheme，整值拒绝。
  if (stripped !== trimmed && colon !== trimmed.indexOf(":")) return null

  const direct = schemeOf(stripped)
  const decoded = decodedScheme(stripped, colon)
  // 形如 scheme 但前缀非法（`java script:`、`-bad:`）→ 歧义值，拒绝。
  const delimiter = firstPathDelimiter(stripped)
  if (colon >= 0 && (delimiter < 0 || colon < delimiter) && direct === null) return null

  const schemes = new Set<string>()
  if (direct !== null) schemes.add(direct)
  if (decoded !== null) schemes.add(decoded)
  if (schemes.size > 1) return null

  if (schemes.size === 1) {
    const scheme = schemes.values().next().value as string
    return ALLOWED_SCHEMES[kind].has(scheme) ? stripped : null
  }

  // 无 scheme：相对/绝对路径，Link 额外允许 fragment。
  if (kind === "image" && stripped.startsWith("#")) return null
  return stripped
}
