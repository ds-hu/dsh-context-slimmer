# DSH 插件 API 勘察地图（dsh-context-slimmer 前置研究）

> 目标：为「上下文精简器」插件确定**精确、可落地**的扩展点。回答 8 个问题，每条给证据路径、类型签名、最小代码片段，并标证据等级。
> 本文件是唯一产出（`docs/research/dsh-api-map.md`）。未安装/未修改任何 profile。

## 0. 取证方法与证据等级

**环境事实**
- DSH 安装：`/usr/local/lib/node_modules/@deepseek-ai/dsh/`（下文记 `$DSH`，即 `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`）。只有构建产物 `lib/index.js` + `lib/types/**/*.d.ts` + README + 官方包自带 `locale/`。
- 当前 profile：`web`（`DSH_PROFILE_DIR=/root/.dsh/profiles/web`），Web GUI `http://127.0.0.1:3080`。
- 参考同级插件仓库：`/workspace/projects/github/dsh-plugins/{dsh-better-subagents,dsh-better-search,dsh-better-mcp-manager,dsh-auto-task-center,dsh-custom-reasoning-effort,dsh-simple-codex-login}`。

> **勘误（2026-11-20，依据 Lead 纠正并逐行复核）**：早先版本称“plugin record 的 client 可见性无证据”是**错的**。已确认：host 全量转发 `session/event`、client 接受未知 `ignorable` 事件为 log-only、Definition 可匹配任意 `type`、chat 不按 kind 白名单过滤 → **自定义 ConversationNodeDefinition 可直接匹配 `plugin:*` record**。详见 §2.4（含最小骨架）与 §11 风险 #5 的写入侧合规限制。

> **本版（v2，2026-11-20 收尾）已对齐 Lead 决策**：① §9.1 改为“bundle 根包 + 每模块一个 npm 包 + 每模块一行”的 better-workspaces 范式（不采纳单 row/config 开关）；② §2.3 主路径改为 plugin record（`appendPluginRecord`）+ 自定义 ConversationNodeDefinition，`compaction/prune` 仅记账，`compaction/prune`+`meta` 保留为备选；③ §12 给出分层 CI 验证清单（A 纯 Node / B 临时 profile 无头 / C 只能真实 GUI）。

**证据等级**
- ✅ **已验证**：直接读到本机安装包 `lib/index.js` / `lib/types/**/*.d.ts` / README 的原文，或 inspect 目录结果，或 | 第三方已发布插件的源码/其 mount-check 明确断言。
- 🟡 **推断**：由类型/文档语义推导，未在本机运行时验证。
- ⛔ **不存在 / 受限**：本 build 缺失或不可用，附 workaround。

**inspect 取证的一个硬缺陷（已复现并抓包）**
`cordis_inspect_query` 的 `input` 实参在工具边界被 **JSON 序列化成字符串**，导致所有需要 input 的方法报 `"input" must be an object`（含 `{}`、`null`、字符串、对象四种形状都失败；无 input 的方法正常）。证据：本会话 session log 反解出的 tool-call 参数：
`{"input":"{\"service\": \"sessions\"}", "method":"listService", ...}`，而工具 `dsh-tool-cordis` 的 `input: {type:'json'}`（`$DSH/dsh-tool-cordis/lib/index.js:56-101`）与 host 校验 `validateInput(...)`（`$DSH/dsh-cordis-host-runner/lib/index.js:915-925`）都不做反序列化。
**影响**：`Service.listService(service)`、`Config.listConfigs(name/entry)`、`Slots.listSubTree(root)` 无法在本会话取到细约；但**无参目录**可用：`Service.listService`、`Event.listEvents`、`Tool.listTools`、`Config.listConfigs`（首页）、`Slots.listSubTree`（本机无 live page 也失败）。
**workaround**：读安装包 `lib/types/**/*.d.ts`（JSDoc 极全，本报告主要证据源）+ 读 `$DSH/*/lib/index.js` + 读 `/root/.dsh/profiles/web/{cordis.yml,cordis.patch.yml,package.json}`；client Slots 改为读 client 包源码。
> 官方 skill 也要求优先 inspect；本环境该通道部分不可用，故本报告用「inspect 目录结果 + 安装包 d.ts/js + 已发布插件源码」三重取证，并在每条标注等级。

---

## 1. 会话事件与投影（Q1）

### 1.1 事件模型：append-only log + surface 投影

✅ `dsh-session` 是事件溯源核心：`Session` 是 append-only typed event log；「模型可见历史」= **surface**（事件 log 的一个增量投影），log 永远保留原事件，compaction/prune 只是**遮蔽（shadow）**而非删除。
- `$DSH/dsh-session/README.md:12`（append-only、replay/fork、compaction hides superseded entries）、`:102`（surface 是派生投影）、`:167`。

Session 类关键 API（✅ `$DSH/dsh-session/lib/types/index.d.ts`）：
```ts
get seq(): SessionLogOffset                                    // :242 下一个事件的 seq（= log length）
append<T extends SessionEventType>(type: T, data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [SurfaceIntent<T>] : []): SessionEvent<T>   // :286
deriveEventMessage(event: SessionEvent): Message | null         // :362
eventAt(seq); snapshotEvents(from?,to?); ownEvents()            // :217/:228/:234（均标注 deprecated：新代码禁用同步读，改用注入的 projection/reader）
```

surface 元数据（✅ `$DSH/dsh-session/lib/types/types.d.ts:466-483`）：
```ts
export type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
export type SurfaceIntent<T> = { surfaceOp: SurfaceOp } & (
  T extends 'assistant/message'
    ? { sourceEventSeqs?: never }                        // assistant 自带 provider stream，不能引用
    : { sourceEventSeqs?: SessionSeq[] }                 // "Complete non-empty set of known earlier source-event seqs"
)
```
- **`sourceEventSeqs` 语义**：本事件「派生自」的早先事件 seq 的**完整集合**；对 replacement 而言必须覆盖被遮蔽的**全部** surface 节点（“complete shadowed-node coverage”，✅ `dsh-session/README.md:121`、`:54`）。
- surface 事件类型只有 5 个：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`（✅ `README.md:52`）。其余事件（turn/step 边界、`assistant/attempt`、`compaction/*`、plugin record）都是 log-only，**禁止**带 `surfaceOp/sourceEventSeqs`（编译期 + 运行期校验）。
- `assistant/message` 禁止 `sourceEventSeqs`；`developer/message` 的 tool-addition 需要 `headerSeq` 引用更早的 `request/header`（✅ 同上）。

事件 envelope（✅ `types.d.ts:497` 起）：`{ type, seq, time, data, surfaceOp?, sourceEventSeqs?, ignorable? }`；`ignorable` 是持久化兼容标记，读路径拒绝未知 type，除非带 `ignorable`（✅ `$DSH/dsh-session/lib/types/known-event-types.d.ts` 注释）。

### 1.2 `tool/call` / `tool/result` 完整结构

✅ `$DSH/dsh-session/lib/types/types.d.ts`：
```ts
'tool/call': {                     // :368-375
  turn: number; step: number;
  callId: ToolCallId;
  name: string;
  arguments: string;               // 模型产出的原始 JSON 字符串（未解析！）
}
'tool/result': {                   // :382-396
  turn: number; step: number;
  message: ToolResultMessage;
  error?: { name: string; code: string; reason?: string };   // 仅 isError===true 允许，且不在模型内容里
  meta?: JsonValue;              // 工具私有展示 payload，必须 JSON-serializable（append 会 isJsonValue 校验）
}
```
`ToolResultMessage`（✅ `$DSH/dsh-llm/lib/types/message.d.ts:153-160`）：
```ts
interface ToolResultMessage extends MessageBase {
  role: 'tool';
  source: { kind: 'tool'; callId: ToolCallId };
  toolCallId: ToolCallId;
  isError?: boolean;
  content: readonly ContentBlock[];   // 模型真正读到的东西
}
```
> 结论：**要“替换工具结果”，改的就是 `message.content`，且必须新 append 一个 `tool/result` replacement**；`callId`/`turn`/`step`/`isError`/`error`/`meta` 原样保留。

> ⚠️ **字段形状勘误（相对本仓库 `docs/architecture.md` §3.3 的伪代码）**：`tool/result` 的 `data` 是 `{turn, step, message: ToolResultMessage, error?, meta?}`，**不是** `{callId, content, isError, …}` 的扁平形状。正确 replacement 必须是
> `session.append('tool/result', { ...original.data, message: { ...original.data.message, content: newBlocks } }, { surfaceOp: { op:'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })`
> ——`callId`/`turn`/`step`/`isError`/`error`/`meta` 都在 `data`/`data.message` 里，不能提到顶层（顶层多余字段虽可能通过 JSON 校验，但 `data.message` 缺失会让 `deriveEventMessage`/回放拿不到消息，且 `error` 只允许在 `data.message.isError===true` 时出现：✅ `$DSH/dsh-session/lib/index.js:271-277`）。
> 另：**是否保留 `error`** 取决于新 message 是否 `isError`；`drop` 类精简应保留 `isError` 原值。

### 1.3 `compaction/prune` 事件协议（影子计价）

✅ 官方定义（`$DSH/dsh-compaction/lib/types/types.d.ts:88-98`）：
```ts
'compaction/prune': {
  shadowedRange: { start: SessionSeq; end: SessionSeq };  // 被替换的 surface 位置跨度（position span，start 可能 > end）
  shadowedSeqs: SessionSeq[];                             // 全部被遮蔽 surface 节点，按 surface 顺序
  shadowedTokenCount: number;                             // 用 token-meter 固定启发式估计的价格（影子价）
}
```
协议契约（✅ 同文件 `:79-87` 注释）：
- 本事件是 **log-only**（无 surfaceOp、不进模型历史）；
- 它**紧邻**其后的 surface `replace` 事件（“The replacement MUST be appended synchronously right after this event”），其中 `shadowedTokenCount` 就是那次 replacement 的影子价，纯消费者可 O(1) 扣减；
- `compaction/summary` 对 summarizing compaction 承担同样协议；`compaction/start|summary|end` 都是 log-only 事件（✅ `types.d.ts:21-78`）。

### 1.4 `ToolResultPruner` 完整签名与调用前提

✅ `$DSH/dsh-compaction-tool-result-pruner`（本 build 已安装）：

```ts
// $DSH/dsh-compaction-tool-result-pruner/lib/types/index.d.ts:19-52
class ToolResultPruner extends Service {
  static inject: string[];                 // ["tokenMeter"]（lib/index.js:59）
  static Config: z<ToolResultPruneConfig>;
  readonly config: ResolvedConfig;
  constructor(ctx: Context, config?: ToolResultPruneConfig);
  measureContent(blocks: readonly ContentBlock[]): number;          // :30
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null;  // :38，null = 未超预算
  pruneSession(session: Session): PruneResult;                      // :51
}
interface ToolResultPruneConfig { thresholdChars?: number; headChars?: number; tailChars?: number }  // types.d.ts:4-11
interface ResolvedConfig { readonly thresholdChars: number; readonly headChars: number; readonly tailChars: number }
interface PrunedEntry {
  readonly originalSeq: SessionSeq; readonly replacementSeq: SessionSeq;
  readonly callId: ToolCallId;
  readonly charsBefore: number; readonly charsAfter: number;
}
interface PruneResult { readonly pruned: readonly PrunedEntry[]; readonly charsRemoved: number }
```
**语义与前提**（✅ README + impl `lib/index.js:137-194`）：
1. `pruneSession` 只看**当前 surface**（`for (const seq of [...session.surface.nodes])` → `session.eventAt(seq)` → `event.type === 'tool/result'`），逐条 `deriveEventMessage` → `pruneContent`。
2. 对每个超预算结果：先 `session.append('compaction/prune', {shadowedRange:{start:seq,end:seq}, shadowedSeqs:[seq], shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original)})`，再 `session.append('tool/result', {...event.data, message}, {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq}, sourceEventSeqs:[seq]})`（`lib/index.js:159-173`）。
3. 失败语义：**同步**执行；某条 replacement 被 session 拒绝即 throw，**此前已提交的替换保持有效**（✅ `index.d.ts:48-50`：“replacements committed earlier in the pass remain durable”）。
4. 配置校验：未知 key、非正整数、`head + marker + tail > threshold` 都会在构造/解析时拒绝；marker 是固定串 `"\n\n[... tool result middle pruned ...]\n\n"`（✅ `lib/types/config.d.ts:4`）。
5. **它不会把“哪些该留”交给模型**：head/tail 盲切；且没有“传入候选计划”的 API。→ 我们的插件要自己写 replacement（不能只调 `pruneSession`），但**复用同一事件协议**。

### 1.5 从插件里「追加一个替换工具结果」的正确方式

✅ **唯一正路 = `Session.append`（append-only，不改写/不删原事件）**。官方先例就是 §1.4 代码。最小可运行片段：

```js
// 前提：session: Session；ctx.tokenMeter；seq = 原 tool/result 的 seq（必须仍是当前 surface 节点）
const event = session.eventAt(seq)                    // 新代码优先注入 projection/reader，避免 deprecated 同步读
const original = session.deriveEventMessage(event)    // ToolResultMessage
const prunedMessage = freezeMessage({ ...original, content: prunedContent })  // dsh-llm 导出的 freezeMessage

session.append('compaction/prune', {
  shadowedRange: { start: seq, end: seq },
  shadowedSeqs: [seq],
  shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
})
const replacement = session.append('tool/result', { ...event.data, message: prunedMessage }, {
  surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
  sourceEventSeqs: [seq],
})
// replacement.seq 可用于 UI / 去重 / 统计
```
要点：
- **事务性**：`append` 是同步原子提交（进入 log 即 committed），**没有 await/事务 API**；observer 失败被逐个隔离、不改变返回值（✅ `dsh-session/lib/types/index.d.ts:257-290` JSDoc）。持久化是插件的异步缓冲（订阅 `session/event`、`session/flush` drain）。
- **重入禁令**：在 `session/event` 同步监听器里再 append 会因“重入 publication”被拒 → 必须 `queueMicrotask`/`ctx.timer` 延后（✅ append JSDoc：“an append reentered ... also rejects before the log changes”）。**但在 `agent/pre-step` waterfall 内同步 append 是官方安全用法**（见 Q5）。
- **回放安全 / 用户可见历史不变**：
  - 原事件仍在 log，replay 可完整重建；
  - 人类可见 transcript 用的是 **append-origin** 事件（`isAppendSurfaceEvent`），replacement 是 model-only（✅ `$DSH/dsh-session/lib/types/surface.d.ts:36-58`：“the model-visible surface deliberately shadows replaced ranges, so it is the wrong source for a human transcript ... replacement copies stay model-only”）；
  - 因此前端聊天记录不会因为精简而丢内容（除非我们另加一行 UI，见 Q2）。
- **失败语义**：payload 必须是 lossless JSON（大整数/循环/稀疏数组等拒绝）；replacement 必须覆盖完整被遮蔽节点；不合法则 throw 且不改 log。mid-pass 失败时前面的替换已提交 → 设计上要**单批聚合、幂等可重试**。
- ⛔ **不存在** “appendReplacement(toolResult)” 之类封装。`appendPluginRecord(session, type, data)`（✅ `$DSH/dsh-session/lib/types/index.d.ts:121`，实现 `lib/index.js:1272-1315`）是**唯一**能写出 `ignorable: true` 的 `plugin:*` 记录的正规入口：它把记录标 `ignorable`、永不进入模型可见 surface、resume/fork 原样携带、格式迁移 best-effort 保留。但官方契约明确限制调用者：README“Plugins outside this repository must not call it either, although no repository check can inspect them.”（✅ `$DSH/dsh-session/README.md:72`）。→ 见 §2.4 的合规取舍。
- 幂等/去重：append 前检查该 seq 是否仍在 `session.surface.nodes`（否则已被别的 pass 遮蔽）；如需要可读最近 `compaction/prune` 事件的 `shadowedSeqs` 做幂等集合。

---

## 2. 压缩与 UI（Q2）

### 2.1 `dsh-compaction-basic`：触发条件与 API

✅ `$DSH/dsh-compaction-basic/README.md:36-88`、`lib/index.js:830-980`：
- **触发公式**：context window `W`、输出预留 `O`、headroom `B`（默认 65536）→ 阈值 `floor(min(W × 0.8, W − O − B))`；保留最近 `W − O` 的 16% 原文。超过阈值才压缩；「压力确认 → 先 prune 后 summary」。
- **三条自动路径**（✅ `lib/index.js:839-895`）：
  - `agent/pre-step`（waterfall）→ `compactIfNeeded(agent,'pressure',signal)`；
  - `agent/request`（waterfall，prepend）→ 模型切换时按新 header 计价；
  - `agent/request-error` → `CONTEXT_WINDOW_EXCEEDED_CODE` 溢出恢复（`maxOverflowRetries`）。
- **核心 API**（✅ `$DSH/dsh-compaction/lib/types/index.d.ts:116/137/157`）：
```ts
abstract compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal): Promise<CompactionResult | null>
abstract compactNow(agent: ManualCompactAgentContext, signal, sourceCommandId?): Promise<CompactionResult | null>   // 手动/import 用，要求 idle
abstract compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?): Promise<CompactionResult>
// CompactionTrigger = 'pressure' | 'context-overflow'
```
- 配置（✅ README 表）：`thresholdRatio .8 / headroomTokens 65536 / retainRatio .16 / retainTokens / summarizationProvider+Model / maxTokens / compactionRetries 1 / maxOverflowRetries 1 / modelPolicies[] / auto true`。
- 它**主动调用** pruner：`this.ctx.get('toolResultPruner')?.pruneSession(agent.session)`（✅ `lib/index.js:938,962`）——**这是我们可以替换/增强的闩点**：压力确认后、选 range 前。
- `/compact` 命令走 `ctx.compaction.compactNow(...)`（✅ `$DSH/dsh-command-compact/lib/index.js:55`）。

### 2.2 前端「上下文已压缩 / 上下文已压缩…」这一行：谁渲染、被什么驱动

✅ 完整链路（全部在 `dsh-client-ui-chat`，无需自研）：

| 层 | 证据 |
|---|---|
| 文案（zh） | `$DSH/dsh-client-ui-chat/lib/client.js:6672-6677`：`message.compaction`=`上下文已压缩`、`.running`=`正在压缩…`、`.completed`=`已压缩 {items} 条历史记录（约 {tokens} tokens）`、`.expand`、`.unavailable`、`.commandTitle`；en 在 `:6870-6875` |
| 行组件 | `CompactionItem`：`$DSH/dsh-client-ui-chat/lib/types/client/chat/CompactionItem.d.ts`；`CompactionNodeView` 在 `lib/client.js:6301` |
| 业务定义（事件→节点） | `compactionDefinition = { kind:'compaction', target:'chat', match(event){…}…, buildViewNode }`：`lib/client.js:11765-11796`；`match` 命中 `compaction/start|summary|end`（带 `compactionId`，且排除 manual）或 landed compact checkpoint |
| 数据来源 | **session 事件流**（`compaction/*` log-only 事件也进入 client 事件流）→ 由 ConversationNodeDefinition 累积 state → `buildViewNode` 产出 `{kind:'compaction', target:'chat', anchorSeq, location, visibility, data}` |
| 渲染 seat | `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({name:'conversation.chat.node', key:'compaction', locale:NS}, CompactionNodeView))`：`lib/client.js:9228`（registerChatNodeRenderers）+ `:9295-9305` |
| 注册 Definition | `ctx.uiConversation.events.register(compactionDefinition)`：`lib/client.js:11799` |

> 即：**不是** projection 驱动，而是「session 事件 → client conversation node definition → chat node kind → keyed slot renderer」。

### 2.3 让前端原生显示「已精简工具调用结果」一行：方案排序

**主路径（Lead 决策，✅ 端到端链路已验证）：自写 `plugin:*` session record（`appendPluginRecord`）作 UI 数据源 + 自注册 ConversationNodeDefinition + `conversation.chat.node` keyed renderer；`compaction/prune` 只做 token-meter 记账（严格官方 schema，不夹带 UI 字段）。**

> 早先版本曾建议“用官方 `compaction/prune` 驱动 UI 行、不写 plugin record”。Lead 核实后决策改为：**UI 数据源 = plugin record**（payload 可自定义：`runId/op/reason/chars/status`），`compaction/prune` 严格保持官方 schema 仅用于记账。两者都进 client 事件流（§2.4 逐行证据）。本报告按此决策编排。

- **数据侧（core 模块统一写）**
  1. 每条替换之前 append 官方 `compaction/prune`（§1.3 严格 schema）→ token-meter / compaction 记账正确（与原生 `dsh-compaction-tool-result-pruner` 同协议）；
  2. **整批**替换完成后 append 一条 `plugin:context-slimmer/tool-result-pruned`（命名文法与写入细节见 §2.4(c)；payload 见 `docs/architecture.md` §3.5）→ UI 行的唯一数据源，同时作进度锚点（计数重置边界、失败行也用它）。
- **渲染侧 API（✅ 精确签名）**
```ts
// $DSH/dsh-client-ui-conversation/lib/types/client/contract/conversation.d.ts:176-230
interface ConversationNodeDefinition<State> {
  readonly kind: string;                                  // 第三方 kind，如 'context-slimmer-tool-result'
  readonly target?: string;                               // 'chat'
  match(event: SessionEventLike): { id: string; role: 'start'|'update'; exclusive?: true } | null;
  start(context: ConversationNodeContext<State>, match: ConversationStartMatch, reader: ConversationContextReader): State;
  update(context: ConversationNodeContext<State> & { state: State }, match: ConversationMatch): State;
  publication?(match): 'none' | 'animation-frame' | 'immediate';
  buildViewNode?(context): ConversationViewNode | null;   // {key,kind,id,target,anchorSeq,location,visibility,data}
}
// 注册：ctx.uiConversation.events.register(definition) => disposer
//       $DSH/dsh-client-ui-conversation/lib/types/client/conversation/event-registry.d.ts:19
// 事件路由：forEvent(type) 按 event.type 建索引，可匹配任意 type 字符串（同文件 :31-38）
```
- **渲染 seat（keyed slot）**（✅ `$DSH/dsh-client-ui-renderer/lib/types/client/registry.d.ts:95,111,164`；`dsh-client-ui-renderer/lib/client.js:1348` 提供 `slots`）
```js
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node', key: 'context-slimmer-tool-result', locale: NS,
}, SlimResultRow))
```
- **完整最小骨架（Definition + 组件 + locale）见 §2.4(b)**。
- 文案：`ctx.locale.register(NS,'zh',dict)` / `'en'` + `bind`（✅ `$DSH/dsh-client-locale/lib/types/client/index.d.ts:209,226`）；面板/包元数据：`locale/en.json`+`locale/zh.json` 的 `{"meta":{"title","description"}}`（见 Q7(b)/Q8）。

**备选路径（仅当 CI/真实 GUI 实测 plugin record 未达 UI 时启用）：官方 `compaction/prune` + replacement `tool/result` 的 `data.meta`。**
- Definition `match: e => e.type === 'compaction/prune'`（或 `isReplacementSurfaceEvent(e)` 聚合 replacement），`data` 取 `{shadowedSeqs, shadowedTokenCount}`，明细塞 replacement `data.meta`（`meta?: JsonValue`，✅ `dsh-session/lib/types/types.d.ts:382-396`）。
- 优点：100% 官方 schema、不写 plugin record；缺点：`shadowedTokenCount` 是估算而非 real chars，`op/reason/status/runId` 无处安放；无法表达失败行。
- CI 断言：主路径与备选**择一必须**产出 UI 行（§12-B4），主路径失败时才降级。

**排除路径**
- **方案 C（只改工具卡片）**：replacement 会按 `callId` 更新工具卡片内容，但**不会**产生独立「已精简」行；卡片内容由各工具 `presentResult` 决定，不属于本包。→ 可作补充（工具卡片显示精简后的内容），不满足“原生一行”。
- **方案 D（复用完整 compaction 行）**：`compaction/summary` 是摘要压缩语义，会触发 compaction 锁与 retention 策略，❌ 不能用。

**结论**：主路径 ≫ 备选 ≫ C ≫ D。主路径 host→client 事件转发与 Definition 匹配链路见 §2.4(a) 逐行证据；仅剩真实浏览器渲染冒烟（§12-C）。

### 2.4 主路径补证：plugin record 进 client 事件流 + 最小 Definition 骨架 + 写入细节（`appendPluginRecord`）

#### (a) 证据链（Lead 核实 + 本报告逐行复核，全部 ✅）

1. **host 全量转发**：`$DSH/dsh-api-session-controller/lib/index.js:1231-1244` `entryFor(event) = {type:'event', event}`（无类型过滤）、`pageRecords(events) = events.map(entryFor)`；实时通道 `EventListener`（`:1267-1320`）对 `ctx.on('session/event')` 仅按 `session.id` 过滤后 `input.append({type:'event', session, event})`，`transform()` 里 `yield entryFor(event)`（`:1314`）。→ **所有** committed session 事件（含 `plugin:*`）都进 client 事件流。
2. **client 接受未知 ignorable 事件为 log-only**：`$DSH/dsh-api-session-controller/lib/client.js:279-289` `surfaceOpOf`：`if (!isSurfaceEligibleType(event.type)) { if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) return; … return }` → 未知类型 + `ignorable:true` 直接按 log-only 接受、不丢事件（与 core 的 surface 校验 `$DSH/dsh-session/lib/index.js:299-307` 同款逻辑）。
3. **Definition 按 event.type 路由、可匹配任意 type**：`$DSH/dsh-client-ui-conversation/lib/client.js:2807-2826` assembler 对每个事件 `eventDefinitions.forEvent?.(event.type)` 取候选（`forEvent` = 按字符串建索引的 type 表 + 所有函数式 handler，✅ `conversation/event-registry.d.ts:31-38`），否则遍历所有 definition 调 `definition.match(event)`；命中即产出节点，**没有任何 type 白名单**。
4. **chat target 接受第三方 kind**：`$DSH/dsh-client-ui-chat/lib/client.js:9475`、`:10296`、`:10437-10474` 只按 `node.kind` 做**行为分支/可见性规则**（`visibility==='visible' && kind!=='system-prompt' …`），`ChatSnapshotBuilder`（`:11401-11520`）按通用 node store 增量维护，**不按 kind 白名单丢弃**；`conversation.chat.node` keyed slot（`:9238` 起）本来就允许任意 `key`（官方 user/steering/reasoning/compaction… 都是 key）。
5. **写入侧**：`appendPluginRecord(session, 'plugin:<owner>/<record>', data)`（✅ `$DSH/dsh-session/lib/types/index.d.ts:121`）是唯一产出 `ignorable:true` 记录的正规 API；记录不进 surface、resume/fork 携带、格式迁移 best-effort（✅ README:70-80）。类型侧通过 declaration merge 扩展 `PluginRecordMap`（✅ `types.d.ts:522-550`：`PluginRecordType = \`plugin:${string}\``，命名文法 `plugin:<owner>/<record>`，段内小写字母/数字/./_/- 且以字母或数字开头）。

#### (b) 最小 Definition 骨架（匹配 plugin record；🟡 仅剩真实浏览器冒烟）

```js
// client half：lib/client.js（手写 __ModuleLoader__ bundle，见 §9.1）
window.__ModuleLoader__.load({
  id: '@ds-hu/dsh-context-slimmer-tool-result',
  factory(require) {
    const React = require('react')
    const NS = 'context-slimmer-tool-result'
    const zh = { 'row.pruned': '已精简工具结果', 'row.pruned.summary': '已精简 {count} 条工具结果（约省 {chars} 字符）', 'row.failed': '精简未生效' }
    const en = { 'row.pruned': 'Tool results slimmed', 'row.pruned.summary': 'Slimmed {count} tool results (~{chars} chars saved)', 'row.failed': 'Slimming made no change' }

    function SlimResultRow({ node, t }) {
      const h = React.createElement
      const d = node.data
      return h('div', { className: 'csw-row', 'data-run': d.runId },
        h('span', { className: 'csw-icon', 'aria-hidden': true }, '⌁'),
        h('span', { className: 'csw-title' }, t(d.status === 'applied' ? 'row.pruned' : 'row.failed')),
        h('span', { className: 'csw-summary' },
          t('row.pruned.summary', { count: d.totals?.items ?? 0, chars: d.totals?.charsSaved ?? 0 })))
    }

    return {
      inject: ['slots', 'locale', 'uiConversation'],
      apply(ctx) {
        ctx.locale.register(NS, 'zh', zh); ctx.locale.register(NS, 'en', en)
        ctx.effect(() => ctx.uiConversation.events.register({
          kind: 'context-slimmer-tool-result',
          target: 'chat',
          // 直接匹配 plugin record（§2.4(a) 链路）
          match: (event) => event.type === 'plugin:context-slimmer/tool-result-pruned'
            ? { id: String(event.seq), role: 'start' } : null,
          start: (_c, m) => ({ seq: m.event.seq, data: validateRecord(m.event.data) }),
          update: (c) => c.state,
          buildViewNode: (c) => ({
            key: c.key, kind: 'context-slimmer-tool-result', id: c.id, target: 'chat',
            anchorSeq: c.state.seq,
            location: c.start?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: c.state.data,
          }),
        }), 'context-slimmer: conversation node')
        ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
          name: 'conversation.chat.node', key: 'context-slimmer-tool-result', locale: NS,
        }, SlimResultRow))
      },
    }
  },
})
// validateRecord：owner 必须自己校验 data（README:80：早前 build 可能写过不同 payload）——只接受 version===1 且有 totals/items/status 的对象，否则返回安全空值。
```
> 定义字段语义与生命周期：✅ `contract/conversation.d.ts:176-230`；`event-registry.d.ts:19`；chat 官方先例 `CompactionNodeView`（`lib/client.js:6301`）与 `compactionDefinition`（`:11765-11799`）。

#### (c) 写入细节：从插件调用 `appendPluginRecord`（全部本机验证）

- **import 与实例同一性（关键）**：`import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'`；从已安装的 profile 插件包解析到的是 **host 唯一副本**——实测：
  - `cd /root/.dsh/profiles/web/node_modules/@ds-hu/dsh-bw-core && node -e "import.meta.resolve('@deepseek-ai/dsh-session')"` → `file:///usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`，`appendPluginRecord` 为 function。
  - 同一 realpath = 同一 ESM 实例 → `commitPluginRecord(session,...)` 调 `session.#appendRecord(...)` 的私有 brand 匹配（✅ `dsh-session/lib/index.js:1547-1565`）。
  - ⚠️ 若打包器把 `@deepseek-ai/dsh-session` 复制成第二份副本，调用会因 `#appendRecord` brand 不匹配抛 TypeError。**对策**：宿主侧代码按 ESM 原样 `import`（不 bundle 该依赖；client 构建的 externals 与本模块无关）、启动时功能自检 `typeof appendPluginRecord === 'function'`、并 try/catch 降级。
- **调用时机**：只能在 session live 且**非重入**（`append` publication 之外）。`agent/pre-step` / `agent/turn-stopping` / `tools/result` 的 microtask 内都可以；官方 app 在 pre-step 内同步 append 的先例见 §5.1。
- **失败模式（会 throw，✅ `index.d.ts:100-120` JSDoc）**：store-owned session 未 enter / 创建公告未完成 / `type` 不符合文法 / `data` 非 lossless JSON / 重入另一个 append 的 publication。→ **每条写入都 try/catch**，失败时 UI 无该行但不影响会话；并在下一 pass 重试。
- **命名**：`plugin:context-slimmer/tool-result-pruned`（owner 段建议等于包短名；与 `docs/architecture.md` §3.5 一致）。
- **payload 约束**：只放 JSON 可序列化数据；加 `version: 1`（未来演进）；`status:'applied'|'no-op'|'rejected'|'failed'`；明细 `items[]`（index/callId/toolName/op/reason/charsBefore/charsAfter/replacementSeq）。
- **回放/恢复**：写一个 `ctx.sessionProjections` 单元，对每个事件调用 `pluginRecordOf(event)`（✅ `index.d.ts:130`），重建 UI 所需状态（上次锚点 seq、累计 savings）→ resume/fork 后 UI 行仍可恢复（因为记录随 log 携带）。**建议必做**，否则重启后 UI 只剩 live 段。
- **契约 caveat（如实记录）**：官方 README 明文“`appendPluginRecord` 仅 repo 内 `packages/experimental/` 生产代码可调用，仓库外插件同样不应调用”（✅ `dsh-session/README.md:72`），且记录在格式迁移中只 best-effort 保留。**Lead 已决策采用此路径**（产品要求 UI 自定 payload）；缓解措施：payload additive+version、UI 对缺失/陌生记录降级、README/CONTEXT 披露、记录不参与模型可见状态（即使未来迁移丢弃只影响 UI 行与计数锚点，不影响主 Agent 历史）。
- **禁止**：`session.append('plugin:…')` 手写（不产生 `ignorable:true`，违背官方未知类型兼容策略 `types.d.ts:540-560`、README:74）。

#### (d) 决策记录

| 决策点 | 结论 | 依据 |
|---|---|---|
| UI 数据源 | **plugin record（`appendPluginRecord`）为主路径** | Lead 决策；§2.4(a) 链路已验证；payload 可自定义 |
| 记账事件 | `compaction/prune` 严格官方 schema，每条替换前写 | 与原生 pruner 同协议（§1.3/§1.4），token-meter 依赖 |
| 备选 | `compaction/prune` + replacement `data.meta` | 主路径 CI 冒烟失败时降级，§12-B4 |
| plugin record 命名 | `plugin:context-slimmer/tool-result-pruned` | 架构契约 §3.5；文法合规 |
| 契约风险 | 已知并接受，附缓解 | README:72；见 (c) caveat |

## 3. fork subagent（Q3）

### 3.1 可选的三条编程路径

**(A) 托管 seam：`ctx.subagents.startActivation()`（推荐用于“省事、后台、可取消”）**
✅ `$DSH/dsh-subagent/lib/types/index.d.ts:136-153`、`types.d.ts:24-100`：
```ts
interface SubagentActivationSpec {
  provider: string;                 // 'fork'
  label: string;
  childId?: SessionId;
  request: Omit<SubagentStartRequest,'label'|'signal'>;  // { parent: Agent; prompt/...; agentOptions?; outputSchema?; maxDepth?; cwd? }
  signal: AbortSignal;
  delivery: 'parent' | 'caller';    // 'caller' = 结果只返回给调用者，不通知父模型
}
interface SubagentActivation {
  childId: SessionId;
  messageId?: MessageId;
  result: Promise<SubagentResult>;  // {output, structured?, diagnostic?, stopReason}
  dispose(): Promise<void>;
}
ctx.subagents.startActivation(spec): Promise<SubagentActivation>
ctx.subagents.waitForChildren(parent): Promise<boolean>
```
- **携带完整上下文**：fork provider 的 `prepareContinuable()` 取 parent「最后一个 `turn/end` 之前的完整前缀」作 seed（✅ `$DSH/dsh-subagent-fork-in-process/lib/index.js:22-48`：`completedTurnPrefix`）。`inheritsParentContext = true`。
- **能力**：`capabilities = { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: true }`（✅ 同文件 `:35`）→ **可覆盖 provider/model/reasoningEffort/maxTokens**、可要结构化输出、可限制深度；**不能**用 agent preset。
- **不适合**：没有 setup 钩子 → 无法在 child 创建时 `restrict` 工具集（见 §3.2）；只能继承父 composition 的工具集。
- **await/取消**：`activation.result` / `activation.dispose()`；`SubagentRun.result` 在子失败时 resolve 为 `stopReason:'error'`（不 reject），基础设施故障才 reject（✅ `types.d.ts:265-295`）。
- **阻塞性**：`delivery:'caller'` + 不 await 即可完全后台；await 则阻塞调用点（例如在 `agent/pre-step` 里 await 会阻塞该 step 准备）。并发：service 允许对**不同 child** 并发调用同一 provider（✅ `types.d.ts:300-310`）。

**(B) 底层：`ctx.agents.create()`（推荐用于“自定义工具集 + 模型覆盖”的精简子 Agent）**
✅ `$DSH/dsh-agent/lib/types/index.d.ts:49-115`：
```ts
interface CreateAgentOptions {
  sessionId: SessionId;
  parentAgent?: Agent;
  meta?: { cwd?; parentSession?: SessionId; isSeeded?; origin?: 'subagent'; delegationDepth?; agentPreset? };
  inheritedEventCount?: SessionLogOffset;
  seed?: readonly SessionEvent[];          // 从 seq 0 连续的 fork 前缀 / replay 历史
  agentOptions?: AgentOptions;             // {provider, model, reasoningEffort?, maxTokens?}
  signal?: AbortSignal;
  setup?: (agentCtx: Context, agent: Agent) => void | AgentSetupCommit | Promise<void|AgentSetupCommit>;
}
ctx.agents.create(options): Promise<AgentHandle>   // handle.agent + handle.dispose()
```
- **seed 的正确构造**：`buildForkSeed(events, boundary)`（✅ `$DSH/dsh-session/lib/types/fork.d.ts:17`）——复制 inclusive 前缀、标记 inherited cut、为未闭合的 tail 补 synthetic results/step/turn closers；`boundary` 必须是已存在连续 seq。**安全边界 = 最后一个 `turn/end`**（in-flight turn 不 balanced，不能作 seed）。
- **setup 内可以做的事**（✅ `CreateAgentOptions.setup` JSDoc 原文）：`agentCtx.tools.register(...)`（scoped）、`agentCtx.tools.restrict(...)`、prompt section/variable、listener、awaited child plugin。这些都在 `agent/created` 与首次 prompt 组装**之前**生效。
- **优点**：完全控制 model / toolFilter / 工具 / persona；**代价**：自己管生命周期（dispose）、父级 catalog、深度、delegation policy 继承（可复用官方 `captureDelegatedPolicyOverrides` / `applyChildComposition` / `childSessionMeta` 等导出，✅ `$DSH/dsh-subagent/lib/types/child-agent.d.ts`）。

**(C) 模型面向工具：`subagent` / `subagent_fork`。** 不用于本插件内部（原因：fork 工具**刻意不暴露** child 路由选择，以保 KV 复用；✅ `$DSH/dsh-subagent-fork-in-process/README.md` Known Limitations：“Shipped fork tools do not expose child LLM route selection”），但可作为用户手动委托的补充能力。

### 3.2 指定子 Agent 可用工具集（禁用其余全部）

✅ 机制：**scoped registration + restrict**。
- `ctx.tools.register(def)` 在 agent scope 内注册 = **scoped tool**，不受 restrict 影响、不与其它 scope 冲突（✅ `$DSH/dsh-tools/lib/types/index.d.ts:42-49`）。
- `ctx.tools.restrict({allow?, deny?})` **只遮蔽 global tools**，按 scope 生效、可叠加、可 dispose 解除（✅ 同文件 `:52-58`；`$DSH/dsh-tools/README.md:88`）。
- **关键约束**：`allow` 里**不能**写 scope-local 名或未知名（会 throw），所以“只留自定义工具”不能写 `allow:['my_slim_tool']`。正确做法是 **deny 全部 global，再 scoped register**：
```js
setup: (agentCtx) => {
  // 1) 先注册本子 Agent 专用工具（scoped，restrict 不影响它）
  agentCtx.tools.register(defineTool({ name:'context_slimmer_plan', ... }))
  // 2) 再遮蔽所有 global 工具（枚举当前 global definitions；必须 JSON 名称）
  const deny = agentCtx.tools.definitions().map((d) => d.name)
  agentCtx.tools.restrict({ deny })   // 先 deny 再 register 顺序无关，但都要在 setup 内
},
```
- ⚠️ 缺口：`restrict` 的 deny 是**创建时快照**；子 Agent 运行期间父侧新注册的 global tool 会漏进子 Agent（`tools/change` 事件可订阅，但 restrict 是一次性 mask）。缓解：子 Agent 生命周期短（单次精简任务）、或按需再次 restrict、或改用 (A)+独立 preset（但 fork 不支持 preset）。
- 其他按需开关：
  - `ctx.tools.register(def, { when: (activationCtx) => boolean|Promise<boolean> })`：**每个 step** 评估，false 时不进 schema、不可调用（✅ `contracts.d.ts:110-119`；`dsh-tools/README.md:69`）。
  - `when` 的 `ToolActivationContext = { agent, modelSelection, signal }`（✅ `contracts.d.ts:101-108`）→ 可据 agent 身份/模型决定可见性。
  - scoped tool 只能在创建它的 scope 可见；`ctx.tools.get(name, scope)` 验证（✅ `index.d.ts:78`）。

### 3.3 覆盖子 Agent 模型

- `AgentOptions = { provider?, model?, reasoningEffort?, maxTokens? }`（✅ `$DSH/dsh-agent/lib/types/runtime-types.d.ts:27-38`）。
- (A) 路线：`request.agentOptions` + fork provider 支持 `agentOptions` 能力（✅ `$DSH/dsh-subagent-fork-in-process/lib/index.js:35`）；官方合规做法是先 `ctx.llm.resolveModelInfo(provider, model)`/`resolveCallConfig` 预检（✅ `$DSH/dsh-tool-subagent/lib/types/model-selection.d.ts` `preflightChildLlmRoute`）。
- (B) 路线：直接 `CreateAgentOptions.agentOptions`。
- 默认模型来源见 Q6。

### 3.4 以不破坏前缀缓存的方式追加任务消息

✅ 规则：
- **只 `append` user 消息**，绝不改 system prompt / 历史 / tool schema。fork 复用父前缀的前提是「byte-for-byte 相同请求输入」：system prompt 节点、tools 数组、消息内容都要一致（✅ `$DSH/dsh-session/README.md:167,195`；`$DSH/dsh-subagent-fork-in-process/README.md` Known Limitations：“Prefix reuse depends on matching request inputs”）。
- 子 Agent 的任务消息应作为**初始 user message 进入 child inbox**（`agent.inbox.append('nextTurn'|'nextStep', userMessage)`，✅ `runtime-types.d.ts` Inbox 文档），或托管路线的 `SubagentStartRequest.prompt`（manager 负责投递）。
- continuable 消息（后续 `sendMessage`）不新增 child-only system-prompt section 或 tool schema（✅ `$DSH/dsh-subagent/README.md` 相关段落）；parent id/返回指引放在初始 user task 里。
- ⚠️ **fork 的 seed 只到最后一个 `turn/end`**：当前 turn 里刚产生的 tool 结果**不在** child 上下文里。→ 精简器若要让 LLM 看“当前 turn 的候选结果”，必须在初始 user message 里**显式附带候选内容/摘要（append-only）**，这是设计上的关键约束（也意味着 token 成本）。

### 3.5 并发、取消、与主循环的关系

- 完成：`result` promise；取消：`signal`（start 前）+ `dispose()`（start 后，幂等）；并发：可并发多个 distinct child；深度：`resolveChildDepth`/`maxDepth`（默认 Host `subagent.maxDepth = 1`）。
- 与主 agent turn 循环：模型面向工具路径是「发起即返回 child id，完成经 notice 送达父模型」；**编程路径在哪个 hook 里 await 就阻塞哪个阶段**。不阻塞主 turn 的做法：
  1. `delivery:'caller'` + fire-and-forget（把 `result.then(...)` 挂到后续）；
  2. 放进 `ctx.jobs.start()`（见 Q5）或 `ctx.timer` 调度的后台任务；
  3. 在 `agent/turn-stopping` 里启动、下一 turn 前消费结果（但仍建议 fire-and-forget）。
- 子 Agent 会创建自己的 turn 循环并在自己 session 里跑；父 `waitForChildren(parent)` 可 join（✅ `$DSH/dsh-subagent/lib/types/index.d.ts:153`）。父 agent 被 dispose 时其 descendant 会被级联（托管路径）。

---

## 4. 工具注册与按 agent/subagent 禁用（Q4）

### 4.1 `ctx.tools` 服务 API

✅ `$DSH/dsh-tools/lib/types/index.d.ts`：
```ts
register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void        // :50
restrict(filter: ToolRestriction): () => void                                              // :58  （按调用者 agent scope）
get(name, scope?, toolSet?): ToolDefinition | undefined                                    // :78
executable(name, scope?, toolSet?): ToolDefinition | undefined                             // :87
resolve(context: ToolActivationContext): Promise<ResolvedToolSet>                          // :95
definitions(scope?, toolSet?): readonly ToolDefinition[]                                   // :102
schemas(scope?, toolSet?): readonly ToolSchema[]                                           // :110
setExecutor(executor: ToolExecutor): () => void                                            // :117
execute(input: ToolBatchInput): Promise<ToolBatchResult>                                   // :130
guard(guard: ToolGuard): () => void                                                        // :136
```
- 注册即自动进入 system prompt 的 tool schema 列表（✅ `dsh-tools/README.md:30`）。
- 重复命名：**同一 layer 内重复 + 保留名 `run_code`** 会失败；scoped 工具 shadow global（✅ `index.d.ts:42-49` JSDoc；`RUN_CODE_NAME` `contracts.d.ts:14`）。**没有命名空间机制** → 自定前缀（`context_slimmer_*`）是唯一实践。

### 4.2 官方 `defineTool` 约定

✅ `$DSH/dsh-tools/lib/types/schema.d.ts`（`defineTool`）+ `contracts.d.ts:23-100`：
```ts
defineTool({
  name, description,
  parameters: { /* 作者 DSL：string/number/integer/boolean/null/array/object/json/oneOf + description/default/title/enum/const/required */ },
  output: { schema, render(args,value): ContentBlock[], presentationMeta?(...) },
  execute(args, exec): Promise<unknown>,           // 只返回 canonical JSON value
  projectContent?, finalizeContent?,               // 内容变换钩子
  presentCall?(args): ToolCallView, presentResult?(args,result): ToolResultView,   // 纯函数、可 replay
  isConcurrencySafe?(args): boolean, timeoutMs?, deferLoading?: true,
})
```
- arguments 在 `execute` 前被严格校验，非法 → 普通 error result（✓ `dsh-tools/README.md:34`）。
- 面向模型的 schema 只投影 `name/description/parameters`；`output/execute/...` 不上线（✅ `README.md:112`）。
- 权限/可见性策略：`tools/pre-execute`（waterfall: allow/deny/ask/cancel）、`ctx.tools.guard()`（单调 deny）、`tools/execute`（timeout/retry wrapper）、`tools/post-execute`（inspect/replace/block/附加 context）、`tools/result`（只观察）（✅ `dsh-tools/lib/types/events.d.ts`；`README.md:92,112`）。审批能力由 `dsh-authorization`/`dsh-user-approval` 提供（本插件不需要）。

### 4.3 只在某个 subagent / 某次调用启用某工具

| 需求 | API | 证据 |
|---|---|---|
| 只给某个（子）Agent | 在该 agent scope 的 `agentCtx.tools.register(...)`（`CreateAgentOptions.setup` 内） | ✅ `dsh-agent/lib/types/index.d.ts:100-115`、`dsh-tools/.../index.d.ts:42-49` |
| 该 Agent 看不见其它工具 | `agentCtx.tools.restrict({deny:[...]})` | ✅ `index.d.ts:52-58` |
| 按 step 条件 | `register(def,{when:(ctx)=>{...}})` | ✅ `contracts.d.ts:110-119` |
| 按调用拦截 | `tools/pre-execute` + `ctx.tools.guard()` | ✅ `events.d.ts` |
| 临时取消某个工具 | 保存 `register()` 返回的 disposer 并调用 | ✅ `index.d.ts:50` |

---

## 5. 触发钩子与 token 计量（Q5）

### 5.1 轮次生命周期与可挂事件（inspect `Event.listEvents` + 类型）

✅ 事件目录（节选，`mode` 即语义）：

| 事件 | mode | 签名/要点 |
|---|---|---|
| `agent/pre-step` | **waterfall** | `(payload:{agent,messages:UserMessage[],turn,step,signal,modelSelection}, next)=>Promise<PreStepDecision>`；`PreStepDecision={kind:'reject'}\|{kind:'enter',messages,startsRequestSeries?}`（✅ `$DSH/dsh-agent/lib/types/runtime-types.d.ts:117`）；**官方压缩就挂这里并在内同步 append**（§1.5） |
| `agent/request` | waterfall | `(payload, next)=>config`；可改 call config（须保 provider/model/effort） |
| `agent/request-error` | waterfall | 返回 `RequestErrorAction {kind:'retry'}` 或 undefined，用于重试/溢出恢复 |
| `agent/turn-stopping` | **serial** | `(payload:{agent,turn,signal}) => Promise<void>\|void`：turn 即将关闭、模型不再欠响应时（✅ `runtime-types.d.ts:422`） |
| `agent/status` | emit | `{agent,status:'idle'\|'running'}` |
| `agent/created` / `agent/disposed` | serial / emit | 生命周期初始化点 |
| `agent/error` | emit | step/turn 错误 |
| `agent/inbox/inserted` / `claimed` / `discarded` | emit | 输入流 |
| `tools/pre-execute` | waterfall | `(exec,next)=>Promise<PreToolDecision>`（allow/deny/ask/cancel） |
| `tools/execute` | waterfall | around-dispatch（timeout/retry/metrics，只能换 signal） |
| `tools/post-execute` | **waterfall** | `(exec, result:Readonly<ToolExecutionResult>, next)=>Promise<PostToolDecision>`；可 accept/replace content 或 value/block+feedback/附加 additionalContexts（✅ `events.d.ts`；`PostToolDecision` `contracts.d.ts:340-356`） |
| `tools/result` | **emit** | `(exec, result) => undefined`；“frozen, lossless-JSON final outcome”，**listener 失败被隔离、不阻塞调用**（✅ `events.d.ts`）→ 最佳“工具完成后计数”钩子 |
| `session/event` | emit | 所有 committed session 事件（append 后同步派发；**不可在此重入 append**） |
| `session/flush` / `app-boot/config-reload` | emit | 持久化 drain / profile 配置重载完成 |
| `llm/stream` | waterfall | 拦截模型调用（如需透明改写请求） |
| `subagent/start` / `subagent/end` | emit | 子 Agent 观测 |

> `dsh-better-subagents` 的成熟范式就是 `ctx.on('tools/post-execute', …)` 对 `list_subagent_models` 结果做增强（✅ `/workspace/projects/github/dsh-plugins/dsh-better-subagents/lib/index.js`、其 cordis.patch.yml 注释）。本插件若只**观察**应在 `tools/result`；若要**改一次结果**用 `tools/post-execute`。

### 5.2 工具调用完成后计数并在阈值处触发后台任务（且不阻塞主 Agent）

✅ 配方：
```js
// per-session 计数；tools/result 是 emit，天然不阻塞工具返回
const counts = new Map()   // sessionId -> number
ctx.on('tools/result', (exec, result) => {
  const agent = exec.agent; if (!agent) return
  const n = (counts.get(agent.session.id) ?? 0) + 1
  counts.set(agent.session.id, n)
  if (n % THRESHOLD !== 0) return
  // 关键：异步启动，绝不 await/不快照 live 对象；job 归属该 agent session
  queueMicrotask(() => {
    const id = ctx.jobs.start({
      kind: 'context-slim',
      label: 'slim tool results',
      owner: agent.session.id,
      run: async (job) => {
        job.updateProgress('planning')
        const plan = await runSlimSubagent(ctx, agent, job)   // §3
        job.append(JSON.stringify({pruned: plan.length}))
        return { detail: `${plan.length} replacements` }
      },
    })
  })
})
```
- `ctx.jobs`（✅ `$DSH/dsh-jobs/lib/types/types.d.ts`）：`start(spec): JobId`；`JobSpec = {kind,label,owner?:SessionId,toolCall?,run:(job:JobHandle)=>Promise<JobOutcome>}`（`:167`）；`JobHandle = {id, append(text,opts?), updateProgress(line)}`（`:128`）；`JobHooks = {cancel(reason?): void; done: Promise<JobOutcome>}`（`:146`）；还有 `list/get/read/readAt/kill/wait/remove`。**job 属于 agent session**：其它 agent 不可见/不可控；owner agent dispose 会 cancel+await（✅ README）。
  - 前提：需组合中有 controller（`dsh-tool-jobs` 会 attach controller）；否则 `start()` 失败。本 profile web 已含 `dsh-tool-jobs`（工具清单里有 `job_*`）→ ✅ 可用。
  - `start()` 会返回 `<kind>-<uuid>`，且 job 结算会被 `dsh-tool-jobs` 转成 **in-session notice**（不轮询）——对用户可见，可接受（也可直接用 detached promise 避免通知，见下）。
- 若不想出现在 job 列表：用 `ctx.timer` 或在 hook 内 `void (async()=>{...})()` 的 detached promise（⚠️ 但 detached 不受 agent dispose 级联，需自管 abort）。**推荐 jobs**：生命周期与 session 绑定、可观测、可取消。
- **不阻塞主 Agent**：`tools/result` 是 emit（返回值被忽略），不要在这里 await 长任务；`agent/pre-step` 里的工作会被 await（压缩就阻塞该 step），所以**只用它做“是否该精简”的快速判定**（读 token meter + 计数），真正 LLM 精简放后台；结果在**下一 step 的 pre-step** 落盘（append replacement），这样替换与请求构建同拍。

### 5.3 `dsh-token-meter`：怎么读 token / 上下文压力

✅ `$DSH/dsh-token-meter/lib/types/index.d.ts`：
```ts
contextPressure(session: Session): Pick<ContextPressureProjection,'pressureTokens'|'contextWindow'>   // :31
measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement                                 // :53
estimateMessage(message: Message): number                                                                // :64
```
- `ContextPressureProjection`：`pressureTokens?` = 最近一次 provider 报告的 prompt 大小（uncached+cacheRead+cacheWrite，不含输出）；`projectedTokens?` = 下一次请求的预估（pressure + 自采样以来 surface 增量的启发式重定价）；`contextWindow?`（✅ `$DSH/dsh-token-meter/lib/types/projection.d.ts:28-50`）。两者都要在 provider 首次报 usage 后才存在。
- `TokenMeasurement = {logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes: TokenSurfaceNode[]}`；每 node `{seq, tokens(route 价), heuristicTokens(固定启发式)}`（✅ `types.d.ts:24-54`）→ **可精确定位“哪个 surface node 贵”**，是选择精简目标的核心数据。
- `tokenMeter.inject` 无特殊；`ToolResultPruner` 已 inject `tokenMeter`（✅ `dsh-compaction-tool-result-pruner/lib/index.js:59`）。
- 结论：用 `ctx.tokenMeter.measure(session)` 算 budget，用 `nodes[]` 排序候选（按 `tokens` 降序、跳过最近 N 个、跳过 user/system/assistant，只挑 `tool/result`），再交 LLM 决策。

---

## 6. 模型解析与覆盖（Q6）

### 6.1 当前 agent 的模型从哪读

✅ 三层，按优先级：
1. **Session 记录的选择**（recorded）：`agent.model.current(): Readonly<ModelSelection> | undefined`（✅ `$DSH/dsh-agent/lib/types/runtime-types.d.ts` Model 接口）；投影 `modelSelection` 由 `sessionProjections` 提供 `{lastUsed, next}`（✅ `$DSH/dsh-agent/lib/types/types.d.ts:77-88`）。
2. **request/header**（实际请求的 route/config）：`session.requestHeader()`；`request/context` 事件记录 provider/model/capacity（✅ `dsh-session/README.md:133`）。
3. **AgentOptions 兜底**：创建时 `agentOptions`。
- **部署默认**：`ctx.agentDefaultModel.currentSelection(): ModelSelection`（service 由 `@deepseek-ai/dsh-agent-default-model` 提供；`saveSelection(next)` 写 profile patch；无 config editor 时 save 是 no-op）（✅ `$DSH/dsh-agent-default-model/README.md:30-60`；inspect `Service.listService` agentDefaultModel 项）。
- `ModelSelection = { provider: string; model: string; reasoningEffort?: ReasoningEffortId }`（✅ `dsh-agent/lib/types/types.d.ts:69-76`）。

### 6.2 为 fork subagent 指定“另一个模型”的合法取值来源

✅ 合法值必须来自 LLM runtime：
```ts
ctx.llm.listProviders(): LlmProviderInfo[]                     // Remote，可直接给配置页
await ctx.llm.listModels(provider): LlmModelInfo[]             // 每个 provider 的模型目录
await ctx.llm.resolveModelInfo(provider, model, signal?)       // 精确校验 + contextWindow/defaultMaxTokens
await ctx.llm.resolveCallConfig(config, signal?)               // 最终 call config
```
（✅ `$DSH/dsh-llm/lib/types/index.d.ts` LlmRuntime；inspect `Service.listService` `llm` 项签名）。`preflightChildLlmRoute(llm, parentOptions, requested, signal)` 是官方做 preflight 的公开函数（✅ `$DSH/dsh-tool-subagent/lib/types/model-selection.d.ts`）。

**插件设置里“可选其他模型”的实现路径**：
- 配置 schema 存 `{ provider, model, reasoningEffort? }`（schemastery 嵌套对象，见 Q7(b)）；
- 选项来源用 `ctx.llm.listProviders()` + `listModels(provider)`（Host 侧 `remote` 可读；client 侧通过自定义 `plugins.row.config` 页面调用 Host API，或直接在配置里填字符串 + 启动时 `resolveModelInfo` 校验并 WARN）；
- 官方还有「子 Agent 允许路由白名单」机制：`ctx.subagentModelSelection`（`SubagentModelSelectionConfig`，volatile `{enabled, allowedModels: {provider,model}[]}`，按新顶层 Session 授权；`$DSH/dsh-tool-subagent/lib/types/model-selection-settings.d.ts`）——**这是“用户允许模型去选哪些子模型”的既有语义**，我们的插件设置可以对齐这个形状（`AllowedModelRoute`）以便复用 UI/语义。
- 未设置时的默认：`parentOptions`（父 agent 的 route）→ 即 `resolveChildAgentOptions(parent, requested, depth)` 的语义（✅ `$DSH/dsh-subagent/lib/types/child-agent.d.ts:43-52`）。

---

## 7. 模块化独立开关（Q7，重点）

### 7.1 (a) 原生插件面板如何列出一个 bundle 的多行；每行是否可独立 enable/disable / config

✅ **能，按 Loader row 粒度独立**：
- bundle patch 的 `insert:` 数组每一行 = 一个独立 Loader entry（有独立 `id`、`name`、`config`、`disabled`）。`plugin_manager`/面板以 **row（组件/parts）** 为单位展示包内多行：`partsLabel: "包含的组件"`（✅ `$DSH/dsh-client-ui-plugin-manager/lib/client.js:173`）、`partsCountRunning/partsCountOff/partsFilter`、每行开关 `partToggle: "启用组件 {name}"`（`:190` 附近）、每行配置入口 `configureRow: "配置 {name}"`（`:198`）。
- **每行独立 config**：settings 命名空间按 **entry id** 建；面板用 `formFor(openRow.rowId)` → `props.configForm(id)` → `ctx.configForms.get(entryId)`（✅ `$DSH/dsh-client-ui-plugin-manager/lib/client.js:6917-6927`；`$DSH/dsh-client-ui-settings/lib/client.js:1270,1294-1300`；`dsh-settings/README.md`：“Forms identify each plugin by its profile entry id”）。
  - **重要限制**：原生自动表单**只暴露 `.volatile()` 字段**；普通配置仍走 Cordis 配置文件（✅ `dsh-settings/README.md`：“Forms expose only volatile fields from active, uniquely addressed profile entries. Ordinary configuration remains editable through Cordis configuration files.”）。每条 form 有 `autoGenerate` 标记，但目前**没有 shipped client 自动生成页面**（同上）→ 想有漂亮表单需自注册 `plugins.row.config` 页面。
- **自定义行配置页（推荐做法）**：slot `plugins.row.config`（keyed，root scope），key = `` `${bundlePackageName}#${rowId}` ``：
  - 面板声明 + 解析：`rowConfigKey(bundle,rowId)`（✅ `dsh-client-ui-plugin-manager/lib/client.js:87`）；声明 `"plugins.row.config": {kind:"keyed", scope:"root"}`（`:7780`）；`RowDetail` 渲染 `renderSlot('plugins.row.config',{view:'page',form},{entryKey:key})`（`:5860-5875`）。
  - 插件侧注册（better-search 实证）：`ctx.slots.inject('plugins.row.config', () => ctx.slots.register({name:'plugins.row.config', key: ROW_CONFIG_KEY, locale: NS}, Page))`，`ROW_CONFIG_KEY = '<pkg>#<rowId>'`（✅ `/workspace/projects/github/dsh-plugins/dsh-better-search/lib/client.js:3010-3015`，`ROW_CONFIG_KEY` 定义 `:19`）。
- **多行架构约束（关键）**：一个 bundle 可以插入多个 row，但**每个 row 的 `name` 必须是“裸包名”（bare package name）**：
  - `barePackageName()` 遇到含 `/` 的 subpath 返回 undefined（✅ `$DSH/dsh-app-boot/lib/index.js:2062-2069`）；
  - `readPluginMeta()` 只对 package-root specifier 读 `package.json`、读 `<specifier>/locale/en.json`；subpath specifier 无面板元数据 → 行显示为**无名组件**（✅ `:3002-3060` 注释与实现）。
  - 指向**同一个包**的两个 row = 同一模块来源两次 import：官方/第三方实践视为非法（第三方发布插件 dsh-custom-reasoning-effort 的 patch 注释明写 “pointing both rows at THIS package would give two rows the same module source, which DSH rejects (resolves from multiple Loader sources)”；本 build 未定位到该精确字符串 → 标 🟡）。功能上也会双份注册 listener/service，不可取。
  - **因此“一个 npm 包多模块”只有一种形态满足产品要求（已决策采用）**：
    - **形态 1（✅ 采用；每个模块 = 独立 npm 包 + 独立 Loader row）**：bundle 根包只放 `cordis.patch.yml` + icon/locale/README/`dependencies`（钉住 core 与各模块，lockstep 版本）；每个模块是**独立发布的 npm 包**，自带 host half（`main`/`exports`/`name`/`inject`/`apply`/`Config`），有 UI 的再加 `dsh.client` + `exports["./client"]` + client bundle + `locale` + `icon`；patch 每行 `name` = 模块包名、`id` = 该包 host half 导出的 `name`。官方 `@ds-hu/dsh-better-workspaces` 即此范式（✅ 根 `package.json` 无 `main`/`exports`/`dsh.client`、`dependencies` 钉 4 个 feature 包 + core；`cordis.patch.yml` 4 行；`packages/<f>/package.json` 有 `dsh.client`/`exports`/`icon`/`locale`；`test/package.mjs` 逐条断言），本仓库已照此建骨架（`/workspace/projects/github/dsh-plugins/dsh-context-slimmer`，契约 `docs/architecture.md` §2，细节 §9.1）。
    - **形态 2（❌ 不采纳）**：单 row + config 内部模块开关。原生面板只有**一个**开关（整包），不满足“每个模块原生独立开关”的产品硬性要求。
    - **历史 workaround（不采用）**：`dsh-custom-reasoning-effort` 的“包内子目录当子包 + postinstall symlink + `peerDependencies: file:`”（✅ 其 patch 注释与 `scripts/link-effort-memory-package.mjs`）——npm workspaces 之前的历史做法，且会踩 pnpm 默认禁 build script；better-workspaces 的真多包发布已取代它。
- `isolate` 注意：若某模块 row 发布服务给另一 row 消费，需要 `isolate` 同 realm，或把两类模块合进一组 `cordis:group`（`group:true` + `name:'cordis:group'` + `config` 为嵌套行列表）；本设计若各模块只通过 `ctx` 内置服务协作、不自建跨模块服务，可全部 loose 在 host root realm（像 better-subagents 一样，✅ 其 patch 注释）。

### 7.2 (b) Config JSON Schema 如何声明（schemastery；嵌套/默认值/描述/本地化）

✅ 官方统一用 **`@deepseek-ai/schemastery`**（`import z from '@deepseek-ai/schemastery'`），Host 侧 `Config` 导出后由 app-boot 投影成 JSON Schema（`Config.listConfigs` 返回的即为投影结果）：
```ts
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  enabled: z.boolean().default(true).description({ en: 'Enable scheduled tool-result slimming', zh: '启用定时工具结果精简' }),
  model: z.object({
    provider: z.string().default('').description({ en: 'Child provider', zh: '子 Agent 提供方' }),
    model: z.string().default('').description({ en: 'Exact model id', zh: '精确模型 id' }),
    reasoningEffort: z.string().default('').description({ en: 'Optional effort', zh: '可选推理档位' }),
  }).description({ en: 'Model used by the slim planner', zh: '精简规划使用的模型' }).collapse(true),
  thresholds: z.object({
    afterToolCalls: z.number().step(1).min(1).default(20).description({ en: 'Run a slim pass every N tool results', zh: '每 N 个工具结果触发一次' }),
    pressureRatio: z.number().min(0).max(1).default(0.75).description({ en: 'Trigger when pressure/context >= ratio', zh: '压力达到比例时触发' }),
    keepRecentResults: z.number().step(1).min(0).default(4).description({ en: 'Never slim the newest N results', zh: '保留最新 N 条结果' }),
  }).description({ en: 'Triggers', zh: '触发条件' }),
  modules: z.object({
    scheduler: z.boolean().default(true),
    pruner:  z.boolean().default(true),
    forkPlanner: z.boolean().default(true),
    uiRow:   z.boolean().default(true),
  }).description({ en: 'Independent feature switches', zh: '各模块独立开关' }),
})
export const inject = ['tools', 'tokenMeter', 'jobs', 'subagents', 'agentDefaultModel']
export const name = 'context-slimmer'
export function apply(ctx, config) { /* ... */ }
```
- schemastery 元数据（✅ `$DSH/schemastery/src/index.ts:104-210`）：`default / required / volatile / disabled / collapse / hidden / loose / role / extra / link / description(string | Dict<locale>) / comment / pattern / max / min / step / badges`；方法：`.default() .description() .i18n({zh:{...},en:{...}}) .hidden() .role() .collapse() .volatile() .min/.max/.step .pattern .comment .deprecated/.experimental`。
- **本地化描述**：`description` 允许 `Dict<string>`（按 locale）；app-boot 投影时把 `meta.description.en` 写进 JSON Schema 的 `description`，并把整个 locale map 放进 `x-cordis.descriptions` 供表单 UI 使用（✅ `$DSH/dsh-app-boot/lib/index.js:3673-3690`）。
- config schema 的投影与校验：`generateConfigSchema(profile, layers, installAnchor)` / `createConfigProjector()`（✅ `$DSH/dsh-app-boot/lib/index.js:4210` 等，由 dsh-app-boot 导出；`Config.listConfigs` inspect provider 直接调用）。
- **面板标题/描述（包/行级）** 不来自 schemastery，而来自 locale JSON：`locale/en.json`（必需基准）+ 其它语言同目录文件，结构仅 `{"meta":{"title":"…","description":"…"}}`；回退链：locale → `package.json.name/description`（title/description）→ 空（✅ `readPluginMeta` `$DSH/dsh-app-boot/lib/index.js:3002-3060`；`dictionariesOf` `:2963-2990`；官方例子 `$DSH/dsh-client-ui-chat/locale/en.json` = `{"meta":{"title":"ui-chat"}}`）。**row 自己的标题来自该 row 模块包（子包）的 locale meta / package.json**（面板 `RowDetail` 用 `row.meta`，✅ plugin-manager client `rowText(row,…)`）。
- **运行时 UI 文案**（组件内文字）走 client 侧字典：`ctx.locale.register(NS,'zh',{...})` / `'en'`，`ctx.locale.bind(NS)`（✅ `$DSH/dsh-client-locale/lib/types/client/index.d.ts:209,226`；better-search 先例 `lib/client.js:2985`）。
- `locale/*.json` 与 `ctx.locale` 的分工：前者是**静态包元数据**（Host 读，不需激活插件）；后者是**浏览器运行时字典**。

### 7.3 (c) 默认关闭/启用 + 实时生效（“patchReload”语义）

✅ 机制（名称澄清：**本 build 没有叫 `patchReload` 的 API**；等价物是 Loader 组合重载）：
- **默认关闭**：patch row 写 `disabled: true`（Loader 支持 `boolean | null | !!js 表达式`，✅ `cordis-composition-reference` skill：`disabled` 接受 boolean/null/`!!js`，每次 mount 决策时求值；`dsh-app-boot` 的 `metadata()` schema 里 `disabled` 亦如此）。用户随后在插件面板点开该组件 → plugin manager 写 profile patch override → 生效。
- **默认从 GUI 列表隐藏**：`package.json.dsh.bundle.listedByDefault: false`（✅ `$DSH/dsh-package-manifest/lib/types/types.d.ts` `DshBundleManifest.listedByDefault`；README 说明仍可在管理库存中看到）。
- **开关一条 row**：`plugin_manager set_plugin`（Host 侧 `PluginManager.change(...)`）在文件锁内写 profile patch，然后：
  - 有 HMR：`ctx.get('hmr').reconcileProfile(requiredIds)` 实时 recompose（✅ `$DSH/dsh-hmr/lib/types/index.d.ts:203-216`，返回 `{warnings,pending,restartReason:'module-comparison'|'package-moved'}`）；
  - 无 HMR：`composeEntries(...)` 并在结果里给 `application:'restart-required'` + `restartReason`（✅ `$DSH/dsh-plugin-manager/lib/index.js:3124-3185`；注释“without HMR ... restart-required 的 restartReason='no-hmr'”）。
  - 无论哪条路，**配置重载完成后发 `app-boot/config-reload`**（✅ `$DSH/dsh-app-boot/lib/index.js:4618`）——插件可订阅它在重载后刷新自身缓存/UI。
- **改 config（不换 row）**：通过 `configEditor.edit(entry, fn)` 写回（✅ `host-plugin.md` §“Persist your own configuration”；`$DSH/dsh-config-editor`）；普通字段修改会让插件**重启**（`apply` 重建），`.volatile()` 字段**原地更新**、代码里用 `config.field.get()` 读（✅ `host-plugin.md:77`；`dsh-settings/README.md`）。**没有 `apply` 后“热替换 config 对象”的 API**——要热更新就用 volatile 引用。
- **替换已安装包的代码**需要 restart 才能加载新 JS generation（✅ `host-plugin.md:83`；插件面板 `restartReasonPackageMoved`）。安装新 bundle 可经 HMR 激活。
- 结论：**“默认关闭、面板可开”** = row `disabled:true`；**“改配置即时生效”** = `.volatile()` 字段 + settings/configForm；**“换模块组合即时生效”** = 依赖 HMR profile recompose，否则提示重启。

---

## 8. 外骨架与一致性约束（Q8）

### 8.1a 单 row 插件包最小结构（每个「模块包」即此形态）

✅（`host-plugin.md` + 已发布同级插件实测；本仓库 `packages/tool-result-slimmer/` 即此形态）
```
<module package root>/
  package.json
  lib/index.js              # host half：导出 name/inject/apply/[Config]
  lib/client.js             # 有 UI 时：browser half（本仓库手写，无构建步骤）
  locale/en.json            # 面板元数据（基准语言）
  locale/zh.json
  icon.svg
  README.md
```
```json
{
  "name": "@ds-hu/dsh-context-slimmer-tool-result",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "icon": "./icon.svg",
  "dependencies": { "@ds-hu/dsh-context-slimmer-core": "0.1.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" },
  "engines": { "node": ">=24.9.0", "dsh": ">=0.2.0 <0.3.0" },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```
- `dsh.bundle.patch` **只有 bundle 根包**才有；模块包**不得**声明 `dsh.bundle`（✅ better-workspaces `test/package.mjs` 断言 `feature.dsh.bundle === undefined`）。
- `dsh.client` 字段：`platform:'web'`、`inject`（信息性依赖，非 Cordis inject，只列官方 `@deepseek-ai/dsh-client-*`）、`immediately`（boot phase-one barrier）、`external`（运行时外部模块请求）（✅ `$DSH/dsh-package-manifest/lib/types/types.d.ts` `DshClientManifest`）。
- `dsh.bundle.patch` 在根包可为**一个路径或有序数组**（多 patch 按序作为同一 bundle 层应用）；`platforms` 限定 OS；`listedByDefault` 控制默认列出（✅ 同文件 `DshBundleManifest`；README）。
- Host 导出形态二选一（**不可混用**）：`export function apply(ctx, config) {}` + 可选 `export const inject = [...]` + `export const Config`；或 default export 一个 Service class（✅ `host-plugin.md:57-64`）。所有资源用 `ctx.effect` / `ctx.on` 注册并返回 cleanup。
- **locale 要求**：`locale/en.json` 是基准；同目录其它语言文件结构相同；`meta` 只认 `title`/`description`；缺失时回退 `package.json.name/description`；坏图标/坏元数据只产生 diagnostic、不阻止管理（✅ `dsh-app-boot` `readPluginMeta:3002-3060`）。**行标题来自该行模块包自己的 locale meta**，不是 bundle 根包的。
- **icon 要求**：`exports["./icon"]` 或 `package.json.icon`；SVG/PNG/JPEG/WebP，≤256 KiB，realpath 必须仍在包内（✅ 同上）。
- **README 元数据**：官方包 README 用 YAML front-matter `description:` + `kind: "package-reference"`；第三方同级插件**不用** front-matter。**`README.i18n.yaml` 不是插件元数据**（是 DSH 仓库内部中英段落哈希表，✅ `$DSH/dsh-client-locale/README.i18n.yaml`）；第三方惯例 `README.md` + `README.zh-CN.md`。

### 8.1b 多模块 bundle 的根包最小结构（本仓库采用）

✅ 先例：`/workspace/projects/github/dsh-plugins/dsh-better-workspaces/package.json` —— 根包只放 patch/元数据/依赖，**没有** `main`、`exports`、`dsh.client`：
```json
{
  "name": "@ds-hu/dsh-context-slimmer",
  "version": "0.1.0",
  "type": "module",
  "workspaces": ["packages/*"],
  "icon": "./icon.svg",
  "engines": { "node": ">=24.9.0", "dsh": ">=0.2.0 <0.3.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@ds-hu/dsh-context-slimmer-core": "0.1.0",
    "@ds-hu/dsh-context-slimmer-tool-result": "0.1.0"
  },
  "files": ["cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "README.*.md", "LICENSE", "docs"]
}
```
- 必需：`workspaces:['packages/*']`；`dependencies` 把 `core` + 每个模块钉到**同一版本**（lockstep，发布用 `npm publish --workspaces`）；`dsh.bundle.patch` 指向唯一 patch；`files` **不含** `packages/`（各 workspace 独立发布），不含 test/scripts。
- 禁止：`main`、`exports`、`dsh.client`（根不 mount row、不导出运行时；✅ better-workspaces `test/package.mjs`:70-80 逐条 `assert.equal(root.main, undefined)` 等）。
- `cordis.patch.yml`：顶层恰好一个 `- insert:`；每行 `- id: <row id>` + `name: '<模块包名>'`（相邻、顺序稳定、带模块说明注释）；**core 永不出现在 patch 中**。
- **发布形态**：bundle 包 + 每模块包 + core 包各自独立 npm 包；依赖单向（bundle → modules → core），模块之间不互相依赖、模块不依赖根 bundle（✅ better-workspaces `test/package.mjs` 对 feature 包的 `dependencies` 双向断言）。
- **一个 row 的开关粒度**：面板按 row 展示开关与配置；根包本身没有 row，所以“整包”不可被误关（这是该范式的额外收益）。

### 8.2 必须成立的一致性约束（范本：`dsh-better-subagents/test/mount-check.mjs` + `dsh-better-workspaces/test/{mount-check,package}.mjs`）

✅ 该测试逐条断言（`/workspace/projects/github/dsh-plugins/dsh-better-subagents/test/mount-check.mjs`）：
1. `manifest.name` = 发布 id；`main` 与 `exports["."]` 都指向 Cordis 入口。
2. 无 client half 时**不得**有 `exports["./client"]`、不得声明 `dsh.client`（反之有 client half 时必须齐全）。
3. 无运行时依赖时 `dependencies` 为空（不随 harness 漂移）。
4. `dsh.bundle.patch` 声明且 `files` 包含该文件（否则 npm publish 会丢掉唯一 mount row）。
5. 入口模块 `import` 成功，且导出集合恰好 `['Config','apply','inject','name']`（有 Config/需要时）。
6. `patch` 顶层**恰好一个** `- insert:`；`insert` 下 row 数与设计一致（该包为 1）。
7. **parity rule #1**：row 的 `name` === `package.json.name`（Loader 从 profile `node_modules` 解析 row 与代码）。
8. **parity rule #2**：row 的 `id` === Host 入口导出的 `name`（“row 与 plugin 可辨认地是同一个东西”）。
9. **row 唯一性**：同一 `id` 重复 = Loader `entry <id> already exists`（✅ `cordis-plugin-loader/lib/index.js:302`），且 include 原样插入 → profile 手抄副本会导致 **boot 失败**而非无害重复；README 必须警告（mount-check 断言 README 含该警告）。
10. 每个 `lib/*.js` 都能独立 import（broken sibling 会让插件激活但监听器不出现）。
- **多包 bundle 追加约束**（✅ `dsh-better-workspaces/test/package.mjs`、`test/mount-check.mjs` 逐条断言；这是本仓库应照抄的范本）：
11. **根包**：`name/version` 合理；`dsh.bundle.patch` 正确；`root.main === undefined`、`root.exports === undefined`、`root.dsh.client === undefined`；`workspaces === ['packages/*']`；`dependencies` 钉住 core + 每个模块的**同版本**。
12. **patch parity**：`rows` 顺序与 `names` 顺序 = 模块清单（顺序敏感）；id 唯一、name 唯一；`names` 不含 core、`rows` 不含 core；顶层只有一个 insert。
13. **模块包**：`main:'lib/index.js'`、`exports['.']==='./lib/index.js'`、`exports['./client']==='./lib/client.js'`（有 UI 时）、`exports['./locale/*.json']`、`exports['./icon']`、`icon` 字段、`dsh.bundle === undefined`、`dsh.client.platform==='web'`、`dsh.client.inject` 只含 `@deepseek-ai/dsh-client-*`、`dependencies[core]===version` 且不含兄弟模块/根 bundle。
14. **host 半 parity**：`module.name === row.id`、`Array.isArray(module.inject)`（内容为它真正需要的服务）、`typeof module.apply === 'function'`；core 包**不得**导出 `apply`/`name`/`inject`（✅ better-workspaces mount-check：core 是 library，不是 row），并且 core 的关键 helper 必须存在。
15. **client 产物**：`lib/client.js` 存在（CI 构建或手写）、包含 `__ModuleLoader__.load(`、注册 `id` 是模块包名（`bundle.includes(JSON.stringify(packageName))`）；构建 externals 只含 `react`/`react-dom/client`/`react/jsx-runtime`/`@deepseek-ai/dsh-client-ui-primitives`。
16. **locale parity**：en/zh 都存在且 `meta.title`/`meta.description` 非空、zh 标题是展示名（≠ 包名）；每个模块 icon 为自包含 SVG ≤256KiB 且各模块 artworks **互不相同**（防止复制粘贴徽标）。
17. **发布文件集**：对每个包跑 `npm pack --dry-run --json`，断言包含 package.json/README/LICENSE/locale/en/zh/icon/lib/index.js(+lib/client.js)；断言**不含** `test/`、`.github/`、`node_modules/`、workspace 源码、`.tgz`；根包断言不含 `packages/`、`scripts/`。
18. **mount 冒烟**：逐个 `import()` 每个 host 模块；用 fake ctx（含 `ctx.effect` 记录器、fake `webServer` 等真实依赖）逐个执行每个 row 的 `apply()`，断言任意 row 子集可 mount、dispose 干净、不会因漏 inject 静默失效（cold-boot 失败在 loader 里会被吞）。
- 建议把以上全部写成 `test/mount-check.mjs` + `test/package.mjs`（并复制 better-workspaces 的 `test/client-smoke.mjs`/`client-react.mjs` 做 jsdom 冒烟），在 `prepublishOnly`/CI 里跑 `test` + `test:mount` + `test:pack`。

---

## 9. 推荐架构草图

### 9.1 模块拆分（已定：bundle 包 + 每模块一个 npm 包 + 每模块一个 Loader row）

> **Lead 决策**：产品硬性要求每个模块在原生插件面板里以**原生方式**独立开关/配置 → 采用官方 `@ds-hu/dsh-better-workspaces` 的范式（✅ 先例：`/workspace/projects/github/dsh-plugins/dsh-better-workspaces/{package.json,cordis.patch.yml}` 与 `packages/*/package.json` 的 `dsh.client`）。本仓库已按此建骨架：`/workspace/projects/github/dsh-plugins/dsh-context-slimmer/{package.json,cordis.patch.yml,packages/core,packages/tool-result-slimmer}`，架构契约见仓库 `docs/architecture.md` §2。

```
@ds-hu/dsh-context-slimmer/                  # 根 = bundle 包（无 main/exports/dsh.client，不 mount row）
├─ package.json                              # workspaces + dependencies(lockstep) + dsh.bundle.patch
├─ cordis.patch.yml                          # 每模块一行 insert（id=row id, name=模块包名）
├─ locale/{en,zh}.json, icon.svg             # bundle 级面板元数据（行标题来自各模块包）
└─ packages/
   ├─ core/                                  # @ds-hu/dsh-context-slimmer-core：共享库，永不成 row
   │  └─ lib/                                # 事件协议、替换原语、plan 校验、prompt、Config 片段、计数器
   └─ tool-result-slimmer/                   # @ds-hu/dsh-context-slimmer-tool-result：模块 1 = 一个 row
      ├─ lib/index.js                        # host 半：apply/inject/name/Config
      ├─ lib/client.js                       # client 半：手写 __ModuleLoader__ bundle，渲染「已精简」行
      ├─ locale/{en,zh}.json, icon.svg, package.json, README.md
```

- **根包**：只放 patch + icon + locale + README/docs；`dsh.bundle.patch`；`dependencies` 钉住 core 与各模块的同版本；**无** `main`/`exports`/`dsh.client`（详见 §8.1b；✅ better-workspaces 同构）。
- **core 包**：`main`+`exports` 指向 `lib/index.js`，导出纯函数/常量/类型（`createPlanValidator`、`applyReplacements`、`buildPrompt`、`recordName`、默认阈值、共享事件常量）；**绝不导出 `apply`/`name`/`inject`**，否则会被 Loader 误 mount 成 row（✅ better-workspaces mount-check 对 core 的断言）。core **不声明** `dsh.bundle`/`dsh.client`。
- **模块包**：`main/exports`/`icon`/`dsh.client`/`locale`/`name/inject/apply/Config`；`dependencies` 仅依赖 core；`peerDependencies` 只 `@deepseek-ai/cordis`；**不声明** `dsh.bundle`。模块之间不互依。
- **patch**：每模块一行；行 `id` = 模块 host 半导出的 `name`（建议 `context-slimmer-tool-result`），行 `name` = 模块包名。将来加模块 = 新 `packages/<m>/` + 根 `dependencies` 加版本 + patch 加一行（本仓库 `cordis.patch.yml` 注释已列 checklist）。
- **服务/隔离**：模块之间不互发 Cordis 服务（通过 `ctx.*` 内置服务 + 各自 Config 协作，共享逻辑放 core 的纯函数）→ 所有 row loose 在 host root realm，无需 `isolate`；若未来某模块发布服务给其它模块用，两者需同 realm 或 `isolate` 同 label（✅ `cordis-composition-reference`）。
- **为什么不用“单包多 row / postinstall symlink”**：row `name` 必须裸包名且指向真实已安装包；同包两 row = 同源重复；`dsh-custom-reasoning-effort` 的 postinstall symlink 是 workspaces 之前的历史 workaround，已被 better-workspaces 的真多包发布取代（顺带避开 pnpm 默认禁 build script 的坑）。

### 9.2 事件流（与仓库 `docs/architecture.md` §3 对齐）

```
主 Agent 正常 turn/step：
  step N 的工具批次结算（tool/call + tool/result 已落盘）
        │
        ▼
  agent/pre-step（waterfall, awaited；官方 compaction 在此同步 append 的先例 §5.1）
    ├─ 过滤：root/普通会话 Agent；排除 session.header.origin==='subagent' 与自己的 childId
    ├─ 读计数：自上次精简以来新增 tool/result 数 / 文本字符数（tools/result 增量计数，pre-step 读取）
    ├─ 触发：everyNToolCalls(8) 或 累计 chars>=minChars(24000)；否则 return next()（零开销）
    └─ 触发 → await 精简流程（本契约选择 pre-step 内 await：主 Agent 被阻塞，但**没有并发写入者**）
         1) 组候选：protectRecent(2) 之外、最近 maxTargets(12) 条；带 index/callId/toolName/text/isError/seq/chars
         2) ctx.subagents.startActivation({provider:'fork', label:'context-slimmer', childId, delivery:'caller',
                                          signal, request:{parent:agent, prompt:<payload+任务>, agentOptions?}})
         3) 子 Agent 创建窗口（agent/created；payload.agent.id===childId）：
              createScope(rootCtx, child) → scope.ctx.tools.restrict({deny:<全部 global 工具名>})
              → scope.ctx.tools.register(slim_tool_results)（仅此一个可见工具）
         4) 子 Agent 调用 slim_tool_results（结构化精简计划）→ 工具体：
              全量校验计划（越界/已替换/超长 → 整批拒绝）
              → for each item: session.append('compaction/prune', <官方 schema>)          // 记账
                               session.append('tool/result', {...orig.data, message:{...orig.data.message, content}}, {surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs:[seq]})
              → 整批结束 appendPluginRecord('plugin:context-slimmer/tool-result-pruned', payload)  // UI/锚点
         5) await activation.result → dispose()；失败/超时(120s) → no-op + plugin record status:'failed'
        │
        ▼
  return next() → 本 step 请求组装：模型只看到精简后的 tool/result；用户 transcript 不变
        │
        ▼
  client：ConversationNodeDefinition(match 'plugin:context-slimmer/tool-result-pruned')
          → chat node kind 'context-slimmer-tool-result' → keyed slot `conversation.chat.node` 渲染「已精简」行
```
- **备选调度（未采纳）**：把 planner 放进 `ctx.jobs.start` 后台、下一 `agent/pre-step` 再落盘（不阻塞主 turn，但需要计划暂存 + 与其它写入者协调）；本仓库契约选择 pre-step 内 await 以获得“单一写入者 + 替换与请求组装同拍”。
- **失败原子性**：任何一步失败 → 主 Agent 上下文不变；已 append 的替换保留（与原生 pruner 语义一致），失败状态写 plugin record 供 UI 显示灰行（默认折叠）。

### 9.3 后台精简器（planner）判定流程

1. **候选集**：surface 上 `tool/result` 节点（`session.eventAt(seq)` 或其注入 reader），排除 `protectRecent`、排除已遮蔽（`compaction/prune.shadowedSeqs` 集合）、排除超大/空结果；按时间倒序取 `maxTargets`。每条附：`index`、`callId`、工具名（从对应 `tool/call` 取）、原文（或 head/tail 截断以控 planner 成本）、`isError`、`seq`、字符数。
2. **规划**：fork child（seed=父已完成 turn 前缀，§3.1）+ 初始 user message 携带候选 payload 与任务指令 → 子 Agent 调 `slim_tool_results` 返回结构化计划。
   - ⚠️ fork seed 只到最后一个 `turn/end`：**当前 turn 新产生的 tool 结果不在 child 历史里** → 必须随初始 user message 传（append-only；违反则子 Agent 看不到候选）。
   - 不加 child-only system section / tool schema；任务约束放初始 user task（前缀缓存友好，✅ §3.4）。
3. **校验**（core 纯函数，可单测）：索引在范围内、`op ∈ {drop, trim}`、`trim.text` 非空且 ≤ min(原长×1.2, 8k)、目标 seq 仍在 surface 且未被本批重复处理 → 否则整批拒绝（原子性）。
4. **落盘**：严格 §1.3/§1.5 顺序；`shadowedTokenCount = ctx.tokenMeter.estimateMessage(original)`；本批结束后写 plugin record；然后 `return next()`。
5. **不做的事**：不改 system prompt、不改历史、不删原事件、不在 `session/event` 内 append、不在子 Agent 侧直接写父 session（写入统一在父侧工具体，便于校验与幂等）。

### 9.4 替换写入（唯一写入者约束）

- 只有一条写入路径（模块包内 `applySlimPlan(session, plan)`，校验/计数在 core），保证：`compaction/prune` 紧邻其后的 replacement、`sourceEventSeqs` 完整覆盖被遮蔽节点、单批聚合（降低 KV 缓存失效面，见风险 #1）。
- 幂等：写前复核 seq 仍在 surface 且内容未被改（长度/hash）；已被处理的目标跳过；重复 pass 不重复写。
- 复核收益：写后 `ctx.tokenMeter.measure(session)` 记录 before/after；若持平或更差，标记 `no-op` 并降级策略（提高 `protectRecent`/只保留高置信项）。
- **进度锚点与回放**：plugin record 是唯一持久锚点（计数重置边界、UI 行、resume 后恢复）；用 `ctx.sessionProjections` 单元 + `pluginRecordOf(event)` 重建「上次锚点 seq / 累计 savings / 最近状态」（✅ §2.4(c)）。文件级审计（`$DSH_HOME/context-slimmer/audit.jsonl`）可作为可选调试产物，不是必需。

### 9.5 UI 行显示（主路径：plugin record）

- **数据**：`plugin:context-slimmer/tool-result-pruned`（payload：`version/runId/createdAt/trigger/model/items[]{index,callId,toolName,op,reason,charsBefore,charsAfter,replacementSeq}/totals{items,charsBefore,charsAfter,charsSaved}/status`）。
- **Definition**：`match: e => e.type === 'plugin:context-slimmer/tool-result-pruned' ? {id:String(e.seq), role:'start'} : null`；`start` 里校验 payload（version===1）；`buildViewNode` 输出 `{key,kind:'context-slimmer-tool-result',id,target:'chat',anchorSeq:seq,location,visibility:'visible',data}`。失败记录（`status:'failed'`）渲染灰色一行、默认折叠。
- **组件**：一行 tertiary 小字「已精简 N 条工具结果（约省 M 字符）」，可展开看 items 明细（reason/chars）；行位置由 `anchorSeq` + chat 的 turn/location 索引决定（与原生「已压缩」行同机制）。
- **跨会话恢复**：Definition 依赖 client 事件流回放（历史页 forwarding 全量事件，§2.4(a)）→ resume 后行仍出现；`ctx.sessionProjections` 另持有计数锚点。
- **备选**（主路径 CI 冒烟失败才降级）：`match 'compaction/prune'` + replacement `data.meta`，见 §2.3 备选。
- 文案：zh/en 通过 `ctx.locale.register(NS, locale, dict)`；组件用注入 `t`。

### 9.6 配置 schema 草图（schemastery；每个模块 row 各自一份 Config）

见 §7.2 示例。本仓库模块 1 的 `Config`（挂在 `@ds-hu/dsh-context-slimmer-tool-result` 的 host half，面板按 row 的 entry id 显示）：
```ts
export const Config = z.object({
  enabled: z.boolean().default(true).description({ en: 'Enable selective slimming', zh: '启用选择性精简' }),
  everyNToolCalls: z.number().step(1).min(0).default(8)
    .description({ en: 'Run a slim pass after N new tool results (0 disables count trigger)', zh: '每新增 N 个工具结果触发一次（0=关闭数量触发）' }),
  minChars: z.number().step(1).min(0).default(24000)
    .description({ en: 'Also trigger when new tool-result text exceeds this many chars', zh: '新增工具结果文本超过该字符数也触发' }),
  protectRecent: z.number().step(1).min(0).default(2)
    .description({ en: 'Never slim the newest K results', zh: '最近 K 条结果永不精简' }),
  maxTargets: z.number().step(1).min(1).max(64).default(12)
    .description({ en: 'Max results per pass', zh: '单次最多精简条数' }),
  model: z.object({
    provider: z.string().default(''), model: z.string().default(''),
    reasoningEffort: z.string().default(''),
  }).description({ en: 'Planner model (empty = inherit parent agent)', zh: '规划模型（空=继承主 Agent）' }).collapse(true),
  maxOutputTokens: z.number().step(1).min(0).default(0)
    .description({ en: 'Planner output cap (0 = default)', zh: '规划输出上限（0=默认）' }),
  timeoutMs: z.number().step(1000).min(1000).default(120000)
    .description({ en: 'Slim pass timeout', zh: '单次精简超时' }),
})
```
- **模块化 = 每个模块自己的 row Config**：未来模块（如 `context-slimmer-compaction`）在新包里自带 `Config`，面板天然分开（entry id = row id）。不需要 `modules:{...}` 总开关组。
- `.volatile()`：只有需要面板实时编辑的字段才加（`Config.listConfigs`/settings form 只暴露 volatile 字段；普通字段走 YAML/patch）。若要做自定义配置页，用 keyed slot `plugins.row.config`，key = `` `<bundle 包名>#<row id>` ``（§7.1）。
- 所有字段 `.description({en,zh})`，嵌套组 `.collapse(true)`；默认值必须让「未配置」= 安全可用的行为（`enabled:true` 但阈值保守）。

## 10. “已验证可用” API 清单（可直接写代码）

| # | API | 证据 |
|---|---|---|
| 1 | `session.append('compaction/prune', {...})` + `session.append('tool/result', {...}, {surfaceOp:{op:'replace',startSeq,endSeq}, sourceEventSeqs:[seq]})` | ✅ pruner `lib/index.js:159-173`；协议 `dsh-compaction/lib/types/types.d.ts:88`；`SurfaceIntent` `dsh-session/lib/types/types.d.ts:466-483` |
| 2 | `ToolResultPruner.measureContent/pruneContent/pruneSession` + `PruneResult` | ✅ `dsh-compaction-tool-result-pruner/lib/types/index.d.ts:30,38,51`；impl `:79,91,137` |
| 3 | `ctx.tokenMeter.{contextPressure,measure,estimateMessage}` | ✅ `dsh-token-meter/lib/types/index.d.ts:31,53,64`；`types.d.ts:24-54` |
| 4 | `ctx.on('agent/pre-step', async (payload,next)=>{…; return next()})` + 官方在其内同步 prune | ✅ `dsh-compaction-basic/lib/index.js:839,938,962` |
| 5 | `ctx.on('tools/result', (exec,result)=>{})`（emit，不阻塞，失败隔离） | ✅ `dsh-tools/lib/types/events.d.ts` |
| 6 | `ctx.on('tools/post-execute', async (exec,result,next)=>{})` + `PostToolDecision` | ✅ 同上；`contracts.d.ts:340-356` |
| 7 | `ctx.tools.register(defineTool({...}))` / `.restrict({deny})` / `.definitions()` / `.schemas()` | ✅ `dsh-tools/lib/types/index.d.ts:50,58,102,110`；`schema.d.ts`；`README.md:30-92` |
| 8 | `ctx.agents.create({sessionId,parentAgent,seed,agentOptions,setup,meta,inheritedEventCount})` | ✅ `dsh-agent/lib/types/index.d.ts:49-115` |
| 9 | `buildForkSeed(events,boundary)`；fork provider `completedTurnPrefix` 边界 | ✅ `dsh-session/lib/types/fork.d.ts:17`；`dsh-subagent-fork-in-process/lib/index.js:22-48` |
| 10 | `ctx.subagents.startActivation({provider:'fork',delivery:'caller',request:{parent,…},signal})` → `activation.result/dispose` | ✅ `dsh-subagent/lib/types/index.d.ts:136-153`；`types.d.ts:24-100` |
| 11 | fork provider 能力：`agentOptions:true, outputSchema:true, depthLimit:true, agentPreset:false` | ✅ `dsh-subagent-fork-in-process/lib/index.js:35` |
| 12 | `ctx.jobs.start({kind,label,owner,run})` / `JobHandle.append/updateProgress` / `kill/wait` | ✅ `dsh-jobs/lib/types/types.d.ts:128-180`；README |
| 13 | `ctx.agentDefaultModel.currentSelection()` / `saveSelection()` | ✅ inspect `Service.listService`；README |
| 14 | `ctx.llm.listProviders/listModels/resolveModelInfo/resolveCallConfig` | ✅ inspect `Service.listService` `llm`；`dsh-llm` types |
| 15 | `@deepseek-ai/schemastery` 的 `z.object/…` + `.description({en,zh})/.default/.i18n/.volatile/.hidden/.collapse` | ✅ `$DSH/schemastery/src/index.ts:104-210`；app-boot 投影 `:3673-3690` |
| 16 | 面板 row 配置页：`plugins.row.config` key=`<bundle>#<rowId>` 注册 | ✅ plugin-manager client `:87,:5860-5875,:7780`；better-search `lib/client.js:3010-3015` |
| 17 | `ctx.uiConversation.events.register(ConversationNodeDefinition)` + `ctx.slots.inject('conversation.chat.node',()=>ctx.slots.register({key:kind},Comp))` | ✅ `conversation/event-registry.d.ts:19`；`contract/conversation.d.ts:176-230`；chat `client.js:9228,11765-11799`；slots `dsh-client-ui-renderer/lib/client.js:1348` + `registry.d.ts:95,111,164` |
| 18 | `ctx.locale.register(ns,locale,dict)` / `ctx.locale.bind(ns)` / `resolveText` | ✅ `dsh-client-locale/lib/types/client/index.d.ts:209,226` |
| 19 | 面板元数据：`locale/<lang>.json` `{meta:{title,description}}` + `exports["./icon"]` | ✅ app-boot `readPluginMeta:3002-3060`；官方 `dsh-client-ui-chat/locale/en.json` |
| 20 | 多 row bundle + 子包 postinstall link + peerDependencies `file:` | ✅ dsh-custom-reasoning-effort（`cordis.patch.yml` 注释、`scripts/link-effort-memory-package.mjs`） |
| 21 | HMR 组合重载 `ctx.get('hmr').reconcileProfile(ids)` + 重载后 `app-boot/config-reload` | ✅ `dsh-hmr/lib/types/index.d.ts:203`；`dsh-app-boot/lib/index.js:4618` |
| 22 | `createConfigProjector` / `generateConfigSchema`（Config→JSON Schema 投影） | ✅ `dsh-app-boot` 导出清单 `:5315` |
| 23 | `ctx.subagentModelSelection`（volatile allowedModels 白名单，按 Session） | ✅ `dsh-tool-subagent/lib/types/model-selection-settings.d.ts` |
| 24 | plugin record 进入 client 事件流；自定义 `ConversationNodeDefinition.match` 可直接匹配 `plugin:*`/任意 `type` | ✅ host `dsh-api-session-controller/lib/index.js:1231-1244,1267-1320`；client `lib/client.js:279-289`；assembler `dsh-client-ui-conversation/lib/client.js:2807-2826`；chat `dsh-client-ui-chat/lib/client.js:9475,10296,11401-11520,9238` |
| 25 | `appendPluginRecord(session, type, data)`（写 `ignorable` plugin record；**官方限制 repo 内 experimental 包调用**）+ `pluginRecordOf(event)` + `PluginRecordMap` merge | ✅ `dsh-session/lib/types/index.d.ts:97-130`；impl `lib/index.js:1265-1315`；README:70-80；`types.d.ts:522-550` |
| 26 | `compaction/prune` 事件的 client 端可见性（与 compaction/start 同属 log-only 转发） | ✅ 与 #24 同一转发链路（host `entryFor` 无过滤） |
| 27 | 从 profile 安装的插件包 import `@deepseek-ai/dsh-session` 解析到 **host 唯一副本**（同一 ESM 实例） | ✅ 实测：`cd /root/.dsh/profiles/web/node_modules/@ds-hu/dsh-bw-core && node -e "import.meta.resolve('@deepseek-ai/dsh-session')"` → `file:///usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`，`appendPluginRecord` 为 function |
| 28 | 多包 bundle 范式（bundle 根包 + 每模块 npm 包 + core 库 + 每模块一行 patch）及其 CI 断言 | ✅ `/workspace/projects/github/dsh-plugins/dsh-better-workspaces/{package.json,cordis.patch.yml,packages/*/package.json,test/{package.mjs,mount-check.mjs,client-smoke.mjs}}`；本仓库已同构（`docs/architecture.md` §2） |
| 29 | `pluginRecordOf(event)` 回放重建 plugin 状态（`ctx.sessionProjections` 单元） | ✅ `$DSH/dsh-session/lib/types/index.d.ts:130`；README:80 |
| 30 | 多包仓库的 bundle 根包**无** `main`/`exports`/`dsh.client`、模块包**无** `dsh.bundle` | ✅ better-workspaces `test/package.mjs:70-80,158-165` |

---

## 11. 风险与缺口清单（按严重度）

1. **KV 前缀缓存失效（最高）**：run16 文档明说 “A `replace` operation invalidates reuse from the first shadowed message even though the underlying event log stays append-only”（✅ `$DSH/dsh-session/README.md:167`）。→ 精简越早的结果，缓存损失越大；**必须批量一次 replace**、只在压力/轮次边界执行；建议默认只精简 `keepRecentResults` 之外的**早期**结果（本来就会被 compaction 重写）或在 `contextPressure` 高时执行。**绝不能每步小改**。
2. **fork seed 不含当前 turn（高）**：planner child 看不到刚发生的 tool 结果（seed 截到最后一个 `turn/end`，✅ fork provider impl）。→ 候选内容必须随初始 user message 传给 child（append-only，但增加 planner 输入 token）；或改成父侧启发式 + 小模型摘要（成本取舍）。
3. **inspect 精细查询不可用（中）**：本 build `cordis_inspect_query` 的 `input` 被字符串化（§0），Config schema / live Slots 无法在线读取；workaround 为读 d.ts/源码/CLI `dsh --profile web --dump-config`。写插件时对 Config 的投影行为要**用真实面板复验**。
4. **客户端 live 验证缺失（中）**：`Slots.listSubTree` 报 “no connected Harness page”（本机 Web GUI 无浏览器连接）。UI 行必须在真实浏览器用 `plugin_manager install_bundle` 后验证；不能用安装成功代替渲染验证（skill 明确要求）。
5. **plugin record 的契约限制（中，已决策接受）**：client 可见性 ✅（§2.4(a)）；但 `appendPluginRecord` 被官方 README 明文限定为 repo 内 `packages/experimental/` 才能调用（第三方便“不应调用”，✅ `dsh-session/README.md:72`），记录在格式迁移中只 best-effort 保留。**Lead 已决策采用 plugin record 作 UI 数据源**（§2.4(d)）→ 缓解：payload 加 `version` 且 additive、UI 对缺失/陌生记录降级、`ctx.sessionProjections` 用 `pluginRecordOf` 回放、README/CONTEXT 披露；备选路径（`compaction/prune`+`meta`）保留在 §2.3。**禁止** `session.append('plugin:…')` 手写（无 `ignorable`）。
6. **`pruneSession` 不能承载“语义决策”（中）**：它只有 head/tail 盲切、无“候选计划”入参（✅ 源码）。本插件必须自写 replacement 写入器，但严格复用其事件协议（§1.5），以保证与 compaction / token-meter / UI 的互操作。
7. **子 Agent 工具限制是快照（中）**：`restrict({deny})` 在 setup 时计算一次；运行期新增 global tool 会漏进 child。→ planner child 生命周期短、单任务；或在 `tools/change` 后重建 restrict（需保留 disposer）。
8. **fork 不支持 agent preset（中）**：`agentPreset:false`（✅ fork provider `capabilities`）→ 不能给 planner 用独立 preset 组合（工具/提示词），只能用 `setup` 手调。走 `startActivation` 时无 setup → 工具集只能继承父级。
9. **多 row 同包不可行（已解决）**：row `name` 必须裸包名（`barePackageName()` 对 subpath 返回 undefined，`readPluginMeta` 不给 subpath 元数据）→ 采用“bundle 根包 + 每模块独立 npm 包（workspaces）+ 每模块一行”的 better-workspaces 范式（§9.1/§8.1b），不走 postinstall symlink 历史方案。剩余成本：发布需 `npm publish --workspaces` 或 publish workflow 统一发多包、版本必须 lockstep、CI 需多包 pack 校验。
10. **原生自动配置表单只显示 volatile 字段（中）**：普通 config 只能在 YAML/patch 或自注册 `plugins.row.config` 页面编辑（✅ `dsh-settings/README.md`）。若产品要求所有模块配置都有面板，必须自建配置页（better-search 模式）。
11. **无 “追加替换” 的官方封装/事务（低）**：`append` 是同步原子但无 rollback；mid-pass 失败保留已提交项（✅ pruner 语义）。→ 写入器要幂等 + 以 surface 为准重算。
12. **`session/event` 内 append 会重入被拒（低）**：计数/触发逻辑不要在 append 派发内回写，`queueMicrotask`/`ctx.timer`/jobs 延后。
13. **`eventAt/snapshotEvents/ownEvents` 已 deprecated（低）**：新代码应尽量用注入的 projection/reader（`ctx.sessionProjections`），但官方 pruner/compaction 目前仍直接用 `eventAt`；跟随官方先例可接受，标注为兼容性观察项。
14. **planner 输出质量与成本（低-需产品决策）**：每 N 次工具调用 fork 一个 LLM child = 额外 token；建议 `maxBatch`、只在 `pressureRatio` 触发、并允许 `planner.enabled=false` 时退化为纯确定性规则（例如复用 pruner 的 head/tail）。
15. **UI 语义未验证项（只能真实 GUI，§12-C）**：第三方 kind 的聊天行实际渲染位置/顺序（`anchorSeq`/`groupTree` 未设置时）；replacement `tool/result` 是否让工具卡片也变短（预期是）以及是否与「已精简」行视觉重复；失败/`no-op` 灰行的展示；面板 row 开关/行配置表单的真实交互。→ §12-C 冒烟。
16. **架构契约与真实事件 schema 的字段错配（高，必须改代码前对齐）**：`docs/architecture.md` §3.3 的 replacement 伪代码写成顶层 `{callId, content, isError, ...}`；真实形状是 `data = {turn, step, message: ToolResultMessage, error?, meta?}`（§1.2/§1.5 勘误）。照伪代码实现会写出无法回放的 replacement。→ 以本报告 §1.5 的正确片段为准，并同步修正架构文档。
17. **pre-step 内 await planner 的延迟取舍（中）**：契约选择在 `agent/pre-step` 内等 fork planner（阻塞主 Agent，换来无并发写入者）。若 planner 慢/超时（默认 120s），用户这一 step 会明显卡顿；需配置 `timeoutMs`、失败即 no-op，并考虑对超大候选批次降级为确定性 head/tail（复用原生 pruner 策略）。
18. **记账事件必须与替换紧邻（中）**：`compaction/prune` 的影子价协议要求“immediately precedes the replacement”（§1.3）；若为了批量而写成「先全部 prune，再全部 replace」，token-meter/compaction 的影子扣减会错配。→ 写入循环严格 per-target 成对 append，只有 plugin record 可以整批尾部写一次。
19. **client bundle 的 `id` 必须等于模块包名（低）**：`window.__ModuleLoader__.load({id})` 的 id 用于事件/模块表路由；写成包路径或短名会导致模块加载但 UI 不出现（better-workspaces 的 `test/package.mjs` 专门断言 `bundle.includes(JSON.stringify(packageName))`）。

---

## 12. CI 可直接执行的验证清单（按“能否自动化”分层）

> 分层规则：**A = 纯 Node，任何 PR 必跑**（不装 dsh、不连浏览器）；**B = 需要 dsh CLI 的临时 profile（无头）**；**C = 只能真实 Web GUI（人工或 Playwright 截图）**。每项写清「验证什么 / 怎么断言 / 预期证据」。范本实现：`/workspace/projects/github/dsh-plugins/dsh-better-workspaces/{test/package.mjs,test/mount-check.mjs,test/client-smoke.mjs,test/client-react.mjs}`。

### A. 纯 Node：每个 PR 必跑（`npm run check`）

| # | 验证什么 | 怎么断言 | 预期证据 |
|---|---|---|---|
| A1 | **多包 manifest + patch parity** | 新建 `test/package.mjs`：断言根包无 `main`/`exports`/`dsh.client`、`workspaces===['packages/*']`、`dependencies` 钉住 core+各模块同版本；patch 恰好一个 `- insert:`、rows 顺序 = 模块清单、id/name 唯一且一一对应、不含 core；每个模块包有 `main`/`exports{".","./client","./locale/*.json","./icon"}`/`icon`/`dsh.client.platform==='web'`/`dsh.client.inject` 只含官方 client 包/无 `dsh.bundle`/不依赖兄弟模块与根 bundle | `node test/package.mjs` exit 0 并打印全部 row 与包名（范本打印 `PACKAGE: ALL PASS`）；失败时 assert 信息点出具体字段 |
| A2 | **host 半 parity + 可 mount** | 新建 `test/mount-check.mjs`：`import()` 每个 `lib/*.js`；对每个 row 用 fake ctx 执行 `apply()`（fake `ctx.effect/on/inject/get/logger`，按需注入 fake 服务）；断言每个模块 `module.name === patch row id`、`Array.isArray(module.inject)`、`typeof module.apply === 'function'`；断言 core **不导出** `apply`/`name`/`inject`；断言 dispose 后 fake 注册项全部清空 | exit 0 + 每个 row 打印 `apply ok`；故意删一个 inject 时测试应失败（防 cold-boot 静默失败） |
| A3 | **替换写入协议**（core 纯函数 + fake Session） | 单测 `applySlimPlan`：fake session 记录 `append(type,data,opts)` 序列，断言每目标严格 `compaction/prune` → `tool/result` 相邻；`surfaceOp==={op:'replace',startSeq:seq,endSeq:seq}`；`sourceEventSeqs===[seq]`；`data.message.content` 改变而 `data.message.toolCallId/isError/source` 保留；`shadowedTokenCount` 来自 `estimateMessage(original)`；再断言非法计划（越界/重复/`trim.text` 超长/目标已不在 surface）→ **整批拒绝且零 append**；幂等：对已遮蔽 seq 第二次 pass 不发 append | `node --test packages/core/test/*.test.mjs` 全绿；fixture 里保存一次成功 pass 的 append 调用快照 |
| A4 | **plugin record payload** | 单测 `appendPluginRecord` 调用参数：type 匹配 `/^plugin:context-slimmer\/[a-z0-9][a-z0-9._-]*$/`；payload 可 `JSON.stringify` 往返相等；含 `version:1/runId/items[]{index,callId,charsBefore,charsAfter}/totals/status∈{applied,no-op,rejected,failed}`；失败分支写 `status:'failed'` 且不写部分 items | 同上；另用真实 `new Session`（如可行）做一次 smoke：append 后 `pluginRecordOf(event)` 返回记录（✅ API #29） |
| A5 | **Config schema** | 单测：`Config({})` 得到全部默认值且 `enabled===true`；`Config({everyNToolCalls:-1})`/`{model:{provider:1}}` 抛错；`Config` 投影可序列化为 JSON；`description` 同时含 en/zh | 同上；把默认值快照写进测试（防误改默认阈值） |
| A6 | **client half smoke（无浏览器）** | 照 better-workspaces `test/client-smoke.mjs`：模拟 `window.__ModuleLoader__`，用透明结构 stub `react` materialize 模块 factory，跑 `apply(fakeClientCtx)`；断言 `uiConversation.events.register` 收到 `{kind:'context-slimmer-tool-result',target:'chat'}`；对 `{type:'plugin:context-slimmer/tool-result-pruned',seq:42,data:{…}}` 调 `match` 得 `{id:'42',role:'start'}`、对其他事件得 `null`；`buildViewNode` 返回 `kind/key/anchorSeq===42/visibility==='visible'`；`slots.inject('conversation.chat.node')` 收到 `key==='context-slimmer-tool-result'`；`locale.register` 收到 zh/en 且 key 集合一致 | `node test/client-smoke.mjs` 打印 `CLIENT SMOKE: ALL PASS` |
| A7 | **UI 组件渲染（jsdom，无浏览器）** | 照 `test/client-react.mjs`：jsdom + react-dom/client 挂载 `SlimResultRow`，断言文本包含「已精简」与 chars 数字；`status:'failed'` 渲染灰行不崩溃；空/畸形 payload 降级渲染（不 throw） | `node test/client-react.mjs` 全绿 + 可选快照 |

### B. 需要 dsh CLI 的临时 profile（无头 CI；不污染开发者 profile）

| # | 验证什么 | 怎么断言 | 预期证据 |
|---|---|---|---|
| B1 | **冷启动真 mount**（多行同时启用） | 脚本用 `mktemp -d` 建临时 `DSH_HOME`+profile，`dsh plugin --profile <tmp> add file:<repo>`（或等价的 profile patch）后启动一次;断言进程无 `duplicate loader entry id`/import 失败；`dsh --profile <tmp> plugin list` 显示 bundle 及其每行组件、每行 switch 存在 | 日志 + `plugin list` 输出；有任一 row 报错即 fail |
| B2 | **真会话端到端**（触发精简） | 脚本发一条会产生大量工具输出的消息（如多次 `read` 大文件）；结束后读 session log（`$DSH_HOME/sessions/**.jsonl.zstd` 或 CLI API），断言：`compaction/prune` 与 `tool/result` replacement 成对出现且 seq 相邻；replacement 的 `sourceEventSeqs` 覆盖原 seq；出现 `plugin:context-slimmer/tool-result-pruned` 且 `status==='applied'`；被替换的 `tool/result` 其 `data.message.content` 文本变短；未被选中的结果字节不变 | 断言脚本 exit 0 + 打印每对 seq/chars before/after |
| B3 | **token 记账** | 同一脚本里在替换前后取 `ctx.tokenMeter.measure(session)`（或读 surface 投影），断言 `surfaceTokens` 下降 ≈ 被精简字符对应 token；`compaction/prune.shadowedTokenCount` 之和与下降量同一量级 | 前后数值表；允许 ±20% 误差 |
| B4 | **UI 数据可达性（wire 层，无浏览器）** | 把 B2 的真实 session log 喂给一个“假 client assembler”（复用 A6 的 fake `uiConversation` + 真实事件对象），断言 Definition 能产出节点；或直接断言 `pluginRecordOf(event)` 能命中该记录（注意真实事件 data 可能含旧字段，payload 版本校验要容纳） | 打印 `assembled nodes: 1 kind=context-slimmer-tool-result`；这条是「主路径 UI 数据链路」在无浏览器下的**保底证据** |

### C. 只能真实 Web GUI / Playwright 截图（发布前人工 smoke）

| # | 验证什么 | 怎么断言 | 预期证据 |
|---|---|---|---|
| C1 | **插件面板多行独立开关**（产品硬性需求） | 打开 `http://127.0.0.1:3080` → 插件页 → 找到 bundle → 「包含的组件」区应列出各模块行，逐行开关可独立 off/on；关掉唯一模块后新会话不再触发精简、重开恢复；开关状态写回 profile patch 并持久 | 2 张截图（开/关）+ `$DSH_HOME/profiles/<p>/cordis.patch.yml` 或 `package.json` 的 override diff |
| C2 | **「已精简工具调用结果」行渲染** | 真实会话触发一次精简；聊天流出现该行，位于对应 turn 内、在「上下文已压缩」行同款视觉层级；展开显示 items 明细（reason/chars）；原工具卡片仍在（内容为精简后或原样需按产品定义确认，本项目定义为“卡片保持原样、额外一行”）；console 无 error | 截图（折叠/展开各一张）+ DOM 文本断言（Playwright 可用 `page.getByText('已精简')`） |
| C3 | **row 配置表单** | 面板中打开该模块行的「配置」：若用自建 `plugins.row.config` 页面，断言字段渲染、保存后 `Config.listConfigs`/cordis 配置值变化并生效；若用原生自动表单，断言仅 volatile 字段可见 | 截图 + 保存前后配置 JSON diff |
| C4 | **失败降级** | 临时把 planner 模型名改成不存在/超时 1s，触发精简：主 Agent 继续正常回答、无替换发生、聊天出现灰色「精简未生效」行（默认折叠）、无未捕获错误 | 截图 + 会话日志无异常中断 |
| C5 | **KV/前缀缓存回归（可选）** | 若 gateway 暴露 cached-token usage：单次精简只应造成“从最早被遮蔽消息起”的一次前缀失效；对比精简前后下一请求的 cached tokens 下降幅度 | usage 数据表；若不可观测则标注未验证 |

> **判据**：A1–A7 必须进 CI；B1–B4 在 CI 有 dsh CLI + 无头 profile 时必跑（否则记为 release checklist）；C1–C4 每次发版前人工/Playwright 各做一次，截图存 `docs/qa/`（或 CI artifacts）。任何一项失败都不得发布。

### 附：本报告用到的关键路径速查（`$DSH = /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`）

- `$DSH/dsh-session/{README.md,lib/types/{types.d.ts,index.d.ts,surface.d.ts,fork.d.ts,known-event-types.d.ts}}`
- `$DSH/dsh-llm/lib/types/{message.d.ts,types.d.ts,index.d.ts}`
- `$DSH/dsh-compaction/{README.md,lib/types/{types.d.ts,index.d.ts}}`
- `$DSH/dsh-compaction-basic/{README.md,lib/index.js}`
- `$DSH/dsh-compaction-tool-result-pruner/{README.md,lib/index.js,lib/types/{index.d.ts,types.d.ts,config.d.ts}}`
- `$DSH/dsh-agent/{lib/types/{index.d.ts,runtime-types.d.ts,types.d.ts,child-agent?}}`（child-agent 在 `dsh-subagent`）
- `$DSH/dsh-agent-loop/{README.md,lib/types/agent.d.ts}`
- `$DSH/dsh-subagent/{README.md,lib/types/{index.d.ts,types.d.ts,descriptor.d.ts,child-agent.d.ts,model-selection.d.ts,model-selection-settings.d.ts,list-models.d.ts}}`
- `$DSH/dsh-subagent-fork-in-process/{README.md,lib/index.js}`
- `$DSH/dsh-tool-subagent/{README.md,lib/types/*}`
- `$DSH/dsh-tools/{README.md,lib/types/{index.d.ts,contracts.d.ts,events.d.ts,schema.d.ts,json-schema.d.ts,executor.d.ts,batch.d.ts}}`
- `$DSH/dsh-token-meter/{README.md,lib/types/{index.d.ts,types.d.ts,projection.d.ts}}`
- `$DSH/dsh-jobs/{README.md,lib/types/types.d.ts}`；`$DSH/dsh-jobs-local/`
- `$DSH/dsh-hmr/lib/types/index.d.ts`；`$DSH/dsh-plugin-manager/lib/index.js`；`$DSH/dsh-app-boot/lib/index.js`
- `$DSH/dsh-package-manifest/{README.md,lib/types/types.d.ts}`
- `$DSH/dsh-client-ui-chat/{lib/client.js,lib/types/client/**}`；`$DSH/dsh-client-ui-conversation/lib/types/client/**`；`$DSH/dsh-client-ui-renderer/{lib/client.js,lib/types/client/**}`；`$DSH/dsh-client-locale/{README.i18n.yaml,lib/types/client/index.d.ts}`；`$DSH/dsh-client-ui-plugin-manager/lib/client.js`；`$DSH/dsh-client-ui-settings/lib/client.js`
- `$DSH/schemastery/src/index.ts`
- 模板/规范：`$DSH/dsh-agent-preset/skills/cordis-plugin-development/{references/{host-plugin.md,ui-plugin.md,practices.md},templates/decoration/*}`、`.../skills/cordis-composition-reference/references/packages.md`
- **client 事件流 / plugin record 转发**：`$DSH/dsh-api-session-controller/{lib/index.js,lib/client.js,lib/types/client/contract/events.d.ts}`
- **多包 bundle 范本（本仓库照抄对象）**：`/workspace/projects/github/dsh-plugins/dsh-better-workspaces/{package.json,cordis.patch.yml,packages/*/package.json,test/{package.mjs,mount-check.mjs,client-smoke.mjs,client-react.mjs}}`
- **本仓库**：`/workspace/projects/github/dsh-plugins/dsh-context-slimmer/{package.json,cordis.patch.yml,packages/core,packages/tool-result-slimmer,docs/architecture.md}`
- 参考实现：`/workspace/projects/github/dsh-plugins/dsh-better-subagents/test/mount-check.mjs`、`/workspace/projects/github/dsh-plugins/dsh-custom-reasoning-effort/{cordis.patch.yml,scripts/link-effort-memory-package.mjs}`、`/workspace/projects/github/dsh-plugins/dsh-better-search/lib/client.js`
