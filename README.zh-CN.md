# Context Slimmer · 上下文精简器

一个原生 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 插件包：在不改写用户可见对话记录的前提下，让 Agent 的上下文保持精简。

插件由多个**完全独立**的功能模块组成——每个模块是独立的 npm 包、独立的 Loader row，因此原生插件面板可以单独开关、单独配置每个模块，一个模块的开关不影响其他模块。

第一个模块是 **工具结果精简**：每累计 N 次工具调用（或新增输出达到字符阈值）时，后台 fork 子 Agent 会带着**已完成的完整上下文**判断哪些过期工具结果还值得占 token。主 Agent 的下一次请求只看到精简后的结果；对话记录中的原始工具卡片保持不变；并像原生“上下文已压缩”一样，在对话流追加一行“已精简工具调用结果”。

```
精简前                              精简后
┌──────────────────────────┐        ┌──────────────────────────┐
│ 读取文件  12.4k 字符      │        │ 读取文件  [elided …]      │  ← 模型可见（替换事件）
│ 搜索      8.1k 字符       │  ───►  │ 搜索      [elided …]      │
│ 测试      失败堆栈 …      │        │ 测试      失败堆栈 …      │  ← 精确证据保留
└──────────────────────────┘        └──────────────────────────┘
   对话记录不变                        + “已精简工具调用结果 · 2 项 · 20,500 字符”
```

## 为什么这样设计

2026 年关于 Agent 上下文的实证研究结论很明确：大部分 token 花在工具输出上；**与当前任务竞争的同格式干扰**比“长但中性的上下文”危害大得多。但粗暴压缩同样危险——它可能删掉约束和失败证据，还会改写用户已经看到的历史。因此本插件把问题拆成三层：

1. **用完整上下文判断，而不是给一段摘要。** fork 子 Agent 继承父会话已完成的 turn 历史，因此“这条结果现在还有用吗”由一个真正看过任务的模型来回答。
2. **绝不改写用户可见历史。** 替换是 model-only surface 事件（`surfaceOp: replace`），与官方工具结果 pruner 完全一致；append-origin 事件保留原始卡片，fork/resume 回放安全。
3. **宁可保留，不可误删。** 成功且相关的结果逐字不动；失败保留精确证据；只有明确无关/可复原/重复的内容才删除；模糊情况一律保留。

文献综述、DSH 协议勘察与精简策略见 [`docs/`](docs/)。

## 模块

| 模块 | 包名 | Row id | 状态 |
|---|---|---|---|
| 工具结果精简 | `@ds-hu/dsh-context-slimmer-tool-result` | `context-slimmer-tool-result` | `0.1.x` 已发布 |
| 未来模块 | 独立 `packages/*` | 独立 row | 规划中——每个模块保持独立开关 |

共享纯库 `@ds-hu/dsh-context-slimmer-core` **故意不是** Loader row：插件面板无法开关它，模块也无法误卸载它。

## 安装

```bash
dsh plugin --profile <profile> add @ds-hu/dsh-context-slimmer
```

bundle patch 会为每个模块插入一行；每一行从 profile 解析自己的包。重启 profile（或等待 patch 热重载）后打开 **插件** 面板：bundle 与模块行会带原生开关与自动生成的配置表单出现。

**不要**把这些 row 复制进你自己的 `cordis.patch.yml`：重复的 `id` 会让 profile 启动失败（`entry <id> already exists`）。请在面板里配置该 row。

## 配置（工具结果精简）

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 模块总开关。 |
| `everyNToolCalls` | `8` | 每新增 N 条已结算工具结果触发一次（0 关闭）。 |
| `minChars` | `24000` | 新增结果字符数达到阈值也触发（0 关闭）。 |
| `protectRecent` | `2` | 最近 K 条结果永不处理。 |
| `maxTargets` | `12` | 单次最多评审的候选数（1–64）。 |
| `triggerOnErrorOnly` | `false` | 仅在批次含失败时触发。 |
| `minTargetChars` | `256` | 小于此字符数的结果不作为候选。 |
| `timeoutMs` | `120000` | 后台规划超时；超时按无操作处理。 |
| `model.provider` / `model.model` | `inherit` | `inherit` 跟随主 Agent 当前路由。 |
| `model.reasoningEffort` | `null` | 规划器推理强度覆盖（可选）。 |
| `model.maxOutputTokens` | `2048` | 规划器输出上限。 |

## 工作原理（简述）

1. `agent/pre-step`（上一批工具已结算、下一次请求尚未组装）按 session 统计新增工具结果。
2. 超过阈值时启动 managed **fork** 子 Agent：seed = 父会话已完成 turn 历史，并使用原生
   `outputSchema` 结构化输出；seed 保持父前缀字节一致（对 KV 缓存友好、append-only）。
3. 通过 `agent.ctx.tools.restrict()` + `tools/pre-execute` 守卫隐藏其全部原生工具，使它只能返回结构化计划。
4. 计划由纯函数原子校验；每条被接受的结果依次 append `compaction/prune` + surface 替换
   `tool/result`。批次摘要挂在 prune 事件的新增 `contextSlimmer` 字段上，驱动对话中的新行。
5. 任何失败——模型、超时、计划非法、append 报错——对主 Agent 都是无操作。

完整协议、安全规则与兼容性降级见 [`docs/protocol.md`](docs/protocol.md) 与
[`docs/dev-notes.md`](docs/dev-notes.md)。

## 兼容性与如实说明的局限

- 需要 DSH `>=0.2.0 <0.3.0`、Node.js `>=24.9.0`。
- 对话中的新行使用官方 log-only `compaction/prune` 事件上的**新增 JSON 字段**。宿主半会检测
  未来更严格的校验并降级为官方三字段事件：替换照常生效，只是该行消失。
- 后台子 Agent 通过 managed fork 路径创建，因此父 Agent 的工具 **schema** 对它可见；但其
  每次执行都会被 scoped restrict + pre-execute 守卫拒绝，唯一可用的工具是原生 `structured_output`。
- 插件不记录 API key、工具结果原文或用户内容；持久化的批次摘要只含索引、字符数、模型标识与
  模型写的一行原因。
- client 半不发起网络请求，除事件 payload 外不读取 session 内容。

## 界面（CI 中真实运行截图）

三张图均来自 GitHub Actions 里真实启动的 DeepSeek Harness（真实模型会话 + `dsh web`），不是手搓示意图：

对话流中的原生风格行（`已精简工具调用结果 · 1 项 · 释放 24,181 字符`）：

![chat row](docs/screenshots/chat-row-zh.png)

展开后可看到本次精简明细（item / trigger / model）：

![detail](docs/screenshots/chat-detail-zh.png)

轨迹视图里模型侧看到的就是被替换后的结果（`[elided by context-slimmer]`）：

![trajectory](docs/screenshots/trajectory-zh.png)

原生插件面板中的模块（可独立开关/配置）：

![plugins](docs/screenshots/plugins-panel-zh.png)

## 开发

```bash
npm install          # workspaces：bundle + core + module
npm test             # 离线单测（不启动 dsh、不调 API）
npm run test:core
node --test packages/tool-result-slimmer/test/*.test.mjs
```

真实端到端验证（真实模型的无头会话 + Web UI 截图）在 GitHub Actions 中运行，见
[`.github/workflows/verify.yml`](.github/workflows/verify.yml) 与 [`docs/ci.md`](docs/ci.md)。

## 许可

MIT © ds-hu
