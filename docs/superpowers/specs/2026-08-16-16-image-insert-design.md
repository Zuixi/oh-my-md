# 16 Image Insert

**日期：** 2026-08-16  
**状态：** 已确认  
**差距分析：** `docs/superpowers/specs/2026-08-16-industry-gap-analysis.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

在现有粘贴截图路径上增加：拖放图片文件、命令面板「Insert image…」选文件。写入规则与粘贴相同。

## 非目标

- 不做图床、缩放语法、资源管理器、多图相册。
- 不改 `write_image` 的 `assets/` 相对路径约定。
- 不支持未保存 untitled 文档插入（与粘贴相同：先保存）。

## 当前证据

- `apps/desktop/src/imagePaste.ts`：剪贴板图片 → `write_image` → 插入 `![paste](assets/...)`。
- 限制：PNG/JPEG/WebP，≤ 10 MiB；需要 `documentPath`。
- `Editor.ts` 有 `dropCursor`，无图片 drop 处理。

## 用户流程

1. 将本地 png/jpg/webp 拖到编辑器：在 drop 位置插入，流程同粘贴。
2. 命令「Insert image…」：系统文件对话框，选中后插入到当前光标。
3. untitled / 超限 / 不支持类型：报错，不改文档。
4. 非图片文件 drop：交给 CodeMirror 默认（通常无操作或插入路径文本，不拦截）。

## 接口

把 `imagePaste.ts` 的写入+插入抽成：

```ts
export function insertImageFile(
  file: File,
  view: EditorView,
  options: ImagePasteOptions,
  mime: string,
  range?: { from: number; to: number },
): Promise<void>
```

现有 `pasteImage` 调用它。新增：

- `imageDropHandler`：`drop` 里若 `dataTransfer.files` 含支持的图片则 `preventDefault` 并调用 `insertImageFile`。
- `pickAndInsertImage(view, options, pick: () => Promise<File | null>)` 供命令面板。

桌面命令 id：`insert-image`，label `Insert image…`。`DesktopServices` 增加可选 `pickImagePath?: () => Promise<string | null>`；Rust/对话框过滤图片后缀。读盘在前端用 `fetch(convertFileSrc)` 或现有 File 路径不可用时：新增 `read_image_base64(path)` 太重——保持 Web 文件选择：`HTML input accept="image/png,image/jpeg,image/webp"`，避免新 IPC。

**裁定：** 选文件用隐藏 `<input type="file">`，不新增 Rust 命令。拖放用 `File`。两者都走 `insertImageFile`。

## 测试

扩展 `imagePaste.test.ts`：drop 图片会写入并插入；drop 文本不调用 write；untitled 报错；命令路径在 mock pick 返回 File 时插入。

## 文档

`docs/manual-qa.md` 增加拖放与 Insert image。
