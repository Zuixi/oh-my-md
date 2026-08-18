# 14 AI and Plugin Boundaries 设计

**日期：** 2026-08-18
**状态：** 待用户审核（本轮只立规格，不实现；实现排在发布可靠性之后，见路线图 Phase C）
**父设计：** `docs/superpowers/specs/2026-08-10-oh-my-md-design.md`（尖刀之二："AI 原生块级操作"）
**路线图：** `docs/superpowers/specs/2026-08-13-00-product-roadmap-design.md` Phase C-14

## 1. 目标与非目标

**目标**

1. 定义块级 AI 操作的完整用户流：选块 → 操作菜单（润色/续写/翻译/自定义 prompt）→ 流式建议 → **diff 确认** → 用户确认才写回。**AI 永不直接改文档**。
2. Provider 抽象：OpenAI 兼容 HTTP（OpenAI/DeepSeek/任意兼容网关）+ Ollama 本地；密钥进 macOS Keychain，绝不落 settings.json/仓库。
3. 插件 capability 模型：第三方扩展声明式声明权限（文件/网络/剪贴板/密钥默认全关），运行时隔离边界。
4. 为 M4 实现计划提供全部接口签名与测试矩阵。

**非目标**

- 本规格不实现任何代码；插件运行时本身（加载器/沙箱）只在 §9 定义边界，另立规格。
- AI 文档级重写/聊天侧栏（只做块级）；自动定时任务。
- 训练/微调、自有模型服务。

## 2. 当前代码证据与待替换行为

- 零 AI 代码（`packages/engine/src`、`apps/desktop/src` 无 provider/流式实现）。
- 现成挂点：`BlockWidget`（`packages/engine/src/decorations/blockWidget.ts`）有 `✎` 编辑按钮与 hover 工具条模式——AI 操作菜单挂同一工具条；diff 呈现可复用 `DocumentDiffPanel.tsx` + `documentDiff.ts` 的行级 diff；Keychain 用 Rust `keyring` crate（需加依赖）。
- 网络约束：CSP `connect-src ipc: http://ipc.localhost ws:`——**必须**为用户配置的 provider 域名动态放开（或全部走 Rust 侧 reqwest，绕开 WebView CSP——**决策：走 Rust 侧代理**，WebView 不发外网请求，CSP 不动）。

## 3. 用户流程与状态机

```text
块 widget 工具条 → "AI" 菜单（无 Key 时先弹 Provider 设置）
  ├─ 选操作（润色/续写/翻译/自定义）→ 取块文本 → Rust stream 请求
  │     ├─ 流式返回 → diff 面板逐段填充（可随时取消）
  │     │     ├─ Accept → 单个 CodeMirror transaction 写回（userEvent: "ai.accept"）
  │     │     └─ Discard / Esc → 无痕关闭
  │     └─ 失败/超时/Key 失效 → toast（复用错误信封），文档不受影响
  └─ Provider 设置（模态）：Base URL / Model / Ollama 地址；Key 存 Keychain
```

**状态机（每请求）**：`idle → streaming → (accepted | discarded | failed)`；streaming 期间源块锁定为只读提示（不真正锁编辑，冲突时请求作废——内容 hash 不匹配即丢弃建议）。

## 4. TypeScript/Rust 接口及错误语义

**Engine（纯 TS，无网络）**：
```ts
// packages/engine/src/ai/diff.ts
export function aiBlockDiff(original: string, suggestion: string): AiDiffHunk[]
// packages/engine/src/ai/apply.ts
export function applyAiSuggestion(view: EditorView, blockFrom: number, blockTo: number, text: string, blockHash: string): boolean  // hash 不匹配返回 false，不写
```

**Rust（唯一网络出口）**：
```rust
#[tauri::command] async fn ai_stream(request: AiRequest, on_event: Channel<AiChunk>) -> Result<(), AiError>
// AiRequest { provider_id, base_url, model, prompt_kind, block_text, custom_prompt? }
// AiChunk: Delta(String) | Done(usage) | …；密钥经 keyring 读，绝不进 IPC 参数/日志
#[tauri::command] fn ai_set_key(provider_id: String, key: String) -> Result<(), String>   // 写 Keychain
#[tauri::command] fn ai_get_providers() -> Result<Vec<ProviderConfig>, String>           // 不含 key
```
错误信封复用 `{ok, error}`；超时 60s；无重试（用户手动重试）。

**Desktop**：`services.aiStream`（封装 Channel）、Provider 设置模态、AI 菜单挂进块工具条 facet（engine 提供 `aiActions` facet，desktop 注入菜单项——engine 保持无 AI 概念耦合，只提供挂点）。

## 5. 安全、无障碍、性能与迁移约束

- 密钥：Keychain（service `md.ohmy.desktop.ai`）；日志与诊断包红廉（diagnostics.rs 增 provider base_url 白名单字段也仅域名）。
- 网络：仅 Rust 侧；用户自担 provider 隐私——首次配置时明示"块文本将发送至 {base_url}"。
- 插件边界：`manifest.json` 声明 `capabilities: ["read:doc"|"net:{host}"|"clipboard"|"secret"]`，默认全关；无通用 `invoke`；API 为版本化的窄接口（`omd.editor.*`、`omd.ai.suggest()` 走同一 diff 流）。第三方代码跑在独立 Webview/Worker，永不进主 WebView。
- 无障碍：diff 面板全键盘操作（复用 DocumentDiffPanel 模型）；流式区域 `role="status"`。

## 6. 自动化测试矩阵

- Engine：`aiBlockDiff` 行级 diff 单测（中文/代码块边界）；`applyAiSuggestion` hash 不匹配拒写。
- Desktop harness：mock `aiStream` 流式三段 → diff 面板渐进渲染；Accept 写回一个 transaction 且撤销一步回原样；Esc 无痕；失败 toast。
- Rust：`ai_stream` 错误映射（超时/401/网络）单测（mock provider HTTP）。
- 回归：现有冲突保存流不被 AI transaction 干扰（同一保存队列语义测试）。

## 7. 手动 QA

真实 Ollama（本地）与一个 OpenAI 兼容服务各跑一遍全流；Key 在 Keychain（`security find-generic-password`）；断网/错 Key 的降级；IME 输入中触发的行为（取块快照在 composition 结束后）。

## 8. 文档更新

README 发布说明披露 AI 能力与隐私边界；apps/desktop/AGENTS.md 增 AI 域路由；known-gotchas 记 Channel 与流式渲染的坑。

## 9. 对后续规格提供的稳定接口

`aiActions` facet、`AiChunk` 协议、Keychain service 名、插件 manifest v1 字段——M4 实现计划据此拆 Task；插件运行时规格消费 §5 边界。
