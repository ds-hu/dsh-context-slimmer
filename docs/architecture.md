# dsh-context-slimmer 架构说明（v1）

> 状态：Lead 起草的架构契约；实现必须以此为准，允许在报告中提出偏差，但不得静默偏离。
> 目标读者：core-dev、ui-dev、qa-reviewer、ci-engineer。

## 1. 产品目标

对 DeepSeek Harness（dsh）主 Agent 的**工具调用结果**做模型驱动的选择性精简，降低长会话上下文压力，同时：

1. **主 Agent 无感知**：主 Agent 后续只看到被替换后的工具结果，不会收到任何“被精简”的提示消息（替换通过原生 surface 替换事件完成，属于模型可见历史，不进入用户可见 transcript）。
2. **用户可见历史不改写**：Chat 对话记录里原来的工具卡片保持原样；额外追加一行“已精简工具调用结果”（视觉上对齐原生“上下文已压缩”行），可展开查看本次精简明细。
3. **原生机制优先**：fork subagent（`ctx.subagents` + `fork` provider）、surface replace 事件、scoped tool restrict、plugin record 事件、Bundle patch 多行开关。
4. **模块化**：本仓库是一个 bundle，未来每个功能模块是**独立 npm 包 + 独立 Loader row**，在 dsh 原生插件面板中可单独开关、单独配置，互不影响。

## 2. 仓库 / 包结构（monorepo，npm workspaces）

```
dsh-context-slimmer/
├─ package.json                 # bundle 包 @ds-hu/dsh-context-slimmer（只含 patch + icon + locale + README）
├─ cordis.patch.yml             # 每个模块一行 insert（id = 模块包名导出的 name）
├─ packages/
│  ├─ core/                     # @ds-hu/dsh-context-slimmer-core（共享库，不是 Loader row，不可开关）
│  │  ├─ lib/                   # host 共享代码：事件协议、类型、替换原语、prompt 模板、配置 schema 片段
│  │  └─ shared/                # host/client 共同引用的纯常量（事件类型名、默认值、阈值键名）
│  └─ tool-result-slimmer/      # @ds-hu/dsh-context-slimmer-tool-result（模块 1：无用工具调用内容删减）
│     ├─ lib/index.js           # host 半：行插件（apply/inject/name），Config schema
│     ├─ lib/client.js          # client 半：手写 __ModuleLoader__ bundle（无构建步骤），渲染“已精简”行
│     ├─ locale/*.json          # zh/en 等标题描述（插件面板 + UI 文案）
│     ├─ icon.svg
│     └─ README.md
├─ docs/                        # 调研报告、API map、本架构、CI 文档
├─ scripts/                     # CI 辅助脚本（由 ci-engineer 提供）
└─ .github/workflows/           # verify.yml（真实会话+截图断言）+ publish.yml（npm 发布）
```

**为什么拆包**：原生插件面板的开关粒度 = Loader row 粒度，而一个 npm 包只能导出有限个可区分 row（`name` 必须等于包名才能被 Loader 从 profile node_modules 解析）。官方多模块范例 `@ds-hu/dsh-better-workspaces` 即采用 “bundle 包 + 每模块一个 npm 包 + 共享 core 包” 的结构，本仓库照此范式。

**版本策略**：所有包同一版本号（lockstep），由 publish workflow 统一 `npm publish --workspaces`。

## 3. 模块 1：无用工具调用内容删减（tool-result-slimmer）

### 3.1 触发

- 监听 **`agent/pre-step`** waterfall（`@deepseek-ai/dsh-agent` 的 agent-subject 事件，serial/awaited，位于“上一 step 工具批次已结算、下一 step 请求尚未组装”之间）。这是唯一能“在模型下一次看到上下文之前、且主 Agent 不在飞行中”的安全阻塞点。
- 只处理满足条件的 agent：根 Agent 或普通会话 Agent；排除我们自己的 slimmer 子 Agent（按 childId 白名单排除）、排除 subagent 会话（`session.header.origin === 'subagent'`），避免递归。
- 统计“自上次精简以来”追加到该 session surface 的 `tool/result` 事件（用 surface 节点/`session/deriveMessages` 或 `session/event` 增量计数；优先实现为按 session 维护计数器，`agent/pre-step` 时读取并清零）。
- 触发条件（插件 Config，均可调）：
  - `everyNToolCalls`（默认 8）：累计新工具结果数 ≥ N；`0` 表示关闭数量触发。
  - `minChars`（默认 24000）：累计新工具结果文本字符数 ≥ 阈值时也触发（大输出提前触发）。
  - 两者满足其一即触发；触发后重置计数。
  - `protectRecent`（默认 2）：最近 K 个工具结果永不作为精简目标（安全阀）。
  - `maxTargets`（默认 12）：单次最多精简条数，按时间倒序取最近的可精简结果。
  - `enabled`（默认 true）。
- 触发后计数重置；进度锚点保存在内存（每 session），插件挂载后首次 `pre-step` 只建基线不触发；重启/重载后依据“已带 `contextSlimmer` 元数据的 prune”与“已替换结果”天然幂等。

### 3.2 后台精简器（fork subagent + 原生结构化输出）

流程（全部在 `agent/pre-step` 内 `await`，主 Agent 被阻塞但无并发写入）：

1. 计算目标集合：从当前 surface 取最近 `maxTargets` 个、且不在 `protectRecent` 内的 `tool/result` 事件；每条包含：`index`（0-based）、`callId`、工具名、原始文本、是否为错误结果、其在日志中的 `seq`、字符数。工具名从对应 assistant `tool/call` 获取；跳过已带 `contextSlimmer` 元数据的替换事件。
2. `ctx.subagents.startActivation({ provider: 'fork', label: 'context-slimmer', childId: <预生成 SessionId>, delivery: 'caller', signal, request: { prompt: [{type:'text',text:<system prompt 前言+任务+CANDIDATES>}], parent: agent, agentOptions: <模型覆盖>, outputSchema: <按 maxTargets 生成的计划 JSON Schema> } })`。
   - 模型默认继承主 Agent（不传 `agentOptions.provider/model`）；Config 可指定 `model: { provider, model, reasoningEffort?, maxOutputTokens? }`、`timeoutMs`。
   - **KV-cache 友好**：fork 子会话 seed = 父 session 已完成的 turn 前缀（原生 `fork` provider 行为），任务只作为追加 user message；不改写任何历史。
   - **结构化输出（原生能力，替代自定义工具）**：fork provider capabilities 含 `outputSchema: true`；manager 会在子 Agent 创建窗口内原生挂 `structured_output` 工具并注入指令。子 Agent 只需返回计划，不提供/不注册任何自定义模型工具。计划从 `activation.result.structured` 读取；若该值缺失（provider/版本差异），从 `result.finalOutput` 文本提取 ```json 块作为兜底。
3. 禁用子 Agent 的原生工具（满足“只允许返回计划”的产品要求，且不 import 任何 dsh 包）：
   - `agent/created` 监听（await serial，子 Agent 第一次请求组装前）中对 `payload.agent.id === childId` 执行 `agent.ctx.tools.restrict({ deny: <插件初始化时从 ctx.tools.definitions() 枚举的全局工具名> })`。官方 practices：*“Hiding tools from one agent is ctx.tools.restrict() on that agent's context; register per-agent behavior on agent.ctx, obtained in an agent/created listener.”* `structured_output` 是 manager 的 scope-local 注册，不在 deny 名单内，天然保留。
   - 兜底守卫：root ctx 上 `ctx.on('tools/pre-execute', ...)`，当 `exec.agent?.id === childId` 且工具名不是 `structured_output` 时返回 `{kind:'deny'}`。
   - 注意 `agent.ctx` 是运行时属性（dsh-agent-loop 构造器 `this.ctx = this.scope.ctx`），TypeScript 公共接口未声明，JS 中直接访问并在缺失时降级为仅守卫。
4. 子 Agent 返回结构化计划后结束本轮；`await activation.result` → `dispose()`。
5. 执行阶段（见 3.3）在主 `agent/pre-step` 内同步完成；`agent/pre-step` 的 `next()` 继续。任何失败（超时/模型失败/计划非法/替换失败）**回滚为无操作**：主 Agent 上下文不变，仅 debug 日志（不写任何 session 事件）。超时默认 120s。

### 3.3 计划的执行（surface replace + 影子记账 + UI 元数据）

- 计划 schema（宿主运行时校验的权威在 `packages/core/lib/plan.js`，JSON Schema 仅作模型提示，`maxItems` 按 `config.maxTargets` 动态生成）：
```jsonc
{
  "summary": "string",            // 一句话说明本次精简（中文，≤80 字）
  "items": [                      // 只列出需要改动的目标；未列出=原样保留
    { "index": 3,                 // CANDIDATES 序号（0-based，不是 seq）
      "op": "drop",               // drop | trim
      "text": "…",                // op=trim 时必填
      "reason": "与任务无关" }      // 可选，≤40 字
  ]
}
```
- 语义：`drop` → 宿主生成占位 stub（`[elided by context-slimmer] …`，模型不写 stub）；`trim` → 用模型给的完整 `text` 替换。索引越界/重复、目标已替换、`text` 超过 `min(300 tokens, 原文 50%)`、字段非法 → **整单拒绝**（原子性，不落地任何替换）。
- 执行顺序（每条目标）：**先 append 官方 log-only `compaction/prune`（带 `data.contextSlimmer` 扩展字段）→ 再 append `tool/result` 替换事件**，成对紧邻。
- `compaction/prune.data` = `{ shadowedRange:{start,end}, shadowedSeqs:[seq], shadowedTokenCount:<tokenMeter.estimateMessage(original) 或字符估算>, contextSlimmer: {...} }`。
- `contextSlimmer` 扩展字段（本仓库协议，**UI 行唯一数据源**，也用于幂等）：
  - 每条 prune：`{ v:1, batchId, role:'item', index, op, charsBefore, charsAfter, toolName }`；
  - 本批最后一条 prune：`role:'summary'`，并带 `{ status:'applied', startedAt, finishedAt, trigger:{...}, model:{provider,model,inherited}, items:[{index,callId,toolName,op,reason,charsBefore,charsAfter,replacementSeq}], totals:{items,charsBefore,charsAfter,charsSaved} }`。
  - 为什么不用 `tool/result.data.meta`：`Session.append` 的 `assertToolResultRewrite` 要求替换事件除 `message.content` 外与原文逐字段深相等，meta 不能改（已由 core-dev 离线实测 + ui-dev 复核）。
  - 为什么不用 `appendPluginRecord`：DSH practices 明确它是 experimental 保留通道、迁移只 best-effort 保留。
  - 兼容性降级：若带扩展字段的 prune append 抛错（未来版本更严格校验），本实例缓存 `extensionSupported=false`，之后只写官方三字段；替换照常落地、UI 行缺失、debug 日志记录。
- 替换事件构造（已验证 API，见 `@deepseek-ai/dsh-compaction-tool-result-pruner` 实现）：
```js
session.append('tool/result', {
  turn: original.turn, step: original.step,
  message: { ...original.message, content: [{ type: 'text', text }] }, // 保留 role/isError/source 等
  ...(original.error === undefined ? {} : { error: original.error }),
  ...(original.meta === undefined ? {} : { meta: original.meta }),      // meta 必须原样复制
}, {
  surfaceOp: { op: 'replace', startSeq: originalSeq, endSeq: originalSeq },
  sourceEventSeqs: [originalSeq],
});
```
- 安全阀：只允许替换 **当前 surface 上、已配对**（assistant tool/call 已有 result）的 `tool/result`；不触碰 user/assistant/system 消息；不触碰本插件产生的替换事件；不替换当前 step 未结算的结果（`protectRecent` 覆盖，另加硬保护：只用 `session.surface.nodes` 上已存在的结果）。

### 3.4 精简提示词（由调研报告驱动）

- 权威文档：`docs/research/prompt-adaptation.md`（工具 description + 中英 system prompt + 替换模板）与 `docs/research/slimming-policy.md`（分类决策表/硬规则/QA 断言）；`docs/research/prompt-regression.md` 的 20 条用例用于离线断言。core 包 `lib/prompt.js` 必须忠实实现这两份文档，不得自创规则。
- 已确认的偏差决策（Lead 接受 paper-researcher 提案）：
  - **DEV-1**：未解决的失败 → **保留精确错误证据**（命令原文、退出码、首个错误行、关键栈帧、重试参数），不做“drop + 经验教训”；仅“同一失败的重复重试”可 drop 为一行 `retry n, same failure, evidence unchanged` 并保留首次完整证据。这与 architecture 早先“失败直接 drop”表述冲突时，以本条为准。
  - **DEV-2**：`drop` 的占位 stub 由宿主生成、以 `[elided by context-slimmer]` 开头（模型只给 `op:"drop"`，不写 stub 文本）；`trim` 的文本由模型给出。
  - **DEV-3**：`trim` 文本上限收紧为 `min(300 tokens, 原文 50%)`，超限整单拒绝。
  - **DEV-4**：payload 每项以 `index` 为主键（`[#<index>] tool=<name> error=<bool> chars=<n>` + 原文），`callId` 由宿主内部映射并写入本批 `meta.contextSlimmer.items` 审计；模型不得引用/臆造 callId。
- 任务 payload 由 `lib/prompt.js` 组装为独立 user 内容块；system prompt 不拼接进 user。
- 目标 ≤ 1200 tokens（中文按字符感知保守口径校验，见 prompt-adaptation §4 的长度说明）。

### 3.5 UI 行（client 半）

- 展示位置：Chat 对话流中，紧随本批最后一条被替换的工具结果之后（anchorSeq = 该 `tool/result` 替换事件的 seq，位置自然落在当前对话流尾部）。
- 视觉：与原生“上下文已压缩”行同构——一行浅色 tertiary 文本 + 上下文图标，文案：
  - 默认：`已精简工具调用结果 · {items} 项 · 释放 {chars} 字符`
  - 展开后：每一行 `#3 bash · drop · 8,123→48 · 与任务无关`，末尾 `模型：{provider}/{model}`。
  - 失败/无操作：不产生替换事件，因此不渲染行（仅宿主 debug 日志）。Renderer 仍保留 status 非 `applied` 的灰色分支以向前兼容。
- 实现（client 半，无构建）：
  - 手写 `lib/client.js`，采用 dsh 客户端模块格式：
    ```js
    window.__ModuleLoader__.load({ id: '@ds-hu/dsh-context-slimmer-tool-result', factory: (require) => { ... } });
    ```
  - `package.json` 声明 `dsh.client: { platform: 'web', inject: ['slots','locale', 'uiConversation'] }`（按实际 service 名）；
  - 在 `apply(ctx)` 中：`ctx.uiConversation.events.register(<自定义 Conversation Node Definition>)`；Definition 的 `match` 只匹配 `event.type === 'tool/result' && isReplacement(event) && event.data.meta?.contextSlimmer?.role === 'summary'`（matching 用事件自带的 `surfaceOp` 对象判定 replacement；不依赖客户端包级 isReplacementSurfaceEvent 导出），`start` 返回事件元数据、`buildViewNode` 产出 `target:'chat'`、`kind:'context-slimmer-tool-result'`、`anchorSeq`=事件 seq 的节点；并在 keyed slot `conversation.chat.node` 注册该 kind 的 React 渲染器（只用 baseline 外部模块 `react`；不依赖 primitives，避免 external 声明）。
  - 文案走 locale（zh/en），由 client 半通过 `ctx.locale` 注册命名空间；宿主 locale 提供插件面板标题/描述。
  - 通过 `ctx.chatNodes` / `ChatNodeDataMap` 扩展的实际注册方式以 api-scout 报告为准；若 keyed renderer 注册受限，退路：在原生 compaction 行旁边用 `conversation.chat.flow` 插槽注入自绘行（同一视觉规范）。
- 注意：client 半禁止读写 session 内容、禁止发起网络请求；只消费事件与渲染。

### 3.6 宿主 Config（插件面板可改）

```yaml
- id: context-slimmer-tool-result
  name: '@ds-hu/dsh-context-slimmer-tool-result'
  config:
    enabled: true
    everyNToolCalls: 8
    minChars: 24000
    protectRecent: 2
    maxTargets: 12
    triggerOnErrorOnly: false
    model:
      provider: inherit        # inherit | <provider id>
      model: inherit
      reasoningEffort: null
      maxOutputTokens: 2048
    timeoutMs: 120000
```
Config 用 `@deepseek-ai/schemastery`（官方包均为该库），每个字段有 `.description()` 与默认值；`Config` 导出并被 Loader 面板渲染为表单。所有字段可热更新（`patchReload: live` 语义）；非法值在构造期拒绝（面板显示错误）。

### 3.7 模块独立性

- 模块 1 只依赖 core 库与 dsh 内置服务；不提供/不消费任何自定义 Cordis service（避免 isolate 需求）。
- 未来模块（例如“重复工具调用合并”“历史消息去噪”“图片/附件上下文压缩”）各自建包、各自 row；模块之间互不 import，只允许 import core 的纯函数/常量。
- `context-slimmer` bundle 包本身不导出插件（无 `dsh.bundle.patch` 之外的代码行），只聚合模块；不参与运行时。

## 4. 质量门禁

1. **静态**：`node --check` 所有 .js；JSON/YAML 解析；`npm pack --dry-run` 校验 files；locale key 完整性脚本。
2. **单元（本机允许的离线测试，不构建、不联网）**：core 纯函数（计划校验、事件构造、prompt 组装、计数/阈值、字段裁剪）用 `node --test`。不启动 dsh、不调 API、不安装 profile。
3. **CI 端到端（GitHub Actions）**：
   - 起真实 dsh（headless 会话 + 真实 DeepSeek API，secret `DEEPSEEK_API_KEY`）；
   - 让 Agent 产生多类工具结果（文件读取、失败命令、无关搜索、大输出），触发精简；
   - 断言：日志出现 `plugin:` 记录且 `status=applied`、替换事件 surfaceOp=replace 指向原 seq、后续 `deriveMessages()` 中目标结果变短、用户可见 transcript（append-origin 事件）未被改写、主 Agent 未收到额外消息；
   - 起 Web GUI + Playwright 截图，截图中出现“已精简工具调用结果”行（中/英 locale 各一张）；
   - 失败上传会话日志、截图、插件日志。
4. **发布（GitHub Actions，tag 触发）**：`npm ci && npm test && npm publish --workspaces`（NPM_TOKEN secret），发布前 `npm pack --dry-run` 断言包内容不含 key/测试文件；GitHub Release 附截图与报告。
5. **生产安装**：部署到本机 `web` profile（`dsh plugin --profile web add <pkg>` 或 plugin_manager install_bundle），只装不跑额外测试；安装后确认插件面板出现开关、会话产出正常。

## 5. 安全与合规

- 测试 key 只存在于：①本机环境变量（安装验证时）；②GitHub Actions secret。**任何仓库文件、README、日志、截图、产物都不得包含 key**（CI 中做 gitleaks/regex 扫描断言）。
- 不采集用户隐私；prompt 与日志中工具结果可能含敏感信息：插件日志默认只记录字符数/条数，不落原文；`meta.contextSlimmer` 只存索引/字符数/原因/模型标识，不存原文（`reason` 由模型给出，已约定不得复述原文）。
- 不修改 dsh 安装目录与 profile 之外的文件；安装动作显式、可回滚（`dsh plugin remove`）。

## 6. 待验证清单（实现前必须由 api-scout/core-dev 确认）

| # | 问题 | 备选方案 |
|---|---|---|
| A1 | `agent/pre-step` 是否确为 awaited waterfall 且在此处 append 安全 | `agent/turn-stopping` + 追加 injected message 触发下一步；或 `tools/post-execute` |
| A2 | `createScope(rootCtx, childAgent)` + `tools.restrict` 在子 Agent 第一次请求前生效 | `tools/pre-execute` 全量 deny 兜底；或自定义 `ctx.subagents` provider |
| A3 | 自定义 `ConversationNodeDefinition` + keyed `conversation.chat.node` renderer 的精确注册 API | **已验证**：`ctx.uiConversation.events.register(definition)` + `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({name:'conversation.chat.node', key:<kind>, locale:NS}, Component))`；范本见 `dsh-client-ui-chat/lib/client.js:11401/11798/9238`，`chatNode()` 在 9770 行 |
| A4 | UI 数据通道：`tool/result.data.meta` 是否可持久化并被 client 收到 | **已验证成立**：`meta?: JsonValue` 官方定义为 tool-private presentation payload、durable log 可复现（`dsh-session/lib/types/types.d.ts` tool/result 段）；服务端 EventListener 无过滤转发全部 `session/event`（`dsh-api-session-controller/lib/index.js:1246-1320`）；client assembler 对每个事件调用 `definition.match`（`dsh-client-ui-conversation/lib/client.js:2807`）；chat 的 tool-call Definition 只对 append-origin 事件更新卡片，替换事件不污染用户转录（`dsh-client-ui-chat/lib/client.js:12484-12568`） |
| A5 | `SubagentActivation.result` 的完成语义与 `dispose()` 时序 | `delivery:'caller'` + 轮询 child 状态 |
| A6 | fork 子会话 seed 边界与“当前 turn 目标内容”的 payload 组合是否足以让模型正确判断 | 在 prompt 中显式声明“以下内容是当前 turn 的快照，以它为准” |
