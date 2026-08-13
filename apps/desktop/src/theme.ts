export type ThemeName = "light" | "dark"

export function applyTheme(theme: ThemeName, customCss = "") {
  document.documentElement.dataset.theme = theme
  let style = document.getElementById("omd-user-theme")
  if (!style) {
    style = document.createElement("style")
    style.id = "omd-user-theme"
    document.head.appendChild(style)
  }
  style.textContent = customCss
}

export function toggleTheme(theme: ThemeName): ThemeName {
  return theme === "light" ? "dark" : "light"
}
