# 26 版本历史快照（本地 snapshot）设计

**日期：** 2026-08-18
**状态：** 已确认，随本轮实现
**路线图关联：** 日常体验长尾（2026-08-18 产品化差距收敛计划 Phase 2.8）；强化"保存可靠性"产品叙事（Typora 有版本历史）

## 目标

每次保存成功后把落盘文件复制一份到本地快照区；「Version History…」弹层可查看某文件的历史快照，并把任一快照**恢复到新标签页**（绝不自动覆盖原文）。

## 非目标

- 自动恢复/时间机器（只做手动恢复）。
- 快照内容的 diff 视图。
- 云端/跨设备历史。
- 快照大小总配额（仅按文件数轮换；总量影响后续按需加）。

## 方案

**Rust（`workspace.rs`）**

- 快照区：`<config>/snapshots/<blake3(canonical path)[..16]>/<unix-millis>.md`——路径哈希隔离不同文件，毫秒时间戳即文件名（同毫秒重复保存覆盖同一份，天然去重）。
- `snapshot_document(path)`：canonical 校验（复用 `canonical_parent_and_name`，授权范围检查同其他 mutation）→ copy（非 rename，原文件不动）→ 轮换：按文件名（=时间）排序，只保留最新 `MAX_SNAPSHOTS_PER_FILE = 20` 份（具名常量，TS 侧同值 + drift test）。
- `list_snapshots(path) -> [{ fileName, mtimeMs, sizeBytes }]`（`#[serde(rename_all = "camelCase")]` + 序列化 JSON 断言——IPC casing 铁律）。
- `read_snapshot(path, fileName)`：fileName 必须匹配 `^[0-9]{1,19}\.md$`（防穿越/防逃逸出快照目录）。
- `clear_snapshots(path)`：删该文件的快照目录。
- 保存成功钩子：`documentSaveRunner.ts` 的 saved 分支调 `host.onSaved?.(targetPath)`（可选回调，测试 host 不实现也编译过）；App 桥接为 fire-and-forget `snapshotDocument`，失败静默（不得影响保存正确性）。

**前端**

- `VersionHistoryModal`：命令面板/`File > Version History…`（无快捷键）；列出当前标签文件的快照（时间 `toLocaleString` + 大小 KB），条目操作"恢复到新标签页"（`newTab` + `resetTabDocument` 注入快照内容，untitled 语义）；底部"清除历史"。无路径标签/无快照时空态文案。
- i18n 键 en/zh；菜单走 `MENU_TO_COMMAND["version-history"] = "history"`（crossLayerMenu 自动覆盖）。

## 测试矩阵

- Rust：JSON camelCase 断言；轮换只留 20 份（注入递增时间戳测内部函数）；`read_snapshot` 拒绝 `../` 与非数字名；越权路径拒绝。
- 桌面 harness：保存成功 → `snapshotDocument` 以目标路径被调用；历史弹层列出来自 `listSnapshots` 的条目；恢复 → 新标签内容为快照文本且原标签不动。
- crossLayerConstants：`MAX_SNAPSHOTS_PER_FILE` 两侧一致。

## 手动 QA

manual-qa.md：多次保存后打开 Version History 列表逐次出现；恢复到新标签页内容正确、原文件未动；清除历史后列表为空；快照目录位于 `~/Library/Application Support/md.ohmy.desktop/snapshots/`。

## 对后续规格提供的接口

`SnapshotEntry` 形状与快照目录布局；diff 视图（V2 候选）可直接消费 `read_snapshot`。
