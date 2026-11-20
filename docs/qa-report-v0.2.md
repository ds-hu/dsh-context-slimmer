# v0.2.0 独立 QA 审查报告 — `@ds-hu/dsh-context-slimmer`

- 审查者：qa-reviewer（独立于实现；只读审查，本轮唯一写入本文件）
- 审查快照：`main` @ **`29bb89d`**（`ci: harden v0.2.0 evidence + release docs`）。审查期间 main 从 Lead 点名的 `d3ad126` 滚动到 `40db396`（文档）、`aeb0c61`（默认策略修复）、`29bb89d`（CI/发布文档/截图收口）；`29bb89d` 未改 `packages/` 运行时代码（只动 `.github`/`CHANGELOG`/`docs`/`scripts/ci`），因此 §1.2/§2 的运行时证据（`aeb0c61` 绿）仍然有效；报告落盘后工作树又出现队友的发布文档改动（CHANGELOG/benchmark/截图，均为 docs 非运行时代码），不影响本报告结论。
- 版本：三包均 `0.2.0`；**尚未打 tag、未发布**（`git ls-remote --tags` 仅 `v0.1.0`；`gh release list` 仅 v0.1.0；npm 仅 `0.0.0-stage`/`0.1.0`）。
- 依据：`docs/plan-v0.2.md`（含 §8–§11 根因/裁决/实现约束）、`docs/architecture.md` v2.0、`docs/dev-notes.md` DEV-13..16、`docs/ci.md`、`.github/workflows/*`。
- 约束遵守：未启动 dsh、未调用模型 API、未改 profile、未 git push；只运行离线脚本与只读 `gh`/`git` 查询。

## 0. 结论：**PASS（无未关闭 P0）**；发布前需处理 2 项 P1

| 维度 | 结论 | 依据 |
| --- | --- | --- |
| host 策略/规划器（对照 plan §1–§3、§8–§11） | **PASS** | 直调 `ctx.llm.stream`、无 `subagent/*`；`reasoningEffort` 默认 inherit、`maxOutputTokens` 默认 0 不传 cap、截断重试不带 cap；AND 阈值；includeSubagents；conservative 证据校验；diagnostics 字段齐全（§3） |
| client 配置页 | **PASS** | slot key/14 字段/`form.state` 兜底/一次 `mutate(ops, revision)`/冲突与传输失败处理/无网络；真实浏览器 artifact 实测 `configStatus=ready`、14 个 `data-field` 全可见（§4） |
| 安全/隐私/打包 | **PASS**（1 条 P2 打包建议） | secret scan（含 `--publish`）全 OK；日志/diagnostics 不落工具原文；三包 files 白名单无测试/密钥；locale 完整 |
| 离线校验 | **PASS** | 干净 archive `aeb0c61`：**62/62 tests pass**、`node --check` 25 文件 0 失败、`bash -n` OK、JSON 8/YAML 4 解析 OK、3 个 dry-run OK、两个 self-test PASS、pack 12/9/29 files |
| 真实 e2e / benchmark（CI） | **PASS**（`aeb0c61`） | verify run `44749045095` 全绿（真实 conservative drop + UI 行 + 配置页）；benchmark run `44749045128` gate PASS（baseline/conservative 各 5/5）（§1） |
| 发布切点 | **FAIL（P1-1）** | 候选提交 `d3ad126` 的 verify 硬门红（run `44747543737`，默认 conservative 在真实会话 0 精简）；必须改以 `aeb0c61` 打 tag |
| 升级兼容 | **FAIL（P1-2）** | v0.1 文档中的 `forkProvider` 配置在 v0.2 被 `unknown-config-key` 拒绝 → 行静默 inert；`docs/ci.md:113` 仍在教用户写它 |

- **P0（release-blocking，未关闭）：0**。`d3ad126` 上曾出现 P0 级缺陷（默认策略在真实会话完全不生效），但**已在发布前被 `aeb0c61` 修复并由 CI 复验**；因此当前无 P0，但发布切点必须修正（P1-1）。
- **P1：2 项**（§6.1）；**P2：10 项**（§6.2）。

## 1. 真实 e2e / benchmark 证据（以下均为 CI artifact/日志实测）

### 1.1 `d3ad126`（Lead 点名的 v0.2.0 提交）verify 红 —— 修复前的问题

run `44747543737`（verify，failure）的关键日志：

```
[PASS] no-subagent-events: no subagent/* events ... (v0.2 planner is a direct LLM call)
[FAIL] slimmer-prune-record: compaction/prune events with contextSlimmer: 0 ...
[FAIL] surface-replacement: 0 tool/result replacement(s) of 0 replace event(s)
[PASS] planner-diagnostics-present: kinds=[trigger, llm-start, llm-result, plan, validate, no-op]
[PASS] no-planner-truncated: finishReasons=[stop]
[PASS] planner-observability: 1/2 records carry usage; promptTokens=44812, completionTokens=11, durationMs=2874
```

即：规划器**正常调用且未截断**（finish=stop），但 conservative 默认策略返回了空计划（completion 11 tokens ≈ `{"items":[]}`），`validate` 通过后 no-op → 0 精简，`derived-context-shrank`/`projected-tool-context-smaller` 失败。根因是：conservative 要求 `duplicateOf` 证据引用，而 `d3ad126` 宿主未向模型提供确定性重复证据/候选提示，模型无法证明安全 → 按提示词要求返回空计划，真实场景（13 个工具结果、含一次重复大文件读取）默认配置下完全不精简。

### 1.2 `aeb0c61`（当前 HEAD）verify 绿 —— 修复后的完整证据

run `44749045095`（verify，success），artifact `verify-evidence-44749045095`：

- 会话 `session-9c06b667-…`，**121 events**；13 个 `tool/call`、14 个 `tool/result`；
- `[PASS] no-subagent-events`（无 `subagent/*`）；`planner-diagnostics-present` kinds=`[trigger, llm-start, llm-result, plan, validate, apply]`；
- 1 条 summary prune（batchId `22993229-…`，`trigger{observedCalls:12,observedChars:51252}`，`model{provider:'deepseek-official',model:'deepseek-flash',inherited:true}`）；
- item：`read` **24,638 → 122 chars（-99.5%）**，`op='drop'`，`evidence.kind='duplicate'`，“与#1逐字相同”；
- replacement **seq 106 ← [17]**，shadow-price prune 紧邻，transcript append-only（30 nodes，hash 不变）、`transcript-not-rewritten` PASS；
- fold 后模型可见工具文本 **51,263 → 26,747 chars**；savings 24,516 chars；`stream-cross-check` 13/13；
- 浏览器截图：`ui_assert_status=found`（chat 行可见，`rowBoundingBox{y:740,h:28}`）、`subagentCounter.status=absent`、`pluginsPanel=found`、`pluginConfig.status=found`（`configStatus=ready`、14 个 `data-field` 全可见）。**这同时验证了 plan §7 的“chat 行可见 + 无 subagent 计数 + 配置页截图可见”。**

### 1.3 `aeb0c61` benchmark 绿（issue #2 证据）

run `44749045128`（benchmark，success），artifact `benchmark-evidence-44749045128/tmp/ci-artifacts/benchmark-summary.md`：

| mode | scores | folded tool chars (median) | drops/trims | planner truncations |
| --- | --- | --: | :-- | --: |
| baseline | 5 | 89,153 | 0/0 | 0 |
| conservative | 5 | **59,142** | 2/0 | **0** |
| aggressive | 5 | 36,778 | 0/2 | 0 |

`gate=PASS`：baseline 与 conservative 均 5/5、conservative 折叠后更小、conservative 至少一次精简且无 `planner-truncated`（与 plan §5/§9 一致）；aggressive 作为对照记录、无门禁（符合 plan）。

### 1.4 发布状态

当前**没有 v0.2.0 tag/Release，npm 也没有 0.2.0 包**。结合 §1.1：**不得以 `d3ad126` 作为 v0.2.0 的发布提交**（其自身 verify 硬门红）；应以 `29bb89d`（或其后提交）打 tag。`29bb89d` 的 verify 与 benchmark **均已绿**（verify run `44750200879`、benchmark run `44750200676`）。`29bb89d` 新增 `CHANGELOG.md`（v0.2.0 条目，含 Upgrade notes）、刷新 `docs/benchmark.md` 与 5 张 release 截图，属发布文档收口。

## 2. 离线校验（在 `git archive aeb0c61` 的干净副本上执行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `node --test packages/core/test/*.test.mjs packages/tool-result-slimmer/test/*.test.mjs` | **62 tests / 62 pass / 0 fail**（core 44 + module 18；`29bb89d` 未改 packages，结论不变） |
| 语法 | 全部 25 个 `.js`/`.mjs` `node --check` | 0 失败 |
| Shell 语法 | `bash -n scripts/ci/*.sh` | OK |
| JSON/YAML | 8 个 JSON、4 个 YAML（3 workflows + patch）解析 | OK |
| assert 自检 | `node scripts/ci/assert-slimming.mjs --self-test` | SELF-TEST PASS（含 installed fold） |
| benchmark 自检 | `node scripts/ci/benchmark.mjs --self-test` | SELF-TEST PASS（含 truncation invalidates conservative） |
| CI helper dry-run | `screenshot.mjs` / `run-scenario.sh` / `prepare-profile.sh --dry-run` | 均 exit 0（无 profile/网络/模型变更） |
| 密钥扫描 | `bash scripts/ci/scan-secrets.sh`；`--publish` | 均 `OK: no credential-shaped material found` |
| 三包打包面 | `npm pack --dry-run --json` | core **12** files、module **9** files、bundle **29** files；均无 test/CI 脚本/密钥 |
| 版本/骨架 | 三个 `package.json` | 均 `0.2.0`；`cordis.patch.yml` 单 insert、`id: context-slimmer-tool-result` ≡ 模块导出 `name` ≡ 包名短横线；locale zh/en 完整（client-smoke 断言） |

## 3. host 审查（对照 plan §1–§3、§8–§11 与 architecture v2.0）— PASS

| 要求 | 结论 | 证据（`aeb0c61`） |
| --- | --- | --- |
| 直调 `ctx.llm.stream`，无 fork/subagent 事件 | PASS | `packages/tool-result-slimmer/lib/index.js:52` `inject=['llm']`；e2e `no-subagent-events` PASS；`list_agents`/WebUI 计数不增（`subagentCounter=absent`） |
| 模型三级 fallback；全空→failed/no-op `no-model` | PASS | `packages/core/lib/config.js:316-336`（config → requestHeader.config → agent.options）；host `:469-478`（no-model diag + reset） |
| `reasoningEffort` 默认 inherit（不默认关思考） | PASS | `config.js:138` 默认 `'inherit'`；`resolveModelTarget` 复制主路由 effort（`:319-329`）；host 仅在定义时传 `:514` |
| `maxOutputTokens` 默认 0（不传 cap） | PASS | `config.js:139` 默认 `0`；host `:507-517` 仅 `>0` 时传 `maxTokens`；e2e diagnostics 无截断 |
| 截断重试不带 cap；仍截断才 `planner-truncated`+no-op | PASS | host `:550-642`：max-tokens 且显式 cap → 删 `maxTokens` 重试一次；再截断写 `planner-truncated` 并 FAILED；不应用半截计划 |
| 成功 finish 仅 stop/tool-calls/none；aborted/error 失败 | PASS | host `:616-640`；diagnostics `llm-result`/`llm-error` |
| AND 阈值（count≥N 且 chars≥M） | PASS | `packages/core/lib/counters.js:78-86`；e2e trigger `{observedCalls:12, observedChars:51252}` |
| `includeSubagents` 默认 true；false 仅 root | PASS | `config.js:172-173`；host `:337-353, 380-390`；host.test 覆盖 |
| conservative：duplicate（逐字/同 tool/保留副本未 drop）、superseded（失败→更晚成功同 tool）、empty；trim 拒绝 | PASS | `packages/core/lib/plan.js:353-464`（`CONSERVATIVE_EVIDENCE_KINDS` `:63`；`item-not-duplicate` `:409,412`；`item-not-superseded` `:427,437`；`policy-op-trim` `:304`）；e2e 实测 drop duplicate 通过 |
| 计划 JSON 不伪造引用、原子拒绝 | PASS | `plan.js` 未命中引用/非法 index/未知字段 → 整单 `ok:false`；host `:662-677` |
| diagnostics 字段（finishReason/usage/durationMs/retried/plan/apply） | PASS | host `:526-540`（llm-start）、`:589-610`（llm-result）、`:599-642`（plan/validate 附 `plannerInfo`）、`:689-712`（apply）；`plan`/`apply` 记录 usage `{promptTokens,completionTokens}`；点号均落在有界/sanitized 值上 |
| 失败 no-op、主循环不受影响 | PASS | `onPreStep` 捕获异常（`:363-372`）；超时/abort → FAILED 并清计数；e2e 与单测覆盖 |
| volatile 深度解包（DEV-15） | PASS | `config.js:86-99`（结构检测 `get()`，递归数组/plain object，不改入参）+ `:237` 二次校验前解包；config.test 覆盖 |
| 无递归、per-session 计数、锁 | PASS | counters keyed by session id；`runningAgents` per agent id；规划器为纯 LLM 调用，无递归 |

## 4. client 配置页审查 — PASS

| 要求 | 结论 | 证据（`aeb0c61`） |
| --- | --- | --- |
| `plugins.row.config` slot + key `@ds-hu/dsh-context-slimmer#context-slimmer-tool-result` | PASS | `client.js:77` slot、`:80` key；`ctx.slots.register({name,key,locale})` `:1609-1613`；真实浏览器 `pluginConfig=found` |
| 14 字段（enabled/everyNToolCalls/minChars/protectRecent/minTargetChars/maxTargets/policy/includeSubagents/triggerOnErrorOnly/timeoutMs/model.provider/model.model/model.reasoningEffort/model.maxOutputTokens） | PASS | `client.js:1071-1086`；artifact `dataFields` 恰为上述 14 个；`verify.yml:184` 选择器全部命中 |
| `form` undefined / `state.status`（loading/unavailable/no-form）/ `writable=false` 兜底 | PASS | `client.js:1392-1408`（summary/status）、`:1422-1557`（page 分支与只读横幅） |
| 一次 `form.mutate(ops, revision)` 原子保存 | PASS | `client.js:1458-1482`：`buildOps(base,draft)` 生成仅变化字段的 `set` ops，单次 `form.mutate(ops, state.revision)`；无第二次写 |
| 冲突/传输失败处理；保留编辑并重读 | PASS | `accepted===false` → `failedRefresh` 文案与 `editing=false`（宿主 recovery read 后快照回落）；异常 → `failed` 文案并保留 draft；`:1464-1482, 1518-1540` |
| 无网络请求 | PASS | 全文件仅 `require('react')`（`client.js:40`）；无 fetch/XHR/WebSocket |
| 字典完整/zh-en 一致 | PASS | client-smoke 词典 key 集合断言；locale `{zh,en}.json` 完整 |

## 5. 安全 / 打包 — PASS（1 条 P2 建议）

- 密钥：`scan-secrets.sh` 与 `--publish` 均无命中；CI secret gate 只判断非空、不 echo key（`verify.yml:152-163`）；`/tmp/ci-env.sh` 不含 key 且不在上传 artifact 根内；artifact 仅 `/tmp/ci-artifacts`（web.log 里只有临时 localhost session token，无 API key）。
- 不落原文：host 日志错误截 200 字符、plan diag 的 item `text` 截 120 字符、`textHead` 200 字符（`index.js:863-904`）；diag 只记 index/chars/reason/model/usage 等派生字段；e2e artifact 中未出现完整工具输出。
- 依赖边界：core 仅 `@deepseek-ai/schemastery ~3.19.0`；module 的 `@deepseek-ai/cordis` 是 peer；无 dsh 运行时 import；client 仅 react。
- locale：root/module 的 zh/en 均完整；`meta.title/description` 存在。
- 打包面（回答 Lead 的“根包含 docs 是否可接受”）：**安全上可接受**（无密钥、无测试、`--publish` OK），但 bundle tarball 31 files 约 1.19 MB，包含内部 `docs/qa-report.md`、本轮 `docs/qa-report-v0.2.md`、`docs/research/*`（含 114 KB api-map）与 `docs/screenshots/*.png`（5 张约 700 KB）——建议 `files` 排除内部 QA/调研/截图（或白名单只保留 architecture/protocol/dev-notes/ui-notes），避免用户包体膨胀与内部报告外发；`CHANGELOG.md` 反而未包含，建议显式加入。

## 6. 问题清单

### 6.1 P1（发布前必须处理，2 项）

| # | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| P1-1 | **发布切点错误风险**：`d3ad126` 的 verify 硬门红（真实保守批次 0 精简，run `44747543737`）；缺陷已在 `aeb0c61` 修复并通过 verify/benchmark。若按 Lead 所说以 `d3ad126` 打 v0.2.0 tag，将发布一个自身验收不通过的版本 | CI 事实：run `44747543737`(d3ad126, verify failure) vs `44749045095`(aeb0c61, verify success)、`44749045128`(benchmark success)；无 v0.2.0 tag/npm 包；HEAD `29bb89d` 的 verify/benchmark 均已绿（run `44750200879`/`44750200676`） | 以 `29bb89d`（或其后提交）打 tag；tag 前确认 `origin/main==tag commit` 且 verify+benchmark 均绿（至少含 §1.2/§1.3 同等证据）；Release notes 附 run 链接；不要复用 `d3ad126` |
| P1-2 | **0.1.0→0.2.0 配置迁移**：v0.1 文档中的 `forkProvider` 键被 `unknown-config-key` 拒绝；`apply()` 捕获后只 `logger.warn` 并返回 → row 静默 inert（用户以为启用实际无行为）。`docs/ci.md:113` 仍是 `"forkProvider": "fork"` 示例；`CHANGELOG.md` 的 Upgrade notes 也未提“forkProvider 已被移除，必须从 profile 配置删除” | `config.js:102-116`（CONFIG_KEYS 不含 forkProvider）、`:221-225`（unknown key 抛错）、`index.js:917-921`（catch→warn→return）；`docs/ci.md:113`；无 migration 文档（grep 仅 dev-notes 提及 “forkProvider is gone”） | a) 把 `forkProvider` 加入“兼容接受并忽略”+ deprecation warning（不参与冻结配置）；b) 更新 `docs/ci.md` 旧示例与 v0.1 段落；c) README 增加 “Upgrading from 0.1.0”（forkProvider 移除、reasoningEffort 默认 inherit、maxOutputTokens 0、 conservative 默认只 drop）；`model.reasoningEffort: null` 实测已被容错为 inherit，无需处理 |

### 6.2 P2（建议，10 项）

1. **绑定计划文档漂移**：`docs/plan-v0.2.md:12` 仍写 `inject: ['tools','llm']`、`:18` 写 `tools: session.requestHeader()?.tools`/`purpose:'compaction'`/`maxTokens ?? 2048`，与实现（`index.js:52` `['llm']`；不传 tools/purpose；仅显式 >0 传 maxTokens）不一致；§8 `:105-106` 的 `'off'/4096` 已被 §10 `:133-135` 取代。建议在 §1/§8 标注 superseded（DEV-14 已有依据），避免按“绑定计划”验收时误判。
2. **模块包 description 过时**：`packages/tool-result-slimmer/package.json:4` 仍写 “a background fork subagent periodically drops or trims”，v0.2 已改为直调 LLM 且默认仅 drop（用户可见于插件面板/文档）。建议更新为 “direct-LLM planner; conservative default drops provably redundant results”。
3. **`docs/ci.md` v0.1 残留**：`:113` forkProvider 配置示例、`:367` 旧 fork 子会话说明、§9 本地自检（`:304+`）仍是 v0.1 断言/数字；与 P1-2 同源，建议整节顺带清理。
4. **benchmark `retried` 统计 bug（已在 `29bb89d` 修复）**：此前 `scripts/ci/benchmark.mjs` 用 JSON 文本匹配 `retry|retried`，会命中每条 plan/apply 记录的 `"retried": false` → 干净 run 被记为 retried（run `44747543865` conservative 显示 retried=3，实际 0）；`29bb89d` 已改为仅布尔判断（`benchmark.mjs:386`），无需再改。
5. **打包面清理**：见 §5——bundle 31 files 含内部 QA/研究/截图（约 1.19 MB，`docs/qa-report-v0.2.md` 也会被打入）；安全可接受，建议 `files` 排除或白名单化；另 `CHANGELOG.md` 未在 `files` 白名单内（发布包不包含 changelog，建议加入）。
6. **verify e2e 硬依赖 diagnostics 文件**（`verify.yml:284`）：dispatch 输入 `slimmer_config` 若未含 `diagnosticsFile` 或指向别处 → assert 直接 fail（“diagnostics file does not exist”），对手动触发是误伤；建议 assert 从插件配置读取路径，或该检查给出明确“配置未开诊断”的提示后再决定是否硬门。
7. **UI/config 断言仍非致命**：`verify.yml:325-328` 只对 `ui_assert_status` 打 warning，`screenshot.mjs` 的 `pluginConfig` 也是非致命；本轮 artifact 已 `found`/`ready`，但发布验收仍依赖人工看图。建议稳定后把 `--fail-on-missing-ui-text` 与 config-page 选择器设为硬门（或 nightly/`workflow_dispatch` 硬门）。
8. **`no-planner-truncated` 扫描范围过大**：`scripts/ci/assert-slimming.mjs:565-574` 对整份 diagnostics 文件判截断，不区分批次；同一 session 多次 trigger 时，早前批次的 truncation 会让后续成功批次误红。建议按 batchId/最后一次 trigger 过滤。
9. **发布 CI 证据收口**：审查中看到的 CI 修复已由 `29bb89d` 提交（benchmark artifact 扁平化、retried 统计、observability 文案、配置页截图更高 viewport）；但其 verify/benchmark 报告时仍 in_progress，tag 前必须等两 workflow 绿，否则 tag 内容缺少可引用的发布证据。
10. **真实 subagent 覆盖缺口**：`includeSubagents=true` 只有 host 单测（fake session origin=subagent）；真实 e2e 场景没有 subagent（`--require-no-subagents` 只证明主日志无 subagent 事件，不代表 subagent 会话精简路径已在真实环境跑通）。建议加一个 subagent e2e 或至少在 `docs/ci.md` 标注该路径仅单测覆盖。

## 7. 未覆盖 / 残余风险

1. **配置页写路径未在真实浏览器验证**：CI 只验证渲染/字段存在；`form.mutate` 实际保存、冲突恢复、只读状态没有端到端点击测试（单测/结构测试覆盖）。
2. **模型行为随机性**：conservative 依赖模型返回证据计划；`aeb0c61` 用宿主确定性 duplicate hints + empty-plan fallback 消除了“重复读取”这类可证明场景的空计划，但非重复类可精简场景仍可能合法 no-op（这是保守策略的预期）。
3. **subagent 会话精简**、**超时/abort/error 的真实路径**、**provider-specific reasoningEffort** 仅有单测/代码级结论。
4. **生产 profile 升级**（`dsh plugin add @ds-hu/dsh-context-slimmer@0.2.0`）与 **npm publish/tag** 未执行（按计划留到发布阶段）。
5. **`ConfigPage` 对 provider-specific effort 值显示 fallback 'inherit'**（只影响显示，不写回，`client.js:1123-1126`）；低风险。
6. benchmark 为单次确定性复合场景（R=1），结论是“非劣演示”，非统计显著性（plan §9 已声明）。

## 8. 复现命令

```bash
# 干净基线（aeb0c61）
git archive aeb0c61 | tar -x -C /tmp/qa-aeb && ln -s "$PWD/node_modules" /tmp/qa-aeb/node_modules
cd /tmp/qa-aeb
node --test packages/core/test/*.test.mjs packages/tool-result-slimmer/test/*.test.mjs   # 62 pass
node scripts/ci/assert-slimming.mjs --self-test && node scripts/ci/benchmark.mjs --self-test
bash scripts/ci/scan-secrets.sh && bash scripts/ci/scan-secrets.sh --publish
for d in packages/core packages/tool-result-slimmer .; do (cd "$d" && npm pack --dry-run --json); done

# CI 真实证据（只读）
gh run view 44749045095 --log      # aeb0c61 verify success
gh run view 44749045128 --log      # aeb0c61 benchmark gate PASS
gh run view 44747543737 --log-failed  # d3ad126 verify failure (发布切点反例)
gh run download 44749045095 -n verify-evidence-44749045095 -D /tmp/artv02  # assert/截图/diagnostics
```

## 9. 最终结论

**v0.2.0 的实现、策略、配置页、安全与打包质量 PASS 独立 QA**：真实 e2e（`aeb0c61`）证明直调 LLM 规划器正常工作、默认 conservative 能落地 duplicable drop（24,638→122，-99.5%）、无 subagent 事件、UI 行/配置页/无 subagent 计数均在真实浏览器可见；benchmark 在 baseline/conservative 均 5/5 且 conservative 折叠后更小。**发布前必须处理 P1-1（以 `aeb0c61` 而非 `d3ad126` 打 tag）与 P1-2（0.1.0 配置迁移/文档）**；P2 十项建议不阻塞发布。
