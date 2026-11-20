# 独立 QA 审查报告 — `@ds-hu/dsh-context-slimmer` 模块 1（工具结果精简）

- 审查者：qa-reviewer（独立于实现；本轮只读审查，未修改任何代码，唯一写入本文件）
- 审查快照：`main` @ `86d4c47`（2026-11-20），工作树仅 `scripts/ci/screenshot.mjs` 由 ci-engineer 修改中；审查期间仓库在滚动修复，见 §9
- 审查依据：DSH `0.2.2-rc.1` / Cordis 4 原生插件 bundle；`docs/architecture.md`、`docs/dev-notes.md`（DEV-1..11）、`docs/protocol.md`、`docs/research/*`、`docs/ui-notes.md`、`docs/ci.md`
- 约束遵守：未启动 dsh、未调用模型 API、未安装/修改任何 profile、未 git push；仅运行离线脚本与只读 `gh` 查询

## 0. 结论：**PASS（无未关闭 P0）**，发布前建议关闭 4 项 P1

| 维度 | 结论 | 主要依据 |
| --- | --- | --- |
| 协议与主链路实现（host+client） | **PASS** | 真实 DSH e2e 两次完整落地（run 44708181181、44712137222），assert-slimming 全绿；离线 56 tests 全绿 |
| 安全与隐私 | **PASS**（2 条 P2 注意项） | secret scan（含 `--publish`）无命中；日志/元数据不含工具原文；client 无网络；发布包不含测试/密钥 |
| 包/发布一致性 | **PASS**（1 条 P2） | 3 包 name/version/exports/`dsh`/files/engines 一致；patch 单 insert 且 row id ≡ 模块导出 `name` ≡ 包名短横线；registry 依赖可解析；干净安装后 56 tests 通过 |
| 文档一致性 | **FAIL（均 P2 级）** | `architecture.md`/README/`dev-notes`/`CONTEXT.md`/`ci.md` 多处与实现漂移（§6） |
| CI 门禁 | **PASS（当前绿，含 1 项非致命告警）** | run 44712137222 e2e 通过；但 UI 截图未取到会话内容（非致命，UI 仍未真机验证 → P1-3） |

- **P0（release-blocking，未关闭）：0**。审查期间发现并已修复的 P0 级缺陷见 §2.4（必须持续回归）。
- **P1（发布前应修）：4 项** — 见 §7.1：timeout 未硬生效、static 门禁单测非致命、真实浏览器 UI 行未验证、e2e 场景对模型输出脆弱（整单拒绝易被单条非法 item 触发）。
- **P2（建议）：12 组** — 见 §7.2。

## 1. 审查范围与方法

按任务要求覆盖五块：①host+client 架构一致性（触发/计数/重置、protectRecent、跳过已替换、原子性、prune→replace 邻接与 sourceEventSeqs、`contextSlimmer` host 写/client 读、失败降级、无递归、多会话隔离、effect 清理）；②安全隐私；③包/发布一致性；④文档一致性；⑤离线检查与真实 e2e 证据复核。

方法：逐行阅读 `packages/core/lib/*`、`packages/tool-result-slimmer/lib/{index,client}.js`、全部文档与 CI 脚本；运行离线测试/静态检查；下载 CI artifact 并在本地复核真实会话日志与 `assert-slimming.mjs`；对真实子 Agent 产出的计划做 `validatePlan` 离线下复跑；用安装版 DSH 源码核对 `subagent`/`tools`/`session`/`client` 契约。

## 2. 真实 DSH e2e 证据（核心正面证据）

### 2.1 run 44712137222（最新，e2e 全绿）

`gh run view 44712137222`：`static` ✓、`gate` ✓、`real session + slimming evidence` ✓（3m22s）。artifact `verify-evidence-44712137222` 中 `assert-report.txt` 全部 PASS：

- 会话 `session-428a79f8-…`，51 events；1 条 `compaction/prune`（`role=summary`，`status=applied`，batchId `9363fa81-…`）；
- `tool/result` replacement seq **36 ← [17]**（`surfaceOp:{op:'replace',startSeq:17,endSeq:17}`），原文 `read` **24,638 → 555 chars（-97.7%）**；
- shadow price prune 紧邻 replacement：`shadowedRange {start:17,end:17}`、`shadowedSeqs [17]`、`shadowedTokenCount` 由 token meter 估算；`surface-replacement` / `shadow-price-precedes-replace` PASS；
- `transcript-append-only` PASS（12 个 append 节点，transcript hash `79f542f5…`，无重复 seq）；`transcript-not-rewritten` PASS；
- fold 后模型可见工具文本 **26,177 → 2,094 chars**（`projected-tool-context-smaller` PASS）；savings 24,083 chars（`derived-context-shrank` PASS）；`stream-cross-check` 4/4 PASS；
- metrics：`replacementCount:1, shadowPriceCount:1, slimmerSummaryCount:1, estimatedTokensSaved:6021`；`structuredOutputToolCalls:0`（见 §2.3 澄清）；
- 插件面板截图捕获到「上下文精简器」（`pluginsPanel.status=found`）。
- 同 run 的诊断文件（DEV-10，opt-in）证明结构化输出路径成功：`result {stopReason:"completed", structuredPresent:true, structuredType:"object"}`、`validate {ok:true}`、`apply {items:1, charsSaved:24083, metaLanded:true}`。

### 2.2 run 44708181181（更早一次完整 PASS，协议形状一致）

我本地下载 artifact 并复跑 CI 的硬门命令，结果 **PASS**（18 项检查）：

```bash
node scripts/ci/assert-slimming.mjs \
  --session-log /tmp/art2/verify-evidence-44708181181/verify-session.jsonl \
  --json-stream /tmp/art2/verify-evidence-44708181181/scenario.jsonl \
  --min-replacements 1 --min-savings-chars 256 --min-reduction-ratio 0.2
# → assert-slimming report — PASS
```

要点：43 events；1 条 summary prune（batchId `51927af9-…`，`trigger{observedCalls:2,observedChars:24664}`，`model{provider:'deepseek-official',model:'deepseek-flash',inherited:true}`）；item `{index:0,callId:'call_00_goOf5…',toolName:'read',op:'trim',charsBefore:24638,charsAfter:470,replacementSeq:29}`；replacement **seq 29 ← [17]**；fold 后 25,988 → 1,820 chars；savings 24,168 chars（98.1%），`estimatedTokensSaved:6042`；transcript 10 个 append 节点 hash `66143d90…` 不变。直接检查日志：seq 28 为 `compaction/prune`（带完整 `contextSlimmer` summary），seq 29 为替换事件；`event[29].data` 与 `event[17].data` 除 `message.content` 外逐字段相等（脚本 deep-equal 实测 `true`）。这正是协议要求的“只改 `message.content`”。

### 2.3 两个 Lead 澄清项的落实

1. **`structuredOutputToolCalls: 0` 不是缺陷**：主会话日志不包含 fork 子 Agent 的 `structured_output` 调用；该指标天然为 0。且 DEV-11 已确认：带 `outputSchema` 的 managed fork 若未调用 `structured_output`，manager 会把 `stopReason` 改写为 `'error'` 且不返回 `structured`，计划仍在最终文本里（文本兜底路径）。因此该指标不得作为 CI 硬断言。
2. **`no-user-visible-rewrite` 是 WARN 不是 FAIL**：`scripts/ci/assert-slimming.mjs:388` 中 `required=false`（advisory）；2 条 `user/message` 是合法策略通知；真正的“用户可见转录未改写”由 `transcript-append-only` + `transcript-not-rewritten` 硬门证明。

### 2.4 审查期间发现并已修复的 P0 级缺陷（发布前必须保留回归）

这两条曾让 e2e 连续静默 no-op（0 prune/0 replacement），属于“功能完全失效”级别：

- **R6 证据守卫误杀合法 trim（已修复：`dfb289e`）**：`claimedEvidenceTokens` 把 `path=/abs/file` 当作原文逐字证据，模型几乎必然在 trim 文本里写这种标注 → `item-text-fabricated` → 整单拒绝。证据：run 44710001940 的 fork 子会话结构化计划被离线复现拒绝；修复后我用同一真实计划在 HEAD 复跑 `validatePlan` → `ok:true`。
- **DEV-11 `stopReason` 改写（已修复：`86d4c47`）**：带 `outputSchema` 的子 Agent 未调用 `structured_output` 时，`captureLocalResult` 把 `'completed'` 改写为 `'error'` 且无 `structured`；旧 host 先判 stopReason → 直接 `FAILED`，文本兜底永远不可达。证据：run 44711627793 的诊断 `result {stopReason:"error",structuredType:"undefined",textRawLength:525}` + 0 prune；而该文本计划离线校验为 `ok:true`。修复后 run 44712137222 走结构化路径成功。

**建议**：把“计划提取/校验结果”固定写入 CI 诊断并在硬门失败时输出（DEV-10 已有 `plan`/`validate`/`no-op` 事件），并在 e2e 增加一条“至少一次 `validate.ok=true` 且 `apply.items>=1`”的硬断言，防止再次出现“模型/协议正常但静默 no-op”。

## 3. 离线检查命令与结果（在本快照上实测）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 离线单测（合计 **56 pass**） | `node --test packages/core/test/*.test.mjs packages/tool-result-slimmer/test/*.test.mjs` | core **41/41 PASS**、module **15/15 PASS**（host 14 + client smoke 1），`fail 0` |
| JS 语法 | 对仓库内全部 22 个 `.js`/`.mjs` 逐个 `node --check` | 0 失败 |
| 密钥扫描 | `bash scripts/ci/scan-secrets.sh` | `OK: no credential-shaped material found`（5 种模式） |
| 发布物密钥扫描 | `bash scripts/ci/scan-secrets.sh --publish` | 三个 tgz 均 `OK`（无凭证形状内容） |
| JSON 解析 | 8 个 JSON（package.json/locale 等）`python3 json.load` | 全部 PASS |
| YAML 解析 | `verify.yml` / `publish.yml` / `cordis.patch.yml`（`python3 yaml.safe_load`） | 全部 OK |
| locale 完整性 | 4 个 `locale/{zh,en}.json` 均为 `meta.title`+`meta.description`；client 字典 zh/en key 集合一致（client-smoke 断言） | PASS |
| assert 脚本自检 | `node scripts/ci/assert-slimming.mjs --self-test --allow-builtin-fold` | `SELF-TEST PASS`（正/负/内置 fold 三 fixture） |
| CI helper dry-run | `prepare-profile.sh --dry-run`、`run-scenario.sh --dry-run`、`screenshot.mjs --dry-run` | 均 exit 0，无网络/无模型/无 profile 变更 |
| 干净安装（registry） | 临时副本 `npm install --ignore-scripts` + `npm test` | 依赖解析成功（仅本地 Node 22 的 EBADENGINE 警告，CI 用 Node 24）；**56/56 tests PASS** |
| 依赖可用性 | `npm view` | `@deepseek-ai/schemastery@3.19.0`、`@deepseek-ai/cordis@4.1.0`（满足 peer `^4.0.2`）、`@deepseek-ai/dsh@0.2.2-rc.1` 均存在 |

### 3.1 三包 `npm pack --dry-run --json` 清单（发布面）

```text
@ds-hu/dsh-context-slimmer-core 0.1.0  files=12
  LICENSE README.md lib/{config,counters,events,freeze,index,plan,prompt,replace,templates}.js package.json
@ds-hu/dsh-context-slimmer-tool-result 0.1.0  files=9
  LICENSE README.client.md README.md icon.svg lib/client.js lib/index.js locale/{en,zh}.json package.json
@ds-hu/dsh-context-slimmer 0.1.0  files=20
  LICENSE README.md README.zh-CN.md cordis.patch.yml icon.svg locale/{en,zh}.json package.json
  docs/{architecture,ci,CONTEXT,dev-notes,protocol,ui-notes}.md docs/research/*.md
```

三包均**不含** test/CI 脚本/`node_modules`/`.github`/密钥文件；core 不含 README.client.md（正确），module 不含测试。`package.json` 字段一致性：root `dsh.bundle.patch=./cordis.patch.yml`、module `dsh.client.platform=web`、module 对 core 精确 `0.1.0`、engines `node>=24.9.0` + dsh `>=0.2.0 <0.3.0`；`cordis.patch.yml` 仅 1 个 `- insert:`、1 行 row，`id: context-slimmer-tool-result` ≡ 模块导出 `name`（`lib/index.js:50`），`name: '@ds-hu/dsh-context-slimmer-tool-result'` ≡ 模块包名。真实 CI 的 `composed-final.yml` 已证明 bundle patch 在真实 profile 中自动生效（`# == @ds-hu/dsh-context-slimmer, patched by …`）。

## 4. host+client 架构一致性核对

| 检查点 | 结论 | 证据 |
| --- | --- | --- |
| 触发/计数/重置（`agent/pre-step`、OR 阈值、errorOnly、基线） | PASS | `counters.js:75-115`、`index.js:390-453`；离线 tests；e2e 观测 `observedCalls:3` |
| `protectRecent` / `minTargetChars` / `maxTargets` / 跳过已替换节点 | PASS | `replace.js:109-157`（`surfaceOp!=='append'`、`hasSlimMeta`、`callId` 配对、newest-first） |
| 原子性（计划整体校验） | PASS | `plan.js` 白名单/重复 index/越界/trim 上限/伪造证据；`replace.js` 预检 `isTargetCurrent` 先于任何 append |
| prune→replace 邻接、`sourceEventSeqs`、shadow 三字段 | PASS | `replace.js:215-360`；真实 e2e seq 28/29 与 35/36 均满足；`assertToolResultRewrite` 只改 content 实测 |
| `contextSlimmer` host 写 / client 读 | PASS | `events.js` 严格校验 + 总读取器；`client.js:382-407` 只匹配 `role:'summary'`；client-smoke 正/负例 |
| 失败降级（超时/模型失败/计划非法/append 异常/扩展被拒） | PASS（timeout 语义见 P1-1） | `applyPlan` 降级路径 + `host.test` “degradation” 用例；真实 e2e run 44711627793 的 failed/=no-op 路径无主循环异常 |
| 无递归 / 排除 subagent 会话 / 多会话隔离 | PASS（多会话仅代码级） | `index.js:290-299`（`session.header.origin==='subagent'` 跳过）、counters 按 session id；未做真实多会话并发 e2e（风险项） |
| effect/ctx.on 清理、`agent.ctx.tools.restrict` 生命周期 | PASS | `install()` 收集 disposer、`dispose()`+`ctx.effect`；`onAgentCreated` 仅对 `runs` 中 child 生效 |
| client 通道/Definition/Node 形状/样式归属/i18n | PASS（离线） | `client-smoke.test.mjs`（匹配、负例、node 形状无 groupTree、locale key 对齐、样式 tag 归属、effect disposer） |
| 真实浏览器 UI 行 | **未验证（P1-3）** | run 44712137222 `ui_assert_status=skipped-timeout`；chat 截图是空白新会话页（见 §5.3） |

## 5. 发现明细

### 5.1 P1（发布前应修）

**P1-1 `timeoutMs` 不是硬超时，与文档承诺不符** — `packages/tool-result-slimmer/lib/index.js:484-485,512-519`
- 机制：`AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)])` 只传给 `startActivation`；安装版 `@deepseek-ai/dsh-subagent/lib/index.js:1397-1480` 的 `startLocal` 只在 **发布前** 使用 `spec.signal`，发布后取消需 `activation.dispose()`。host 之后 `await activation.result` 没有 race/dispose，子 Agent 卡住时会无限期阻塞 `agent/pre-step`（主 Agent 被阻塞），超时信号此时仅能拒绝已被接受的 promise。
- 文档承诺：`README.md:77`、`README.zh-CN.md:59`、`packages/tool-result-slimmer/README.md:39`（“timeout means no-op”）、`docs/architecture.md:70`、`docs/protocol.md:145`（超时 → failed/no summary）、`docs/CONTEXT.md:54` 推荐的正是当前写法。
- 修复：`await Promise.race([activation.result, abortPromise(signal)])`，超时/abort 分支调用 `activation.dispose()` 并返回 `STATUS_FAILED`；补一条“子 Agent 挂起 → finally dispose 且主循环在 timeout 内返回”的离线测试。若暂不修，则上述文档必须改为“仅覆盖启动阶段”。
- 证据：无法在本环境制造真实挂起（不允许启动 dsh/调 API），结论来自源码契约核对；风险等级 P1 而非 P0。

**P1-2 CI static job 的离线测试/pack 非致命** — `.github/workflows/verify.yml:109-118`
- `npm run test:core || echo "WARNING…"`、`test:module`、`test:pack` 全部容错；合并到 main 时单测/打包回归不会让 CI 红，只有 tag 时 `publish.yml:109-130` 才严格跑 `npm test`/pack。
- 现状已非 bring-up 阶段（core 41 + module 15 tests 已存在且全绿），建议改为 `&&`（或拆成 `continue-on-error` + 显式 issue 跟踪），否则 P0 级回归（如本次 R6/DEV-11）只能靠付费 e2e 偶然发现。
- `docs/ci.md:56-60` 已如实描述“tolerant during bring-up”，属于风险接受，需在发布前关闭。

**P1-3 真实浏览器 UI 行仍未验证（CI 非致命告警，puppeteer 脚本打开会话未生效）** — `verify.yml:305-319`、`scripts/ci/screenshot.mjs:202-220,296-330`
- run 44712137222 的 `screenshot-report.json`：`ui_assert_status: "skipped-timeout"`、notes “conversation body stayed short；screenshots may show an empty state”；`verify-chat-zh.png` 实测是**空白“新会话”欢迎页**（侧栏存在场景会话行 “You are running a fixed…”，但未打开/未渲染对话），`pluginsPanel=found`（插件面板正常）。
- 因此 UI 行的真实浏览器渲染、`anchorSeq` 落位、折叠/process 分组行为、展开明细、i18n 切换**均未验证**（`docs/ui-notes.md:225` 已列为残余风险）。脚本 printed `session.status=opened-exact` 与截图不一致，说明“点击会话行 → 会话渲染”这一步在 CI 环境未真正生效（ci-engineer 正在修）。
- 另：架构要求中/英 locale 各一张截图（`docs/architecture.md:173`），当前脚本只跑 zh（`verify.yml:183`、`screenshot.mjs:40`）。
- 修复：先修 `openScenarioSession`（验证对话区域出现 user/tool 文本后再截图）；截图步骤改 `if: always()`（失败也取证）；修好后把 `--fail-on-missing-ui-text` 打开至少跑一次；补 en locale 截图。

**P1-4 e2e 场景对模型输出脆弱：单条非法 item 触发整单拒绝 → 静默 no-op（会周期性红）** — `scripts/ci/slimmer-config.default.json:5`、`packages/core/lib/plan.js:173-183`、`packages/core/lib/prompt.js:109,119`
- 证据：run 44710746160 的子 Agent 计划含 `items[1]`（trim 26-char 失败输出，文本 215 chars）→ 离线下复跑 `validatePlan` 返回 `{ok:false,code:"item-text-too-long"}`（limit `min(50% of 26 = 13, 300 tokens=1200, 8000)=13`）→ 整单拒绝、0 prune；而 run 44711627793 的计划只含大文件 → 离线 `ok:true`；run 44712137222 恰好也只含大文件 → 绿。**同一代码、不同模型决策 → 绿/红随机**。
- 根因组合：prompt 判定规则 2 鼓励 trim 失败结果（“保留命令/退出码/首个错误行/关键栈帧”），但校验器对 26-char 结果只给 13 chars 预算；CI 配置又设 `minTargetChars: 0`，把不可行目标放进 CANDIDATES。
- 建议（任一即可，推荐前两条一起）：a) CI 配置 `minTargetChars: 2048`（只让 fixture 大文件成为候选），或让 scenario 的失败/搜索输出天然短于候选阈值；b) prompt 硬规则增加“小于 N 字符的候选不要 trim；预算不足时省略该条”；c) 宿主在构建 CANDIDATES 时排除“50% 预算小于 `[elided by context-slimmer]` 前缀+最小描述长度”的目标（保留整单原子性，不改变校验器）。同时把 `validate` 失败 code 打进 CI 失败注解（DEV-10 已具备）。

### 5.2 P2（建议）

1. **architecture.md 多处与实现/DEV 决定漂移**：`docs/architecture.md:70`（“任何失败回滚为无操作”，与 `:86`/`protocol.md:133,145` 的“已落地项保留”矛盾）；`:74`（“maxItems 按 config.maxTargets 动态生成”，实际 `plan.js:288-330` 故意不含 maxItems）；`:122`（anchorSeq=替换事件 seq，实际 summary prune seq，差 1，见 `protocol.md:155`）；`:132-135`（`dsh.client.inject` 写成服务名 → 实际是包名；match 仍写旧 `tool/result.data.meta` 通道；`ctx.chatNodes` 旧表述）；`:172`（断言 `plugin:` 记录，实际通道是 `compaction/prune+contextSlimmer`）；`:175`（`npm ci && npm publish --workspaces`，实际 `publish.yml:126-151` 逐包发布且无 lockfile）；`:180`（“gitleaks”，实际 `scan-secrets.sh`）。建议在 architecture 顶部加“实现偏差以 dev-notes DEV-1..11 为准”并逐条更新上述行。
2. **README 配置表漂移**：`README.md:77`/`README.zh-CN.md:59`/module `README.md:39` 的 timeout 文案（与 P1-1 同源）；`README.md:79`、`README.zh-CN.md:61`、module `README.md:43` 写 `model.reasoningEffort` 默认 `null`，实际 schema 默认 `inherit`（`config.js:118`）；root README（en/zh）缺 `forkProvider`、`promptLocale`、新增 `diagnosticsFile`；module README 缺 `diagnosticsFile`，且 `promptLocale` 默认写 `zh` 而 schema 默认 `auto`（auto→zh）。
3. **协议与 client 前向兼容不一致**：`protocol.md:158` 声称“client 对未知版本等价跳过”，但 `client.js:200-247`（`normalizeSummary`）只读取 `v`/`version` 字段、从不 gate；未知 `v` 仍会被渲染。建议按协议 gate（`v!==1` → `null`/降级 no-op）或把协议措辞改为“client 容忍任意版本，只展示已知字段”。
4. **末条 summary 先于其替换 append 写入（窄窗口）**：`replace.js:302-340` 先写 summary prune（含 predicted `replacementSeq`）再在 `:352` append 替换；若最后一次替换 append 抛错，会留下“摘要引用了不存在的 replacement”。与 `protocol.md:98`“中途 append 失败不写 summary”不一致，UI 可能显示无实际替换的摘要行。建议：末条 summary 的写入移到替换成功之后（log-only 事件可以跟在替换后），或明确文档化该窄窗口并加测试。
5. **重入守卫是死代码**：`index.js:398` `if (this.runs.has(agent.id)) return` —— `runs` 的 key 是 `childId`（`:469,487`），与父 `agent.id` 永不相等；真正的并发保护仅靠 Cordis serial 派发。建议改用 `Set<sessionId>` 或在 `maybeSlim` 入口置 `runSessions`；补一个“同 session 重入”单测。
6. **子 Agent 请求仍暴露 6 个 scoped 工具**：真实 artifact 子会话 `request/header.tools` = `interrupt_agent,list_agents,send_message,structured_output,subagent,subagent_fork,workflow`；`tools.restrict({deny})` 只隐藏 global 工具（安装版 `dsh-tools` 源码语义），`structured_output` 之外的工具可见但被 `tools/pre-execute` 守卫拒绝。README/模块 README 的“only usable tool is structured_output”成立（“usable”=执行被拒），但建议文档写明“可见、不可用”，并考虑把守卫 reason 改为固定枚举便于审计；若未来 manager 支持 allow-list，可直接 allow 只保留 structured_output。
7. **`[TASK]` 实际为空**：`index.js:170-184,446` 从 `payload.messages` 提取 task，但 `agent/pre-step` 的 messages 只含本 step 新 claim 的消息（通常为空数组）→ payload 里几乎总是“（未提供）”，任务相关性判断主要依赖 fork seed。建议回退到 session surface 里最近一条 `user/message` 文本（有界截断），或删除 TASK 段以免误导模型。
8. **prompt 自相矛盾**：`prompt.js:119`（ZH）/`:146`（EN）既要求“保留内容（路径/命令/URL+行号）”，又要求“引用文件用普通路径文本，勿写 path=、URL 或原文不存在的文件:行号”。建议统一为“路径用普通文本；URL/行号仅在原文逐字出现时引用”。
9. **死代码/未接线**：`packages/core/lib/counters.js:128-142` 的 `countEntriesSince` 仅测试使用，生产路径未接线（宿主用 `createCounter({lastSeq})` 建基线，是合理行为，但导出函数易误导）；client `replacementPayloadOf` 死分支已由注释说明（可保留）。
10. **发布/复现**：root `package.json:58` 的 `test:pack` 只跑 core+module（不含 bundle 包，与“验证发布清单”的 CI 目标不完整）；仓库无 `package-lock.json`（`verify.yml:104-107`、`docs/ci.md:57` 走 `npm install` fallback），依赖可能漂移；建议补 root pack dry-run 与 lockfile（publish 用 `npm ci`）。
11. **文档陈旧**：`docs/ci.md:320`（“0 tests until core/test lands”）、`:357-378`（“待验证…首次真实 CI 运行后才能确认”，实际 e2e 已多次运行、2 次完整 PASS、core 41 tests 已存在）、`docs/CONTEXT.md:3` 与 `packages/core/README.md:33` 仍写“DEV-1..8”（现为 DEV-1..11）、`docs/dev-notes.md:92` 与 `packages/core/lib/prompt.js:100` 仍写 prompt 长度 1199/2819（R6 后为 1237/2943，`docs/research/prompt-final.md` 已 v1.3 更新）。
12. **诊断文件隐私/仓库卫生（DEV-10 新增）**：`config.js:108` `diagnosticsFile`（默认关闭）会把 `sanitizePlanForLog()` 后的计划片段（每 item text 前 120 chars、整行 JSON ≤4000 chars）写入文件；CI 路径在 `/tmp/ci-artifacts/` 并随 artifact 上传。虽不含工具原文，但属于模型生成文本（可能回显路径/错误串）。建议 README 隐私声明补充“诊断文件内容与保留期”，并在 `.gitignore` 增加 `*.diagnostics.jsonl`/`slimmer-diagnostics.jsonl`，避免本地误提交。

## 6. 安全与隐私核对结论（PASS）

- 密钥：`scan-secrets.sh`（5 类模式）+ 手工 grep 全仓（`sk-` 命中仅为 “Task-Conditioned” 等词，非 key）；`--publish` 扫描三个 tgz 均 OK。
- 日志：host 只记录计数/工具名/状态/有界错误（`index.js:533-535` 截 200 code points）；`debug` 受 `__CTXSLIM_DEBUG__` 控制；不含工具原文。诊断文件见 P2-12（opt-in、有界、无原文）。
- 元数据：`contextSlimmer` 仅 index/callId/toolName/op/reason/chars/model/trigger 等派生字段（`events.js` 严格白名单校验），不存工具原文。
- client：只 `require('react')`，无 `fetch/XHR/WebSocket/console.log`（client-smoke 强制断言），无 session 写入；样式 tag 带 `data-plugin` 归属、卸载清理。
- 包面：三包 files 白名单无 test/CI/密钥（§3.1）；`.gitignore` 覆盖 `node_modules/`、`.ci-*`、`.artifacts/`、`*.tgz`、`*.log`、`.env*`、`secrets.json`。
- 依赖边界：core 仅 `@deepseek-ai/schemastery ~3.19.0`；module 的 `@deepseek-ai/cordis` 仅为 peer；无 dsh 运行时 import（DEV-8 成立）。
- 备注：真实会话日志/CI artifact 含测试数据原文（fixture/工具输出）——属预期，仅测试环境；仓库与发布包不含会话日志。

## 7. 问题清单汇总

### 7.1 P1（发布前应修，4 项）

| # | 问题 | 位置 | 修复建议 |
| --- | --- | --- | --- |
| P1-1 | `timeoutMs` 仅在激活前生效，发布后无硬超时；文档承诺“超时=无操作/120s” | `packages/tool-result-slimmer/lib/index.js:484-485,512-519`；README×3、architecture:70、protocol:145、CONTEXT:54 | race `activation.result` 与 abort，超时 `dispose()`；补测试；否则改文档 |
| P1-2 | static job 单测/pack 非致命，合入回归不可见 | `.github/workflows/verify.yml:109-118`（docs/ci.md:56-60 已注） | 改严格 `&&` / `continue-on-error`+跟踪 issue |
| P1-3 | 真实浏览器 UI 行未验证：截图脚本打开会话未生效（空白新会话），截图非致命，仅 zh | `verify.yml:305-319`；`scripts/ci/screenshot.mjs:202-220,296-330`；`verify.yml:183`；architecture:173 | 修 openScenarioSession 并验证对话渲染；截图 `if: always()`；修好后开 `--fail-on-missing-ui-text` 跑一次；补 en |
| P1-4 | e2e 因单条非法 item 整单拒绝 → 静默 no-op，绿/红随机 | `scripts/ci/slimmer-config.default.json:5`；`plan.js:173-183`；`prompt.js:109,119` | CI `minTargetChars` 提高；prompt 小候选规则；或宿主预过滤不可 trim 目标 |

### 7.2 P2（建议，12 组）

见 §5.2（architecture 漂移、README 配置、client 版本容忍、summary 窄窗口、重入死代码、子 Agent 可见工具、TASK 为空、prompt 矛盾、死代码、pack/lockfile、陈旧文档、诊断隐私）。

## 8. 未覆盖风险（明确声明）

1. **真实浏览器 UI**：行的可见性/位置/是否被 Turn-process 折叠、展开明细、中英切换、刷新重放均未验证（P1-3；脚本截图是空白新会话页）。
2. **模型行为随机性**：e2e 绿/红取决于模型计划（已实测同一代码 3 种结果：全绿、`item-text-too-long` 全单拒绝、路径守卫误杀已修）；需要一个确定性的场景配置（P1-4）。
3. **多会话并发**：counters 按 session、runs 按 child 的隔离是代码级结论，未做真实并发 e2e。
4. **安装路径**：`dsh plugin --profile <p> add <bundle>` 的 pnpm 安装路径未实际执行（CI 用 symlink 进 profile + `dsh.profile.bundles` reconcile；已用安装版 `dsh-plugin-manager` 源码核对 reconcile 行为，并用真实 `composed-final.yml` 验证 patch 挂载）。
5. **子 Agent 工具限制的运行时行为**：`restrict` + `pre-execute` 守卫在真实 dsh 中生效（子会话未调用非 structured_output 工具），但没有“模型尝试调用其他工具被拒绝”的真实正向证据，仅有单测。
6. **超时/挂起路径**：受环境限制无法真实复现（不允许起 dsh/调 API），P1-1 结论来自源码契约。
7. **发布**：仅 `npm pack --dry-run` 与 registry 依赖探测，未实际 `npm publish`；npm/DSH 版本兼容边界仅测 `0.2.2-rc.1`。
8. **其他平台/环境**：本地 Node 22（CI Node 24）；Node 24.9+、Linux 之外的运行环境未验证。

## 9. 快照与复现

- 审查快照：`main` @ `86d4c47`（工作树仅 `scripts/ci/screenshot.mjs` 修改中，属 ci-engineer 的 P1-3 修复）；审查期间 HEAD 从 `dfaa616` 滚动到 `86d4c47`，P0 修复（`dfb289e`、`86d4c47`）已包含在本快照内。
- 复现关键证据（离线）：

```bash
# 1) 单元测试（56 pass = core 41 + module 15）
node --test packages/core/test/*.test.mjs
node --test packages/tool-result-slimmer/test/*.test.mjs

# 2) CI 硬门复跑（用已下载 artifact）
node scripts/ci/assert-slimming.mjs \
  --session-log /tmp/art2/verify-evidence-44708181181/verify-session.jsonl \
  --json-stream /tmp/art2/verify-evidence-44708181181/scenario.jsonl \
  --min-replacements 1 --min-savings-chars 256 --min-reduction-ratio 0.2

# 3) 真实子 Agent 计划离线复跑（R6 修复验证思路）
node --input-type=module -e '/* 读取 artifact child-sessions/summary.json 的 plan，构造 targets，调 validatePlan */'

# 4) secret/pack/静态检查
bash scripts/ci/scan-secrets.sh
bash scripts/ci/scan-secrets.sh --publish
for d in packages/core packages/tool-result-slimmer .; do (cd "$d" && npm pack --dry-run --json); done
```

- CI 状态（截至报告落盘）：run `44712137222` **success**（static/gate/e2e 全绿；仅 UI 文本 skipped-timeout 非致命告警）；此前 `44708634014/44709192651/44710001940/44710746160/44711627793` 为 e2e failure（根因见 §2.4、P1-4，已定位/修复中）；更早 `44708181181` 也完整 PASS（协议证据）。

---

**最终结论**：模块 1 的协议与实现**通过独立 QA**（真实 DSH e2e 两次落地成功、离线 56 tests、安全与打包均无阻断项、无未关闭 P0）；**发布前建议关闭 P1-1（timeout 真实性）、P1-2（static 门禁）、P1-3（真实浏览器 UI 验证）、P1-4（e2e 场景确定性）**，其余 P2 为文档/健壮性改进。
