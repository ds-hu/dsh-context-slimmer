# 开发决策记录（dev notes）

本文件记录实现过程中**偏离初版架构文档**、或对 DSH 行为做出明确取舍的决策。每条都注明证据与影响；后续维护者改动相关代码前必须先读本文件。

---

## DEV-1 未解决的失败 → 保留错误证据，而不是 drop

**决策**：失败的工具结果不做“删掉 + 一句经验教训”。TRIM 时保留精确证据（命令原文、退出码、首个错误行、关键栈帧、重试参数）；仅“同一失败的重复重试”允许 drop 为一行 `retry n, same failure, evidence unchanged`，且首次完整证据必须保留。

**理由**：2026 年研究显示错误信息是模型自我纠错的关键证据（context-irrelevance 报告 §7，Keep the Wrong Stuff In 等）；把失败改写成“教训”会诱导模型复述错误结论。初版 `docs/architecture.md` §3.4 的“失败直接 drop”表述作废，以本条为准。

---

## DEV-2 drop 占位文本由宿主生成

**决策**：计划的 `drop` 项只带 `index`/`op`/`reason`，不写替换文本；宿主生成以 `[elided by context-slimmer]` 开头的占位 stub，包含：原工具名/调用摘要、原字符数、可复原提示（重新执行同一调用即可）。

**理由**：模型不该为“删除”编造内容；stub 必须诚实、可恢复，且长度稳定（避免模型借 drop 写入长文）。`trim` 的文本仍由模型提供。

---

## DEV-3 trim 文本上限

**决策**：`trim` 文本拒绝边界 = `min(300 tokens, 原文 50%)`，其中 token 估算沿用项目口径 `chars / 4`（中文保守取 min）。超出 → **整单拒绝**（原子性），不得部分落地。

**理由**：调研报告显示“压缩后重写”最容易引入不忠实内容；50% 与 300 tokens 双重上限能区分“真正精简”与“重新生成”。实现见 `packages/core/lib/plan.js` 的 `MAX_TRIM_TOKENS`/`CHARS_PER_TOKEN`。

---

## DEV-4 payload 以 index 为主键，callId 不由模型引用

**决策**：CANDIDATES payload 每项前缀 `[#<index>] tool=<name> error=<bool> chars=<n>`，`index` 是 CANDIDATES 数组下标（0-based），**不是** session seq；宿主内部把 index 映射到 `callId`/`seq`，并写入批次元数据 `items[].callId` 供审计。模型输出只允许 index。

**理由**：模型对 seq 无直观概念、容易抄错；index 是 payload 自身顺序，稳定可验证。`plan.js` 对 index 做 dense/重复/越界断言。

---

## DEV-5 fork 子 Agent 无法替换 system prompt → 任务消息前言

**决策**：后台精简器的 system prompt 作为**单条 task user message 的显式前言**发送（用分隔线包围），不拼接进父会话历史，也不尝试覆盖子 Agent 的 system prompt。fork 子 Agent 继承父 preset 的 system prompt（`ctx.subagents.startActivation` 无 system-prompt hook），这一点不可改变。

**影响**：fork 子会话的 seed 前缀（父历史）保持字节一致 → KV 前缀缓存不受损；子 Agent 第一次请求中，任务消息在所有者历史之后追加。提示词因此不能依赖“system role 优先级”，关键规则在有界前言中重复强调。

---

## DEV-6 UI 数据通道：`compaction/prune.data.contextSlimmer` 扩展字段

**背景**：前端需要一行“已精简工具调用结果”。三个候选：

| 通道 | 结论 |
|---|---|
| `tool/result.data.meta` | ❌ 不可行。`Session.append` 的 `assertToolResultRewrite` 要求替换事件除 `message.content` 外与原文逐字段深相等，meta 不能改（离线实测 + 双人复核） |
| `appendPluginRecord`（`plugin:*`） | ❌ 不采用。DSH `practices.md` 明确它是 experimental 保留通道，Session 格式迁移只 best-effort 保留；且 client 端属于未知事件类型 |
| `compaction/prune.data` 扩展字段 | ✅ 采用。已知 log-only 事件类型、live append 接受（log-only 事件只做通用 JSON 校验）、snapshot/replay/seed 原样保留、原生 token-meter 只读官方三字段 |

**协议**：每条替换前紧邻 append `compaction/prune`（官方三字段 + `contextSlimmer`）；本批最后一条 `contextSlimmer.role='summary'` 携带整批摘要，是 UI 行的唯一数据源；前面各条 `role='item'`。client 半 Definition 只匹配 `role='summary'`。

**降级**：若带扩展字段的 append 抛错（未来版本收紧校验），本实例缓存 `extensionSupported=false`，之后只写官方三字段；替换照常落地，UI 行缺失，debug 日志记录。主流程绝不因 UI 记账失败而失败。

**风险披露**：这是对官方事件 data 的增量扩展（非新事件类型）。已在 `docs/protocol.md`、README 与 `docs/research/dsh-api-map.md` 如实记录；若 DSH 后续为该事件增加严格 schema，降级路径保证主功能仍工作。

---

## DEV-7 子 Agent 用原生结构化输出，不注册自定义工具

**决策**：后台精简器 = managed fork activation（`ctx.subagents.startActivation({provider:'fork', ...})`）+ 原生 `outputSchema` 能力。子 Agent 通过 manager 在创建窗口内原生挂载的 `structured_output` 工具提交计划；**不注册/不使用任何自定义模型工具**。

**理由**：
1. 外部插件不应 import `@deepseek-ai/dsh-tools`（`defineTool`/`ToolDefinition` 依赖 host 包，profile 顶层 `@deepseek-ai` 为空，只有本机 `/root/.dsh/profiles/node_modules` 这种非可移植软链才能解析）；
2. 原生结构化输出把“子 Agent 只能返回计划”变成框架级约束，比自定义工具更安全；
3. managed activation 自带 fork seed（完整父上下文），无需 import `buildForkSeed`。

**禁工具**：在 `agent/created` 监听中对保留的 `childId` 执行 `agent.ctx.tools.restrict({deny:<全局工具名>})`（官方 practices 推荐做法），并用 root 级 `tools/pre-execute` 守卫兜底（`exec.agent?.id === childId` 且工具名非 `structured_output` → deny）。`structured_output` 是 manager 的 scope-local 注册，不在 deny 名单位，天然保留。

**降级**：若 `activation.result.structured` 缺失，从 `result.output`（ContentBlock[]）中提取首个平衡 JSON 对象；仍失败则本批 no-op。

---

## DEV-8 依赖边界

**决策**：除 `@deepseek-ai/schemastery`（仅 core 的 Config schema 使用，npm 有同版本 3.19.0，跨副本 schema 对象可用于 Loader 校验/表单投影）外，所有包**不 import 任何 `@deepseek-ai/*` 包**。替换事件用纯 JSON 构造（`Session.append` 会校验并冻结）；事件读取走 `session.surface` / `session.eventAt` / `session.deriveEventMessage`。

**理由**：外部插件（profile 安装）不能依赖 DSH 安装目录的模块解析；`/root/.dsh/profiles/node_modules` 的软链是非可移植的本机配置。CI 里 npm workspaces 从 registry 安装 schemastery 即可。
