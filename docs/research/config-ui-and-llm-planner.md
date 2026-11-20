# v0.2.0 取证：原生配置页（`plugins.row.config`）+ 直调 `ctx.llm.stream()` 规划器 + subagent 覆盖

> 任务：task-10（api-scout）。输入绑定决策：`docs/plan-v0.2.md`。本文只取证、不改代码。
> 证据等级：**已验证** = 读过安装包源码/类型定义并给出 `文件:行号`；**推断** = 由类型/注释合理外推，未逐行运行时验证。
> 宿主安装根：`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`（下称 `$B`）。profile：`/root/.dsh/profiles/web`。

## 0. 速览结论（先看这 10 条）

1. `plugins.row.config` 是 **root keyed slot**，`key = "<bundle 包名>#<row id>"`，owner props = `{ view:'summary'|'page', form?: ConfigPageForm }`。✅
2. `form` 由页面用 **row id**（不是复合 key）去 `configForms.get(rowId)` 取；若该 row 没有可配置 namespace，`form === undefined`（我们的 slot 必须自己兜底）。✅
3. settings namespace = **profile loader entry id**（即 patch row 的 `id`），也就是 `context-slimmer-tool-result`，**不是** `@ds-hu/...#row`。✅
4. 表单**只显示/只写 volatile 字段**：`Config` 里没 `.volatile()` 的字段既不会出现在 `form.state.value`，写它也会抛 `"Config field X is not volatile"`。⚠️ plan §4 未提，属硬约束。
5. 写落盘 = profile 的 **`cordis.patch.yml`**（`profileContext.patchPath`），由 Loader reconcile 实时生效；`mutate` 一次提交所有 op，带 `revision` 冲突保护。✅
6. `ctx.llm.stream()` 外部插件可用（`Context.llm` 是官方 service）；官方同构实现 = `dsh-compaction-basic` 的 `summarizeWithLlm`（可直接抄）。✅
7. chunk 处理不要手写：用官方 `BlockAssembler`（`@deepseek-ai/dsh-llm` 导出），`finish.kind` 为 `stop|tool-calls|max-tokens|aborted|error`；`max-tokens/error/aborted` 必须当失败。✅
8. `agent/pre-step` 是 **Scope-filtered dispatch**：每个 Agent（含 subagent）都触发；子会话判定唯一可靠字段 = `session.header.origin === 'subagent'`（root 为 `undefined`）。✅
9. 不再用 `ctx.subagents.startActivation` → 日志不会出现 `subagent/*`（这些事件只由 subagent manager 写）；顶部「N 个子智能体」数据源 = `subagentCatalog` projection（`dsh-client-ui-workspace`），无 catalog 即为 0。✅
10. client bundle 的 `require` 可用性已确认：`react`、`react/jsx-runtime`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-primitives`（`react-dom/client` 官方 UI 包也在用，推断可用）。✅/推断

## 1. Q1：原生「插件」面板配置页

### 1.1 slot 契约（声明方 + 注册方式）

- 声明（**keyed / root**）：
  `$B/dsh-client-ui-plugin-manager/lib/client.js:7780-7783`
  ```js
  "plugins.row.config": { kind: "keyed", scope: "root" },
  ```
- 官方文档化的契约（introspeciton 目录，可直接抄措辞）：
  `$B/dsh-cordis-client-runner/lib/client.js:5158-5190`（`plugins.row.config` 条目）：
  - summary：「The configuration of one row a bundle declares, keyed by `<package name>#<row id>` … the row on the bundle's page gains a configure control that opens the entry's page」
  - `registerOptions`: `key`（required，可替换已占用 key）
  - `ownerProps`: `PluginConfigViewProps`
  - 示例：`ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name:'plugins.row.config', key:'<key>' }, Component))`
- key 生成函数（宿主自己用）：
  `$B/dsh-client-ui-plugin-manager/lib/client.js:85-90`（`rowConfigKey(bundle, rowId)`）；row 详情页 `:5811` 用 `rowConfigKey(pkg.name, row.rowId)` 派发。
- owner props 类型（**已验证**）：
  `$B/dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:23-28`
  ```ts
  export interface PluginConfigViewProps {
    readonly view: 'summary' | 'page'
    readonly form?: ConfigPageForm | undefined
  }
  ```
  `ConfigPageForm`（同文件 `:203-210`）：
  ```ts
  export interface ConfigPageForm {
    readonly state: ConfigFormSnapshot<Record<string, unknown>>;
    readonly mutate: ConfigForm<Record<string, unknown>>['mutate'];
  }
  ```
- **注册可行性**（提问点）：`ctx.slots.register` / `ctx.slots.inject` 在 plugin `apply()` 里直接用，与 `dsh-better-search` 的 `plugins.row.config` 用法一致；客户端插件模块形状就是 `export const inject=['slots']; export function apply(ctx){...}`。✅

### 1.2 渲染位置与 `form` 的来源（关键细节）

- 详情页 `RowDetail`（`client.js:5811` 起）：
  - 标题下方描述：`children: description ?? renderSlot("plugins.row.config", { view: "summary" }, { entryKey: key })` → **`:5853-5856`**
  - 配置区：`<div data-plugin-config>` 内 `renderSlot("plugins.row.config", { view: "page", form }, { entryKey: key })` → **`:5867-5873`**
- `form` 传参：`form: formFor(openRow.rowId)` → **`:7279`**
- `formFor` 实现（**决定 namespace 语义**）：`client.js:6919-6928`
  ```js
  const configurations = props.useConfigurations((snapshot) => snapshot.view?.namespaces);
  const formFor = (id) => {
    if (!configurations?.some((view) => view.ns === id)) return void 0;
    const form = props.configForm(id);        // = ctx.configForms.get(id)
    return { state: form.getSnapshot(), mutate: (ops, rev) => form.mutate(ops, rev) };
  };
  ```
  → 结论：**只有 host 端存在 `ns === rowId` 的 settings form 时，`form` 才存在**；否则 `view:'page'` 收到 `form: undefined`，我们的组件必须渲染「不可配置/加载中」。
- 注意 summary 的语义：**只有在 row 没有 description 时才会渲染 summary**（`:5855` 的 `??`）；如果 row 的 locale/元数据给出 description，summary 分支不出现。plan §4 的「一行摘要」要么接受不显示，要么不放 description。⚠️ 与 plan 的隐含预期冲突。

### 1.3 `form.state` / `mutate` / op 形状（全部已验证）

- `ConfigFormSnapshot<T>`：`$B/dsh-client-ui-settings/lib/types/client/config-form-types.d.ts:6-40`
  ```ts
  interface ConfigFormSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable';
    value: T | undefined;     // 当前 schema 解析值（仅 volatile 字段）
    base: unknown;            // 组合层默认（清空字段时回落到它）
    user: unknown;            // 用户显式覆盖层（字段“存在”即表示被 override）
    revision: number | undefined; // 下一次写的 fence
    writable: boolean;        // Host 文档是否接受写入
  }
  ```
- `ConfigForm`：同文件 `:15-72`
  - `getSnapshot()`, `subscribe(fn)`, `mutate(ops, expectedRevision?) => Promise<boolean>`, `set(field, value)`, `unset(field)`；`mutate`：一次原子写，true=Host 接受，false=拒绝/跳过，传输错误 reject。
- `SettingsPathOpView`：`$B/dsh-settings/lib/types/types.d.ts:47-54`
  ```ts
  type SettingsPathOpView =
    | { op: 'set'; path: string[]; value: JsonValue }
    | { op: 'unset'; path: string[] };
  ```
  （嵌套 = `path:['model','provider']`；数组下标也用字符串 path 段。）

### 1.4 namespace、volatile 与“为什么可能没有 form”

- `settings.describe()` 按 **entry.options.id** 生成 namespace：`$B/dsh-settings/lib/index.js:411-447`
  - 过滤：`entry.fiber` 存在且运行、`schema.toJSON` 存在、`volatileForm(schema)` 返回非空 → `:415-417`
  - `ns: entry.options.id`、`revision` 计算 `:422-433`、`emit('settings/document-updated', entry.options.id, revision)` `:433`
- `volatileForm`：`dsh-settings/lib/index.js:122-131` —— **递归收集 schema 中 `.volatile()` 的字段**；顶层无 volatile、对象内也无 volatile 则返回 `undefined`（该 entry 不出现在 settings 列表 → row 无 form）。
- `configEditor.entries()` 只返回 **id 唯一**的 profile 行：`$B/dsh-config-editor/lib/index.js:29-34`（重复 id 直接排除）。
  → 我们的 patch 只有一行 `context-slimmer-tool-result`，id 唯一，✅ 可配置。
- namespace 是否等于 row id：**等于**（`entry.options.id` 即 row id，见上）；不包含 bundle 包名。

### 1.5 写落盘 / revision / 实时生效

- `settings.update/replace/mutate(ns, ...)`：`dsh-settings/lib/index.js:470-518` → 内部 `write()` `:519-540`
  - 找 entry：`configEditor.entries().find(row => row.options.id === ns)` `:502`
  - 无 schema / 无 volatile：抛 `"No configurable plugin entry"` / `"Plugin entry ... has no volatile fields"` `:503-505`
  - **每个 op path 必须 volatile**：`"Config field \"x\" is not volatile"` `:506`
  - revision 冲突：`SettingsConflictError(ns, expected, descriptor.revision)` `:510-511`
- 落盘：`configEditor.edit(entry, change)` `dsh-config-editor/lib/index.js:76-...`；`documentPath` = `profileContext.patchPath` `:24-26`
- patch 文件名：`PROFILE_PATCH_FILENAME = "cordis.patch.yml"`（`$B/dsh-app-boot/lib/index.js:1327`），profile 目录下：`join(profileDir, PROFILE_PATCH_FILENAME)`（`:1822`，创建模板 `:1398-1399`）
  → 即 `/root/.dsh/profiles/web/cordis.patch.yml`（本 profile 已存在）。写时持 profile `package.json` 文件锁 `dsh-config-editor:79`，写完 Loader reconcile 热生效（config-editor 注释 `:15`「Persist complete raw configs and apply them through the normal Loader path」）。
- revision 语义：由 describe 按 raw 快照（`fiber.uid + schema JSON + entry.options.config`）变化递增（`dsh-settings:422-431`）；`mutate` 用页面拿到的 `state.revision` 作为 fence 即可。

### 1.6 最小示例（纯 `React.createElement`，不依赖 jsx 构建）

```js
// packages/tool-result-slimmer/lib/client.js
export const inject = ['slots']

export function apply(ctx) {
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
    { name: 'plugins.row.config', key: '@ds-hu/dsh-context-slimmer#context-slimmer-tool-result' },
    ConfigEntry,
  ))
}

const h = React.createElement

function ConfigEntry(props) {
  const { form } = props
  const [msg, setMsg] = React.useState('')
  const [draft, setDraft] = React.useState({})
  const state = form?.state
  const value = { ...(state?.value ?? {}), ...draft }
  const writable = state?.status === 'ready' && state.writable === true

  if (props.view === 'summary') {
    return h('span', null, `每 ${value.everyNToolCalls ?? 12} 次调用 · ${value.policy ?? 'conservative'} 策略`)
  }
  if (form === undefined) return h('p', null, '该行没有可配置的 Host 设置（检查 Config 是否声明了 .volatile() 字段）')
  if (state.status !== 'ready') return h('p', null, state.status === 'loading' ? '加载中…' : '不可用')

  const num = (name, label) => h('label', { 'data-field': name },
    label, h('input', {
      type: 'number', disabled: !writable,
      value: value[name] ?? '',
      onChange: (e) => setDraft({ ...draft, [name]: Number(e.target.value) }),
    }))

  return h('div', { 'data-ctxslim-config': true },
    num('everyNToolCalls', '每 N 次调用'),
    num('minChars', '最小字符'),
    h('button', {
      type: 'button', disabled: !writable,
      onClick: async () => {
        const ops = Object.entries(draft).map(([k, v]) => ({ op: 'set', path: [k], value: v }))
        const ok = await form.mutate(ops, state.revision)   // 一次原子提交
        setMsg(ok ? '已保存' : '保存被拒绝（可能 revision 冲突，已重新读取）')
        setDraft({})
      },
    }, '保存'),
    msg && h('span', { role: 'status' }, msg))
}
```

### 1.7 与 plan §4 的差异/冲突

| plan 说法 | 取证结论 | 处理 |
| --- | --- | --- |
| 字段 `enabled` 作为「软开关」 | 只能写入 volatile 字段；`enabled` 是自定义 config 字段（可），但**原生 row disabled 是硬开关**，软开关要插件自己读 `config.enabled` 并在 apply 时短路 | 可保留，但要写进 Config schema（volatile）+ host 逻辑 |
| 所有字段（含 `model.provider/model.model`）直接写 | **每个字段都必须是 `.volatile()`**；嵌套对象里也要在子字段上标 volatile，否则 `mutate` 抛 `not volatile` | 必须改 package 的 Config 定义（`.volatile()` 标注）；这是 plan 未写的实现前提 |
| summary 一行摘要 | summary 只在 row **没有 description** 时渲染；有 description 时被宿主吞掉 | 决定：不放 row description，或把摘要放进 page 顶部 |
| `form.state.status/writable` 处理 | ✅ 有，`loading/ready/unavailable` + `writable` | 按 §1.3 |
| 保存一次 `form.mutate(ops, revision)` | ✅ 正确；`mutate` 内部有 write queue + 冲突恢复，返回 boolean | 无需逐个 `set()` |
| `require('react/jsx-runtime')` 待确认 | ✅ 客户端模块表提供（runner 自己 `require("react/jsx-runtime")`，见 §5） | 可用；但保持 `React.createElement` 更稳 |

## 2. Q2：host 直调 `ctx.llm.stream()`

### 2.1 服务可用性与 inject

- `dsh-llm` 声明 `Context.llm`：`$B/dsh-llm/lib/types/index.d.ts:29-31`
  ```ts
  declare module '@deepseek-ai/cordis' {
    interface Context { llm: LlmRuntime }
  }
  ```
- `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`：同文件 `:115`（`LlmRuntime`），另有 `:122`/`:196` 实现类。
- 外部插件 `inject: ['llm']` ✅：官方 `dsh-compaction-basic` 用 `static inject = [ ... ]`（`$B/dsh-compaction-basic/lib/index.js:801`）访问 `ctx.llm.stream`（`:323`），说明该 service 对普通插件上下文公开。
  → plan §1 的 inject 改为 `['tools','llm']` 可行；只要 profile 里已挂 `dsh-llm`+至少一个 provider（web profile 已有，compaction 正常工作即证）。

### 2.2 `GenerateOptions` 必填/可选（`$B/dsh-llm/lib/types/types.d.ts:538-580`）

必填：`provider: string`、`model: string`、`messages: RequestMessage[]`。
可选：`reasoningEffort?`、`system?`（一次性调用的系统提示，循环式请求留空）、`tools?: ToolSchema[]`、`toolHistory?: ToolHistory`、`temperature?`、`maxTokens?`（**输出 token 上限**，与 `TokenUsage.outputTokens` 对应，单位=token 个）、`stop?`、`signal?`、`sessionId?: SessionId`（路由/游标隔离，适配器可映射为模型不可见元数据）、`purpose?`。
→ plan §1 的参数**除 `purpose` 外全部有类型依据**；`purpose` 见 2.5。

### 2.3 官方同构实现：`summarizeWithLlm`（**直接抄**）

`$B/dsh-compaction-basic/lib/index.js:292-345`（已验证）：
```js
const latest = agent.session.requestHeader()?.config;             // {provider, model, ...} | undefined
const target = configured ?? latest ?? agentTarget;               // 解析顺序与 plan §1 一致
const assembler = new BlockAssembler();
const options = {
  provider: target.provider, model: target.model,
  messages: [...input.messages, deepFreeze({ role:'user', content:[{type:'text', text: INSTRUCTION}] })],
  toolHistory: agent.session.toolHistory(),
  ...input.tools === undefined ? {} : { tools: [...input.tools] },  // requestHeader()?.tools
  maxTokens: config.maxTokens,
  sessionId: agent.session.id,
  purpose: 'compaction',
  ...signal === undefined ? {} : { signal },
};
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
const error = finishError(assembler.finish); if (error) throw error;
const rawOutput = assembler.blocks();                             // ContentBlock[]
```
要点：
- 末尾追加 **user 指令**而不是 system prompt → 前缀是上次请求的真前缀，复用 provider KV cache（同文件注释 `:282-290`：把指令放在“replayed conversation 的最后一条 user 消息”正是为 cache）。
- `toolHistory: agent.session.toolHistory()`、`tools: requestHeader()?.tools` 与主循环请求保持一致（否则 prefix 不一致，cache 失效）。

### 2.4 chunk 解析（不要手写）

- `StreamChunk` union（`dsh-llm/lib/types/types.d.ts:458-488`）：`block-start{index,blockType}` / `text-delta{index,text}` / `reasoning-delta` / `tool-call-delta{index,id,name?,argumentsDelta}` / `block-end{index,block}` / `usage{usage}` / `finish{reason,replayState?}`。
- 官方 `BlockAssembler`：`$B/dsh-llm/lib/types/assembler.d.ts:22-49`
  - `push(chunk)`、`blocks(): ContentBlock[]`、`get usage()`/`get finish()`（同文件 `:50+`，从字段 `_usage/_finish` 暴露）；`dsh-llm` 包根导出（compaction-basic import 自 `@deepseek-ai/dsh-llm`，`:3`）。
- `FinishReason`：`types.d.ts:138-156`
  ```ts
  'stop' | 'tool-calls' | 'max-tokens' | 'aborted'{failure} | 'error'{failure}
  ```
- 错误映射（抄 `compaction-basic/lib/index.js:358-369`）：
  ```js
  switch (finish.kind) {
    case 'error': case 'aborted': throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    case 'max-tokens': { const e = new Error('truncated at token cap'); e.code='MAX_TOKENS'; throw e }
    default: return  // 'stop' | 'tool-calls'
  }
  ```
- `structured_output`：plan §1 说「优先从 `structured_output` tool call 提取」。用 `BlockAssembler.blocks()` 后过滤 `block.type === 'tool-call' && block.name === 'structured_output'` 即可（`ContentBlock` 的 tool-call 形状与 `tool/result` 同族，**推断**字段 `{type:'tool-call', id, name, arguments}`）；没有工具定义时模型通常不会发，可作兼容分支。

### 2.5 `purpose` 省略是否允许

- `purpose?: Purpose`（`types.d.ts:579`），注释：「Provider-neutral classification for an auxiliary model call … **Ordinary conversation requests leave it unset**」→ **省略合法**。
- `LlmRequestPurposeMap` 在 core 里是空接口（`dsh-llm/lib/types/types.d.ts:529-532`）；`'compaction'` 由 `dsh-compaction-basic/lib/types/types.d.ts:7-9` 通过 declaration merge 声明。
- → 我们的插件若想传 `purpose:'compaction'`，TS 下需自己 merge 声明（或使用 `GenerateOptions<string>` 泛型）；运行时任何 string 均可。**建议**：省略 purpose（plan 中写 `purpose:'compaction'` 与类型所有权冲突，轻微偏离，不影响功能/记账——token-meter 按 sessionId/事件记账，不看 purpose，**推断**）。

### 2.6 `session` / `agent` 侧读取 API

- `requestHeader(): EpochHeader | undefined` — `$B/dsh-session/lib/types/index.d.ts:311`；`EpochHeader`（`types.d.ts:223-234`）：`config: LlmCallConfig`、`tools?: ToolSchema[]`、`adapterDefaults?`；`system?: never`（系统提示在 `system/message` 事件里）。
- `toolHistory(): ToolHistory` — `index.d.ts:330`
- `deriveMessages(): Message[]` — `index.d.ts:355`（派生请求历史，含代表性 system/user/assistant/tool 消息；plan 的 `[...deriveMessages(), userInstruction]` 即官方 compaction 的 replay 形态，**高置信推断**）
- `agent.options: AgentOptions` — `dsh-agent/lib/types/runtime-types.d.ts:166`；`AgentOptions`（`:27-36`）：`provider?`、`model?`、`reasoningEffort?`、`maxTokens?`。
- `agent.session.requestHeader()?.config` 的字段（`LlmCallConfig`）在 compaction 里直接当 `{provider,model}` 用（`:294-300`），✅ 与 plan 一致。

### 2.7 与 plan §1 的冲突/风险

| # | 冲突 | 证据 | 建议 |
| --- | --- | --- | --- |
| C1 | `purpose:'compaction'` 不是 core 的 purpose；跨包 declaration merge 才存在 | `dsh-llm` types:529-532；`dsh-compaction-basic` types:7-9 | 省略 purpose，或本地 merge 声明 `'context-slimmer'` |
| C2 | 传 `tools: requestHeader()?.tools` 会让模型有机会真的调用**主会话工具**（read_file 等）；`structured_output` 并不在这些 tools 里 | `EpochHeader.tools?: ToolSchema[]`；plan §1 的提取描述 | 保留 tools 以复用 cache，但把非 `structured_output` 的 tool-call 视为无效输出；明确不执行任何 tool call |
| C3 | 硬超时 `AbortSignal.any([payload.signal, AbortSignal.timeout(ms)])`：HMR/runtime 的 Node ≥20 支持（引擎要求 node ≥24.9）✅ | package.json engines | 无需改 |
| C4 | plan 说「优先 structured_output，否则拼 text block」：官方 `summaryText` 还会**拒绝含图片的输出**（`UNSUPPORTED_CONTENT`） | `compaction-basic:371-374` | 我们的 extract 也应只接受 text/tool-call，含 image → 失败 no-op |
| C5 | `maxTokens: model.maxOutputTokens ?? 2048`：`model` 是 `ctx.llm.resolveModelInfo` 才能拿到的适配器信息（tool-subagent :206 用到 `llm.resolveModelInfo`）；直接 `agent.options.maxTokens` 也可 | `dsh-tool-subagent/lib/index.js:206` | 若只想省成本：`maxTokens: agent.options.maxTokens ?? 2048`；plan 的 `model.maxOutputTokens` 需一次 `resolveModelInfo` 调用（多一次往返，非网络） |

## 3. Q3：`agent/pre-step` 对 subagent 是否派发 + origin

### 3.1 派发语义（已验证）

`$B/dsh-agent/lib/types/runtime-types.d.ts:325-339`：
```ts
/**
 * Scope-filtered dispatch (@deepseek-ai/dsh-scope): agent-scoped listeners receive only that agent.
 * @mode waterfall
 */
'agent/pre-step'(this: Scoped<Agent>, payload: { agent, messages, turn, step, signal, modelSelection }, next): Promise<PreStepDecision>
```
- 事件由 **agent-loop 每步**触发，`this: Scoped<Agent>`；subagent 子会话的 Agent 是真实 Agent（manager 用 `ctx.agents.create` 创建，`childSessionMeta` 提供 meta），因此**同样派发**。
- 子 Agent 的创建路径：`$B/dsh-subagent/lib/index.js:347-361`（`childSessionMeta(parent, childDepth, isSeeded, selectedPreset)`）→ `ctx.agents.create({ sessionId, parentAgent, seed, agentOptions, meta, ... })`（内部 API，见架构报告 §3）。
- → plan §2「对每个 Agent（root 或 subagent）都触发」**成立**。

### 3.2 `session.header.origin` 取值（已验证）

`$B/dsh-session/lib/types/types.d.ts:70-86`：
```ts
readonly parentSession?: SessionId;   // 历史 fork 也保留，不能用来判定子会话
readonly isSeeded: boolean;
readonly origin?: 'subagent';        // 唯一负值；普通/root 会话 = undefined
readonly delegationDepth?: number;
```
- root 会话：`origin === undefined`；子会话：`origin === 'subagent'`（manager 在 `childSessionMeta` 里显式写 `origin:"subagent"` + `parentSession` + `delegationDepth`，`dsh-subagent/lib/index.js:355-357`）。
- 可靠判定（唯一官方分类）：
  ```js
  const isSubagent = agent.session.header.origin === 'subagent'
  ```
  不要用 `parentSession` 是否存在（注释明确：普通 fork 也可能保留 parentSession），也不要用 `delegationDepth`。
- `session.header` 访问器：`dsh-session/lib/types/index.d.ts:154` (`readonly header: SessionHeader`)。

### 3.3 agent-team 会话的 origin

- `@deepseek-ai/dsh-experimental-agent-team` 的成员创建走 **`this.ctx.subagents.startActivation({...})`**（`$B/dsh-experimental-agent-team/lib/index.js:1035`），其 inject 列表含 `"subagents"`（同文件 `:1439`）。
- 因此 agent-team 子会话 = subagent manager 管理的子会话 → 同样 `origin:'subagent'` + `parentSession` + `subagent/catalog`（manager `:817`），与普通 subagent 无差别。
- ⚠️ 产品影响：`includeSubagents:false` 会**同时**跳过 agent-team 成员会话（是否期望？plan 未区分；若要只覆盖 `subagent` 直属子会话，还需按 `parentSession`/`agentPreset` 再筛，但那就不是官方分类）。**需 lead/product 确认**。

## 4. Q4：隐藏规划器（无 `subagent/*` 事件、不计「N 个子智能体」）

### 4.1 不再使用时日志不会出现 `subagent/*`

- `subagent/*` 事件类型的写入方只有 subagent manager：
  - `subagent/catalog`：`establishCatalogChild` 显式 `parent.append("subagent/catalog", {...})` — `$B/dsh-subagent/lib/index.js:817-824`
  - `subagent/descriptor`、`subagent/model-selection-policy`：会话类型清单见 `$B/dsh-session/lib/index.js:100-130`（`subagent/catalog` / `subagent/descriptor` / `subagent/model-selection-policy` 等），均由该链路产生
- 直调 `ctx.llm.stream()` 只发出网络 chunk，**不写会话日志**（官方 compaction 也是自己另行 append 压缩事件才落日志；`ctx.llm.stream` 本身无 append 行为，见 2.3 代码）。
- → 规划器改为直调后，主会话日志无 `subagent/*` ✅（plan §1 的结论成立）。CI 断言：`grep -c '"type":"subagent/' session.jsonl === 0`（**注意**：v0.1 遗留会话仍可能有；断言只针对新跑会话/本轮 turn）。

### 4.2 WebUI「N 个子智能体」数据源（已找到，含行号）

**顶部/侧栏计数（workspace）**：
- 数据 = 每个 session 的 `runningSubagentCount`
  `$B/dsh-client-ui-workspace/lib/client.js:1056-1058`：
  ```js
  function runningChildCount(list, parentId, statuses) {
    return list.projectionsBySession[parentId]?.values.subagentCatalog
      ?.reduce((count, child) => count + ((statuses.get(child.id)?.running ?? list.byId[child.id]?.running) === true ? 1 : 0), 0) ?? 0;
  }
  ```
  - `sessionNode` 填充：`:1067`（`:1213` 另一处子节点路径）
  - 渲染：`:2329-2332`
  - 文案：`locale/zh.json` 对应 `status.subagentsRunning.one/other` = `"{n} 个子智能体运行中"`（`client.js:4858-4859` zh；en `:4980-4981`）
- **来源是 `subagentCatalog` projection 的值**（即 `subagent/catalog` 事件投影，见 `dsh-subagent/lib/index.js` 的 `subagentCatalogProjectionDefinition`），不是子会话列表、也不是工具调用。
  → 直调方案不写 catalog ⇒ `runningSubagentCount = 0`，顶部不计数 ✅。

**聊天内 turn-process 的 subagent 计数（次要计数）**：
- `isSubagentDelegationTool(name) = name === "subagent" || name.startsWith("subagent_")` — `$B/dsh-client-ui-chat/lib/client.js:4415-4417`
- 在 `tool/call` 事件上累加 `subagentCount` — `:12874-12883`
- 渲染为 `data-turn-process-subagents` — `:8712`
- → 直调规划器不产生 `tool/call`，该计数也不增（v0.1 用 startActivation 同样不增；只有模型自己调用 `subagent` 工具才增）。

### 4.3 主 Agent 的 subagent 工具列出的 entry

- 工具注册：`$B/dsh-tool-subagent/lib/index.js:480`（`mount` 里 `ctx.tools.register(definition)`，工具名 `config.toolName ?? "subagent"`，见日志文案 `:503`；另有 `subagent_fork` 等按 provider 挂载）与 `list_subagent_models`（`:215-240`）。
- 主 Agent 可见的「子智能体」列表面板/工具数据来自 `subagent/catalog` 投影与 `ctx.subagents` children registry；**不使用 startActivation ⇒ catalog 为空 ⇒ `list_agents` / `wait_agent`（chat locale `tool.title.listAgents` / `tool.title.waitAgent`，`dsh-client-ui-conversation/lib/client.js:16957-16958,16979`）列不出规划器**。
- 结论 ✅（plan §1「主 Agent 的 subagent 工具也列不出规划器」成立）；建议 CI 断言 `subagent/catalog` 事件数为 0（比 UI 断言更稳）。

## 5. Q5：client bundle 的 `require` 可用列表与 import 限制

### 5.1 客户端模块系统（已验证）

- 每个 client bundle = `window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => { ... } })`；`factory` 收到**同步** `require`。
- 解析顺序（`$B/dsh-client-modules/lib/client.js:10-40` 注释）：seed word → shell instance；已 memoized 记录 → exports；graph row → 注册依赖工厂+自身；已注册 factory → materialize；否则 **throw loud**（构建期 bundle purity gate 的运行时镜像）。
- `dsh.client.external`（`parseDshClient` `:86-103`）：声明把哪些包当作外部依赖（由 boot 注入/加载），**不是**随手可 require 任意包。
- 我们的 `packages/tool-result-slimmer/package.json` 已有 `dsh.client.inject: [...]`（官方 client 包列表），照 better-workspaces 范式即可。

### 5.2 实测可用 require（按证据强度）

| 模块 | 证据 | 结论 |
| --- | --- | --- |
| `react` | 所有官方 client bundle 首行 `require("react")`（如 `$B/dsh-cordis-client-runner/lib/client.js:30`） | ✅ 可用 |
| `react/jsx-runtime` | `dsh-cordis-client-runner/lib/client.js:13` 自己 `require("react/jsx-runtime")`（runner 也是 client bundle，走同一 require 表） | ✅ 可用 |
| `@deepseek-ai/cordis` | 同上 `:29` | ✅ 可用 |
| `@deepseek-ai/dsh-client-ui-primitives` | `$B/dsh-client-ui-chat/lib/client.js:10` | ✅ 可用 |
| `react-dom/client` | 官方 UI 组件包渲染根用（未逐行取证，**推断**） | 推断可用 |
| 任意 `@deepseek-ai/dsh-*`（未在 boot graph/inject 声明） | 解析顺序「anything else → throw」 | ❌ 不可用 |

→ plan §4 的「`require('react')` 与 `require('react/jsx-runtime')` 可用」**已确认**；但现有 `client.js` 手写 bundle 用 `React.createElement` 无需 jsx runtime，建议保持（减少构建差异）。

### 5.3 host 侧 import 限制

- 外部插件 host 半边**可以** `import '@deepseek-ai/dsh-schemastery'` 之外的官方包（模块解析到宿主安装，本机已验证 `@deepseek-ai/dsh-session` 解析到宿主唯一副本）；但：
  - **不要**把任何 `@deepseek-ai/*` 打进 bundle（会复制第二份 ESM 实例，破坏私有 brand/单例，例如 `dsh-session` 的 `#appendRecord`；见 `dsh-api-map.md` §2.4c）。
  - 声明为 `peerDependencies`（cordis）或 `dependencies` 但保持 external（参考 better-workspaces 的 `peerDependencies: {"@deepseek-ai/cordis":"^4.0.2"}`）。
  - `@deepseek-ai/schemastery` 用于 `Config` schema（`z.object`），可直接依赖（官方插件惯例）。
- 推断级：没有发现“只允许 import schemastery”的硬闸；限制是 **bundle purity gate / dsh.client.external / graph 注册**三处（client 侧），host 侧是 ESM 实例一致性。

## 6. 与 `docs/plan-v0.2.md` 的冲突/待补清单

| # | plan 位置 | 冲突/缺口 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| P1 | §4 配置字段 | 未要求 `.volatile()`；非 volatile 字段不显示且写入抛错 | `dsh-settings:122-131,415-417,506` | Config schema 全部字段标 `.volatile()`（嵌套 `model` 子字段也标）；写进 task-12 验收 |
| P2 | §4 summary | summary 只在 row 无 description 时渲染 | plugin-manager `client.js:5855` | 明确取舍：去掉 row description 或把摘要挪进 page |
| P3 | §1 `purpose:'compaction'` | 非 core purpose，需跨包 declaration merge | `dsh-llm types:529-532`；compaction types:7-9 | 省略 purpose（推荐）或本地 declare merge |
| P4 | §1 structured_output | 传了 `tools` 后模型可能真调用主会话工具；structured_output 不在 tools 里 | `EpochHeader.tools?` types:228 | 忽略/拒绝非 structured_output 的 tool-call；不执行任何工具 |
| P5 | §1 `model.maxOutputTokens` | 需 `ctx.llm.resolveModelInfo(provider, model)` 才有适配器信息 | `dsh-tool-subagent:206` | 改用 `agent.options.maxTokens ?? 2048`，或接受一次 resolve |
| P6 | §2 `includeSubagents` | agent-team 成员也是 `origin:'subagent'`，会被一并跳过/覆盖 | agent-team `:1035`；manager `:355` | 产品确认是否要把 team 成员排除（若排除需额外判定，非官方分类） |
| P7 | §4 `enabled` 软开关 | 与原生 row disabled/硬开关语义重叠 | plugin-manager row detail / catalog | 明确：软开关只在 host apply 内早退；面板仍用 row switch 控制硬开关 |
| P8 | §7 验收「无 subagent 计数」 | 顶部计数=0 可断言；聊天 turn-process 计数与子会话无关 | workspace `:1056`；chat `:4415` | CI 断言 `subagent/catalog` 事件数=0；UI 断言顶部文案不存在/计数为 0 |

## 7. 给实现方的落地清单（简短）

- **ui-dev（task-12）**：按 §1.6 骨架；`key` 用 `@ds-hu/dsh-context-slimmer#context-slimmer-tool-result`；page 必须能处理 `form===undefined` 与 `status!=='ready'`、`!writable`；`data-ctxslim-config` + `data-field="<name>"` 供 CI 截图断言；保存一次 `mutate(ops, state.revision)`。
- **core-dev**：Config 全部字段 `.volatile()`；host 侧 `inject:['tools','llm']`；planner 抄 §2.3，`purpose` 省略；失败（finish error/max-tokens/空文本/JSON 解析失败/超时）→ no-op + diagnotics，不写 replacement；CI 断言新会话 `subagent/*` 事件数为 0。
- **ci-engineer（task-13）**：面板截图断言用 `[data-ctxslim-config]`、`[data-field="everyNToolCalls"]`、`[data-field="model.provider"]`；顶部「N 个子智能体」断言用 DOM 文本「个子智能体」不存在或计数 0；日志断言 `subagent/` 事件数=0。

## 附：本文证据路径速查

- slot 契约：`$B/dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:23-28,203-210`；`lib/client.js:85-90,5811,5853-5856,5867-5873,6919-6928,7279,7780-7783`
- 契约文档：`$B/dsh-cordis-client-runner/lib/client.js:5158-5190`
- settings：`$B/dsh-settings/lib/index.js:122-131,399-401,411-447,470-540`；`lib/types/types.d.ts:47-54`；`$B/dsh-client-ui-settings/lib/types/client/config-form-types.d.ts:6-72`
- 落盘：`$B/dsh-config-editor/lib/index.js:24-26,76-...`；`$B/dsh-app-boot/lib/index.js:1327,1398-1399,1822`
- llm：`$B/dsh-llm/lib/types/{index.d.ts:29-31,115,122,196;types.d.ts:138-156,223-234,458-488,529-532,538-580;assembler.d.ts:22-49}`；`$B/dsh-compaction-basic/lib/index.js:292-345,358-374,801`；`$B/dsh-compaction-basic/lib/types/types.d.ts:7-9`
- agent/session：`$B/dsh-agent/lib/types/runtime-types.d.ts:27-36,166,325-339`；`$B/dsh-session/lib/types/index.d.ts:154,311,330,355`；`lib/types/types.d.ts:70-86,124,223-234`
- subagent/agent-team：`$B/dsh-subagent/lib/index.js:347-361,817-824`；`$B/dsh-experimental-agent-team/lib/index.js:1035,1439`；`$B/dsh-session/lib/index.js:100-130`
- UI 计数：`$B/dsh-client-ui-workspace/lib/client.js:1056-1058,1067,2329-2332,4858-4859`；`$B/dsh-client-ui-chat/lib/client.js:4415-4417,8712,12874-12883`；`$B/dsh-client-ui-conversation/lib/client.js:16957-16958,16979`
- client 模块表：`$B/dsh-client-modules/lib/client.js:10-40,86-103`；`$B/dsh-cordis-client-runner/lib/client.js:13,29,30`；`$B/dsh-client-ui-chat/lib/client.js:10`
