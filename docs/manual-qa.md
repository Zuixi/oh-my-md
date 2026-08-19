# oh-my-md 手动 QA 清单

M1 交付物：一个能 Cmd+O 打开 .md → Live Preview 编辑 → Cmd+S 保存、Cmd+E 切换 live/source 模式的桌面 App。以下项自动化成本高、人眼判断快，发布前逐项过一遍。

## 启动
- [ ] `pnpm dev` 能起 Tauri 窗口，无构建错误
- [ ] 窗口打开即见一个空 CM6 编辑器，光标可定位

## 编辑核心
- [ ] 中文输入法合成期不抖动、不吞字（拼音/双拼各试一次）
- [ ] 在 `**粗体**` 中间打字，光标贴近 `**` 边缘时语法展开、离开后重新折叠
- [ ] 撤销/重做（Cmd+Z / Cmd+Shift+Z）正确，跨模式不串味
- [ ] 链接 URL 区光标进入时展开、离开折叠

## 模式切换
- [ ] Cmd+E 在 live/source 间来回切换，文本零丢失、光标位置合理
- [ ] 切换后滚动位置保持

## 文件 IO
- [ ] Cmd+O 打开含中文路径的 .md，内容正确
- [ ] 当前文档 dirty 时 Cmd+O 会确认；取消后路径、内容、dirty 状态均不变
- [ ] 快速连续打开两个文件时，较晚返回的旧读取结果不会覆盖当前文档
- [ ] 打开另一文件后 Cmd+Z 不会撤回到前一文件；撤销到已保存内容时 dirty 标记消失
- [ ] Cmd+S 保存后用别的编辑器打开，格式无损
- [ ] 保存期间继续编辑时，本次只保存捕获的快照且界面继续显示 dirty；再次保存后落盘最新内容
- [ ] 另存为新文件（无 path 时 Cmd+S）工作正常

## 性能
- [ ] 打开 `packages/engine/test/fixtures/large.md`（~1500 行），滚动流畅、首次渲染 < 1s
- [ ] 快速连续敲键无卡顿；含多个代码/公式/图表块的文档滚动仍流畅

## 渲染（对照 styles.css 类名）
- [ ] 各级标题字号正确；ATX 的 `#` 与 Setext 的 `===` / `---` 在光标离开后折叠
- [ ] 加粗 / 斜体 / 删除线 样式正确，语法标记被折叠；CJK 紧邻的 `__粗体__` / `_斜体_` 与 `**` / `*` 等效
- [ ] 行内代码 背景等宽字体
- [ ] `==高亮==` 与 `<mark>高亮</mark>` 黄底，`<u>下划线</u>` 下划线，标记在光标离开后折叠
- [ ] 链接 蓝色，URL 折叠，光标进入展开
- [ ] 单击 `[^id]` 跳到对应定义并滚入视口；再单击该定义的 `[^id]:` 标记回到刚才的引用；缺失定义时不跳转、不报错
- [ ] 单击相对路径 `.md` / `.markdown` 链接（可带 `#anchor`）打开该文件标签；文件不存在时报错且不新建；`https://` / `mailto:` 仍用系统打开；图片等其它相对路径单击无动作
- [ ] 任务复选框可点切换，状态写回源码（`[ ]`⇄`[x]`）
- [ ] 无序列表 marker 折叠为 `•`，有序列表按项序显示 1,2,3，并把源码改成连续编号（光标进入该行与预览一致）；任务项不叠 bullet
- [ ] 嵌套列表逐级缩进，换行的续行对齐到正文（悬挂缩进）；光标进入该行时源码缩进显露
- [ ] 围栏/缩进代码块整行等宽底色；块内 `**` 等行内语法不折叠；高亮属 M2
- [ ] 输入 `> ` 后引用块立即出现左边框，光标在正文时 `>` 折叠；光标落到 `>` 上才展开
- [ ] 多层 `> > >` 显示逐级左边框，不是全部叠成一层；单击或连点引用正文时 `>` / `**` 保持折叠，光标落到标记上才展开；单击嵌套引用之间的空 `>` 行后，下一行仍是引用（左边框在），不是普通段落
- [ ] 引用块内的有序/无序列表显示编号或 `•`，缩进在引用竖线内侧，竖线与普通引用行对齐、不内缩
- [ ] 列表项里的引用缩进到列表正文下，左边框从列表缩进处开始（不顶到行首）；`>` 前需要四个空格
- [ ] 引用块内标题、代码块、链接、图片、加粗/行内代码渲染正确；围栏代码留在引用里（左边框不断开），内容不含 `>`
- [ ] Unicode emoji（📚）原样显示；`&#x1f4da;` / `&#128218;` / `&copy;` 在光标离开实体后显示为字符，源码不改写
- [ ] 输入 `:` 出现 gemoji 补全，选中后源码变成 Unicode（如 🎉）而不是 `:tada:`；打开已有 `:tada:` 时预览为 🎉，光标进入短码才显示原文；`12:00` 与行内代码里的 `:tada:` 不触发
- [ ] 水平线（`---` / `***` / `* * *` 等）光标离开后只显示分割线，进入该行显源码
- [ ] 脚注引用上标并折叠 `[^` `]`；定义的 `[^id]:` 标记折叠；4 空格缩进的续行归入定义（不显示为代码块）

## M2 块渲染
- [ ] 表格渲染为 HTML 表格，对齐正确；单击单元格就地编辑源码（Enter/Tab 提交并移到下一格，Shift-Tab 上一格，Escape 取消）；右上角可在下方插行、右侧插列、删当前行/列；点 ✎ 仍回源码
- [ ] 表格单元格内 Markdown 任意语法渲染：粗体/斜体/删除线/高亮/下划线/行内代码/行内公式/链接/autolink/图片/emoji/`<br>`，以及单行列表（`- item`）、引用（`> q`）、代码块（`` ``` ``）；导出 HTML 与预览一致
- [ ] 代码块高亮（js/ts/rust 各试一个）；未知语言降级纯文本；光标进入显源码
- [ ] `$$` 块公式与 `$` 行内公式渲染；错误公式显示错误+原文不白屏
- [ ] ```mermaid 块渲染图表；语法错时显示错误+原文
- [ ] 截图粘贴生成 assets/ 文件并渲染为图片；图片加载失败显示占位文本
- [ ] 将本地 PNG/JPEG/WebP 拖到编辑器，会在 drop 位置插入 `![](assets/...)`；非图片文件 drop 不被拦截
- [ ] ⇧⌘P → `Insert image…` 打开文件选择；选中本地 PNG/JPEG/WebP 后在当前选择处插入 `![](assets/...)`
- [ ] 图片读取或写入失败会显示错误且不插入 Markdown
- [ ] 图片写入期间移动光标仍插入到原选择；切换路径、切换文档或继续编辑不会写入错误文档
- [ ] 快速并发粘贴不会并发写入；过期操作会明确报错
- [ ] PNG/JPEG/WebP 使用匹配扩展名；GIF、未知格式和超过 10 MiB 的图片被拒绝
- [ ] 表格/公式/Mermaid 在 blockquote 或列表内对齐到外层缩进，不炸（冲突过滤兜底）

## 已知限制（当前范围，非缺陷）
- 表格单元格内的引用式链接（`[text][id]`）不解析，只有内联 `[text](url)` 生效；跨行块内容（多段列表）无法在单行 cell 内表达
- 代码块编辑态无高亮（光标进入即源码形态；Typora 式就地高亮成本高，v2 再议）
- math 仅支持 `$$`/`$` 定界符
- 脚注：空行仍会结束定义（跨空行的多段脚注暂不合并，见 footnotes.ts 的 ponytail 注记）
- 行内 HTML 目前只渲染 `<mark>` 高亮、`<u>` 下划线，以及 `&...;` 字符引用；其它标签仍显示源码。`:octocat:` 等无 Unicode 的 GitHub 自定义 emoji 不渲染；`:)` 颜文字不转换
- 代码块编辑态高亮、`:octocat:` / `:)`：仍属已知限制

## M3 产品壳
- [ ] 多标签各有独立撤销；脏点显示；关脏标签会确认；`+` 新建标签
- [ ] 左侧始终有 Files 栏（Search；无 Open folder 按钮）；File 菜单含 New / Open / Open Folder / Open Recent / Close / Save / Save As / Export（HTML、PDF、Image）；打开单个 .md 会带出父目录文件树；点子目录原地展开且兄弟文件仍在；点文件开标签；外部改干净文件会重载，改脏文件会询问；右键文件/目录行可 New File、New Folder、Rename、Delete、Reveal in File Manager（文件删除会先确认，打开且脏时先走现有关标签确认）
- [ ] 文件树 Delete 确认后文件/目录移入系统废纸篓（Finder 废纸篓可见、可恢复）；非空目录同样可删；确认文案说明移入废纸篓（trash 语义，单测只覆盖缺失路径与越权拒绝，真实移入需人工验证）
- [ ] 打包构建（`tauri build`）后：Finder 双击 .md/.markdown/.mdx 用 oh-my-md 打开（"打开方式"可选、可设默认）；应用未运行时双击启动并直接打开该文件（不恢复上次会话）；应用运行中双击或拖文件到 Dock 图标在已有窗口打开；重复启动聚焦已有窗口不开新实例（dev 模式无法验证关联，需打包产物）
- [ ] 拖 .md 文件到编辑器窗口：打开该文件（复用脏标签确认/最近文件/文件树展开逻辑）；拖 .txt 无反应；拖图片仍走原通道插入 `assets/`（回归）；已打开同路径文件时聚焦已有标签
- [ ] 外部变更即时感知（notify 主通道）：打开文件与文件夹后，用其他编辑器改/删该文件 → 标签约 0.3–1s 内出现外部变更提示（不再等 2s）；git checkout/切分支后文件树几乎即时刷新；改动打开的文件夹内其他文件 → 文件树相应更新；30s 兜底轮询仍有效（watcher 丢事件场景代码保证，难以人工构造）
- [ ] 富文本粘贴：从浏览器复制含格式内容（标题/加粗/链接/列表/表格）粘贴 → 转为 Markdown 插入（turndown+GFM：表格管道语法、删除线 `~~`、代码围栏）；VS Code 复制代码粘贴 → 围栏代码块；纯文本复制粘贴行为与旧版一致（text/plain 等价时走默认通道）；截图粘贴仍走图片通道（引擎粘贴钩子在图片 flavor 时让位）
- [ ] front matter：文档顶部 `---`…`---` 块折叠为 "YAML front matter" chip（title 显示行数），点击进入源码编辑；⌘E 切源码模式全显；正文中的 `---` 分隔线不受影响；注意首行 `---` 且无闭合的行为变化：整块按 front matter 源码显示（不再当分隔线）；字数统计不含 front matter；front matter 内的 `#` 行不出现在大纲
- [ ] 版本历史：已保存文件每次保存成功后自动生成快照（`~/Library/Application Support/md.ohmy.desktop/snapshots/`，每文件保留最近 20 份）；File 菜单/命令面板「Version History…」列出时间+大小；"恢复"在新未命名标签打开快照内容且原文件不动（恢复后活动标签切换为快照标签，此时再开历史会提示无文件——切回原标签即可）；"Clear History" 清空后显示空态；未保存的 untitled 标签触发历史命令出现提示不弹层
- [ ] 应用菜单「检查更新…」无更新时状态区出现"已是最新版本"；无网络时静默失败不打断编辑；更新横幅（版本号 + 查看发布页 + 以后再说）需 release CI 产出 `latest.json` 后才能端到端验证（13-B 解锁项）；启动后台检查 8s 延迟、失败无提示
- [ ] 应用菜单「关于 oh-my-md」弹窗版本号与 `tauri.conf.json` 一致（`pnpm release:version` 单源同步，versionSync 测试守护）；设置/会话/恢复数据位于 `~/Library/Application Support/md.ohmy.desktop/`（首次启动自动从旧 temp 目录迁移，不再受系统清理影响）
- [ ] 打开深层子目录的 .md（FileTree 点开或搜索面板点结果）会逐级自动展开祖先目录并滚动到该文件；千级文件的目录展开后滚动无卡顿、无空白行（树行虚拟化）
- [ ] 右侧只有 Outline，没有 Export 面板；导出走 File 菜单或 ⇧⌘P
- [ ] Outline 可用左侧常驻窄条的按钮或 ⇧⌘O 折叠/展开（命令面板也有 Toggle outline）；折叠状态跨会话记住；折叠后面板 aria-hidden/inert，动画无文字挤压
- [ ] 大纲点击跳转到标题；状态栏显示 `{words} words · {chars} chars`、光标行列、live/source；中文文档按字计词
- [ ] ⇧⌘P 能打开/保存/切主题/Focus/导出；File 菜单与命令面板共用同一命令
- [ ] 编辑器排版快捷键（live/source 两模式一致）：⌘B 粗体、⌘I 斜体、⇧⌘X 删除线、⇧⌘` 行内代码、⇧⌘K 代码块、⌘1–⌘6 标题、⌥⌘7 有序列表、⌥⌘8 无序列表、⌥⌘9 引用、⌘K 插入链接；再次按同键可切换（去掉标记）；命令面板含同一组命令
- [ ] 原生菜单含 File / Edit / Format / View / Window 五组，且与命令面板共用同一命令：File 含 New/Open/Open Folder/Open Recent/Close/Save/Save As/Export▸(HTML/PDF/Image)；Edit 含剪贴板 + Find▸(Find ⌘F / Search in Folder ⇧⌘F)；Format 含 ⌘B/⌘I/⇧⌘X/⇧⌘`/⇧⌘K、⌘1–⌘6、⌥⌘7/8/9、⌘K 链接、Insert Image；View 含 Show Source Code ⌘E / Sidebar ⌘\ / Outline ⇧⌘O / Typewriter / Focus / Toggle Theme / Load Custom CSS，其中前五项为勾选项、勾选状态与 UI 实际一致且切标签后刷新；Window 含 Minimize ⌘M / Zoom / Toggle Full Screen / Bring All to Front
- [ ] Window 菜单四项真实生效：Minimize 最小化窗口（⌘M 同）、Zoom 在最大化/还原间切换、Toggle Full Screen 进出全屏、Bring All to Front 把窗口带到最前；从菜单触发与快捷键/红绿灯按钮行为一致
- [ ] 通过原生菜单触发格式/视图命令与快捷键结果一致（菜单 accelerator 会先于 webview 拦截按键）；⌘E 切 Source 后 View 菜单 Show Source Code 勾选状态同步
- [ ] ⌘F 打开文档查找条（不打开文件夹搜索）；Enter / ⌘G 下一个，⇧Enter / ⇧⌘G 上一个；Escape 关闭并焦点回编辑器；⌘H 展开替换；Replace 改当前匹配，Replace all 一次改完全部；区分大小写可选；`.*` 正则模式（`$1` 捕获替换生效、无效正则显示 role=alert 提示且不跳转）；全字匹配仅文本模式可用（正则开启时禁用），中文查询在全字模式下仍可命中
- [ ] ⇧⌘F 或 FileTree「Search in folder…」打开文件夹搜索 `.md`，点结果打开并定位；命中词高亮；默认大小写不敏感，Case 开关可区分大小写；超过 500 条命中显示封顶提示；快速改查询不闪旧结果
- [ ] ⌘P 或 File 菜单「Quick Open…」打开文件名快开（需已打开文件夹）：子串过滤大小写不敏感、↑↓ 移动高亮、Enter 打开所选、Esc 关闭、点击背景关闭；未打开文件夹时按 ⌘P 出现 transient 提示不弹层；超大文件夹（>5000 个 .md）显示截断提示
- [ ] 列表项 Enter 续写同类型 marker，空项退出列表；Tab / Shift-Tab 仅在列表项缩进/反缩进
- [ ] Settings → Spellcheck 打开后编辑区可对英文词显示原生拼写红线；关闭后 `.cm-content` 为 `spellcheck="false"`；改设置立即作用于当前文档
- [ ] 已保存文档停手约 1.5s 自动落盘；未保存 untitled 只进恢复；启动有恢复提示且不静默覆盖
- [ ] 导出 HTML 是源码投影（含公式/代码/表）；PDF / Image 弹出保存对话框（默认 `export.pdf` / `export.png`），确认后目标路径必须出现真实文件；由离屏 WKWebView 的 `createPDF` 生成（Image 再栅格化为 PNG），不是系统打印对话框，也不是把编辑器 DOM 截屏
- [ ] 含数学公式（KaTeX）、代码块、表格的文档导出 PDF/PNG：`window.__omdExportReady` 就绪前 WKWebView 最多等待 5 秒再截图；若超时界面出现警告提示（"Export warning:"）；正常导出文件完整呈现公式/代码/表格内容
- [ ] 亮/暗主题与自定义 CSS；Typewriter 当前行居中；Focus 非当前行降透明度
- [ ] 打开 `large.md` 后多标签切换与文件树刷新时滚动仍流畅

## 有序列表规范化确认（Source Fidelity）

Live Preview 打开含跳号有序列表（如 `1.` / `3.` / `7.`）时会改写 marker、显示 dirty 与非模态提示条。以下项需 `pnpm dev` 目视；VoiceOver / IME 在本环境未跑则标 **NOT RUN**。

- [ ] 打开 `1. / 3. / 7.` 文档：预览连续编号、源码已改写、dirty、提示条与状态栏 `Normalization review required`
- [ ] 等待超过 autosave 时长（约 1.5s）：磁盘文件仍保持跳号
- [ ] 点击 **Save normalization**：磁盘变为连续编号，提示消失，dirty 清除
- [ ] 点击 **Keep original numbers**：磁盘与编辑器恢复跳号，提示消失
- [ ] 提示出现后先编辑正文再保留原编号：正文编辑不丢
- [ ] 提示出现后切 Source 修改一个 marker 再保留原编号：手动编号不被覆盖；若 marker 被改过，出现 skipped 状态文案
- [ ] 保留原编号后继续编辑并来回切换 Source/Live：不再自动规范化；预览仍显示连续编号
- [ ] 关闭并重开同一文件：自动规范化策略恢复（跳号文件再次触发提示）
- [ ] Pending 时切 Source：提示仍在；返回 Live 后 id 不变，新 marker 合并到同一 pending
- [ ] 无 pending 时 Source→Live 若发生规范化：出现新的待确认提示
- [ ] Pending 时外部修改文件：选「加载磁盘」清 pending；选「保留我的」保留 pending
- [ ] 仅规范化造成 dirty 时关闭标签：仍触发未保存确认
- [ ] 中文输入法合成期间不触发编号改写 — **NOT RUN**（需 Tauri + IME）
- [ ] 多标签：后台 tab pending 切回时显示正确提示；活动 tab 不显示他人 pending
- [ ] 仅键盘 Tab 可到达保存/保留并完成操作 — **NOT RUN**（需 GUI）
- [ ] VoiceOver 朗读 status 文案与按钮名，busy 时按钮仍可聚焦 — **NOT RUN**（需 VoiceOver）

## Conflict-safe guarded save

外部修改、删除、symlink、权限与多标签冲突需 `pnpm dev` + 真实 macOS 文件系统目视；VoiceOver / IME 未跑则标 **NOT RUN**。

- [ ] 打开文件，在外部编辑器修改后保存，oh-my-md 不覆盖外部内容
- [ ] 在 temp 写入阶段模拟第二次外部改动，确认出现 conflict
- [ ] Autosave conflict 后继续输入，内容与 recovery 保留
- [ ] Compare 显示 current/disk 正确 hunk，点击可跳转
- [ ] Overwrite 前再次外部修改，确认出现新 conflict
- [ ] Reload 取消不改变内容；确认后加载点击时最新版本
- [ ] Save copy 写出当前内容，原标签 path/conflict 不变
- [ ] 外部删除 dirty 文件，验证 recreate / save copy / close and discard 三条路径
- [ ] 外部删除后同名文件重新出现，recreate 不覆盖新文件
- [ ] 修改 symlink 目标后保存，两个目标都不被误写
- [ ] Finder tags 与 permission bits 保存前后保持 — **NOT RUN**（需 macOS + Finder tags）
- [ ] 两标签同时保存，完成顺序不影响 active tab
- [ ] Conflict 时 Cmd+S 聚焦 banner，不覆盖
- [ ] 键盘与 VoiceOver 可操作 banner 和 diff panel — **NOT RUN**（需 GUI + VoiceOver）
- [ ] 中文路径、中文正文与 IME 编辑后保存正常 — **NOT RUN**（需 Tauri + IME）
- [ ] PathChanged 仅重开旧 resolved file，dirty 取消后内容不变
- [ ] Save As missing 目标竞态出现 symlink 时只允许换路径/取消
- [ ] PermissionDenied 可 Retry、Save copy 和 Reveal in File Manager

## P0 平台地基回归（macOS）

跨平台 P0 地基（平台检测、按平台格式化的快捷键标签、mac-only 导出命令过滤、诊断包跨平台化）不应改变 macOS 既有行为。需 `pnpm dev` 目视；未跑则标 **NOT RUN**。

- [ ] 命令面板（⇧⌘P）快捷键标签抽查：Save 为 ⌘S、Ordered list 为 ⌥⌘7，与改动前逐字一致（mac 仍显示 ⌘⇧⌥ 字形，不出现 Ctrl/Alt 字样）
- [ ] reveal 文案：文件树右键菜单与保存冲突横幅显示「Reveal in File Manager」（zh 界面为「在文件管理器中显示」），中英文均不再出现 Finder 字样
- [ ] 命令面板与 File▸Export 菜单在 mac 上仍显示 Export PDF / Export Image（`MACOS_ONLY_COMMANDS` 过滤仅作用于非 mac 平台），导出流程可用
- [ ] 菜单「导出诊断信息…」生成的 zip 含 `os.txt`（os_info 输出，替代旧 `uname.txt`），且仍不含任何文档正文

## Linux（P1）

在 Linux VM（UTM/arm64 Ubuntu 亦可，交互 QA 不要求与发布同 arch）跑 dev 版（`pnpm install && pnpm dev`）逐项目视；本环境无 VM，执行待人工，未跑项标 **NOT RUN**。

- [ ] 启动无 crash；窗口标题/图标正常。
- [ ] 应用内菜单栏（2026-08-19 D2 修订，替代旧 ☰ 单面板）：TopBar 上方一行 文件/编辑/格式/视图/帮助 五个顶级菜单，各自弹出独立下拉；点击开合、已打开时悬停其他顶级菜单切换；菜单条目全量可触发；文件菜单 Open Recent 展开列出最近文件并可打开；编辑菜单含 撤销/重做/剪切/复制/粘贴/全选（粘贴在 WebKitGTK 受限时静默失败，Ctrl+V 不受影响）；视图菜单前五项为勾选项且勾选状态与 UI 一致；帮助菜单 检查更新/导出诊断/关于（关于弹窗版本号正确）；文件菜单 设置… 打开设置、退出 关闭应用（Alt+F4 亦可）；Escape/外点关闭菜单。
- [ ] Ctrl 系快捷键：保存 Ctrl+S、查找 Ctrl+F、格式化 Ctrl+B/I/K、列表 Ctrl+Alt+7/8/9 与键位指南一致。
- [ ] 打开/保存/另存为对话框；覆盖保存已有文件（内容正确落盘）。
- [ ] 文件树：reveal（在文件管理器中显示）、删除进回收站（freedesktop Trash）、新建/重命名。
- [ ] 右键粘贴图片（裁决 D11：WebKitGTK 下右键是否异常移动光标；异常则维持 workaround，正常则把门控收窄为 `isMacOS()`）。
- [ ] 拖拽 .md 到窗口打开；CJK 中文字体渲染（PingFang 缺失时回落 Noto/YaHei 正常）。
- [ ] 外部修改文件 → watcher 提示；HTML 导出；PDF/PNG 入口不可见。
- [ ] Export Diagnostics 产出含 `os.txt` 与日志。

## Windows（P2）

在 Windows VM（或 CI 产出的 NSIS 包 + VM 安装；P3 前用 dev 版）逐项目视；本环境无 VM，执行待人工，未跑项标 **NOT RUN**。

- [ ] 启动无 crash、无多余控制台窗口（`windows_subsystem` 属性）。
- [ ] 应用内菜单栏全量走查（同 Linux 清单）。
- [ ] Ctrl 系快捷键全测（同 Linux 清单）。
- [ ] 双击 .md 经文件关联打开（argv 路径裁决 D12：中文/空格路径正常；失败则修 `lib.rs` 的 argv 处理并补单测）。
- [ ] 覆盖保存已有文件（裁决 A6：多次保存、保存同时被杀毒扫描不丢数据）。
- [ ] Explorer reveal、删除进回收站、重命名、新建。
- [ ] 右键粘贴截图/复制图片（WebView2 无 workaround 门控生效，光标不跳）。
- [ ] 拖拽 .md 到窗口打开；CJK 字体（YaHei 回落）。
- [ ] 外部修改 watcher 提示；HTML 导出；PDF/PNG 入口不可见；诊断包含 `os.txt`。

## 语种切换（i18n）

- 启动 OS=zh-CN：界面与原生菜单均为中文。
- 启动 OS=en：均为英文。
- Settings 选 `zh → en` 运行时切换：webview 文案、原生菜单、aria-label 同步变更，无需重启；焦点保留。
- 选 `auto` 并在系统设置切换语言后重启 oh-my-md：跟随系统。
- 切换后 `Cmd+S` / 打开 / 导出 等菜单操作正常。
- broken 图片在 `zh` 显示中文「加载失败」、`en` 显示英文等价。

**已知限制（i18n）**：错误提示 alert（Open failed / Folder listing failed / Export failed 等）、保存冲突横幅动作标签（Compare/Overwrite/Save copy…）、以及持久化/跳过标记状态横幅（DURABILITY_WARNING/SKIPPED_MARKERS_STATUS）在 zh 下仍为英文——这些是模块级常量或测试断言钉住的文案，需独立重构，不在本次 i18n 范围内。

## 自动化验证命令
- 引擎单测：`pnpm test`
- Desktop 类型检查与自动化：`pnpm --filter @omd/desktop test`
- 前端构建：`pnpm --filter @omd/desktop build`
- Rust 测试：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- Rust 构建：`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`

测试数量以命令当次输出为准，不在本清单固定。

## 最近一次验证记录

- 日期：2026-08-14（Task 14 / Conflict-safe guarded save）
- 自动化已通过：`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`、`pnpm test`（engine 179）、`pnpm --filter @omd/desktop test`（206）、`pnpm --filter @omd/desktop build`、`rg` 计划扫描无 TBD/TODO、`git diff --check`
- Conflict-safe GUI / VoiceOver / IME / Finder tags：本环境未执行 `pnpm dev`，上方新节交互项保持未勾选或标 **NOT RUN**
- 日期：2026-08-14（Task 8 / Source Fidelity）
- 自动化已通过：`pnpm test`（engine 179）、`pnpm --filter @omd/desktop test`（137）、`pnpm --filter @omd/desktop build`、`git diff --check`
- 有序列表规范化 GUI / VoiceOver / IME：本环境未执行 `pnpm dev`，上方新节交互项保持未勾选或标 **NOT RUN**
- 日期：2026-08-13
- 自动化已通过：`pnpm test`、`pnpm --filter @omd/desktop test`、`pnpm --filter @omd/desktop build`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`、`cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`、`git diff --check`。具体用例数以当次命令输出为准。
- 交互式 M2 QA：本环境未执行 `pnpm dev` GUI 清单，上方交互项保持未勾选。

## 发布与升级（13-A/13-B 烟测）

> 需要 `tauri build` 产物或真实 Release 的项目标注了前提；Apple 公证链路（B2/B3）解锁后补充。

- [ ] `pnpm release:version 0.2.0` 后四处版本号更新，`rg '"0\.1\.0"' package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json` 无残留，`rg '^version = "0\.1\.0"' apps/desktop/src-tauri/Cargo.toml` 无残留（验证后还原改动）。
- [ ] 菜单「导出诊断信息…」：保存 zip；zip 含版本与日志文件、不含任何文档正文。
- [ ] 断网状态下启动 App：8s 后无任何更新提示，编辑不受影响；「检查更新…」显示已是最新或静默，无未处理错误弹窗。
- [ ] （需打包产物）双击 `.md` / Finder 拖入 Dock 图标打开文件；再次启动聚焦既有窗口。
- [ ] （需 B3 Release）旧版本内「检查更新…」提示新版本 → 升级成功；`latest.json` 可访问。
- [ ] （需 B2 公证）干净 Mac 安装无 Gatekeeper 拦截，`spctl -a -vv` 通过。

## 性能（Spec 05）

- [ ] 50k 行样本（`makeBenchmarkDoc(50000)` 存盘后打开）：进入安全模式提示条出现、默认源码模式；滚动与 IME 输入手感记录。
- [ ] 安全模式状态栏显示「统计字数」按钮，点击后 1s 内出现实际字数。
- [ ] 安全模式手动切回 Live Preview（⌘E/菜单）：复杂块恢复渲染；同会话再次载入该文档不再强制源码模式。
- [ ] 10 标签 × 10k 行：前台输入无可感卡顿，切换标签 < 500ms（人感）。
- [ ] 发布前跑 `pnpm --filter @omd/engine bench`，数字记入发布说明（README 性能节同步）。

- [ ] 10MB/20MB 样本（`makeBenchmarkDocBytes` 存盘后打开）：逐键无可感卡顿（p95 < 16ms，安全模式源码）；连续输入 10s 后暂停，确认崩溃恢复文件包含末次内容（≤1s 窗口）。
- [ ] 防抖窗口内 ⌘S / 关闭标签 / 另存：落盘与 dirty 判定均基于最新输入（flush 生效）。
