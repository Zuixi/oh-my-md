import type { InlineContext, InlineParser } from "@lezer/markdown"
import {
  CHAR_ASTERISK,
  CHAR_AT,
  CHAR_CLOSE_PAREN,
  CHAR_GT,
  CHAR_LOWER_A,
  CHAR_LOWER_F,
  CHAR_LOWER_H,
  CHAR_LOWER_W,
  CHAR_LOWER_Z,
  CHAR_LT,
  CHAR_NINE,
  CHAR_OPEN_PAREN,
  CHAR_SLASH,
  CHAR_SPACE,
  CHAR_TILDE,
  CHAR_UNDERSCORE,
  CHAR_UPPER_A,
  CHAR_UPPER_Z,
  CHAR_ZERO,
} from "./chars"

// Parentheses stay in the match so `trimUrl` can balance them: `Foo_(bar)` is
// URL punctuation, the `)` in `(https://x)` is prose punctuation.
const URL_PATTERN = /^(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>]+/i
// Unicode letters/digits in the local part keep `über@example.com` one autolink;
// the TLD stays letter-only so `a@b.12` is not a link.
const EMAIL_PATTERN = /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu
const TRAILING_PUNCTUATION = /[.,!?;:]+$/
const AUTOLINK_SCHEME = /^(?:https?|ftp):\/\//i
const WWW_PREFIX = /^www\./i
const WWW_PREFIX_LENGTH = 4
const AUTHORITY_END = /[/?#]/
// A host needs at least one character that is not a delimiter of its own
// authority: `https://.`, `https://:` or `https:///?` name no host at all.
const HOST_CHARACTER = /[^\s./:?#]/
// `www.` needs a dotted host: `www.a.b` links, `www.` and `www.a` do not.
const DOTTED_HOST = /^[^./?#\s]+(?:\.[^./?#\s]+)+/
/**
 * Word characters for autolink boundaries: letters and digits of cased and
 * alphabetic scripts plus `_`. CJK scripts are excluded on purpose — Chinese,
 * Japanese and Korean prose runs text directly against a URL (`见https://x`
 * must link) and treats `_` as punctuation for emphasis flanking.
 */
const NON_CJK_WORD_CHAR =
  /^(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{Alphabetic}\p{N}_]$/u

const SURROGATE_LOW_START = 0xd800
const SURROGATE_HIGH_START = 0xdc00
const SURROGATE_HIGH_END = 0xe000
const ASCII_END = 0x80
const ASCII_LOWER_OFFSET = 0x20
// RFC 5321 caps email local-parts at 64 octets; 128 keeps non-ASCII local-parts
// generous while preventing O(n^2) forward scans on pathological space-less lines.
const MAX_EMAIL_LOCAL_CHARS = 128

// BMP blocks occupied by CJK/Kana/Hangul prose and fullwidth forms. A code unit
// in one of them can never start an autolink: these scripts run words together
// without spaces (`中文段落`), CJK punctuation sits between words, and fullwidth
// forms are CJK typography. Rejecting at the first code unit keeps space-less
// CJK prose allocation-free — no `codePointAt`, no slice, no forward scan.
const CJK_SYMBOLS_START = 0x3000
const KANA_END = 0x30ff // through Hiragana and Katakana
const CJK_IDEOGRAPHS_START = 0x3400 // Extension A + unified ideographs
const CJK_IDEOGRAPHS_END = 0x9fff
const HANGUL_SYLLABLES_START = 0xac00
const HANGUL_SYLLABLES_END = 0xd7af
const CJK_COMPATIBILITY_START = 0xf900 // compatibility ideographs
const CJK_COMPATIBILITY_END = 0xfaff
const FULLWIDTH_FORMS_START = 0xff00
const FULLWIDTH_FORMS_END = 0xffef

function isMarkdownDelimiter(character: number): boolean {
  return character === CHAR_ASTERISK || character === CHAR_TILDE
}

function isDelimiterRunChar(character: number): boolean {
  return isMarkdownDelimiter(character) || character === CHAR_UNDERSCORE
}

function isAsciiWordChar(character: number): boolean {
  return isAsciiAlphanumeric(character) || character === CHAR_UNDERSCORE
}

function isAsciiAlphanumeric(character: number): boolean {
  return (character >= CHAR_LOWER_A && character <= CHAR_LOWER_Z)
    || (character >= CHAR_UPPER_A && character <= CHAR_UPPER_Z)
    || (character >= CHAR_ZERO && character <= CHAR_NINE)
}

function isLowSurrogate(character: number): boolean {
  return character >= SURROGATE_HIGH_START && character < SURROGATE_HIGH_END
}

/** CJK/Kana/Hangul code units: exactly the scripts `NON_CJK_WORD_CHAR` excludes. */
function isCjkScriptCodeUnit(character: number): boolean {
  return (character >= CJK_SYMBOLS_START && character <= KANA_END)
    || (character >= CJK_IDEOGRAPHS_START && character <= CJK_IDEOGRAPHS_END)
    || (character >= HANGUL_SYLLABLES_START && character <= HANGUL_SYLLABLES_END)
    || (character >= CJK_COMPATIBILITY_START && character <= CJK_COMPATIBILITY_END)
}

/** First code units that are CJK prose and therefore cannot start an autolink. */
function isCjkProseCodeUnit(character: number): boolean {
  return isCjkScriptCodeUnit(character)
    || (character >= FULLWIDTH_FORMS_START && character <= FULLWIDTH_FORMS_END)
}

function lowerAscii(character: number): number {
  return character >= CHAR_UPPER_A && character <= CHAR_UPPER_Z
    ? character + ASCII_LOWER_OFFSET
    : character
}

/** Whether lowercase `literal` sits at `pos`; compared code unit by code unit. */
function hasAsciiLiteral(cx: InlineContext, pos: number, literal: string): boolean {
  if (pos + literal.length > cx.end) return false
  for (let index = 0; index < literal.length; index++) {
    if (lowerAscii(cx.char(pos + index)) !== literal.charCodeAt(index)) return false
  }
  return true
}

function hasSchemeSlashes(cx: InlineContext, pos: number): boolean {
  return cx.char(pos) === CHAR_SLASH && cx.char(pos + 1) === CHAR_SLASH
}

/**
 * `http://`, `https://`, `ftp://` or `www.` at `pos`, case-insensitively and as
 * integers: an ordinary word must not pay a slice or a regex to learn that it
 * carries no URL.
 */
function hasUrlPrefixAt(cx: InlineContext, pos: number): boolean {
  switch (lowerAscii(cx.char(pos))) {
    case CHAR_LOWER_H:
      if (hasAsciiLiteral(cx, pos + 1, "ttp:")) return hasSchemeSlashes(cx, pos + 5)
      return hasAsciiLiteral(cx, pos + 1, "ttps:") && hasSchemeSlashes(cx, pos + 6)
    case CHAR_LOWER_F:
      return hasAsciiLiteral(cx, pos + 1, "tp:") && hasSchemeSlashes(cx, pos + 4)
    case CHAR_LOWER_W:
      return hasAsciiLiteral(cx, pos, "www.")
    default:
      return false
  }
}

/**
 * Whether the candidate token starting at `pos` carries an `@`. Integer only and
 * it stops at the first `@`, so ordinary prose pays one bounded forward scan and
 * nothing else; the email path rescans for the token end afterwards.
 */
function tokenHasAt(cx: InlineContext, pos: number): boolean {
  const limit = Math.min(cx.end, pos + MAX_EMAIL_LOCAL_CHARS)
  let index = pos
  while (index < limit) {
    const character = cx.char(index)
    if (character <= CHAR_SPACE || character === CHAR_LT || character === CHAR_GT) return false
    if (character === CHAR_AT) return true
    index++
  }
  return false
}

/** The code point starting at `pos` as a string, so astral characters are tested whole. */
function codePointAt(cx: InlineContext, pos: number): string {
  const character = cx.char(pos)
  const paired = character >= SURROGATE_LOW_START && character < SURROGATE_HIGH_START
    && pos + 1 < cx.end
  return paired ? cx.slice(pos, pos + 2) : String.fromCharCode(character)
}

/** Whether the code point ending at `pos` is a word character (see `NON_CJK_WORD_CHAR`). */
function isWordCharBefore(cx: InlineContext, pos: number): boolean {
  if (pos <= cx.offset) return false
  const character = cx.char(pos - 1)
  if (character < 0) return false
  if (character < ASCII_END) return isAsciiWordChar(character)
  // CJK/Kana/Hangul are never word characters: answer without slicing, so prose
  // that runs straight into a URL (`见https://x`) stays allocation-free here.
  if (isCjkScriptCodeUnit(character)) return false
  const from = isLowSurrogate(character) && pos - 2 >= cx.offset ? pos - 2 : pos - 1
  return NON_CJK_WORD_CHAR.test(cx.slice(from, pos))
}

/**
 * `_` opens an emphasis run only when the contiguous `_*~` run before the URL
 * contains an underscore and that run itself starts a word boundary. The run
 * scan is what makes composite openers work: in `_**https://x**_` the character
 * before the URL is `_`, not `*`.
 */
function hasUnderscoreOpener(cx: InlineContext, pos: number): boolean {
  let sawUnderscore = false
  let index = pos - 1
  let character = cx.char(index)
  while (isDelimiterRunChar(character)) {
    if (character === CHAR_UNDERSCORE) sawUnderscore = true
    index--
    character = cx.char(index)
  }
  if (!sawUnderscore) return false
  return index < cx.offset || !isWordCharBefore(cx, index + 1)
}

/**
 * A URL starts at a boundary only when the character before it is not part of a
 * word. An intra-word `_` run (`foo_bar`, `foo__https://…`) is not a boundary;
 * an emphasis opener (`__https://x__`) is, because `hasUnderscoreOpener` walks
 * the whole `_*~` run back to its own boundary.
 */
function isBoundary(cx: InlineContext, pos: number): boolean {
  if (pos <= cx.offset) return true
  const previous = cx.char(pos - 1)
  if (previous < 0) return true
  if (previous === CHAR_UNDERSCORE) return hasUnderscoreOpener(cx, pos)
  return !isWordCharBefore(cx, pos)
}

/**
 * End of the candidate token. Bare autolinks never span whitespace, control
 * characters or an HTML delimiter, so bounding the forward scan here keeps the
 * one `slice` proportional to the token instead of the rest of the inline
 * section — the parser runs this at every position of every paragraph.
 */
function tokenEnd(cx: InlineContext, pos: number): number {
  let index = pos
  while (index < cx.end) {
    const character = cx.char(index)
    if (character <= CHAR_SPACE || character === CHAR_LT || character === CHAR_GT) break
    index++
  }
  return index
}

/** Authority of a URL: everything up to the first `/`, `?` or `#`. */
function authorityOf(rest: string): string {
  const end = rest.search(AUTHORITY_END)
  return end < 0 ? rest : rest.slice(0, end)
}

/**
 * Rejects autolinks that name no host: `https://`, `https://.`, `**https://**`,
 * `www...` and `www.` all survive pattern matching and trimming, and would
 * otherwise render as links to the scheme or to the `www.` label alone.
 */
function hasValidAutolinkHost(value: string): boolean {
  const scheme = AUTOLINK_SCHEME.exec(value)
  if (scheme) {
    const authority = authorityOf(value.slice(scheme[0].length))
    if (authority.length === 0) return false
    if (authority.startsWith(".") || authority.endsWith(".")) return false
    return HOST_CHARACTER.test(authority)
  }
  if (WWW_PREFIX.test(value)) {
    return DOTTED_HOST.test(authorityOf(value.slice(WWW_PREFIX_LENGTH)))
  }
  return EMAIL_PATTERN.test(value)
}

/**
 * Cheap first-code-unit gate: `parse` runs at every position of every inline
 * section, so the common case must stay integer-only. CJK/Kana/Hangul/fullwidth
 * prose exits on the code unit the parser already read; a non-CJK non-ASCII
 * letter is still only a candidate, confirmed against the token below.
 */
function mayStartAutolink(next: number): boolean {
  if (next < ASCII_END) {
    return next === CHAR_LOWER_H || next === CHAR_LOWER_W || next === CHAR_LOWER_F
      || next === CHAR_AT || isAsciiAlphanumeric(next)
  }
  return !isCjkProseCodeUnit(next)
}

/**
 * A URL may carry balanced parentheses (`Foo_(bar)`); a closer without a
 * matching opener inside the URL belongs to the surrounding prose. A dangling
 * opener at the end is prose punctuation too.
 */
function trimParens(value: string, end: number): number {
  let openCount = 0
  let closeCount = 0
  for (let index = 0; index < end; index++) {
    const character = value.charCodeAt(index)
    if (character === CHAR_OPEN_PAREN) openCount++
    else if (character === CHAR_CLOSE_PAREN) closeCount++
  }
  while (end > 0 && value.charCodeAt(end - 1) === CHAR_CLOSE_PAREN && closeCount > openCount) {
    end--
    closeCount--
  }
  if (end > 0 && value.charCodeAt(end - 1) === CHAR_OPEN_PAREN) end--
  return end
}

/**
 * Trims prose punctuation and Markdown emphasis/strikethrough delimiters that
 * would otherwise be swallowed into the URL (`**https://x**.`,
 * `(~~https://x~~, next)`). Trailing punctuation can expose a delimiter and the
 * reverse, so the pass repeats until it stops changing the value; a trailing
 * `_` is trimmed only when it can be the closer of an underscore emphasis pair.
 */
function trimUrl(value: string, cx: InlineContext, pos: number): string {
  const underscoreOpener = hasUnderscoreOpener(cx, pos)
  let sawDelimiter = false
  let end = value.length
  let previousEnd = -1
  while (end > 0 && end !== previousEnd) {
    previousEnd = end
    const punctuation = TRAILING_PUNCTUATION.exec(value.slice(0, end))
    if (punctuation) end -= punctuation[0].length
    end = trimParens(value, end)
    while (end > 0 && isMarkdownDelimiter(value.charCodeAt(end - 1))) {
      sawDelimiter = true
      end--
    }
    if (underscoreOpener || sawDelimiter) {
      while (end > 0 && value.charCodeAt(end - 1) === CHAR_UNDERSCORE) end--
    }
  }
  return value.slice(0, end)
}

export const BareAutolink: InlineParser = {
  name: "BareAutolink",
  before: "Link",
  parse(cx, next, pos) {
    if (!mayStartAutolink(next)) return -1
    if (cx.hasOpenLink) return -1
    // Intra-word ASCII positions cannot start a bare autolink; rejecting before
    // any forward scan keeps single-token 350k lines (`"x".repeat(...)`) O(n).
    if (pos > cx.offset && isAsciiAlphanumeric(cx.char(pos - 1))) return -1
    // Cheapest rejection before any non-ASCII boundary or code-point work: a
    // token with neither a URL prefix nor an `@` cannot be an autolink, so
    // ordinary prose (ASCII, Latin, Cyrillic, CJK) leaves with zero `slice`
    // calls and zero regex calls.
    const hasUrlPrefix = hasUrlPrefixAt(cx, pos)
    if (!hasUrlPrefix && !tokenHasAt(cx, pos)) return -1
    if (!hasUrlPrefix && next >= ASCII_END
      && !NON_CJK_WORD_CHAR.test(codePointAt(cx, pos))) return -1
    if (!isBoundary(cx, pos)) return -1

    const end = tokenEnd(cx, pos)
    if (end <= pos) return -1
    const token = cx.slice(pos, end)
    const match = URL_PATTERN.exec(token) ?? EMAIL_PATTERN.exec(token)
    if (!match) return -1

    const value = trimUrl(match[0], cx, pos)
    if (!value || !hasValidAutolinkHost(value)) return -1
    const to = pos + value.length
    return cx.addElement(cx.elt("Autolink", pos, to, [
      cx.elt("URL", pos, to),
    ]))
  },
}
