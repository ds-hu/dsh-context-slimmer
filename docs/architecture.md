# dsh-context-slimmer 架构说明（v2.0）

> 状态：v0.2.0 实现契约。v1 的 fork-subagent 方案已被本文档第 3.2 节的直调 LLM 方案取代；
> 决策过程、根因证据与偏差记录见 [`docs/plan-v0.2.md`](plan-v0.2.md) 与
> [`docs/dev-notes.md`](dev-notes.md) 的 DEV-13/14。
> 目标读者：维护者、core-dev、ui-dev、qa-reviewer、ci-engineer。

## 1. 产品目标

对 DeepSeek Harness（dsh）Agent 的**工具调用结果**做模型驱动的选择性精简，降低长会话上下文压力，同时：

1. **Agent 无感知**：被精简的后果只出现在模型后续请求的 `deriveMessages()` 里；不注入提示消息、不改写任何事件内容以外的字段。
2. **用户可见历史不改写**：Chat 里原来的工具卡片保持原样；额外追加一行“已精简工具调用结果”（视觉对齐原生“上下文已压缩”行），可展开查看明细。所有事件 append-only。
3. **原生机制优先**：`compaction/prune` 影子记账 + `tool/result` surface 替换、`agent/pre-step` waterfall、`plugins.row.config` 原生配置页、bundle patch 多行开关；不 fork 进程之外的东西。
4. **覆盖所有 Agent**：根 Agent 与子 Agent（含 agent-team 成员）都按同一策略精简（issue #1）。
5. **默认谨慎**（issue #2）：默认 `conservative` 策略只做“可被程序证明无损”的整条 drop；长文本 read 与失败证据默认不动；`balanced`/`aggressive` 需显式开启。
6. **模块化**：每个功能模块是独立 npm 包 + 独立 Loader row，在原生插件面板中单独开关、单独配置、互不影响。
7. **规划器完全隐身**：选哪些结果可以删，由一个后台 LLM 调用决定；它不创建子会话、不出现在 WebUI“N 个子智能体”计数里、主 Agent 的 subagent 工具也列不出它。

## 2. 仓库 / 包结构（monorepo，npm workspaces）

```
dsh-context-slimmer/
├─ package.json                 # bundle 包 @ds-hu/dsh-context-slimmer（只含 patch + icon + locale + README）
├─ cordis.patch.yml             # 每个模块一行 insert（id = 模块包名导出的 name）
├─ packages/
│  ├─ core/                     # @ds-hu/dsh-context-slimmer-core（共享库，不是 Loader row，不可开关）
│  │  └─ lib/                   # 事件协议、替换原语、计划校验、prompt、计数器、Config schema
│  └─ tool-result-slimmer/      # @ds-hu/dsh-context-slimmer-tool-result（模块 1）
│     ├─ lib/index.js           # host 半：agent/pre-step + 直调 ctx.llm.stream 的规划器
│     ├─ lib/client.js          # client 半：手写 __ModuleLoader__ bundle（无构建），Chat 行 + 配置页
│     ├─ locale/*.json          # zh/en 标题描述（插件面板 + UI 文案）
│     ├─ icon.svg
│     └─ README.md
├─ docs/                        # 调研、API 取证、协议、架构、CI、QA 报告
├─ scripts/ci/                  # verify / benchmark / 发布辅助脚本
└─ .github/workflows/           # verify.yml、benchmark.yml、publish.yml
```

**为什么拆包**：原生插件面板的开关粒度 = Loader row 粒度，而一个 npm 包只能解析自己的 row。官方多模块范例（如 `@ds-hu/dsh-better-workspaces`）即 “bundle 包 + 每模块一个 npm 包 + 共享 core 包”。

**版本策略**：所有包同一版本号（lockstep），由 publish workflow 统一发布。

## 3. 模块 1：工具结果精简（tool-result-slimmer）

### 3.1 触发

- 监听 **`agent/pre-step`** waterfall（`@deepseek-ai/dsh-agent` 的 scope-filtered 事件，每步每个 Agent 在“上一批工具已结算、下一次请求尚未组装”之间 awaited 触发）。这是唯一能在模型下一次看到上下文之前、且 Agent 不在飞行中的安全阻塞点。
- **每个 Agent 都会触发**：根 Agent 与子 Agent（`session.header.origin === 'subagent'`，包括 `subagent_*` 工具与 agent-team 成员）。`includeSubagents` 默认 `true`；设为 `false` 时仅跳过 origin 为 `subagent` 的会话（注意：agent-team 成员同样标为 subagent）。规划器是纯 LLM 调用、不是 Agent，因此不存在递归。
- 按 session 维护计数器，统计“自上次精简以来”新增的 `tool/result` 数量与文本字符数；插件挂载后的首次 `pre-step` 只建立基线。
- 触发条件是 **AND**（避免小批次频繁打扰）：
  - `everyNToolCalls`（默认 `12`）：新增工具结果数 ≥ N；`0` 表示不按数量判断。
  - `minChars`（默认 `24000`）：新增工具结果文本字符数 ≥ 阈值；`0` 表示不按字符判断。
  - 两者同时满足才触发；触发后计数清零。`triggerOnErrorOnly=true` 时还要求窗口内出现过失败结果。
- 候选筛选（宿主纯函数，`packages/core/lib/replace.js#selectTargets`）：
  - 只看当前 surface 上已配对（assistant `tool/call` 之后）的 `tool/result`；
  - 最近 `protectRecent`（默认 `3`）条永不触碰；
  - 文本长度 < `minTargetChars`（默认 `4096`）不候选；
  - 扫描窗口 `max(protectRecent + maxTargets*3, 12)` 后再过滤，单批最多 `maxTargets`（默认 `4`）条；
  - 跳过本插件产生的替换事件（`surfaceOp !== 'append'` 或已带 `contextSlimmer` 元数据）。

### 3.2 规划器：直调 LLM，不创建子 Agent

一次运行的全部步骤都在 `agent/pre-step` 内完成（主 Agent 被阻塞，因此无并发写）：

1. 从当前 surface 选出候选目标，把“最近上下文 + 任务摘要 + 候选列表”组成规划器指令。
2. **`ctx.llm.stream(GenerateOptions)`**（host 半 `inject: ['llm']`；范本 = 官方 `dsh-compaction-basic` 的 `summarizeWithLlm`）：
   - `messages = [...session.deriveMessages(), { role: 'user', content: [{ type: 'text', text: instruction }] }]`
   - `toolHistory = session.toolHistory()`；**不传 `tools`**、**不传 `purpose`**（避免模型调用主 Agent 工具，也避免跨包枚举问题）
   - `sessionId = session.id`；`signal = AbortSignal.any([stepSignal, AbortSignal.timeout(timeoutMs)])`
   - 模型路由三级 fallback：`config.model.{provider,model}`（都非空）→ `session.requestHeader()?.config` → `agent.options`；都没有 → 本次 no-op + diagnostics `no-model`。
   - `reasoningEffort`：默认 `'inherit'` = 复制主模型本次路由的 effort（**保留思考**；面板可显式设为 off/low/medium/high/max…）。`maxOutputTokens`：默认 `0` = **不传**，跟随模型默认输出预算；显式设置时作为整个 completion（含推理）的上限。
   - **截断保护**：若本次显式设置了 `maxOutputTokens` 且 finish 为 `max-tokens`，自动**不带 maxTokens 重试一次**；仍截断才失败 no-op 并写 diagnostics `planner-truncated`。绝不应用半截计划。
   - 成功 finish 仅接受 `stop` / `tool-calls`；`max-tokens`/`aborted`/`error` 一律失败 no-op。
3. 输出解析：纯文本 JSON（容错：直接 parse → 代码围栏 → 首尾大括号 → 平衡扫描）；同时兼容把计划放在 `structured_output` tool-call 里的旧格式（**只读不执行**任何工具调用）。
4. 计划通过 `packages/core/lib/plan.js#validatePlan` 原子校验后，交给 `applyPlan` 落地（见 3.4）；任何失败（超时/模型失败/无效 JSON/策略拒绝/替换失败）都是 **no-op**，主 Agent 上下文不变。

**为什么不再 fork 子 Agent**（v0.1 → v0.2 的关键改动，见 plan §8/§10）：

- v0.1 的 fork 子 Agent 请求头带 `maxTokens: 2048` + 继承 `reasoningEffort: "max"`，而输出预算**同时覆盖推理与最终输出**；推理一开就耗尽 2048 → 生产日志里 14/15 个规划子会话 `turn/end.reason.kind = "max-tokens"`，最后一个 assistant message 只有 reasoning block，整批失败。v0.2 默认不设 maxTokens、默认继承推理档，且截断时自动重试无 cap。
- 直调 LLM 不写 `subagent/*` 事件、不产生子会话：WebUI 顶部“N 个子智能体”不计数，主 Agent 的 `list_agents`/`wait_agent` 也列不出规划器（产品要求）。
- 少一层 fork/seed/dispose 生命周期，成本与延迟更低。

**Prompt（`packages/core/lib/prompt.js` v1.4）**：policy-aware、zh/en 两套、每套 ≤2500 chars；只要求输出一个 JSON 对象、不解释/不思考、`reason` ≤20 字；conservative 明确“无法证明安全就返回 `{"items":[]}`”。不在 prompt 里要求任何工具调用。

### 3.3 策略与计划校验

`policy` 三档（默认 `conservative`）：

| 策略 | 允许的 op | 约束 |
|---|---|---|
| `conservative`（默认） | 仅 `drop` | 每条 drop 必须有**可程序校验的证据**：`duplicate`（`duplicateOf` 指向更晚、同 tool、归一化后逐字相等且未被同批 drop 的结果）、`superseded`（目标 `isError=true`，`supersededBy` 指向更晚、同 tool、成功且未被 drop 的结果）、`empty`（目标文本匹配核心 `EMPTY_OUTPUT_PATTERNS`）。**trim 整单拒绝**。 |
| `balanced` | drop + trim | drop 证据放宽；trim ≤ `min(50%, 4000 chars)`，且不得引入原文不存在的 URL/行号等。 |
| `aggressive` | drop + trim | v0.1 旧规则（trim ≤ min(50%, 300 tokens/1200 chars)），有损，需用户显式选择。 |

- 校验是**确定性宿主代码**，模型只是提议者：证据引用必须指向真实候选、逐字相等/更晚成功等条件由宿主重算；索引越界、重复、字段非法、策略不允许 → **整单拒绝**（原子性，不落地任何替换）。
- **20% 字符比例不是规则**：单批 drop 只受 `maxTargets` 约束；比例仅作为 benchmark 观测指标（plan §9 裁决）。
- drop 的替换文本由宿主生成并**指向保留副本**，例如
  `[elided by context-slimmer] duplicate of call_… (kept above) — content identical, do not re-read`；
  禁止出现“可重新读取/re-fetch”字样，避免诱发重复读取。

### 3.4 执行：影子记账 + surface 替换（append-only）

对每条通过校验的目标：

1. 先 append 官方 log-only **`compaction/prune`**：`{ shadowedRange:{start,end}, shadowedSeqs:[seq], shadowedTokenCount }`，并附加本仓库的 `data.contextSlimmer` 扩展字段；
2. 再 append **`tool/result`** 替换事件：`{...original.data, message:{...original.message, content}}`，`surfaceOp = { op:'replace', startSeq: seq, endSeq: seq }`，`sourceEventSeqs:[seq]`。`assertToolResultRewrite` 要求除 `message.content` 外逐字段深相等，因此 meta 原样复制。
3. `contextSlimmer` 是 UI 行与幂等的唯一数据源：每条 `role:'item'`，本批最后一条 `role:'summary'`（含 `status`、`trigger`、`model`、`items`、`totals`、可选的 `error`）。
4. 兼容降级：若带扩展字段的 prune 被更严格的运行时拒绝，本实例缓存 `extensionSupported=false`，之后只写官方三字段；替换照常落地，仅 UI 行缺失（`metaLanded:false`）。

安全阀：只替换当前 surface 上、已配对、未被 replace 过的 `tool/result`；替换内容必须比原文小；替换前复查目标仍是当前节点；失败整批回滚（已 append 的事件不会发生，因为先校验后写入）。

### 3.5 UI 行（client 半）

- 位置：Chat 对话流，锚定在本批最后一条替换事件之后；`ConversationNodeDefinition` 匹配
  `event.type === 'compaction/prune' && data.contextSlimmer?.role === 'summary'`，keyed slot `conversation.chat.node` 渲染。
- 文案：`已精简工具调用结果 · N 项 · 释放 C 字符`；展开显示每项 `#index tool · op · before→after`、触发条件、模型路由；非 `applied` 显示灰色分支。
- 视觉：复用原生“上下文已压缩”行的 typography/token（tertiary 文本 + 图标 + chevron + `aria-expanded`）。
- 实现：手写 `lib/client.js`（`window.__ModuleLoader__.load`，只 `require('react')`，无构建、无网络请求、不读 session 原文）。

### 3.6 原生插件面板配置页

- client 半注册 keyed slot **`plugins.row.config`**，key = `<bundle 包名>#<row id>` =
  `@ds-hu/dsh-context-slimmer#context-slimmer-tool-result`；owner props `{view:'summary'|'page', form?}`。
- Host `Config` 的**每个可编辑字段都 `.volatile()`**（嵌套 `model.*` 也必须逐字段标），否则 settings 不生成 form、写入会抛 `not volatile`。Loader 在调用 `apply` 前已完成校验，插件自身再次 `Config()` 前必须深度解包 cosmokit 引用（`unwrapVolatileDeep`）。
- 表单一次 `form.mutate(ops, form.state.revision)` 提交变更字段（嵌套 `path:['model','provider']`），写入 profile 的 `cordis.patch.yml`，Loader 热重载；冲突时提示“已刷新，请重试”。
- 字段（14 个）：`enabled`、`everyNToolCalls`、`minChars`、`protectRecent`、`minTargetChars`、`maxTargets`、`policy`、`includeSubagents`、`triggerOnErrorOnly`、`timeoutMs`、`model.provider`、`model.model`、`model.reasoningEffort`、`model.maxOutputTokens`。
- 已知限制：row 有 locale description 时原生 summary seat 不渲染（page 是主入口）；`promptLocale`/`diagnosticsFile` 不在 page 清单内，需要时直接改 profile patch。

### 3.7 模块独立性

- 模块 1 只依赖 core 纯库与 dsh 内置服务（`llm`、`slots`、`locale`、`uiConversation` 等），不提供/不消费自定义 service。
- 未来模块各自建包、各自 row；模块之间互不 import，只允许 import core 纯函数/常量。
- bundle 包本身不导出插件（只是一个 patch + locale + icon），不参与运行时。

## 4. 诊断与可观测

- `diagnosticsFile`（默认空 = 关闭）可以写 JSONL 诊断：`trigger`、`llm-result`、`plan`、`validate`、`apply`、`no-op`、`llm-error`、`planner-truncated`。
- 规划器元数据（`finishReason`、`usage.{promptTokens,completionTokens}`、`durationMs`、`retried`）会附加到 `llm-result`/`plan`/`validate`/`apply`，**不记录工具原文**。
- CI 用它做硬门禁：本次运行不得出现 `planner-truncated`；主日志不得出现 `subagent/*` 事件。

## 5. 质量门禁

1. **静态**：`node --check` 所有 `.js`；JSON/YAML 解析；`bash -n` 所有脚本；`npm pack --dry-run` 检查 files 白名单；locale key 完整性。
2. **单元（离线）**：core 纯函数（策略校验、证据重算、事件构造、prompt 长度、计数 AND 阈值、Config volatile 解包）+ host 测试（mock `ctx.llm.stream`：正常/无文本/截断重试/双重截断/超时/抛错/策略拒绝/subagent 开关）。
3. **CI 端到端（GitHub Actions，真实模型）**：起真实 dsh headless 会话（13 次工具调用：重复大 read、唯一大 read、失败命令、重复日志…），触发 conservative 精简；断言：prune/replacement 成对合法、`sourceEventSeqs` 正确、折叠后工具文本变短、用户可见 transcript 未改写、**无 `subagent/*` 事件**、diagnostics 无 `planner-truncated`；起 Web GUI + Playwright：截图“已精简工具调用结果”行 + 插件面板配置页（14 个 `data-field`），并断言页面无“N 个子智能体”计数。
4. **Benchmark（真实模型）**：baseline（插件 disabled）/conservative/aggressive 对比，5 个精确事实校验点 + planner 开销/截断统计；硬门禁 baseline 与 conservative 5/5、conservative 折叠后字符 < baseline、conservative 截断 0；见 [`docs/benchmark.md`](benchmark.md)。
5. **发布**：tag `v*` → 静态门禁 + `npm publish`（三个包，NPM_TOKEN）+ GitHub Release。
6. **生产安装**：`dsh plugin --profile <p> add @ds-hu/dsh-context-slimmer@<version>`；安装后在原生面板确认行存在、可配置、会话正常。

## 6. 安全与合规

- API key 只存在于环境变量 / GitHub Actions secret；仓库文件、README、日志、截图、benchmark artifact 均不得包含 key（CI `scan-secrets` 门禁）。
- 插件日志与诊断只记录字符数/条数/模型标识/耗时；不记录工具结果原文与用户消息；prompt 指令中要求模型不得复述原文（`reason` 写类别）。
- client 半无网络请求，只消费事件 payload。
- 只修改 profile 配置与自身安装的包；安装/卸载显式。

## 7. 兼容性与已知限制

- 需要 DSH `>=0.2.0 <0.3.0`、Node.js `>=24.9.0`。
- UI 行依赖 `compaction/prune` 的 additive 字段；未来运行时若拒绝，自动降级为“替换照常、行消失”。
- `includeSubagents=false` 会同时跳过 agent-team 成员（它们同样是 origin=`subagent`）。
- 面板自定义 page 取代原生自动表单：`promptLocale`/`diagnosticsFile` 不在 page 中（值保留、可经 profile patch 修改）。
- benchmark 单次运行为“方向性/非劣演示”，统计显著需 `workflow_dispatch` 提高 repetitions。

## 8. 关键文件索引

- 触发/规划/落地：`packages/tool-result-slimmer/lib/index.js`
- 事件协议：`packages/core/lib/events.js`；替换原语：`packages/core/lib/replace.js`
- 策略校验：`packages/core/lib/plan.js`；提示词：`packages/core/lib/prompt.js`
- 计数器/阈值：`packages/core/lib/counters.js`；Config：`packages/core/lib/config.js`
- UI 行 + 配置页：`packages/tool-result-slimmer/lib/client.js`
- 决策记录：`docs/plan-v0.2.md`、`docs/dev-notes.md`（DEV-13/14）
- 协议细节：`docs/protocol.md`；CI：`docs/ci.md`；QA：`docs/qa-report.md` / `docs/qa-report-v0.2.md`
