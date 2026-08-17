// happy-dom does not implement document.compatMode (it is undefined), while a
// standards-mode browser reports "CSS1Compat". KaTeX reads it at module load
// and refuses to render without a warning otherwise, so pin the real value.
Object.defineProperty(document, "compatMode", {
  value: "CSS1Compat",
  configurable: true,
})
