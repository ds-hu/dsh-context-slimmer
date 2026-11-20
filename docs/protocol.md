# 批元数据与替换协议（v1）

本文件是 `dsh-context-slimmer` 各模块之间、以及模块与 DSH 会话日志之间的**权威协议**。实现：`packages/core/lib/events.js`（schema/校验/读取器）、`packages/core/lib/replace.js`（替换与批次元数据落地）、`packages/tool-result-slimmer/lib/index.js`（宿主编排）、`packages/tool-result-slimmer/lib/client.js`（UI 消费）。测试：`packages/core/test/events.test.mjs`、`replace.test.mjs`。

> 版本：`META_VERSION = 1`；命名空间键 `contextSlimmer`；本文件与实现同步，改字段先改这里。

---

## 1. 设计约束（为什么不是别的通道）

| 候选通道 | 结论 |
| :-- | :-- |
| `tool/result.data.meta` | **不可写**。`Session.append` 对 surface replacement 执行 `assertToolResultRewrite`：除 `message.content` 外，替换事件 data 必须与原文逐字段深相等；新增/修改/删除 `meta` 均抛 `tool/result surface replacement may change only content`（离线实测，dsh-session 0.2.2-rc.1）。 |
| `appendPluginRecord` / `plugin:*` | 不采用。DSH `practices.md` 将其列为 experimental 包保留通道；外部插件无移植性，且 client 侧属未知事件类型。 |
| `compaction/prune.data` 扩展字段 | **采用**（本协议）。已知 log-only 事件类型；`Session.append` 只做通用 JSON 校验；snapshot/seed 重建原样保留；原生 token-meter/压缩只读官方三字段；client 端按已知类型匹配。 |

硬性要求：

1. 每条 `tool/result` surface replacement 之前**紧邻** append 一条 `compaction/prune`（prune → replace 成对，不得先批量 prune 再批量 replace）。
2. prune 的官方三字段必须原样携带：`shadowedRange: {start, end}`、`shadowedSeqs: SessionSeq[]`、`shadowedTokenCount: number`（本批每条都是一对一的单节点遮蔽：`start === end === 原 seq`，`shadowedSeqs = [原 seq]`）。
3. 附加字段只放 `data.contextSlimmer`，值必须是 lossless JSON（`Session.append` 用 `isJsonValue` 校验）。
4. **元数据不得包含工具输出原文**（隐私/体积）：只有 index、callId、toolName、字符数、op、reason 等派生字段。
5. 替换事件 `data` = `{...原 event.data, message: {...原 message, content: [新内容]}}`，`error`/`turn`/`step`/`meta` 原样复制；**`meta` 一律不改**。

---

## 2. `data.contextSlimmer` 结构

### 2.1 公共外壳

```jsonc
{
  "v": 1,                 // META_VERSION，必须为 1；未知版本 → 读取器返回 null（前向兼容）
  "batchId": "…",         // 全局唯一、整批稳定；UI Context id = "context-slimmer:" + batchId
  "role": "item"          // "item" | "summary"
}
```

### 2.2 `role: "item"`（本批前 N-1 条 prune，每条替换一个目标）

```jsonc
{
  "v": 1,
  "batchId": "5f0c…",
  "role": "item",
  "index": 3,             // 0-based CANDIDATES 下标（非 seq）
  "op": "drop",           // "drop" | "trim"
  "charsBefore": 8123,    // 原消息文本的 Unicode code point 数
  "charsAfter": 48,       // 替换后文本的 code point 数
  "toolName": "bash",
  "callId": "call_…",     // 可选，审计用
  "reason": "与任务无关"   // 可选，≤40 code points
}
```

### 2.3 `role: "summary"`（本批最后一条 prune，携带整批摘要；UI 唯一数据源）

```jsonc
{
  "v": 1,
  "batchId": "5f0c…",
  "role": "summary",
  "status": "applied",          // 见 §4；只有 applied 批次会产生 summary
  "startedAt": 1763600000000,   // epoch ms
  "finishedAt": 1763600012345,  // epoch ms，>= startedAt
  "trigger": {
    "everyNToolCalls": 8,       // 本次生效的配置值
    "minChars": 24000,
    "observedCalls": 9,         // 触发窗口内观测到的 tool/result 数
    "observedChars": 31200      // 触发窗口内累计字符数
  },
  "model": {
    "provider": "deepseek",     // 有效路由（inherit 时为主 Agent 路由）
    "model": "deepseek-chat",
    "inherited": true           // true = 继承主 Agent；false = Config 覆盖
  },
  "items": [                    // 只统计真正落地的替换，按落地顺序
    {
      "index": 3,
      "callId": "call_…",
      "toolName": "bash",
      "op": "drop",
      "reason": "与任务无关",
      "charsBefore": 8123,
      "charsAfter": 48,
      "replacementSeq": 1042    // 对应 tool/result 替换事件的 seq
    }
  ],
  "totals": {
    "items": 1,
    "charsBefore": 8123,
    "charsAfter": 48,
    "charsSaved": 8075
  }
}
```

`items[].replacementSeq` 的末项由宿主在 append 前确定性预测：日志 append-only 且本 run 是唯一写者，`prune.seq = session.seq`、`replacement.seq = session.seq + 1`。若一批中途 append 失败，失败项不进入 `items`，且**不写 summary**（UI 不出现没有实际替换的摘要行）。

### 2.4 校验与读取（`packages/core/lib/events.js`）

| 函数 | 行为 |
| :-- | :-- |
| `buildItemMeta(input)` / `buildSummaryMeta(input)` | 构造 + 全量 normalize + 深冻结；非法即抛 `MetaProtocolError`（宿主 bug 早失败） |
| `normalizeMeta(value)` | 严格校验并返回冻结对象；未知版本/角色/字段抛错 |
| `readSlimMeta(value)` / `readSlimMetaFromEvent(event)` | **总函数**：任何不合法/不认识的载荷返回 `null`，绝不抛（replay/UI 边界安全） |
| `hasSlimMeta(data)` | 幂等检查（新节点筛选时跳过已精简结果） |
| `summarizeItems` / `summarizeMeta` | 纯聚合/一行日志摘要，不含工具原文 |

严格性规则：`v` 必须为 1；`batchId` 1–64 字符；`index`/`chars*`/`replacementSeq` 为非负安全整数；`charsAfter <= charsBefore`；`op ∈ {drop, trim}`；`status ∈ {applied, no-op, rejected, failed}`；`finishedAt >= startedAt`；`totals.items === items.length`；`trigger`/`model` 字段齐全；`reason <= 40`、`error.code <= 64`、`error.message <= 200` code points。

---

## 3. 一次运行的完整事件序列

设主会话当前 `session.seq = S`，本批选中 2 个目标（原 seq `a`、`b`，`a < b`），计划 `drop(a) + trim(b)`：

```
seq S     compaction/prune  { shadowedRange:{start:a,end:a}, shadowedSeqs:[a], shadowedTokenCount:TA,
                              contextSlimmer:{ v:1, batchId:B, role:'item', index:0, op:'drop', … } }
seq S+1   tool/result       { ...原 data, message:{...原 message, content:[stub]} }
                              surfaceOp:{ op:'replace', startSeq:a, endSeq:a }, sourceEventSeqs:[a]
seq S+2   compaction/prune  { shadowedRange:{start:b,end:b}, shadowedSeqs:[b], shadowedTokenCount:TB,
                              contextSlimmer:{ v:1, batchId:B, role:'summary', status:'applied', items:[…], totals:{…}, … } }
seq S+3   tool/result       { ...原 data, message:{…content:[trim文本]} }
                              surfaceOp:{ op:'replace', startSeq:b, endSeq:b }, sourceEventSeqs:[b]
```

要点：

- `shadowedTokenCount` 取 `ctx.tokenMeter.estimateMessage(原 message)`；服务缺失时退化为 `ceil(chars/4)`。
- 替换只改 `message.content`；`role`/`toolCallId`/`source`/`isError` 等保持，保证 tool call/result 配对被模型历史正确重建。
- 替换前的目标必须“当前 surface 上仍是 append 节点”；全量计划预检 + 逐条 append，任何一条失败即中止剩余项，已落地项保留（与原生 pruner 语义一致）。
- 已替换节点在 surface 上被替换事件取代；新事件带非 `append` 的 `surfaceOp`，因此候选筛选天然跳过，不会二次精简。

---

## 4. 状态与降级

| `status` | 何时出现 | 是否落盘 summary | 主会话影响 |
| :-- | :-- | :-- | :-- |
| `applied` | 计划合法且 ≥1 项落地 | 是（末条 prune） | 目标结果被替换 |
| `no-op` | 子 Agent 返回空计划/无计划 | 否 | 无 |
| `rejected` | `validatePlan` 拒绝整单（越界/重复/超长/缺前缀/伪造证据等） | 否 | 无 |
| `failed` | 超时、子 Agent 错误、启动失败、append 异常 | 否 | 已落地部分保留（原子性只在校验阶段） |

- 四种状态都**不向主 Agent 抛异常**，只写 debug/warn 日志（日志只含计数，不含工具原文）。
- 计数器窗口在四种结果后都重置，避免失败后每一步重试打爆主循环。
- **UI 扩展降级**：首次发现“带 `contextSlimmer` 的 prune append 抛错”时，进程内实例缓存 `extensionSupported = false`；本批剩余项与之后所有批次只写官方三字段，替换照常落地，仅无 UI 行。实现：`replace.applyPlan` 的 `batch.attachMeta/attachMeta=false` + `batch.degraded`。

---

## 5. UI 消费契约（client 半）

- `match`：`event.type === 'compaction/prune' && event.data.contextSlimmer?.role === 'summary'`；每批一行，`anchorSeq = 该 summary prune 的 seq`。
- 原生 pruner 的 prune 事件没有 `contextSlimmer`，**不会误渲染**（client smoke 有负例）。
- 行文案/展开明细只读 summary 字段；`role:'item'` 的 prune 不消费（只用于审计/未来）。
- 前向兼容：`readSlimMetaFromEvent` 对未知版本返回 `null`，client 侧等价地跳过；`status !== 'applied'` 的灰色分支保留但当前不会出现。

---

## 6. 幂等、重载与重启

- 候选筛选跳过：非 append 的 surface 节点（含本插件与原生 pruner 的替换事件）、`data.meta` 已带命名空间的节点、未配对结果、最近 `protectRecent` 个结果、短于 `minTargetChars` 的结果、`structured_output` 工具结果。
- 计数只在内存，插件重载后每 session 首次 `agent/pre-step` **只建立基线不触发**；历史结果不会被重新计数。
- 已落盘的 batch 元数据在 replay/seed 重建后仍可读（snapshot 保留扩展字段；`readSlimMetaFromEvent` 可恢复 summary）。

---

## 7. 兼容性与变更流程

1. 任何字段/语义变更 → 先改本文件 → 升 `META_VERSION`（不兼容时）→ 同步 `events.js` 校验器/读取器、`replace.js` 写入、client renderer fixture、测试。
2. 只增字段且旧客户端可忽略 → `v` 仍为 1，读取器忽略未知附加键（当前 normalize 严格白名单，新增需同时改读取器；client 侧按需读取）。
3. 不新增事件类型；不写 `plugin:*`；不改 `tool/result.data.meta`。
4. 如未来 DSH 对 `compaction/prune` 增加严格 schema，本协议自动走 §4 降级路径，主功能不变——届时按 `docs/research/dsh-api-map.md` 记录的官方通道重新评估 UI 行。
