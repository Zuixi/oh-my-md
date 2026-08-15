# 09 Workspace Operations

**日期：** 2026-08-16  
**状态：** 已确认  
**差距分析：** `docs/superpowers/specs/2026-08-16-industry-gap-analysis.md`  
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`

## 目标

文件夹树支持在授权根内新建、重命名、删除 Markdown 文件与子目录，并 Reveal in Finder。

## 非目标

- 不做跨卷移动、多选批量、Git 状态。
- 不做任意扩展名文件编辑；新建文件固定 `.md`。
- 不实现完整 Finder 替代。

## 当前证据

- Rust `list_dir` / `search_markdown` 只读。
- `FileTree.tsx` 单击打开/展开，无上下文菜单。
- `revealInFinder` 已在 DesktopServices 可选存在（冲突保存用）。

## 用户流程

右键文件行：

- New File / New Folder（在该目录；文件行则在父目录）
- Rename
- Delete（确认后删除；若已打开则关标签，dirty 先走现有关闭确认）
- Reveal in Finder

New File 默认名 `untitled.md`，重名则 `untitled-2.md`。Rename 校验：无 `/`、无 `..`、保留 `.md`。Delete 目录须为空，否则报错（YAGNI：不递归删）。

## 接口

Rust（均先 canonicalize，必须落在已授权 workspace 根内）：

```rust
create_markdown(dir: String, name: String) -> Result<String, String>
create_dir(dir: String, name: String) -> Result<String, String>
rename_path(from: String, to_name: String) -> Result<String, String>
delete_path(path: String) -> Result<(), String>
```

`to_name` 只是文件名，不是路径。序列化测试：若有结构体字段必须 camelCase JSON 断言。

前端 `DesktopServices` 对应方法。`FileTree` 增加 context menu；成功后 `listDir` 刷新该父节点。打开中的文件被 rename：更新 tab path 与 session baseline，不重读内容。

## 错误处理

- 越权 / `..`：Rust 返回错误字符串。
- 目标已存在：错误，不覆盖。
- 非空目录删除：错误。

## 测试

Rust：在临时目录创建/重命名/删除；拒绝 `../secret`；拒绝覆盖。

桌面：菜单动作调用 services；rename 打开中的 tab 更新 path。

## 文档

`docs/manual-qa.md` 文件树节补充 CRUD。`apps/desktop/AGENTS.md` 命令列表补充四条 IPC。
