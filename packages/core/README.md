# @ds-hu/dsh-context-slimmer-core

`dsh-context-slimmer` bundle 的**纯共享库**：批元数据协议、surface 替换原语、计划校验、提示词、计数器与配置 schema。它不是 Cordis 插件（不声明 `dsh.bundle`/`dsh.client`，面板不可开关），只被功能模块按 subpath 引用。

```js
import { SLIM_SYSTEM_PROMPT_ZH, buildSlimTaskMessage } from '@ds-hu/dsh-context-slimmer-core/prompt'
import { validatePlan, buildPlanJsonSchema } from '@ds-hu/dsh-context-slimmer-core/plan'
import { applyPlan, selectTargets, readSurfaceEntries } from '@ds-hu/dsh-context-slimmer-core/replace'
import { readSlimMetaFromEvent } from '@ds-hu/dsh-context-slimmer-core/events'
```

## 模块

| subpath | 内容 | 关键导出 |
| :-- | :-- | :-- |
| `./events` | 批元数据 schema/校验/读取器（`compaction/prune.data.contextSlimmer`） | `META_VERSION`、`buildItemMeta`、`buildSummaryMeta`、`readSlimMetaFromEvent`、`hasSlimMeta`、状态常量 |
| `./replace` | 目标筛选、prune→replace 替换、`applyPlan`（原子预检、末条 summary、降级） | `readSurfaceEntries`、`selectTargets`、`applyToolResultReplacement`、`applyPlan` |
| `./plan` | 计划严格校验（原子拒绝、DEV-2/3/4）、outputSchema 投影 | `validatePlan`、`buildPlanJsonSchema`、`MAX_TRIM_TOKENS`、`estimateTokens` |
| `./prompt` | tool description、中/英 system prompt（逐字来自 `docs/research/prompt-final.md`）、payload 渲染 | `SLIM_SYSTEM_PROMPT_ZH/EN`、`SLIM_PARAMETERS`、`renderPayload`、`buildSlimTaskMessage` |
| `./templates` | 替换模板（T1–T4）、`[elided by context-slimmer]` 占位 | `ELIDED_PREFIX`、`buildDropText`、`REPLACEMENT_TEMPLATES` |
| `./counters` | 每会话计数与阈值（OR 触发、error gate） | `noteToolResult`、`shouldTrigger`、`triggerSnapshot`、`CounterStore` |
| `./config` | schemastery `Config` + 交叉校验 + 模型覆盖 | `Config`、`resolveConfig`、`agentOptionsOverride`、`recordModel` |
| `./freeze` | `deepFreeze`/`freezeSnapshot` 小工具 | `deepFreeze`、`isPlainObject` |

## 设计约束

- **纯函数**：无 I/O、无网络、无 dsh 运行时 import；唯一依赖 `@deepseek-ai/schemastery@~3.19.0`（仅 `config.js`），跨副本 schema 对象可直接交给 Loader 校验/表单投影。
- **冻结输出**：所有协议/计划对象深冻结，避免下游意外改坏批次数据。
- **总读取器**：`readSlimMeta*` 对未知版本/非法结构返回 `null`，绝不在 replay/UI 边界抛错。
- **替换只改 `message.content`**：`applyPlan` 用纯 JSON 构造替换事件，由 `Session.append` 校验/冻结；`meta`/`error`/`turn`/`step` 原样复制。
- **原子性**：整单计划先预检（含“目标仍是当前节点”），再逐条 append；中途失败保留已落地项，但**不写 summary 元数据**。

协议细节见仓库根 `docs/protocol.md`；设计决策（DEV-1..8）见 `docs/dev-notes.md`。

## 测试

```bash
node --test packages/core/test/*.test.mjs
```

离线运行；不需要 dsh 进程、模型或网络。覆盖：协议校验/读取器总性、计划 300-token/50% 边界与伪造证据拒绝、prune→replace 顺序与 summary 元数据、扩展字段降级、计数器阈值、配置交叉校验、提示词快照（长度/锚点/分类顺序/禁用词/参数描述）。

## License

MIT © 2026 ds-hu
