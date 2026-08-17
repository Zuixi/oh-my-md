const ENTITY_HEX = /^&#x([a-f\d]+);$/i
const ENTITY_DEC = /^&#(\d+);$/
const ENTITY_NAMED = /^&(\w+);$/

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  mdash: "—", ndash: "–", hellip: "…",
  laquo: "«", raquo: "»", times: "×", divide: "÷",
}

function fromCodePoint(cp: number): string {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return "\uFFFD"
  return String.fromCodePoint(cp)
}

function decodeNamed(raw: string, name: string): string | null {
  const mapped = NAMED[name] ?? NAMED[name.toLowerCase()]
  if (mapped) return mapped
  const text = new DOMParser().parseFromString(raw, "text/html").documentElement.textContent
  if (text && text !== raw) return text
  return null
}

export function decodeHtmlEntity(raw: string): string | null {
  const hex = ENTITY_HEX.exec(raw)
  if (hex) return fromCodePoint(parseInt(hex[1], 16))
  const dec = ENTITY_DEC.exec(raw)
  if (dec) return fromCodePoint(parseInt(dec[1], 10))
  const named = ENTITY_NAMED.exec(raw)
  if (named) return decodeNamed(raw, named[1])
  return null
}
