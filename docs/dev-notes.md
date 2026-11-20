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

---

## DEV-9 子 Agent 提示词与结构化输出（R5 收口）

**决策**：后台精简器使用 managed fork activation + 原生 `outputSchema`，提示词里的提交通道改为 manager 在子 Agent 创建窗口内原生挂载的 `structured_output` 工具：

- `packages/core/lib/prompt.js` 的 `SLIM_SYSTEM_PROMPT_ZH` / `SLIM_SYSTEM_PROMPT_EN` 中原两处 `slim_tool_results` 改为 `structured_output`（`调用一次 structured_output 提交计划` / `只调用一次 structured_output`）。两个标识符都是 17 字符，因此 prompt-final §5 的 `ZH.length === 1199`、`EN.length === 2819`、英文 words 419 等长度断言**不变**（快照测试仍全绿）；`SLIM_TOOL_DESCRIPTION`（112 words）保留为“计划含义”的描述段，但不再注册任何自定义模型工具。
- 计划读取顺序：`activation.result.structured` 优先（provider 已按 outputSchema 校验）；缺失时从 `result.output`（`ContentBlock[]`）的文本里提取 ```json 代码块或首个平衡 JSON 对象；仍失败 → 本批 no-op。宿主再用 `validatePlan` 做权威校验（schema 只做提示）。
- `packages/core/lib/plan.js` 新增 `buildPlanJsonSchema()`，只使用 enforced subset 允许的关键字（type / properties / required / additionalProperties / items / enum / description），**不含** `maxItems`、`minimum`、`maxLength` 等被 `assertObjectJsonSchema` 拒绝的关键字；长度/越界边界全部由 `validatePlan`（`MAX_PLAN_ITEMS`、`MAX_TRIM_TOKENS=300`、50% 原文）在宿主侧强制。已用安装版 `@deepseek-ai/dsh-tools` 的 `assertObjectJsonSchema` 离线验证本 schema 通过。
- 不允许直接 `import @deepseek-ai/dsh-tools`（外部插件依赖边界，见 DEV-8），因此不调用 `defineTool`；`structured_output` 由 manager 在子 scope 内注册，不在我们 `ctx.tools.definitions()` 的全局 deny 名单里，天然保留；root 级 `tools/pre-execute` 兜底守卫只放行 `structured_output`，其余一律 deny。
- 风险：fork provider 必须声明 `capabilities.outputSchema` 与 `agentOptions`（安装版 `dsh-subagent-fork-in-process` 两者均为 true；`agentOptions` 用于 `model`/`maxTokens` 覆盖）。若未来 provider 不支持，`startActivation` 抛错 → 本批 `failed`、主循环无感。

**文档同步**：`docs/research/prompt-final.md` 由 paper-researcher 升 v1.2 记录本次工具名迁移（Lead 已安排），实现以本仓 `prompt.js` 常量为准。

---

## DEV-10 可选诊断文件（`diagnosticsFile`）

**用途**：CI e2e/线上排查“子 Agent 已完成但 0 prune/0 replace”这类**静默 no-op**。精简链路跨进程/跨子会话，仅靠宿主日志很难定位卡在 trigger、计划提取、计划校验还是替换落地。

**决策**：`Config.diagnosticsFile`（string，默认 `''` = 关闭）。非空时 `SlimmerHost` 在关键节点向该路径 append JSONL，每行一个 `{ts, kind, sessionId?, ...}`：

| kind | 关键字段 |
| :-- | :-- |
| `trigger` | observedCalls/observedChars/observedErrorCalls、targets[{seq,tool,isError,chars}] |
| `activation-start` | childId、targets 数量 |
| `activation-error` | stage（start/result）、error（≤500 字符） |
| `result` | stopReason、structuredType、outputBlockCount、textRawLength |
| `plan` | 提取到的计划快照（items[].text 先截 120 code points，整体 JSON ≤4000 字符） |
| `validate` | ok；失败时 code + message（完整 message 便于定位） |
| `apply` | items/charsSaved/degraded/metaLanded，或异常 message |
| `no-op` | reason: no-text-plan / no-structure / empty-items |

**安全与边界**：
- 默认关闭；生产环境无需开启。只写派生字段；计划文本先截断，**绝不写入完整工具结果原文**（`plan.items[].text` 120 code points、错误 500、整行 JSON 4000）。
- 所有写入 `try/catch` 吞掉异常：诊断失败绝不影响主 Agent 循环。
- 路径由用户/CI 提供，需运行进程可写；不自动建目录、不轮转（CI 每次 fresh 目录，本地按需自行清理）。
- CI：`scripts/ci/slimmer-config.default.json` 设置为 `/tmp/ci-artifacts/slimmer-diagnostics.jsonl`，verify.yml 的 artifact 已覆盖该目录；失败时直接 grep `"kind":"validate"` / `"kind":"no-op"` 定位根因。
- 实现：`packages/core/lib/config.js`（字段/校验）、`packages/tool-result-slimmer/lib/index.js` 的 `SlimmerHost.diag()` 与 `sanitizePlanForLog()`；测试 `host.test.mjs` 覆盖“成功/失败路径均有合法 JSONL”“未配置不创建文件”。

---

## DEV-11 子 Agent 未提交 outputSchema 时 stopReason 被改写为 `'error'`：成功与否按“计划能否提取”判定

**机制（源码证据）**：managed fork activation 带 `outputSchema` 时，若子 Agent 结束前**没有调用 `structured_output`**（例如把合法 JSON 计划直接写在最终 assistant 文本里），`dsh-subagent` 的 `captureLocalResult` 会把 `stopReason` 从 `'completed'` **改写为字符串 `'error'`**，且结果对象**不含 `structured` 字段**；`output` 仍保留最终 assistant 的 `ContentBlock[]`（含文本计划）。证据：`dsh-subagent/lib/index.js:1104-1127`、`dsh-subagent/lib/types/activation.js:74-88`、`dsh-subagent/lib/types/types.d.ts:237-262`。

**此前的错误**：host 先判 `stopReason !== 'completed'` → 直接返回 `failed`，**没有走到文本兜底**，导致两轮 CI 中“子 Agent 返回合法文本计划却被静默 no-op”。

**决策**：批次成败由「能否提取出计划」决定，而不是单独由 `stopReason` 决定。顺序：
1. `stopReason ∈ {aborted, max-tokens, refusal}` → 永远失败（即使带 `structured` 也不得改写父 surface）；
2. 先 `extractPlan(result)`（`structured` 优先；否则把 **所有** text blocks 拼接后提取 ```json 代码块/首个平衡 JSON 对象）；
3. `plan !== null` → 无论 `stopReason` 是 `completed` 还是被改写的 `error`，继续 `validatePlan` → `applyPlan`（这是正常的结构化输出降级路径，不算子 Agent 故障）；
4. `plan === null` 且 `stopReason === 'error'` → `failed`（诊断 reason `no-plan:error`）；
5. `plan === null` 且 `stopReason === 'completed'` → `no-op`（reason `text-plan-parse-failed`；若 `structured` 存在但不可用则 `no-structure`）。

**诊断补充（DEV-10 字段）**：`result` 事件记录 `stopReason`（字符串）、`structuredPresent`、`structuredType`、`outputBlockCount`、`textRawLength`，以及 `result.diagnostic` 非空时的前 200 字符（不参与解析）；`no-op`/`activation-error` 的 reason 使用固定枚举：`text-plan-parse-failed`、`no-structure`、`empty-items`、`no-plan:<stopReason>`、`stop:<stopReason>`。

**测试**：`host.test.mjs` 新增「`stopReason:'error'` + `structured` 缺失 + output 文本计划 → 必须落 prune→replace 且末条 summary」正例；新增「`aborted`/`max-tokens`/`refusal` + 有 `structured` 也不落地」负例；原「stopReason error 且无 plan → failed」用例语义保留。

---

## DEV-12 硬超时语义：发布前后都覆盖

**决策**：`config.timeoutMs` 是**硬超时**，覆盖两个阶段：`startActivation` 发布窗口与 `activation.result` 运行窗口。实现：一个 `AbortController` + 一个覆盖全程的 `setTimeout`，两个 await 都 `Promise.race([..., timeoutPromise])`；超时分支先 `aborter.abort()` 取消子激活、diagnostics 记 `activation-error stage:'start-timeout'|'result-timeout'`、`finally` 中 `await dispose()`（catch 吞掉 teardown 错误）后返回 `STATUS_FAILED`，主 Agent 的 `agent/pre-step` 正常返回其 decision（对主会话即 no-op）。`parentSignal` 仍通过 `AbortSignal.any` 合并，turn 取消同样会中止子激活。

**测试**：`host.test.mjs` → “hard timeout: a never-settling activation.result fails the run without blocking the step”（`timeoutMs: 20`，断言 pre-step 正常返回、耗时受控、0 个 surface 事件、activation 被 dispose、计数窗口重置）。
