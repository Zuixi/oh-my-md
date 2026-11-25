import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

// Real-Chromium user journeys against the full desktop <App> shell
// (`e2e/app-harness.html`), with an in-memory disk/services double instead of
// Tauri IPC. These cover the wiring that happy-dom contract tests cannot: real
// CodeMirror typing, the native <dialog> top layer, real layout/ARIA output.
const HARNESS = "/e2e/app-harness.html"
const ROADMAP_PATH = "/notes/roadmap.md"
const CONTENT_SELECTOR = ".editor-host:not([hidden]) .cm-content"

interface AppTestHandle {
  readDisk(path: string): string | null
  setDiskExternal(path: string, contents: string): void
  savedHistory(): readonly { readonly path: string; readonly contents: string }[]
  runMenuCommand(id: string): void
  errors(): readonly string[]
}

type AppTestWindow = Window & { readonly __omdAppTest: AppTestHandle }

const activeEditor = (page: Page) => page.locator(CONTENT_SELECTOR)
const roadmapTreeItem = (page: Page) => page.locator(`[role="treeitem"][data-tree-path="${ROADMAP_PATH}"]`)

const readDisk = (page: Page, path: string): Promise<string | null> =>
  page.evaluate(p => (window as unknown as AppTestWindow).__omdAppTest.readDisk(p), path)

const setDiskExternal = (page: Page, path: string, contents: string): Promise<void> =>
  page.evaluate(
    ([p, c]) => (window as unknown as AppTestWindow).__omdAppTest.setDiskExternal(p, c),
    [path, contents] as const,
  )

const runMenuCommand = (page: Page, id: string): Promise<void> =>
  page.evaluate(
    commandId => (window as unknown as AppTestWindow).__omdAppTest.runMenuCommand(commandId),
    id,
  )

const appErrors = (page: Page): Promise<readonly string[]> =>
  page.evaluate(() => (window as unknown as AppTestWindow).__omdAppTest.errors())

/** WCAG 2.0/2.1 Level A+AA rule set; `color-contrast` stays on (wcag2aa). */
type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>
const wcagScan = (builder: AxeBuilder): Promise<AxeResults> =>
  builder.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()
const violationSummary = (violations: AxeResults["violations"]): string =>
  violations
    .map(v => `${v.id}: ${v.help} (${v.nodes.map(n => n.html).join(" | ")})`)
    .join("\n")

/** Load the harness and wait until the restored welcome document and tree render. */
async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS)
  await expect(page.locator(".editor-host:not([hidden]) .cm-editor")).toBeVisible()
  await expect(activeEditor(page)).toContainText("Welcome")
  await expect(roadmapTreeItem(page)).toBeVisible()
}

/** Open roadmap.md from the sidebar (a new tab) and wait for its text. */
async function openRoadmap(page: Page): Promise<void> {
  await roadmapTreeItem(page).click()
  await expect(page.locator(".topbar-file")).toHaveText("roadmap.md")
  await expect(activeEditor(page)).toContainText("Initial roadmap plan.")
}

/** Put the caret on the last paragraph and append a new paragraph. */
async function appendParagraph(page: Page, text: string): Promise<void> {
  await activeEditor(page).locator(".cm-line").last().click()
  await page.keyboard.press("End")
  await page.keyboard.press("Enter")
  await page.keyboard.type(text)
  await expect(activeEditor(page)).toContainText(text)
}

test("opens workspace file from sidebar, edits in live preview, and saves cleanly", async ({ page }) => {
  await openHarness(page)
  await openRoadmap(page)

  await appendParagraph(page, "Added E2E item.")
  // The active tab's dirty dot is the only "Unsaved" node in the shell.
  await expect(page.locator('[aria-label="Unsaved"]')).toBeVisible()

  await runMenuCommand(page, "save")

  await expect.poll(() => readDisk(page, ROADMAP_PATH)).toContain("Added E2E item.")
  await expect(page.locator('[aria-label="Unsaved"]')).toHaveCount(0)
  expect(await appErrors(page)).toEqual([])
})

test("surfaces external disk conflict banner and opens diff comparison without losing local edits", async ({ page }) => {
  await openHarness(page)
  await openRoadmap(page)

  await setDiskExternal(page, ROADMAP_PATH, "# Roadmap\n\nTheirs from disk.\n")
  await appendParagraph(page, "Mine in editor.")
  await runMenuCommand(page, "save")

  const banner = page.locator(".save-conflict-banner")
  await expect(banner).toBeVisible()
  await expect(banner).toContainText("changed on disk")
  await banner.getByRole("button", { name: "Compare" }).click()

  const diff = page.getByRole("region", { name: "Document differences" })
  await expect(diff).toBeVisible()
  await expect(diff).toContainText("Theirs from disk.")
  await expect(diff).toContainText("Mine in editor.")
  // Comparing is read-only: the disk copy is untouched and the buffer keeps its edits.
  await expect.poll(() => readDisk(page, ROADMAP_PATH)).toContain("Theirs from disk.")
  await expect(activeEditor(page)).toContainText("Mine in editor.")
})

test("restores a version history snapshot into a new tab via command palette", async ({ page }) => {
  await openHarness(page)
  await openRoadmap(page)

  // ControlOrMeta maps to Meta on macOS and Control on Linux/Windows, matching platform.ts.
  await page.keyboard.press("ControlOrMeta+Shift+P")
  const paletteInput = page.getByRole("combobox")
  await expect(paletteInput).toBeVisible()
  await paletteInput.fill("Version History")
  await paletteInput.press("Enter")

  const history = page.getByRole("dialog", { name: "Version History" })
  await expect(history).toBeVisible()
  await history.getByRole("button", { name: /2 KB/ }).click()

  await expect(history).toHaveCount(0)
  await expect(activeEditor(page)).toContainText("Restored snapshot milestone.")
  expect(await appErrors(page)).toEqual([])
})

test("opens MediaLightbox on rendered image click and restores focus on Escape", async ({ page }) => {
  await openHarness(page)

  const image = page.locator('.editor-host:not([hidden]) img.omd-image[alt="Sample diagram"]')
  await expect(image).toBeVisible()
  await image.click()

  const lightbox = page.locator("dialog.media-lightbox")
  await expect(lightbox).toBeVisible()
  await expect(lightbox).toHaveAttribute("open", "")
  // showModal() puts it in the top layer, so the shell behind it is unreachable.
  expect(await lightbox.evaluate(dialog => dialog.matches(":modal"))).toBe(true)
  await expect(lightbox.locator(".media-lightbox-zoom-readout")).toContainText("%")

  await page.keyboard.press("Escape")
  await expect(lightbox).toHaveCount(0)
  await expect(image).toHaveCount(1)
  expect(await appErrors(page)).toEqual([])
})

test("passes structural WCAG/ARIA ergonomics invariants across the live App shell", async ({ page }) => {
  await openHarness(page)

  const audit = await page.evaluate(() => {
    const failures: string[] = []
    const describe = (element: Element) => element.outerHTML.slice(0, 240)

    const isRendered = (element: Element): boolean => {
      if (element.closest('[inert], [aria-hidden="true"], [hidden]')) return false
      const style = getComputedStyle(element)
      return style.display !== "none"
        && style.visibility !== "hidden"
        && element.getClientRects().length > 0
    }

    // Accessible name in author precedence: aria-label, labelledby target text,
    // then trimmed text content (the source of a button's implicit name), title.
    const accessibleName = (element: HTMLElement): string => {
      const label = (element.getAttribute("aria-label") ?? "").trim()
      if (label) return label
      const labelledBy = (element.getAttribute("aria-labelledby") ?? "").trim()
      if (labelledBy) {
        const fromIds = labelledBy
          .split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim() ?? "")
          .join(" ")
          .trim()
        if (fromIds) return fromIds
      }
      return (element.textContent ?? "").trim() || (element.getAttribute("title") ?? "").trim()
    }

    const buttons = [...document.querySelectorAll("button")].filter(isRendered)
    for (const button of buttons) {
      if (!accessibleName(button)) {
        failures.push(`button without accessible name: ${describe(button)}`)
      }
    }

    const nested = document.querySelectorAll(
      'button button, a button, button a, [role="tab"] [role="tab"]',
    )
    for (const element of nested) {
      if (isRendered(element)) {
        failures.push(`nested interactive content: ${describe(element)}`)
      }
    }

    const tablists = [...document.querySelectorAll('[role="tablist"]')].filter(isRendered)
    if (tablists.length === 0) failures.push("no rendered tablist")
    let tabs = 0
    for (const list of tablists) {
      // The live tab strip keeps close buttons as siblings of each tab, so the
      // tablist itself owns the tabs through `aria-owns` instead of DOM
      // children. Fall back to descendant tabs for ordinary tablists.
      const ownedIds = list.getAttribute("aria-owns")?.split(/\s+/).filter(Boolean) ?? []
      const listTabs = ownedIds.length > 0
        ? ownedIds
            .map(id => document.getElementById(id))
            .filter((el): el is HTMLElement => el !== null && el.getAttribute("role") === "tab")
        : [...list.querySelectorAll('[role="tab"]')]
      for (const tab of listTabs) {
        tabs += 1
        const selected = tab.getAttribute("aria-selected")
        if (selected !== "true" && selected !== "false") {
          failures.push(`tab without aria-selected: ${describe(tab)}`)
        }
      }
    }
    if (tabs === 0) failures.push("tablist owns no tabs")

    const trees = [...document.querySelectorAll('[role="tree"]')].filter(isRendered)
    if (trees.length === 0) failures.push("no rendered file tree")
    let treeitems = 0
    for (const tree of trees) {
      for (const item of tree.querySelectorAll('[role="treeitem"]')) {
        treeitems += 1
        const selected = item.getAttribute("aria-selected")
        if (selected !== "true" && selected !== "false") {
          failures.push(`treeitem without aria-selected: ${describe(item)}`)
        }
      }
    }
    if (treeitems === 0) failures.push("tree owns no treeitems")

    const appWindow = window as unknown as AppTestWindow
    return {
      failures,
      errors: [...appWindow.__omdAppTest.errors()],
      buttons: buttons.length,
      tabs,
      treeitems,
    }
  })

  expect(audit.failures, JSON.stringify(audit, null, 2)).toEqual([])
  expect(audit.errors).toEqual([])
  // Guard against a vacuous pass if the shell stopped rendering its landmarks.
  expect(audit.buttons).toBeGreaterThan(0)
  expect(audit.tabs).toBeGreaterThan(0)
  expect(audit.treeitems).toBeGreaterThan(0)
})

test("passes axe-core WCAG 2.1 AA audit across light theme, dark theme, settings modal, and media lightbox", async ({ page, browser }) => {
  // Every surface below is the real <App>: axe sees the shipped markup, tokens
  // and computed colors, so a token-level contrast regression fails here. The
  // surface label keeps a failure attributable on whichever host runs the suite.
  const settleAndScan = async (targetPage: Page, surface: string, builder: AxeBuilder) => {
    // Wait for finite entrance transitions (e.g. .modal-backdrop / dialog fade-in)
    // to finish so axe samples steady-state opacity rather than an intermediate frame.
    await targetPage.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter(anim => anim.effect?.getComputedTiming().iterations !== Infinity)
          .map(anim => anim.finished.catch(() => undefined)),
      ))
    const { violations } = await wcagScan(builder)
    expect(violations, `${surface}\n${violationSummary(violations)}`).toEqual([])
  }
  const violationsOf = (surface: string, builder: AxeBuilder) => settleAndScan(page, surface, builder)

  // Light shell. Only CodeMirror's contenteditable scroller is excluded: its
  // syntax tokens are engine-owned, the surrounding chrome is audited in full
  // (topbar, tablist, sidebar, tree, statusbar, buttons, color contrast).
  await openHarness(page)
  await expect(page.locator(".app.theme-light")).toBeVisible()
  await violationsOf("light shell", new AxeBuilder({ page }).exclude(".cm-editor"))

  // Settings modal is an in-page overlay, not a browser top layer.
  await runMenuCommand(page, "preferences")
  const settingsDialog = page.locator(".settings-modal")
  await expect(settingsDialog).toBeVisible()
  await violationsOf("settings modal", new AxeBuilder({ page }).include(".settings-modal"))
  await page.keyboard.press("Escape")
  await expect(settingsDialog).toHaveCount(0)

  // MediaLightbox lives in the native <dialog> top layer.
  await page.locator('.editor-host:not([hidden]) img.omd-image[alt="Sample diagram"]').click()
  const lightbox = page.locator("dialog.media-lightbox")
  await expect(lightbox).toBeVisible()
  await violationsOf("media lightbox", new AxeBuilder({ page }).include("dialog.media-lightbox"))
  await page.keyboard.press("Escape")
  await expect(lightbox).toHaveCount(0)

  // Dark shell: the harness seeds settings.theme from ?theme so the shell keeps
  // dark instead of resolving the default "system" back to light.
  await page.goto(`${HARNESS}?theme=dark`)
  await expect(page.locator(".editor-host:not([hidden]) .cm-editor")).toBeVisible()
  await expect(roadmapTreeItem(page)).toBeVisible()
  await expect(page.locator(".app.theme-dark")).toBeVisible()
  await violationsOf("dark shell", new AxeBuilder({ page }).exclude(".cm-editor"))

  // Dark Settings modal: primary buttons flip to --omd-btn-primary-fg, so the
  // dark contrast floor is asserted on the real overlay rather than by token.
  await page.locator(".statusbar").getByRole("button", { name: "Preferences" }).click()
  await expect(page.getByRole("dialog", { name: "Preferences" })).toBeVisible()
  await violationsOf("dark settings modal", new AxeBuilder({ page }).include(".settings-modal"))

  // Non-macOS in-app menubar (`AppMenu.tsx` hides itself on macOS): exercise it
  // in a Linux UA context so macOS dev runs catch Windows/Linux menubar regressions.
  const linuxContext = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
  })
  try {
    const linuxPage = await linuxContext.newPage()
    await openHarness(linuxPage)
    await expect(linuxPage.locator(".app-menubar")).toBeVisible()
    await linuxPage.locator(".app-menubar").getByRole("button", { name: "View" }).click()
    await expect(linuxPage.getByRole("menu", { name: "View" })).toBeVisible()
    await settleAndScan(linuxPage, "linux menubar + open menu", new AxeBuilder({ page: linuxPage }).exclude(".cm-editor"))
  } finally {
    await linuxContext.close()
  }
})

test("opens the About dialog with icon, build date, and project link", async ({ page }) => {
  await openHarness(page)
  await runMenuCommand(page, "about")

  const dialog = page.getByRole("dialog", { name: "About oh-my-md" })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(".about-icon")).toBeVisible()
  await expect(dialog).toContainText("Version 0.1.5")
  await expect(dialog).toContainText("Built 2026-11-24")
  await expect(
    dialog.getByRole("button", { name: "github.com/Zuixi/oh-my-md" }),
  ).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused()

  await dialog.getByRole("button", { name: "Close" }).click()
  await expect(dialog).toHaveCount(0)
})
