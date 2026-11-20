# Changelog

All notable changes to the `@ds-hu/dsh-context-slimmer` bundle. Packages are versioned in lockstep.

## v0.2.0 — 2026-11-20

安全性与可靠性优先的版本：修复 issue #1、#2，重做规划器链路，新增原生插件面板配置页。

### Fixed

- **规划器输出被截断（v0.1.0 生产回归）**：v0.1.0 给后台 fork 子 Agent 硬编码 `maxTokens: 2048`，
  而输出预算同时覆盖推理 token 与最终输出；继承主模型 `reasoningEffort: "max"` 时推理先耗尽预算，
  生产日志里 14/15 个规划子会话以 `turn/end.reason.kind = "max-tokens"` 结束、没有任何计划输出。
  v0.2.0 默认**不设 `maxTokens` 上限**（`model.maxOutputTokens: 0` = 跟随模型默认），
  `model.reasoningEffort` 默认 `inherit`（保留思考）；只有显式设置上限且发生截断时才自动不带 cap
  重试一次，仍失败才整体 no-op 并写 `planner-truncated` 诊断。**不默认关闭思考。**
- **子 Agent 会话也参与精简（issue #1）**：`includeSubagents` 默认 `true`；根 Agent 与
  subagent / agent-team 成员会话都会触发精简（`session.header.origin === 'subagent'`）。
- **默认策略过激进（issue #2）**：默认 `policy: 'conservative'`，只做宿主可重新验证证据的整条
  drop（`duplicateOf` 逐字相等 / `supersededBy` 失败→后续成功 / `empty` 空输出）；禁止 trim。
  `balanced` / `aggressive` 需显式开启。触发条件改为 **AND**（`everyNToolCalls=12` 且
  `minChars=24000`），`protectRecent=3`、`minTargetChars=4096`、`maxTargets=4`。
- 宿主对“逐字相同的重复读取”提供确定性提示；若模型在 conservative 下返回空计划，宿主会对可证明
  重复做确定性兜底（重新走同一套 `validatePlan`），避免保守策略退化为永远 no-op。

### Changed

- **规划器改为直调 `ctx.llm.stream()`**：不再 fork 子 Agent。没有 `subagent/*` 会话事件，
  不计入 WebUI “N 个子智能体”，主 Agent 的 subagent 工具也列不出规划器。
- 精简阈值与精简模型现在可在 **原生插件面板** 中点击模块标题配置并实时生效（14 个字段，含
  `everyNToolCalls`、`minChars`、`policy`、`includeSubagents`、`model.provider/model`、
  `model.reasoningEffort`、`model.maxOutputTokens` 等）；写入 profile 的 `cordis.patch.yml`。
- drop 替换文案指向保留副本并明确 `do not re-read`，避免诱发重复读取。
- 提示词升级为 v1.4：极简纯 JSON 输出、policy 分档、保守档“无法证明安全就返回空计划”。
- 诊断（`diagnosticsFile`）新增 planner `finishReason` / `usage` / `durationMs` / `retried`
  与 `planner-truncated` / `planner-invalid-json` 记录。

### Added

- CI benchmark（`.github/workflows/benchmark.yml`）：baseline / conservative / aggressive 对比，
  5 个精确事实校验点 + planner 开销/截断统计，硬门禁 conservative 截断=0 且质量不劣。
- verify e2e 新增硬门禁：主日志无 `subagent/*` 事件、diagnostics 无 `planner-truncated`；
  Playwright 截图新增原生配置页并断言 14 个字段、页面无“N 个子智能体”计数。

### Benchmark（single-run，非统计显著）

| 模式 | 校验点 | 折叠后工具文本 | drops/trims | planner 截断 |
| :-- | :-- | --: | :-- | --: |
| baseline（插件 disabled） | 5/5 | 89,153 字符 | 0/0 | 0 |
| conservative（默认） | 5/5 | 59,142 字符（-33.7%） | 2/0 | 0 |
| aggressive（仅报告） | 5/5 | 36,778 字符（-58.7%） | 0/2 | 0 |

详见 [`docs/benchmark.md`](docs/benchmark.md)。

### Upgrade notes

- 升级后默认策略是 conservative：只会删除有可验证证据的重复/被覆盖/空输出，**不会再 trim 长文本**。
  需要旧行为请显式设置 `policy: aggressive`。
- 若你在 v0.1.0 里显式设置过 `model.maxOutputTokens`（例如 2048），请改成 `0` 或足够大的值：
  该上限包含推理 token，过小会导致规划器截断。
- 子 Agent 会话默认也会被精简；如需只处理根 Agent，设置 `includeSubagents: false`。

## v0.1.0 — 2026-11-19

- 首个版本：`tool-result-slimmer` 模块（fork 子 Agent 规划器）、原生风格“已精简工具调用结果”行、
  bundle patch 模块化行、离线单测与 GitHub Actions verify/publish 流水线。
