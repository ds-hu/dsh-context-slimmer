# UI 说明与证据（client 半）

本文记录 `@ds-hu/dsh-context-slimmer-tool-result` 浏览器半（`packages/tool-result-slimmer/lib/client.js`）的最终实现结论：注册了哪些对象、数据从哪个事件通道来、为什么这样选、样式与文案如何对齐原生行，以及离线验证方式与残余风险。

- 目标 DSH 版本：`0.2.2-rc.1`（下文路径均相对于 `@deepseek-ai/dsh/node_modules/@deepseek-ai/`）。
- 相关文档：`docs/architecture.md` §3.5（UI 行）、`docs/dev-notes.md`（实现决策）、`packages/tool-result-slimmer/README.client.md`（开发者使用说明）。
- 离线验证：`node --check packages/tool-result-slimmer/lib/client.js`、`npm run test:module`（`packages/tool-result-slimmer/test/client-smoke.test.mjs`）。

---

## 1. 注册对象与 API 证据

| 事项 | 实际名称 / 形态 | 证据（DSH 0.2.2-rc.1） |
| --- | --- | --- |
| client bundle 入口格式 | `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 返回模块导出 | 官方 client bundle 同格式：`dsh-client-modules/lib/client.js:1`；加载器校验“必须注册 `id`”：同文件 `:760,877` |
| 注册 Conversation 业务定义 | `ctx.uiConversation.events.register(definition)` | `dsh-client-ui-conversation/lib/client.js:3356-3359`（内部 `registerDefinition` 用调用方 `ctx.effect` 持有生命周期，`:3322-3341`） |
| 定义类型 | `ConversationNodeDefinition`：`{ kind, target, match, start, update, buildViewNode? }` | `dsh-client-ui-conversation/lib/types/client/contract/conversation.d.ts:179-231` |
| 事件分发 | 引擎对每个 durable 事件调用 function 形式 `definition.match(event)` | `dsh-client-ui-conversation/lib/client.js:2805-2810`（表路由 `forEvent` 之后回退 function match） |
| Chat 行渲染插槽 | keyed 插槽 `conversation.chat.node`，key = 最终 Node 的 `kind` | `dsh-client-ui-chat/lib/client.js:9238-9262`（官方注册 `{name:'conversation.chat.node', key, locale: NS}`），渲染点 `:4593` |
| 插槽注册 | `ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name, key, locale }, Component))` | 同上；`inject` 等待目标插槽先声明，卸载时自动回收 |
| `t` 注入 | 注册项里的 `locale: 'context-slimmer'` 让渲染器为组件注入该命名空间的 `t`（locale 切换会换 `t` 引用，从而重渲染） | `dsh-client-ui-renderer/lib/client.js:541-566`（locale seat，缓存键含 revision） |
| 样式归属 / 卸载清理 | 手写 `<style data-plugin="<pkg id>" data-plugin-css="<css id>">`；客户端模块卸载时按 `data-plugin` 清扫 | `dsh-client-modules/lib/client.js:314`（移除 `style[data-plugin=<id>]`）、`:618-629`（tag 归属与按 `data-plugin-css` 收集） |
| `dsh.client.inject` 语义 | 包名数组（Loader 依赖提示），**不是** Cordis 服务注入；真正的服务注入是 bundle 导出的 `inject` | `dsh-package-manifest/lib/types/types.d.ts:81-95`（`DshClientManifest`） |
| 服务注入列表 | 导出 `inject = ['slots', 'locale', 'uiConversation']` | 运行时由 Cordis 解析；官方最小示例 `dsh-client-ui-goal/lib/client.js:661-673` 用同一组服务（`locale` + `uiConversation` + `slots`） |
| baseline 外部模块 | `react` 已在 shell 冻结模块表内，因此本 bundle **不需要** `dsh.client.external` | `dsh-web-frontend/dist/assets/index-*.js` 的 `staticModules` 表（含 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-*` 等） |
| 官方推荐做法 | “Add a Chat row by registering an event definition with `ctx.uiConversation.events.register()` and its view in the `conversation.chat.node` slot under the definition's `kind`” | `dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:37` |
| 插件面板标题 / 图标 | 包根 `locale/<lang>.json` 的 `meta.title/description` + `package.json#icon`（或 `./icon` 资源）由 DSH app-boot 直接读取，不走 Client bundle | `dsh-app-boot/lib/index.js:2986-3047` |

`packages/tool-result-slimmer/package.json` 中与本半相关的字段（core-dev 已落盘，保持一致即可）：

```json
{
  "exports": { "./client": "./lib/client.js" },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-chat",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer"
      ]
    }
  }
}
```

不需要 `immediately`（bundle 只注册懒工厂，无启动期副作用），也不需要 `external`（只用 baseline `react`）。`peerDependencies` 只保留 `@deepseek-ai/cordis`；对 core 包的依赖是普通 `dependencies` 且版本 `0.1.0`。

---

## 2. 数据通道（最终决策：`compaction/prune.data.contextSlimmer`）

### 2.1 采用的通道

Host 半在每次 `tool/result` 替换事件**之前**按原生 shadow-price 协议 append 一条 `compaction/prune`，并在其 owner-defined `data` 上附加本插件命名空间字段：

```jsonc
// 每条替换前都有一条；本批最后一条 role = 'summary' 携带整批摘要
{
  "type": "compaction/prune",
  "seq": 123,
  "data": {
    // 原生字段（供纯消费者减 token 账）
    "shadowedRange": { "start": 5, "end": 5 },
    "shadowedSeqs": [5],
    "shadowedTokenCount": 1234,
    // 插件附加字段（opaque to core）
    "contextSlimmer": {
      "v": 1,
      "batchId": "…",
      "role": "item" | "summary",
      "status": "applied",              // 仅 summary 携带
      "startedAt": 0, "finishedAt": 0,  // 仅 summary 携带
      "trigger": { "everyNToolCalls": 8, "minChars": 24000, "observedCalls": 8, "observedChars": 30000 },
      "model": { "provider": "deepseek", "model": "…", "inherited": false },
      "items": [{ "index": 0, "callId": "…", "toolName": "bash", "op": "drop", "reason": "…",
                  "charsBefore": 8123, "charsAfter": 48, "replacementSeq": 20 }],
      "totals": { "items": 1, "charsBefore": 8123, "charsAfter": 48, "charsSaved": 8075 }
    }
  }
}
```

UI 只消费 `role === 'summary'` 的那一条（一批一行）；`role === 'item'` 不渲染。

### 2.2 为什么不走 `tool/result.data.meta`

Lead 曾决定把摘要挂到替换事件的官方 `data.meta.contextSlimmer`，但运行时校验禁止：

- `dsh-session/lib/index.js:394-410` 的 `assertToolResultRewrite`（`dsh-session/lib/types/surface.js:350-373` 为其编译内联副本）：把 original 与 replacement 的 `data` 逐字段深比较（仅把 `message.content` 置空后比较其余字段），不等即抛
  `tool/result surface replacement may change only content`。
- 因此 replacement 的 `meta` 只能**原样复制**，无法新增/修改；meta 通道拿不到任何 contextSlimmer 数据。该类方案已作废。

### 2.3 为什么可以走 `compaction/prune.data`

1. **事件类型是官方的**：`compaction/prune` 在客户端 wire 的已知类型集合中（`dsh-api-session-controller/lib/client.js:148`），不是未知事件，无兼容性风险。
2. **data 是 owner-defined JSON，wire 不校验其字段**：客户端 `validateSessionEventData`（`dsh-api-session-controller/lib/client.js:242-330`）只校验 surface 类型的 message/developer 规则、`request/header`、`tool/result` 的 error 一致性；**不检查 `compaction/prune` 的 data 形状**。`assertSessionWireEvent` 的 JSDoc 明确“reject non-current envelopes without stripping or normalizing wire fields”（同文件 `:336-360`），data 原样保留。
3. **Host 持久化同样原样**：`Session.append` 只要求事件 data 可 JSON 序列化（`isJsonValue`）；服务端转发不过滤、jsonl 原样落盘。
4. **不会与原生行重复**：原生自动压缩行只匹配 `compaction/start|summary|end` 与 checkpoint（`dsh-client-ui-chat/lib/client.js:11765-11804` 的 `compactionDefinition`），不匹配 `compaction/prune`；原生 tool-result pruner 产生的 `compaction/prune` **没有** `contextSlimmer`，本插件匹配不到，因此不会误渲染、也不会重复渲染。
5. **替换协议要求 prune 先行**：原生 pruner 在每条替换前 append `compaction/prune`（`dsh-compaction-tool-result-pruner/lib/index.js` `pruneSession`），Host 半沿用该协议，prune 一定存在且与替换一一对应。
6. **可回放**：prune 是 durable 事件，页面刷新/会话恢复后 conversation assembler 重新喂事件即可重建行（无需额外本地状态）。

### 2.4 残留的前向兼容分支

`lib/client.js` 里保留了 `event.type === 'tool/result' && isReplacementEvent(event) && data.meta.contextSlimmer.role === 'summary'` 的第二通道（`replacementPayloadOf`）。**当前运行时永不触发**（原因见 2.2），仅当未来 DSH 放宽 `assertToolResultRewrite` 时无需再改 client。代码注释已写明这一点。

### 2.5 通道风险与降级

- 若未来 DSH 收紧 `compaction/prune` 的 data 校验（当前没有），Host 写入会被拒绝：UI 表现为“没有行”，不会报错/崩溃（`match` 拿不到 payload 即返回 null）。届时需与 core-dev 一起换通道（替换文本前缀推断只作为最后手段，明细不可得，不推荐）。
- Host 必须保证：每条替换前有 prune；本批最后一条 prune 的 `role` 为 `summary` 且带完整摘要。缺失时 UI 静默不渲染（符合“失败/无操作不产生行”的架构约定）。

---

## 3. Node 定义（与原生 compaction 行同构）

`lib/client.js` 中的 Definition：

```js
{
  kind: 'context-slimmer-tool-result',   // 同时是 Chat keyed renderer 的 key
  target: 'chat',
  match(event),        // compaction/prune + data.contextSlimmer.role === 'summary'
  start(context, match) / update(context, match),  // → { anchorSeq: event.seq, time, summary: normalizeSummary(payload) }
  buildViewNode(context) // → Chat Node 或 null
}
```

- **id**：`'context-slimmer:' + batchId`；缺 `batchId` 时退化为 `'context-slimmer:seq-<seq>'`（稳定、可去重）。一批一条，不会因每条替换行重复。
- **Node 形状**（完全等价于官方 `chatNode(context, kind, anchorSeq, data)` 默认值，`dsh-client-ui-chat/lib/client.js:9770-9782`）：

  ```js
  {
    key: context.key,
    kind: 'context-slimmer-tool-result',
    id: context.id,
    target: 'chat',
    anchorSeq: event.seq,          // summary prune 的 seq（比对应替换事件早 1）
    location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'session' },
    visibility: 'visible',
    data: <归一化后的 summary payload>,
  }
  ```

  **不传 `groupTree`**：官方 `compactionDefinition` 调用 `chatNode` 时不带 options（`groupTree = undefined`、`visibility = 'visible'`、location = `contextLocation(context)`），本行与原生压缩行完全一致，避免被重新挂到 Turn 分组层影响“出现在对话流对应位置”的观感（早期版本曾用 `groupTree: 'turn'` 防折叠，已按 Lead 裁决移除）。
- **location 兜底** 用 `{ kind: 'session' }`（Lead 指定），与原生 `contextLocation()` 的 `{ kind: 'unresolved' }` 不同；只影响极端情况下（匹配事件未解析出 Turn/Step）行的归位，不影响正常路径。
- **anchorSeq 语义**：summary prune 是“本批最后一条替换前的 shadow-price 事件”，其 seq 在对话流尾部（当前 turn 内、替换事件前 1 个 seq）；行的视觉位置 = 紧接本批最后一条被精简结果之后。
- **update**：引擎对同一 Context 的后续 match 调 `update`；本实现按最新 payload 重新快照（当前 Host 一批只发一条 summary，正常不会走到，保留健壮性）。
- **不匹配**（smoke test 覆盖）：`compaction/summary` 等其它事件、无 `contextSlimmer` 的原生 prune、`role !== 'summary'`、`state` 缺失 → 返回 null / 不渲染。

---

## 4. 渲染器与视觉

- 注册：`ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: NODE_KIND, locale: 'context-slimmer' }, SlimRowView))`。
- 组件（`React.memo`）只依赖 baseline `react`，`h = React.createElement`，无 JSX/build。
- 收起态：与原生“上下文已压缩”行同构的**单行**（对照 `dsh-client-ui-chat/lib/client.js:5102-5160` 的 `CompactionItem` + `MessageItem.module.css` 的 `compaction*` 规则）——
  - 16px 前置图标位（at rest 是“上下文压缩”glyph；hover/focus/展开时切换为展开/收起 chevron，仿原生 disclosure 交互）。**图标为内联 SVG 近似**：原生用 `@deepseek-ai/dsh-client-ui-primitives` 的图标字体（`IconApiOutlineRegular`/`IconChevronRightOutlineRegular`/`IconChevronDownOutlineRegular`）；本 bundle 为免除 `dsh.client.external` 不依赖 primitives，用等效几何 SVG 近似，尺寸/位置/换位逻辑与原生一致；若必须逐像素一致，可在 manifest 加 `external:['@deepseek-ai/dsh-client-ui-primitives']` 并 require 该包（当前不需要）；
  - 标题 `已精简工具调用结果`；2px 圆点分隔；摘要 `{N} 项 · 释放 {X} 字符`（千分位手写分组，zh/en 一致）；`white-space: nowrap; text-overflow: ellipsis` 单行省略。
  - 整行是原生 `<button type="button">`，天然支持 `Enter`/`Space`，折叠语义用 `aria-expanded` 暴露；无可展开内容时 `disabled`。
  - 展开时头部 `position: sticky; top: 0; z-index: 7` 且背景 `--dsw-alias-bg-base`（与原生一致，长明细滚动时标题钉住；hover 用 `--dsw-alias-interactive-bg-hover-solid`）。
- 展开态（detail body，缩进 22px 对齐原生）：
  - 每条 item 一行：`#index toolName · op · charsBefore→charsAfter · reason`（`op` 原样显示 `drop`/`trim`，缺失 reason/字符数时有兜底文案），`data-op` 供 e2e/样式区分；
  - `渲染上限 40 条`（`DETAIL_ITEM_LIMIT`），超出显示 `…还有 N 项`；
  - 末尾：`触发：新增工具结果 N 条、X 字符`（有 trigger 时）→ `模型：{provider}/{model}`（`inherited` 时显示“继承主 Agent”）。
- 状态分支（向前兼容）：`status !== 'applied'` 时整行灰色（`--dsw-alias-label-caption`），文案 `本次无改动` / `已跳过（模型未返回有效计划）`；当前 Host 只在 applied 时产生 summary，因此实际只会看到正常行。
- 防御性：`props.t` 缺失时用 `ctx.locale.bind` 的兜底翻译器；payload 缺失/旧版本/非对象 → 归一化为 no-op 行，不抛异常。
- e2e 钩子（供 Playwright）：`data-ctxslimmer-row`、`data-ctxslimmer-toggle`、`data-ctxslimmer-summary`、`data-ctxslimmer-item`、`data-ctxslimmer-model`、`data-ctxslimmer-trigger`、`data-ctxslimmer-status`、`data-status`、`data-expanded`。

### 文案（`locale` 命名空间 `context-slimmer`）

`lib/client.js` 内置 zh/en 两套完整字典（key 集合一致，smoke test 断言），通过 `ctx.locale.register('context-slimmer', { zh, en })` 注册；其它语言回退 en。UI 行不读 `locale/*.json`（那些文件是宿主插件面板的 `meta.title/description`，由 Host 半使用），因为手写 bundle 不能 import JSON，也不引入构建步骤。

| key | zh | en |
| --- | --- | --- |
| `row.title` | 已精简工具调用结果 | Tool results slimmed |
| `row.items.one` / `other` | 1 项 / {count} 项 | 1 item / {count} items |
| `row.saved` | 释放 {chars} 字符 | {chars} chars freed |
| `row.noop` | 本次无改动 | No changes this run |
| `row.skipped` | 已跳过（模型未返回有效计划） | Skipped (the model returned no valid plan) |
| `row.more` | …还有 {count} 项 | …and {count} more |
| `row.model` / `row.model.inherited` | 模型：{model} / 模型：继承主 Agent | Model: {model} / Model: inherited from the main agent |
| `row.trigger` | 触发：新增工具结果 {calls} 条、{chars} 字符 | Triggered after {calls} new tool results and {chars} chars |
| `row.empty` | 无明细 | No details |
| `item.unknownTool` / `item.chars` / `item.charsMissing` | 工具 / {before}→{after} / 字符数未知 | tool / {before}→{after} / chars unknown |

---

## 5. 样式与主题

- 单条 `<style data-plugin="@ds-hu/dsh-context-slimmer-tool-result" data-plugin-css="…/SlimRow.css">`，在 `ctx.effect` 中挂载、dispose 时移除；即使异常退出，客户端模块卸载清扫也会按 `data-plugin` 兜底移除（`dsh-client-modules/lib/client.js:314`）。
- 只用主题 token，无硬编码颜色；与原生压缩行一致的 token：
  `--dsw-alias-label-tertiary`（行主色）、`--dsw-alias-label-secondary`（hover/工具名）、`--dsw-alias-label-caption`（分隔点/弱化字/灰色状态）、`--dsw-alias-interactive-bg-hover` / `--dsw-alias-interactive-bg-hover-solid`（hover / 展开态 sticky 头 hover）、`--dsw-alias-bg-base`（sticky 头背景）、`--dsw-radius-sm`、`--dsw-focus-ring-color`（回退 `--dsw-alias-state-business-primary`）、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta`、`--dsh-content-font-delta-secondary`（字体缩放与 `--dsh-compaction-header-height`）、`--ds-font-family-code`（等宽数字/工具名）。
- 所有选择器都以 `.ctxslim-` 前缀限定，不设置全局规则、不用 `!important`；`hover` 规则包在 `@media (hover:hover)`，动效包在 `prefers-reduced-motion` 守卫内。
- 行高 24px + 字距对齐原生 compaction 行（`dsh-client-ui-chat` 内 `CompactionItem` 的样式实现，`lib/client.js:5102-5160` 附近）。

---

## 6. 离线验证

```bash
cd packages/tool-result-slimmer
node --check lib/client.js
npm run test:module          # == node --test test/*.test.mjs
# 或直接：
node test/client-smoke.test.mjs
```

- `node --check lib/client.js`：通过（classic CJS 脚本语法，非 ESM）。
- `test/client-smoke.test.mjs`：通过。覆盖：
  1. bundle 格式守卫：`window.__ModuleLoader__.load`、id 等于包名、唯一 `require('react')`、无 `console.log`、无网络 API、无 plugin-record 事件类型残留；
  2. fake loader + 结构化 `react`（`createElement/memo/useState`）物化 factory；factory 阶段无 DOM 副作用；
  3. `apply(ctx)` 注册：`slots.inject` 目标 slot 名、Definition、keyed renderer 选项 `{name,key,locale}`、locale 字典（zh/en key 集合一致）、样式 tag 归属与 token；
  4. Definition：正向匹配 `compaction/prune + contextSlimmer.role='summary'`；负例——原生 prune 无 contextSlimmer、`role='item'`、无 role、普通 `tool/result` replacement、无关事件；缺 batchId 的 id 退化；
  5. Node 形状：kind/key/id/anchorSeq/location/visibility、**无 `groupTree`**、location 兜底 `{kind:'session'}`、无 state 返回 null、update 快照；
  6. 渲染树（不跑真 React）：收起态单行文本与 `aria-expanded=false`、`<button type=button>`、展开态 item 明细/触发/模型行、no-op/rejected/未知 status/畸形 payload 的灰色与兜底、en locale 文案；
  7. 尾部：dispose 所有 effect 不抛异常；清理 fake document。

---

## 7. 残余风险与维护提示

1. **与 Host 半的契约耦合**：依赖“每条 `tool/result` 替换前有 `compaction/prune`；本批最后一条带 `role:'summary'`”。core-dev 若调整写入顺序/字段名，UI 静默不出行——联调时先看 Host 日志的 prune 数量与 summary 是否落盘。
2. **`data` 校验收紧**：见 2.5；唯一可写通道是 owner-defined JSON 的官方事件，若 DSH 未来加白名单需重新评估（不建议退回 meta 或文本前缀推断）。
3. **`groupTree` 决策**：当前完全对齐原生 compaction（不传）。若未来 chat 包对 process 分组/排序规则调整，需在真实 GUI 里复核行位置与可见性；如需“永不折叠”再评估 `groupTree:'turn'`。
4. **locale 切换**：`t` 引用随注册的 locale seat revision 变化，`React.memo` 浅比较会重渲染；若未来改用手工缓存需保持该行为。
5. **kind 命名冲突**：`context-slimmer-tool-result` 若被其它插件重复注册，`uiConversation.events.register` 会在 `apply` 期抛 duplicate 错误（快速失败，可接受）；改名时同步改 Definition kind、slot key、测试。
6. **插件禁用/卸载**：Definition、renderer、字典注册都由 `ctx.effect`/`ctx.slots.inject` 自动回收，样式 tag 由 dispose + 卸载清扫移除；已渲染的历史行随 Definition 注销而消失（符合“关掉插件即无行”的预期）。
7. **无会话写入 / 无网络**：client 半只读事件流与渲染，不调用 `session.append`、不请求网络；`meta` 只存索引/字符数/模型标识（不存原文），与 §5 隐私约定一致。
8. **数字口径**：`charsSaved` 直接取 payload；缺失时用 `charsBefore - charsAfter` 兜底；千分位为手写分组（zh/en 相同），不依赖 `Intl`（避免 locale/时区差异）。
