# 仓库上下文与未来模块清单（CONTEXT）

本文件面向**后续在本仓库贡献模块的人（或 Agent）**：说明仓库如何组织、一个模块必须满足什么契约、怎么离线验证、以及新增模块的逐步清单。开始改动前先读：`docs/architecture.md`（产品契约）、`docs/dev-notes.md`（已拍板的偏差 DEV-1..8）、`docs/protocol.md`（批元数据/替换协议）、`docs/ci.md`（CI 门禁）。

---

## 1. 仓库结构

```
dsh-context-slimmer/
├─ package.json              # 根 bundle 包：workspaces + dsh.bundle.patch；不是一个运行时插件
├─ cordis.patch.yml          # bundle patch：每个功能模块一个 insert 行（id/name 成对）
├─ locale/{zh,en}.json       # bundle 级面板标题/描述
├─ icon.svg                  # bundle 图标
├─ packages/
│  ├─ core/                  # @ds-hu/dsh-context-slimmer-core：纯库，不是 Loader row
│  │  ├─ package.json        # 只有 @deepseek-ai/schemastery 一个依赖
│  │  ├─ lib/{events,replace,plan,templates,prompt,counters,config,freeze,index}.js
│  │  └─ test/*.test.mjs     # node:test，离线
│  └─ tool-result-slimmer/   # @ds-hu/dsh-context-slimmer-tool-result：模块 I
│     ├─ package.json        # exports + dsh.client + engines；依赖 core 精确 0.1.0
│     ├─ lib/index.js        # host 半（Cordis row）
│     ├─ lib/client.js       # client 半（浏览器 __ModuleLoader__）
│     ├─ locale/{zh,en}.json # 模块面板标题/描述
│     └─ test/*.test.mjs     # host 单测 + client smoke
├─ docs/                     # architecture / protocol / dev-notes / context / ui-notes / ci
└─ scripts/ci/               # 离线 CI 脚本（README/资源/JSON/YAML/打包校验）
```

约定：

- **core 是库不是功能**：不声明 `dsh.bundle`/`dsh.client`，面板不可开关；模块只通过其 subpath exports 使用。
- **一个模块 = 一个 npm 包 = 一个 Loader row**：用户可见的开关/配置粒度是 row；模块可独立启用/卸载。
- **根 bundle 只做补丁**：不导出运行时插件代码；安装时 `dsh.bundle.patch` 把模块行插进 profile。
- 版本：所有包 `0.1.0` 同步；模块对 core 使用**精确版本** `"0.1.0"`；engines `node >= 24.9.0`、`dsh >= 0.2.0 < 0.3.0`。无构建步骤（纯 ESM JS 直接发布）。

---

## 2. 模块契约（host 半）

`packages/<module>/lib/index.js` 必须导出：

| 导出 | 要求 |
| :-- | :-- |
| `name` | 等于 `cordis.patch.yml` 行的 `id`，也等于模块 `package.json` 名称的短横线形式（例：`context-slimmer-tool-result`） |
| `inject` | 必需的 cordis 服务名数组（例：`['tools','subagents']`）；可选服务用 `ctx.get(name)` 惰性取，不要写进 inject |
| `Config` | schemastery schema；面板据此渲染表单。每个字段 `.description()` + 默认值 |
| `apply(ctx, config)` | 校验配置 → 挂 host。配置非法时抛错（面板显示红行），不要静默用默认值 |

实现要求：

- 只依赖 node builtins + `@ds-hu/dsh-context-slimmer-core`；**不 import 任何 `@deepseek-ai/*` 包**（`schemastery` 仅 core 允许，见 DEV-8）。会话读写走借用对象的方法（`session.append` / `session.surface` / `session.eventAt` / `session.deriveEventMessage`），由 `Session.append` 校验并冻结。
- 所有监听器在 `agent/pre-step` 里**先 `await next()`**，拿到决定后再做事；`decision.kind === 'reject'` 时不动；**任何异常都不得抛进主循环**（catch + warn + 退化 no-op）。
- 有后台子 Agent 的模块：`ctx.subagents.startActivation({ provider:'fork', delivery:'caller', childId, signal, request:{ prompt, parent, outputSchema? , agentOptions? } })`；`signal` 用 `AbortSignal.any([payload.signal, AbortSignal.timeout(timeoutMs)])`；`await result` 后 `finally dispose()`。
- 子 Agent 的工具限制：在 `agent/created`（await serial）里对保留的 `childId` 执行 `agent.ctx.tools.restrict({ deny: <插件初始化时 ctx.tools.definitions() 的全局工具名> })`；再在 root `tools/pre-execute` 加 `exec.agent?.id === childId && name !== 'structured_output'` 的 deny 兜底。不要注册自定义模型工具（DEV-7）。
- 日志只允许长度/计数/工具名/状态；**绝不打印工具结果原文、用户内容、路径下的私密数据**。
- 时间/超时/模型等可配字段全部走 `Config` + `core/config.js` 的 `resolveConfig` 交叉校验。

## 3. 模块契约（client 半，有 UI 时）

- `package.json` 的 `exports["./client"] = "./lib/client.js"`；`dsh.client = { platform:'web', inject:[...] }`（**不含** `external`/`immediately`）。
- `lib/client.js` 只做一件事：`window.__ModuleLoader__.load({ id: '<包名>', factory })`；所有浏览器副作用在 `apply(ctx)` 内通过 `ctx.effect`/`ctx.slots.inject` 持有，可随插件卸载。
- UI 数据只能来自宿主写入的**已持久化**通道（当前：`compaction/prune.data.contextSlimmer`，见 `docs/protocol.md`）；不要读宿主内存状态，不要新增事件类型。
- 新 UI 行：一个 `ConversationNodeDefinition`（match 唯一、可 replay）+ 一个 keyed Chat renderer；locale 走模块 `locale/*.json`；样式随 fiber 挂载/卸载。
- client 测试：`test/client-smoke.test.mjs` 用最小 `window.__ModuleLoader__`/ctx 假件验证 match/render 结构与 fixture，不启浏览器。

---

## 4. 新增模块逐步清单（copy this）

1. **先写文档**：在 `docs/architecture.md` 增加模块小节（触发、数据流、配置、隐私、失败语义、UI 行），在 `docs/protocol.md` 登记新增事件/元数据字段；如偏离架构，在 `docs/dev-notes.md` 加 DEV-n 并注明证据。
2. **core 优先**：把可纯函数化的逻辑放 `packages/core/lib/<topic>.js`（无 dsh import、无 I/O、冻结输出），同步 `core/package.json` 的 subpath export、`core/lib/index.js` 只导公共常量、补 `test/<topic>.test.mjs`。
3. **建模块包**：`packages/<module>/`，`package.json` 字段照 `tool-result-slimmer`：
   `main:"lib/index.js"`、`exports{".":"./lib/index.js","./client":"./lib/client.js","./locale/*.json":"./locale/*.json","./icon":"./icon.svg","./package.json":"./package.json"}`（有 UI 时）、`dsh.client`、`dependencies:{"@ds-hu/dsh-context-slimmer-core":"0.1.0"}`、`peerDependencies:{"@deepseek-ai/cordis":"^4.0.2"}`、engines、`files:["lib","locale/*.json","icon.svg","README.md","LICENSE"]`、`"test":"node --test test/*.test.mjs"`。
4. **host 骨架**：`name`/`inject`/`Config`/`apply`；`SlimmerHost` 式类封装状态，`install()` 里 `ctx.on` + `ctx.effect(() => () => this.dispose())`；配置非法直接抛。
5. **注册 row**：在 `cordis.patch.yml` 加**一个** insert 行（`- id: <name>` + `name: '@ds-hu/dsh-context-slimmer-<module>'`），保持成对、注释说明功能；`packages/` glob 自动纳入 workspace。
6. **locale/icon**：模块 `locale/{zh,en}.json` 写 `meta.title`/`meta.description`（面板用）；`icon.svg` 放模块包根。
7. **测试**：
   - core 纯函数：边界/拒绝/冻结；协议读写器要测“总函数不抛、未知版本返回 null”。
   - host：假 `ctx` + 假 `session`（可复用 `packages/core/test/helpers/fake-session.mjs`）覆盖触发、prune→replace 顺序、批次元数据、失败回滚、幂等/重载基线、降级路径。
   - 禁止网络/模型/真实 dsh 进程；`node --test` 必须离线可跑。
8. **门禁**：`node --check` 所有新增 JS；`npm run test:core`、`npm run test:module`；`node -e "JSON.parse(...)"` 校验 JSON；YAML（若有）用 CI 脚本解析；`npm run test:pack` 确认发布清单。
9. **文档收尾**：模块 `README.md`（安装/配置表/隐私与安全/工作原理/限制）；根 `README` 的模块列表；`docs/CONTEXT.md` 结构树；报告偏差与已知风险。
10. **评审 checklist**：
    - [ ] 没有 `@deepseek-ai/*` import（除 core 的 schemastery）
    - [ ] 没有向主循环抛异常；所有策略失败都退化 no-op + 有界日志
    - [ ] 没有把工具原文/用户数据写进日志或元数据
    - [ ] 替换只改 `message.content`；prune→replace 成对；末条 summary 才带完整批次
    - [ ] 配置每个字段有默认值+description；非法组合在 `resolveConfig` 拒绝
    - [ ] 面板可独立开关；关掉后不残留监听器/定时器/工具注册
    - [ ] engines/deps 版本符合约定；无构建步骤；`npm pack --dry-run` 清单完整
    - [ ] 测试离线全绿；文档（protocol/dev-notes/README）与实现一致

---

## 5. 本地离线开发（无安装权限时）

本机验证不需要安装依赖，可在仓库根建两个**不提交**的软链（已写进 `.gitignore` 的 `node_modules/`）：

```bash
mkdir -p node_modules/@ds-hu
ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai
ln -sfn ../../packages/core node_modules/@ds-hu/dsh-context-slimmer-core
ln -sfn ../../packages/tool-result-slimmer node_modules/@ds-hu/dsh-context-slimmer-tool-result
```

这样 `@ds-hu/dsh-context-slimmer-core/...` 与 `@deepseek-ai/schemastery` 可解析，`node --test` 离线可跑。**CI 不需要这些软链**：npm workspaces 从 registry 安装 `@deepseek-ai/schemastery@~3.19.0`（`cordis` 只作 peer，由 dsh profile 提供）。

---

## 6. 已知坑（血泪版）

- `tool/result.data.meta` 在 surface replacement 上**不可改**：`assertToolResultRewrite` 只豁免 `message.content`；改 meta 会抛 `tool/result surface replacement may change only content`。UI 数据走 `compaction/prune` 扩展字段（`docs/protocol.md` §1）。
- `Session.seq` 是**下一个** append 的 seq（不是最后一条）。summary 里末项 `replacementSeq` 的确定性预测依赖这一点。
- `session.append` 返回的是提交后的 event（含 `seq`）；批内不要依赖异步顺序，宿主在 `agent/pre-step` 内串行 append。
- 候选筛选必须跳过非 `append` 的 surface 节点（替换事件），否则会二次精简/死循环。
- `protectRecent` 保护的是“最近 N 条结果”；它同时是“当前 step 安全阀”，删掉会精简掉 Agent 正在用的结果。
- `agent/pre-step` 的 `next()` 不调用会破坏整条 waterfall；调用后必须原样返回 decision。
- 子 Agent 的 system prompt 不可替换（fork 继承父 preset）；精简 prompt 作为 task user message 的显式前言（DEV-5）。
- 外部插件不要用 `appendPluginRecord`（experimental 保留）；不要新增未知事件类型（client 兼容风险）。
- 元数据只放派生字段，禁止工具原文；日志同样。
