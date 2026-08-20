// Shared, self-contained typography for exported HTML. Inlined as a <style>
// block so exports are presentable without the desktop stylesheet. Engine has
// no CSS bundler step, so this is a TS string constant (do NOT `import "./x.css"`).

export const EXPORT_BODY_CSS = `body {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: #1f2328;
  word-wrap: break-word;
}
@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  a { color: #58a6ff; }
  code, pre, blockquote, table { background: #161b22; }
  code, pre { color: #e6edf3; }
  th, td { border-color: #30363d; }
  blockquote { border-left-color: #30363d; color: #8b949e; }
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  margin: 1.4em 0 0.6em;
  font-weight: 600;
}
h1 { font-size: 1.9em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.25em; }
h4 { font-size: 1.05em; }
h5, h6 { font-size: 0.95em; }
p { margin: 0 0 1em; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  padding: 0.2em 0.4em;
  border-radius: 4px;
  background: #f3f4f6;
}
pre {
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  background: #f3f4f6;
}
pre code { padding: 0; background: none; font-size: 0.875em; }
blockquote {
  margin: 0 0 1em;
  padding: 0 1em;
  border-left: 4px solid #d0d7de;
  color: #57606a;
}
table {
  border-collapse: collapse;
  margin: 0 0 1em;
  width: 100%;
}
th, td {
  border: 1px solid #d0d7de;
  padding: 6px 12px;
  text-align: left;
}
img { max-width: 100%; height: auto; }
ul, ol { padding-left: 1.6em; margin: 0 0 1em; }
hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }`
