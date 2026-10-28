import { expect, test, type Page } from "@playwright/test"

const ROWS = Array.from({ length: 5 }, (_, r) => `| a${r} | b${r} | c${r} |`).join("\n")
const DOC = ["| A | B | C |", "| --- | --- | --- |", ROWS, "", "after"].join("\n")
// 源码态表格的每一行（表头 + 分隔行 + 5 个数据行）都带 .omd-table-src
const TABLE_LINES = DOC.split("\n").filter(line => line.startsWith("|")).length

const docText = (page: Page) =>
  page.evaluate(() => (window as any).__view.state.doc.toString())
const caretHead = (page: Page) =>
  page.evaluate(() => (window as any).__view.state.selection.main.head as number)

test("Tab walks every cell without touching the document", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  const before = await docText(page)
  // 3 列表头 + 5×3 数据格 = 18 格；从首数据格走到末格需 14 次 Tab。
  // 第 15 次会触发"末格加行"，所以这里只走 14 次。
  for (let i = 0; i < 14; i++) await page.keyboard.press("Tab")
  const after = await docText(page)
  expect(after).toBe(before)
  // "文档没变"在 Tab 根本没移动光标时同样成立，所以再钉住两件事：
  // 1) 整表确实以源码网格呈现（每行一条 .omd-table-src 装饰）；
  await expect(page.locator(".omd-table-src")).toHaveCount(TABLE_LINES)
  // 2) 光标精确停在第 18 格（c4）的内容起点 —— 内容起点跳过单元格的前导空格，
  //    所以偏移就是 "c4" 在文档里的位置，不是"比某处大"。
  expect(await caretHead(page)).toBe(DOC.indexOf("c4"))
  // 源码态表格里不该出现任何输入元素：旧的 cell <input> 已删除（表格只有两个状态，见
  // docs/memory/gotchas-engine.md 的表格条目）。选择器刻意不写已删除的那个类名，
  // 免得把退役符号重新带进 grep 门槛。
  await expect(page.locator(".omd-table-src input")).toHaveCount(0)
})

// 分支的核心承诺：表格输入走的是普通文档编辑，因此撤销/查找/自动保存覆盖表格输入。
// 旧的导航用例只钉住"文档没变"，Tab 完全不动光标时它照样通过 —— 这里真的往格子里打字。
test("typing inside a source cell edits the document and undo restores it byte-identically", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  // 点第 1 个数据行的第 2 格（b0）→ 光标落在该格内容起点
  await page.locator(".omd-table tbody tr").first().locator("td").nth(1).click()
  await expect(page.locator(".omd-table-src")).toHaveCount(TABLE_LINES)
  const before = await docText(page)

  await page.keyboard.type("X")
  const typed = await docText(page)
  const lineOf = (text: string) => text.split("\n").find(line => line.includes("b0"))
  expect(lineOf(typed)).toBe("| a0 | Xb0 | c0 |")
  // 打字后光标停在刚输入的字符之后
  expect(await caretHead(page)).toBe(typed.indexOf("Xb0") + 1)

  await page.keyboard.press("ControlOrMeta+Z")
  expect(await docText(page)).toBe(before)
})

// 表尾边界（pos === Table.to）是可达光标位：末行 End / Cmd+→ 就停在那里。装饰层把两个
// 边界都算作"在表内"，所以整表仍以源码网格呈现 —— 但查询层若在那里返回 null，五个表格
// 键位全部落空，Tab 会逃到浏览器默认的焦点切换。
test("End reaches the table end boundary, where Tab still belongs to the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody tr").last().locator("td").last().click()
  const before = await docText(page)
  const tableEnd = DOC.indexOf("| a4 | b4 | c4 |") + "| a4 | b4 | c4 |".length

  await page.keyboard.press("End")
  expect(await caretHead(page)).toBe(tableEnd)

  // 边界正好落在最后一格，所以 Tab 走"末格加行"（tableNextCellSpec 的既有行为），
  // 文档会多一行 —— 这里钉住的是"键位被表格接管"，不是"文档一个字都没变"。
  await page.keyboard.press("Tab")
  const after = await docText(page)
  const tableRows = (text: string) => text.split("\n").filter(line => line.startsWith("|")).length
  expect(tableRows(after)).toBe(tableRows(before) + 1)
  expect(after).not.toContain("\t")
  // 新行插在表尾（Table.to 处），表前和表后的既有内容一字不改
  expect(after.startsWith(before.slice(0, tableEnd))).toBe(true)
  expect(after.endsWith(before.slice(tableEnd))).toBe(true)
  // 光标落在新增行的首格、仍在表内：源码网格多一行，光标没有逃出编辑器
  await expect(page.locator(".omd-table-src")).toHaveCount(TABLE_LINES + 1)
  expect(await caretHead(page)).toBeGreaterThan(tableEnd)
})

// 加行是 Tab 的专属动作（上面的用例钉住了）；Enter 在末行必须退出到表后的空段。
// 文档里已有一个空行，所以「退出」= 纯选区移动：文档一字不改，光标停到表后那一行。
test("Enter at the last row exits to the blank paragraph", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody tr").last().locator("td").first().click()
  await page.keyboard.press("Enter")
  expect(await docText(page)).toBe(DOC)
  const caret = await page.evaluate(() => {
    const view = (window as any).__view
    return { line: view.state.doc.lineAt(view.state.selection.main.head).number,
      text: view.state.doc.lineAt(view.state.selection.main.head).text }
  })
  expect(caret).toEqual({ line: TABLE_LINES + 1, text: "" })

  // 第二次 Enter 只是普通段落换行：不再加行，也不会跑回表格里。
  await page.keyboard.press("Enter")
  await page.keyboard.type("outside")
  const after = await docText(page)
  expect(after).toBe(DOC.replace("\n\nafter", "\n\noutside\nafter"))
  expect(after.split("\n").filter(line => line.startsWith("|"))).toHaveLength(TABLE_LINES)
})

test("Mod-Enter leaves the table", async ({ page }) => {
  await page.goto(`/e2e/harness.html?doc=${encodeURIComponent(DOC)}`)
  await page.locator(".omd-table tbody td").first().click()
  await page.keyboard.press("ControlOrMeta+Enter")
  const line = await page.evaluate(() => {
    const view = (window as any).__view
    return view.state.doc.lineAt(view.state.selection.main.head).text
  })
  expect(line).toBe("")
})
