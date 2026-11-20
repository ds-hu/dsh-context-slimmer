# v0.2.0 计划 — 收紧策略、覆盖 subagent、原生配置页、隐藏规划器

发布日期目标：2026-11-21。对应 GitHub issues #1（subagent 也要精简）与 #2（初版策略过激进），以及用户追加的两点：
配置 UI 进原生插件面板、规划器不计入「N 个子智能体」且对主 Agent 不可见。

本文件是 v0.2.0 的**绑定决策**；实现与 CI 断言以这里为准，偏离必须记录在 `docs/dev-notes.md` 的 DEV-13。

## 1. 规划器改为直接 LLM 调用（解决「隐藏子智能体」）

**决策**：删除 managed fork subagent 规划路径，改用 `ctx.llm.stream()` 一次性调用（与 `@deepseek-ai/dsh-compaction-basic` 的 `summarizeWithLlm` 同构）。

- inject：`['tools', 'llm']`（去掉 `subagents`）。
- 目标模型解析顺序（与 compaction-basic 一致）：
  1. 配置 `model.provider` + `model.model` 都非空 → 用它；
  2. 否则 `agent.session.requestHeader()?.config`；
  3. 否则 `agent.options.provider` + `agent.options.model`。
  全空 → `STATUS_FAILED` + diagnostics `no-model`（no-op）。
- 调用参数：`provider`、`model`、`messages: [...session.deriveMessages(), {role:'user', content:[{type:'text', text: '<planner instruction>'}]}]`、`toolHistory: session.toolHistory()`、`tools: session.requestHeader()?.tools`（存在时）、`maxTokens: model.maxOutputTokens ?? 2048`、`sessionId: session.id`、`purpose: 'compaction'`、`signal`（含硬超时）。
- 输出：优先从 `structured_output` tool call 提取（模型仍可能调用它，虽然不再有工具定义；保持兼容），否则拼接所有 text block，按现有 `extractPlan` 逻辑解析 JSON。
- 解析/校验/落地管线不变（prune + replacement）。
- 结果：主会话日志中**不再出现** `subagent/*` 事件，WebUI 顶部「N 个子智能体」不增加，主 Agent 的 subagent 工具也列不出规划器。
- cleanup：删除 host 中 fork activation、`agent/created` restrict、pre-execute guard、child session 相关代码；测试相应改为 mock `ctx.llm.stream`。
- 硬超时保留并简化：`AbortSignal.any([payload.signal, AbortSignal.timeout(timeoutMs)])`，超时 abort 流并返回 FAILED。

## 2. 覆盖 subagent（issue #1）

- 删除 `isSubagentSession` 跳过逻辑：`agent/pre-step` 对每个 Agent（root 或 subagent）都触发计时与判断。
- 计数 per-session（已有），锁 per-agent（已有则保留）。
- 新配置 `includeSubagents: boolean`，默认 `true`；关闭时仅 root（`session.header.origin !== 'subagent'`）触发。
- 保护：不触发条件：`agent.session === 规划调用目标`（无此概念，因为不再有子 Agent）；其余照旧（`tools/post-execute` 计数、`protectRecent`、已替换跳过）。
- 测试：host 单测覆盖“subagent 会话 origin='subagent' 且 includeSubagents=true 时触发”“false 时不触发”。

## 3. 保守默认策略（issue #2）

**新增 `policy` 配置**：`'conservative' | 'balanced' | 'aggressive'`，默认 `'conservative'`。旧行为对应 `'aggressive'`，保留但明确标注 lossy。

| policy | 允许的 op | 硬约束（core `validatePlan` 强制） |
| --- | --- | --- |
| conservative（默认） | 仅 `drop` | 只有证据类别 `duplicate`（内容逐字重复，后出现者保留）或 `superseded`（同一目标的失败尝试被后续成功结果覆盖）或 `empty`（无信息量输出，如 `(no output)`）才允许；`trim` 一律拒绝；单批最多 drop 20% 的目标 char（maxTargets×保护）|
| balanced | `drop` + `trim` | trim 上限 = 原文的 50% 且 ≤ 4000 chars；drop 同 conservative 证据要求 |
| aggressive | `drop` + `trim` | 现行 v0.1 规则：trim ≤ min(原文 50%, 300 tokens/1200 chars)；drop 证据放宽到 `irrelevant` |

- 提示词（`docs/research/prompt-final.md` v1.4）：conservative 只允许“重复/被覆盖/空输出”，并显式要求：**唯一的长文本读取结果一个字都不要动**；balanced/aggressive 的说明附在 prompt 的 policy 段。
- `claimedEvidenceTokens`（引用校验）保持 v0.1 的 URL + `file:line` 规则（R6）；conservative 下额外要求：被 drop 的目标必须在保留集合里有“重复来源或覆盖结果”的调用 id 引用（`replaces`/`duplicateOf` 字段，见 prompt 结构）。
- 计划 JSON 增加可选 `evidence.kind: 'duplicate'|'superseded'|'empty'|'irrelevant'|'redundant-blocks'`；conservative 校验必须匹配允许集合。
- 默认阈值更保守：`everyNToolCalls: 12`、`minChars: 24000`、`protectRecent: 3`、`minTargetChars: 4096`、`maxTargets: 4`；触发条件改为 **AND**（新增结果数 ≥ everyNToolCalls **且** 新增字符 ≥ minChars）——两个条件都满足才触发，避免小会话误触发。
- `triggerOnErrorOnly` 保留。

## 4. 原生插件面板配置页（用户点 1）

- 在 `packages/tool-result-slimmer/lib/client.js` 注册 `plugins.row.config`，key = `@ds-hu/dsh-context-slimmer#context-slimmer-tool-result`（`<bundle 包名>#<row id>`，见 `dsh-client-ui-plugin-manager` slot 契约）。
- owner props：`{ view: 'summary' | 'page', form?: ConfigPageForm }`。
  - `summary`：一行只读摘要，如 `每 12 次调用 · 保守策略 · 模型跟随当前 Agent`。
  - `page`：表单，字段：
    - `enabled`（开关）— 模块总开关（等价原生 row disabled 之外的软开关）
    - `everyNToolCalls`（number，1..200）
    - `minChars`（number，0..10_000_000）
    - `protectRecent`（number，0..50）
    - `minTargetChars`（number，0..1_000_000）
    - `maxTargets`（number，1..20）
    - `policy`（select：conservative/balanced/aggressive）
    - `includeSubagents`（checkbox）
    - `triggerOnErrorOnly`（checkbox）
    - `timeoutMs`（number，1000..600000）
    - `model.provider` / `model.model`（text，空=inherit；placeholder 说明）
    - `model.maxOutputTokens`（number）
  - 保存：一个「保存」按钮，把所有改动作为一次 `form.mutate(ops, revision)`（`{op:'set', path:['everyNToolCalls'], value}`）；成功后显示「已保存」，失败显示错误并重读。
  - 需处理 `form.state.status !== 'ready'`（loading/unavailable）与 `!writable`（只读）状态。
- 样式复用原生 token（`--dsw-alias-*`），单文件手写 bundle（现有构建方式），无新增依赖，`require('react')` 与 `require('react/jsx-runtime')` 可用（参考现有 client.js 写法；当前 client.js 只 require('react')，如需 jsx-runtime 需确认运行时 builtin 列表）。
- 测试：`test/client-smoke.test.mjs` 增加 form 渲染/修改 op 生成的离线 smoke（mock form）。
- CI 截图：打开插件面板 → 进入模块行 detail → 断言表单字段存在 → 截图 `verify-plugin-config.png`。

## 5. 基准对比（issue #2 的证据要求）

- 新增 `scripts/ci/benchmark.mjs` + `scripts/ci/benchmark-scenario.md`（场景 prompt）+ `.github/workflows/benchmark.yml`（也可并入 verify 的单独 job，手动/标签触发）。
- 单一复合场景（一次会话覆盖四类输出，控制成本）：
  1. 大文件 read 两遍（完全相同输出，可安全 drop 重复；第二次读的内容仍需在答案中使用）；
  2. 一个唯一大文件 read（信息不可丢，conservative 必须不动）；
  3. 一条失败命令（exit code/错误文本是答案依据）；
  4. 一段高重复日志输出（可安全 drop 重复块）。
  最终答案必须包含 5 个校验点（3 个来自唯一内容/失败证据，2 个来自重复内容），CI 断言全部出现。
- 每种模式跑一次：`baseline`（插件 disabled）、`conservative`、`aggressive`。记录：答案校验点通过数、重复 read 次数、总 token、折叠后工具文本字符数、prune/replace 数量。
- 硬门禁：baseline 与 conservative 都必须 5/5 通过；conservative 的模型可见工具文本必须 < baseline；aggressive 作为对照报告（允许失败/丢信息，不设门禁）。
- 输出：`docs/benchmark.md`（自动生成表格 + 结论段）+ artifact JSON；CI job summary 表格。
- 成本目标单轮 ≤ ¥1：`maxOutputTokens` 2048、reasoningEffort off、三次会话。

## 6. 版本与发布

- 三包版本 0.2.0；更新 `cordis.patch.yml`（无变化则不动）；README 策略/配置/截图更新；`docs/dev-notes.md` 追加 DEV-13（本计划决策）与 DEV-14（LLM 直调）。
- 发布：tag `v0.2.0` → publish workflow；然后 `dsh plugin --profile web add @ds-hu/dsh-context-slimmer@0.2.0` 更新生产 profile。
- 关闭 issue #1/#2：在各 issue 留言实现摘要 + CI run 链接 + benchmark 链接，然后 close。

## 7. 验收清单

- [ ] `npm run test` 全绿（新增策略/LLM/host/config 测试）
- [ ] verify workflow：真实会话仍 PASS、chat 行可见、无 subagent 计数、插件面板配置页截图可见
- [ ] benchmark workflow：baseline=conservative=5/5、conservative token 更少、aggressive 对照结果记录
- [ ] secret scan / pack / 文档同步
- [ ] 0.2.0 发布 + Release 截图 + 生产 profile 升级

## 8. 追加（运行中发现的回归）：规划器输出被截断

真实生产会话（v0.1.0 已装到本机 profile）暴露：规划子 Agent 思考过长 → 输出 token 上限 → 截断失败，用户一次会话里约 20 次 fork 子 Agent 大多失败。v0.2.0 一并修：

- **规划模型默认低 reasoning**：`model.reasoningEffort` 默认 `'off'`（panel 可改；适配器不接受时重试一次并记 diagnostics）。
- **输出预算**：`model.maxOutputTokens` 默认 4096（panel 可改）。
- **极简 prompt**：只输出 JSON，不要解释/思考；指令 ≤ 2500 chars；无法证明安全就返回空计划。
- **容错解析**：直接 JSON → 围栏/首尾 `{}` 提取；finish reason 为 max-tokens/length 或解析失败时 diagnostics 记 `planner-truncated`/`planner-invalid-json`，主流程 no-op。
- **可观测**：diagnostics 的 `plan`/`apply` 记录 planner 的 usage（prompt/completion tokens）、durationMs、finishReason，benchmark 汇总。
- **verify 断言**：e2e 的 diagnostics 中本次保守精简批次必须 `status=applied`（或合法 no-op 且非 truncation），且无 `planner-truncated`。
- 生产 profile 在 0.2.0 验证通过前临时 `disabled: true`，验证后再启用。
