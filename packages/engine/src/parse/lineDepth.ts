/**
 * `@lezer/markdown`'s `Line` carries the current container depth at runtime,
 * but the public typings omit it. One cast lives here so a parser regression
 * from an upstream patch is one site to inspect, not three copies.
 */
export function lineDepth(line: object): number {
  return (line as { depth?: number }).depth ?? 0
}
