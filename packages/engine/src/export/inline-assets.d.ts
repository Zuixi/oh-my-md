// Vite asset-query modules. `?inline` inlines the asset as the module's
// default export: base64 data URLs for binary files (e.g. KaTeX woff2 fonts)
// and the file's text for stylesheets (e.g. katex.min.css?inline). These
// specifiers are resolved by Vite/Vitest; this ambient declaration keeps
// `tsc --noEmit` happy. See katexAssets.ts.
declare module "*?inline" {
  const value: string
  export default value
}
