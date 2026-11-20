# @ds-hu/dsh-context-slimmer-core

`dsh-context-slimmer` bundle 的**纯共享库**：批元数据协议、surface 替换原语、策略化计划校验、提示词、计数器与配置 schema。它不是 Cordis 插件（不声明 `dsh.bundle`/`dsh.client`，面板不可开关），只被功能模块按 subpath 引用。

```js
import { buildPlannerInstruction, selectSystemPrompt } from '@ds-hu/dsh-context-slimmer-core/prompt'
import { validatePlan, POLICIES, CONSERVATIVE_EVIDENCE_KINDS } from '@ds-hu/dsh-context-slimmer-core/plan'
import { applyPlan, selectTargets, readSurfaceEntries } from '@ds-hu/dsh-context-slimmer-core/replace'
import { readSlimMetaFromEvent } from '@ds-hu/dsh-context-slimmer-core/events'
import { Config, resolveConfig, resolveModelTarget, unwrapVolatileDeep } from '@ds-hu/dsh-context-slimmer-core/config'
```

## 模块

| subpath | 内容 | 关键导出 |
| :-- | :-- | :-- |
| `./events` | 批元数据 schema/校验/读取器（`compaction/prune.data.contextSlimmer`） | `META_VERSION`、`buildItemMeta`、`buildSummaryMeta`、`readSlimMetaFromEvent`、`hasSlimMeta`、状态常量 |
| `./replace` | 目标筛选（保护尾部/窗口/证据扫描）、prune→replace 替换、`applyPlan`（原子预检、末条 summary、降级） | `readSurfaceEntries`、`selectTargets`、`applyToolResultReplacement`、`applyPlan` |
| `./plan` | 策略化计划校验（conservative 证据重算、balanced/aggressive 分级、原子拒绝） | `validatePlan`、`POLICIES`、`EVIDENCE_KINDS`、`CONSERVATIVE_EVIDENCE_KINDS`、`EMPTY_OUTPUT_PATTERNS`、`trimCharLimit`、`buildPlanJsonSchema` |
| `./prompt` | policy×locale 的规划器 system prompt（v1.4）、payload 渲染 | `SYSTEM_PROMPTS`、`selectSystemPrompt`、`renderPayload`、`buildPlannerInstruction`、`STRUCTURED_OUTPUT_TOOL` |
| `./templates` | 替换模板（drop stub 指向保留副本）、`[elided by context-slimmer]` 占位 | `ELIDED_PREFIX`、`buildDropText`、`REPLACEMENT_TEMPLATES` |
| `./counters` | 每会话计数与 AND 阈值（error gate） | `noteToolResult`、`shouldTrigger`、`triggerSnapshot`、`CounterStore` |
| `./config` | schemastery `Config`（全部字段 `.volatile()`）+ 交叉校验 + 模型路由 | `Config`、`DEFAULT_CONFIG`、`resolveConfig`、`resolveModelTarget`、`unwrapVolatileDeep`、`recordModel`、`MODEL_KEYS` |
| `./freeze` | `deepFreeze`/`freezeSnapshot` 小工具 | `deepFreeze`、`isPlainObject` |

## 设计约束

- **纯函数**：无 I/O、无网络、无 dsh 运行时 import；唯一依赖 `@deepseek-ai/schemastery@~3.19.0`（仅 `config.js`），跨副本 schema 对象可直接交给 Loader 校验/表单投影。
- **volatile 配置**：所有面板字段带 `.volatile()`，Loader 校验后传给插件的值含 cosmokit 引用对象；`resolveConfig` 会先 `unwrapVolatileDeep` 再二次校验（否则会报 `$.enabled expected boolean but got [object Object]`），入参不被修改。
- **冻结输出**：所有协议/计划对象深冻结，避免下游意外改坏批次数据。
- **总读取器**：`readSlimMeta*` 对未知版本/非法结构返回 `null`，绝不在 replay/UI 边界抛错。
- **替换只改 `message.content`**：`applyPlan` 用纯 JSON 构造替换事件，由 `Session.append` 校验/冻结；`meta`/`error`/`turn`/`step` 原样复制。
- **保守默认**：`conservative` 只接受带可校验证据的整条 drop（duplicate/superseded/empty），`trim` 整单拒绝；`balanced`/`aggressive` 为显式 opt-in。
- **原子性**：整单计划先预检（含“目标仍是当前节点”），再逐条 append；中途失败保留已落地项，但**不写 summary 元数据**。

协议细节见仓库根 `docs/protocol.md`；架构见 `docs/architecture.md`；设计决策（DEV-1..14）见 `docs/dev-notes.md`。

## 测试

```bash
node --test packages/core/test/*.test.mjs
```

离线运行；不需要 dsh 进程、模型或网络。覆盖：协议校验/读取器总性、策略与证据边界（duplicate 逐字相等、superseded 失败→成功、empty 模式、trim 拒绝）、prune→replace 顺序与 summary 元数据、扩展字段降级、AND 阈值、volatile 引用深度解包与配置交叉校验、prompt 快照（policy×locale 长度/锚点/禁用词）。

## License

MIT © 2026 ds-hu
