# 日志与故障排查

oh-my-md 把诊断信息写进一个本地日志文件和一个可导出的诊断信息包。这份指南面向使用者：日志在哪、怎么开详细日志、怎么把诊断包发给维护者，以及日志里那几行 `session *` 是什么意思。实现细节见 `docs/superpowers/specs/2026-10-03-logging-and-diagnostics-design.md`。

## 日志文件在哪

一个日志文件同时接收 Rust 主进程和 webview 两边的记录，文件名是 `oh-my-md.log`；写满 2 MiB 后轮转，保留 5 份归档（归档名形如 `oh-my-md_2026-10-03_14-22-05.log`，时间戳是**本地时间**）。

| 平台 | 目录 |
| --- | --- |
| macOS | `~/Library/Logs/md.ohmy.desktop/`（没有 `logs/` 子目录） |
| Windows | `%LOCALAPPDATA%\md.ohmy.desktop\logs\` |
| Linux | `~/.local/share/md.ohmy.desktop/logs/` |

路径由 `TargetKind::LogDir` 的平台表决定（`tauri-plugin-log`）。只有 macOS 的位置是普通用户翻得到的，所以别让用户自己去找：

- 菜单 **Help → 打开日志目录**（Windows/Linux 是窗口内的横向菜单栏）会直接在文件管理器里打开该目录。
- 命令面板（⇧⌘P）里的 **Open Log Folder** 是同一个入口。
- 两者最终都调用 Rust 的 `open_log_dir`，它打开的是**本次运行实际使用的目录**，而不是按平台表重新算出来的路径。日志降级时（见下）打开的可能是临时目录。

## 日志打不开时会降级，不会崩

启动时、注册日志插件之前，程序会在目标目录里写一个 `.write_test_<pid>` 探针文件并立刻删除——是**写测试**，不是看权限位，因为 Windows 的只读属性和 Unix 的 mode 位都回答不了"这个进程现在能不能写"。探针失败时：

1. 改用 `<临时目录>/oh-my-md-<pid>.log`，状态标记为 `fallback`；
2. 连临时目录也失败，就完全不打日志，状态标记为 `disabled`。

无论哪种情况，**应用都必须能启动**（这是设计里最重要的一条：日志故障绝不允许升级成启动崩溃）。Settings 的 Logging 一节会在 `degraded` 时显示「日志记录已降级」并给出实际目的地。诊断包的 `environment.txt` 里也会记录同一个状态。

## 打开详细日志

两条路径，优先级从高到低：

1. **`OMD_LOG` 环境变量**（维护者用）。取值是单个级别名：`OMD_LOG=debug`、`OMD_LOG=trace`。它不是过滤器列表——`tao=warn,omd=debug` 这种写法解析不出级别，会被忽略。
2. **Settings →「启用详细日志」**（`verboseLogging`）。勾选后写入设置，**下次启动生效**；生效时进程级别提升到 `Debug`。

解析顺序是 `OMD_LOG` → 持久化的 `verboseLogging` → 编译时默认值（debug 构建 `Debug`，release 构建 `Info`）。`OMD_LOG` 写错时是**落到持久化开关**，不是落到编译默认值：一个拼写错误不该被当成"关掉我上次打开的详细日志"。所以想临时压过持久开关，用 `OMD_LOG=info`（这是合法级别，会生效）。

Settings 里的开关不是可选项：macOS 用户从 Finder 双击启动时**根本无法设置环境变量**，只有 `OMD_LOG` 一条路会恰好漏掉最需要报 bug 的那批人。

## 导出诊断信息包

菜单 **Help → 导出诊断信息…**（或命令面板里的 Export Diagnostics）→ 确认对话框说明将要包含什么 → 选择 `.zip` 保存位置。

包的内容（`manifest.json` 记录格式版本与每个文件的 blake3）：

| 条目 | 内容 |
| --- | --- |
| `manifest.json` | 包格式版本、生成时间、应用版本、系统/架构、生效日志级别、每个文件的大小与 blake3，以及 `previous_exit`（上次会话结论，见下节） |
| `version.txt` / `os.txt` | 应用版本 / 系统摘要 |
| `diagnostics.txt` | 合并后的日志（已脱敏），便于一次读全 |
| `oh-my-md.log` 及归档 | 逐个日志文件（已脱敏） |
| `environment.txt` | webview 版本、语言、dev/release、日志目录、日志降级状态等 |
| `settings.json` | 你的设置（已脱敏） |
| `session.json` | 会话恢复状态（路径已脱敏） |

**绝不含**：文档内容、版本历史快照、更新签名私钥。

脱敏发生在导出时（本地日志本身是全保真的）：家目录替换成 `<home>`，`file:///` URL 只留文件名，结构化路径字段（`path=…` / `paths=[…]`）里的非家目录绝对路径折叠成 `<path>/…/<文件名>`，`*_KEY` / `*_TOKEN` / `*_PASSWORD` 与 `Authorization:` 值整段删除。

> 目前**没有**"包含完整文件路径"的可达入口。命令参数 `include_full_paths` 仍在、也有测试，但 TypeScript 调用方永远传 `false`：当时唯一能用的界面是 `window.confirm`，它的 OK 按钮没法单独标注，而 OK 恰好等于"包含完整路径"——那是隐私上更危险的那个答案，所以那个提问被删掉了。要保留完整路径需要一个有独立标签的复选框，等它存在。

## 读 `session` 行：上次是不是崩了

启动时程序会读回上次运行留下的边界记录（当前日志 + 最新归档各取尾部 64 KiB，按时间顺序合并），然后在本次的 `session start` **之后**写一句人类可读的结论。三种标记行的含义：

| 行 | 写入时机 | 含义 |
| --- | --- | --- |
| `session start pid=<pid> version=<版本> mode=<release 或 debug>` | 启动、注册日志插件并完成上次扫描之后 | 本次会话开始的锚点 |
| `session exit intent=<原因>` | 收到退出请求、**任何 flush 之前** | 退出被请求过（当前版本写的是 `intent=user`，即用户主动退出） |
| `session end clean=true` | `RunEvent::Exit`，事件循环的终点 | 进程正常走完了退出流程 |

判定规则（只看**最后一个** `session start` 之后的内容）：

| `session start` 之后是什么 | 结论 | 级别 |
| --- | --- | --- |
| `session end clean=true` | 上次正常退出 | 不写（debug 级） |
| 只有 `session exit intent=…`，没有 `session end` | 退出被系统打断（macOS 注销/关机强杀） | `INFO`：`previous session was interrupted by the system` |
| 什么都没有 | **异常终止** | `WARN`：`previous session ended abnormally` |
| 两段尾部里都没有 `session start`（已轮转掉，或首次运行） | 未知 | `INFO`：`previous session outcome unknown (no markers in range)` |

要点：

- **`session start` 之后没有 `session end`，就是崩溃的样子**——SIGKILL、段错误、`kill -9`，或任何没走到事件循环终点就消失的进程。下次启动会看到 `session ended abnormally` 的 `WARN`。
- **有 `session exit intent=` 但没有 `session end`，是"操作系统打断了退出"**，不是崩溃。macOS 注销/关机时系统给的宽限期可能短于 flush 需要的 2 秒，于是进程被强杀；`intent=` 行在收到退出请求的瞬间就写了，所以这种情况下判定仍然是"被打断"，而不是误报崩溃。
- 正常退出两条都会写（先 `intent=`，后 `end clean=true`）；判定里只要看到 `clean=true` 就算正常退出。
- 跨轮转也成立：一次超长会话可能把 `session start` 留在归档、`session end` 留在当前文件，扫描会把两段拼起来看。
- 没有证据时**不下结论**：读不到 `session start` 就报"未知"，不报崩溃。日志尾部写盘后即已 flush，只有断电才可能丢最后几行，而那种情况正好落进"未知"。

判定结果也会作为一个字段写进诊断包的 `manifest.json`（`previous_exit`，含 pid、版本与人类可读的 reason）。

## 提交问题时的建议

1. 打开 **Settings → 日志**，确认没有出现「日志记录已降级」。若已降级，请把提示里给出的实际路径一并说明。
2. 如果是可复现的问题，先勾选 **启用详细日志**，重启，复现一次，再导出诊断包——详细日志记录了更多边界细节。
3. **Help → 导出诊断信息…** 导出 `.zip`，用一句话说明"发生了什么、期望什么、大概什么时间"，和包一起发出。
4. 如果怀疑是崩溃，先说清上次是怎么退出的（点了退出 / 直接关机 / 强制结束进程）——`session` 行的结论能对上，也能帮维护者确认要读哪一段日志。
