export type AppTheme = "system" | "light" | "dark"
export type ThemeName = "light" | "dark"

export function resolveTheme(theme: AppTheme): ThemeName {
  if (theme === "system") {
    if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark"
    }
    return "light"
  }
  return theme
}

export function applyTheme(theme: AppTheme | ThemeName, customCss = "") {
  const resolved = resolveTheme(theme)
  document.documentElement.dataset.theme = resolved
  let style = document.getElementById("omd-user-theme")
  if (!style) {
    style = document.createElement("style")
    style.id = "omd-user-theme"
    document.head.appendChild(style)
  }
  style.textContent = customCss
}

export function toggleTheme(theme: AppTheme): AppTheme {
  const resolved = resolveTheme(theme)
  return resolved === "light" ? "dark" : "light"
}
