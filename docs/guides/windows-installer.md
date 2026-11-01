# Windows 安装包策略（单一 setup.exe）

> 平台说明：本文只覆盖 Windows 分发。macOS 走 `.dmg`，Linux 走 `.deb` / `.AppImage`，不在本文讨论范围。

oh-my-md 在 Windows 上只发布一个 NSIS 安装器 `oh-my-md_<版本>_x64-setup.exe`，与主流消费级产品（Git、VLC、VS Code）的"一个 exe"策略对齐。本文记录这套机制的边界、取舍与运维契约。

## 为什么只有一个 exe

历史上 Release 同时发布 NSIS setup.exe 与 WiX MSI 两种安装器。两者安装范围不同（NSIS 默认 per-user 写 `HKCU`，MSI 是 per-machine 写 `HKLM`），混装会在桌面产生双图标、在"设置 → 应用"产生双卸载项——静默安装（winget / Intune）下还会叠加安装。收敛到单一工件后，这类问题在结构上不存在。

三个渠道消费同一份字节：

| 渠道 | 形式 |
| --- | --- |
| 浏览器手动下载 | Release 页 / 更新器深链直下的同一个 setup.exe |
| 应用内自动更新 | Tauri updater 下载同一 setup.exe，验 minisign 签名后被动安装 |
| winget（规划中） | manifest 哈希钉住同一资产的 SHA256 |

MSI **不再随 Release 发布**，但保留了本地自建能力：`tauri.conf.json` 的 WiX 配置与图标素材都在，受管环境（Intune / SCCM / 组策略）需要 MSI 时自行 `pnpm --filter @omd/desktop tauri build --bundles msi` 构建即可。

## 关键配置（tauri.conf.json）

| 配置 | 值 | 理由 |
| --- | --- | --- |
| `bundle.windows.nsis.installMode` | `currentUser` | 与主流一致：无需 UAC、装到用户目录、注册 `HKCU`；也使静默升级不需要提权 |
| `bundle.windows.webviewInstallMode` | `downloadBootstrapper` + `silent` | 见下文取舍 |
| `bundle.targets` | `"all"` | 本地构建仍产 MSI 供企业自建；CI 显式 `--bundles nsis` 只发 exe |

### WebView2 引擎的取舍

| 方案 | 体积 | 离线 | 结论 |
| --- | --- | --- | --- |
| `downloadBootstrapper`（现选） | 安装器 ~7 MB | 需联网下载引擎 | Win10/11 绝大多数预装 WebView2，未预装时静默下载，与 VS Code 同策略 |
| `embedBootstrapper` | +2 MB | 仍需联网 | 无收益 |
| `offlineInstaller` | +约 127 MB | 完全离线 | 体积不可接受 |

注意：**updater 更新包始终使用 downloadBootstrapper**，与安装器配置无关（Tauri 行为）。

## 静默安装守卫（MSI 残留检测）

`windows/installer-text.nsh` 中的 `NSIS_HOOK_PREINSTALL` 钩子只在**静默模式**（`/S`）下检测残留的 per-machine MSI 安装：

- 检测方式与 Tauri 内置 WixMode 迁移完全同源：枚举 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`（64 位视图，见下），匹配 `DisplayName == oh-my-md` 且 `Publisher == ohmy`，且 `UninstallString` 含 `msiexec`
- 命中 → 安装中止，**进程退出码 1603**，不写入任何文件
- 退出码语义（winget / Intune 按此解读）：**1603 = 静默安装检测到 MSI 残留**，需人工运行一次交互向导完成迁移

为什么拒绝而不是自动迁移：卸载 per-machine MSI 需要管理员权限，而 currentUser 静默安装以普通用户运行，自动卸载必然失败；静默失败比明确拒绝更糟。

交互（双击）与 passive（`/P`，应用内更新使用）模式**不加守卫**——这两种模式由安装向导的 reinstall 页引导用户完成 MSI 卸载（会弹出 msiexec 卸载界面与 UAC，属预期行为）。

实现细节（修改钩子时必读）：

1. **注册表视图**：NSIS 安装器是 32 位进程，`HKLM` 访问默认被重定向到 `WOW6432Node`；而 MSI（x64 打包）注册在 64 位视图。钩子里必须 `SetRegView 64` 枚举、读完 `SetRegView 32` 恢复。这也解释了为什么 Tauri 内置 WixMode 检测在某些机器上"看不见"MSI。
2. **退出码**：NSIS Section 内的 `SetErrorLevel` 会被进程退出路径覆盖。正确做法是把码存入变量，在 `Function .onInstFailed`（Section `Abort` 触发）里重新 `SetErrorLevel`。
3. 测试注意：通过 `cmd /c ... %ERRORLEVEL%` 取码会拿到 wrapper 的 0；`Start-Process -Wait` 的 `ExitCode` 才是真实进程退出码。

## 命令行参数

| 参数 | 含义 |
| --- | --- |
| `/S` | 静默安装（无人值守） |
| `/P` | 被动安装（只显示进度条，应用内更新使用 `/P /UPDATE /R`） |
| `/NS` | 跳过创建快捷方式 |
| `/UPDATE` | 更新模式（由 updater 传入） |
| `/R` | 安装完成后重启应用 |
| `/D=<目录>` | 指定安装目录（必须为最后一个参数） |

企业批量部署：`setup.exe /S` 即可（遇到 MSI 残留退出码 1603，见上）。

## 更新器深链

check-only 安装（如历史 MSI 装）在应用内点"下载安装包"时，前端直接打开：

```
https://github.com/Zuixi/oh-my-md/releases/download/v<版本>/oh-my-md_<版本>_x64-setup.exe
```

- URL 构造器：`apps/desktop/src/constants.ts` 的 `windowsSetupAssetUrl(version, arch)`
- 打开失败时回退到 Release 列表页（`RELEASES_URL`）
- 该 URL 形状与 `scripts/update-manifest.mjs` 的 `immutableUrl` 一致，且被 release workflow 双重钉死（windows 与 publish 两个 job 都会在资产名缺失时 fail）

## 资产不可变策略

**已发布 Release 的资产字节永不替换。** 任何修复都以新版本号发新 Release。原因：winget manifest 与 `SHA256SUMS.txt` 都钉住资产哈希，替换字节会让所有已分发渠道的校验静默失败。

## 待办：代码签名与 publisher 字段

当前包未签名（SmartScreen 会警告）。签名落地时注意：`bundle.publisher`（当前沿用 identifier 派生的默认值 `ohmy`，同时作为注册表 Publisher 与 MSI 卸载匹配键）**必须与签名证书 subject 校准后再改**——单独改 publisher 会破坏对存量安装（含 MSI 残留检测、内置 WixMode 迁移）的匹配。改动时需一并提供存量迁移方案。

## 已知行为（非 bug）

- passive 应用内更新在"NSIS + MSI 双装"机器上会先弹 msiexec 卸载向导 + UAC，然后完成升级——一次性，之后收敛为单安装
- 静默安装遇 MSI 残留直接失败（1603），不做静默迁移——跨格式迁移必须人工跑一次向导
