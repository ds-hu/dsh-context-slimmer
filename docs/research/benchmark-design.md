# Benchmark 设计 — conservative 默认策略的质量非劣证明（v0.2.0 / issue #2）

- **文档**：`docs/research/benchmark-design.md`
- **版本**：v1.1（2026-11-20）
- **v1.1 变更**：新增必测退化类型「规划器截断/超预算」（真实生产回归）；固定 5 校验点组成（≥2 唯一大 read / 1 失败精确错误 / ≥2 重复或高重复日志）；补随机性下限与单次运行降级规则。
- **配套**：`docs/plan-v0.2.md` §5（绑定要求）、`docs/research/slimming-policy.md` §10（conservative 证据依据）、`docs/research/context-irrelevance-2026.md` §14（引用）。
- **目标**：证明 `baseline`（插件 disabled）与 `conservative`（默认策略）都 **5/5** 通过事实校验点、conservative 的模型可见工具文本更少，且 `aggressive` 出现**可观测的质量退化**；同时把模型随机性/场景歧义与策略退化分开。
- **引用编号**：`[Rn]` 对应报告 §14；文献未直接测本插件，标注 **[推断]** 的句子是外推。

---

## 1. 门禁总览

| 门禁 | 条件 | 性质 |
| :-- | :-- | :-- |
| **G0 有效运行** | setup 调用齐全、答案 JSON 可解析、conservative 触发并留下 plugin record | 无效 run 重跑（不计入统计） |
| **G1 质量非劣** | `baseline` 与 `conservative` 在**每次有效 run** 都 **5/5** 通过（字段级精确匹配） | 硬门禁 |
| **G2 实际省 token** | 每次 run：conservative 折叠后工具文本字符数 `<` baseline；中位降幅 ≥10%；最终上下文估算 token 中位降幅 ≥5% | 硬门禁 |
| **G3 证据与合法性** | conservative：failure 证据保留率 100%；所有 drop 均有 `duplicateOf`/`replaces` 指向**保留集合内**的目标；无 trim | 硬门禁 |
| **G4 隐藏成本** | conservative 工具调用数 ≤ baseline +10%，setup 后的重复 read 次数 ≤ baseline，墙钟时间 ≤ baseline ×1.2 | 硬门禁 |
| **G5 对照退化** | `aggressive` 中位校验点 <5，且至少 1 个校验点在 ≥半数 run 中缺失 | **观测项，不设发布门禁**（plan §5：允许失败/丢信息） |
| **G6 场景自检** | baseline 在重复 run 中校验点集合一致；否则场景歧义，先修场景再谈策略 | 前置硬门禁 |
| **G7 规划器稳健性** | conservative 每次有效 run：`finishReason ∈ {length,max_tokens}` 的截断次数 **=0**，**且**至少发生 1 次成功精简（applied drop ≥1）；否则不通过。**不对 aggressive 断言不截断**（只记录） | 硬门禁（仅 conservative） |

> baseline 无规划器调用（插件 disabled），G7 不适用；aggressive 的截断/失败整批只作报告项。

> `aggressive` 若也 5/5：先怀疑**校验点太浅/可猜**（见 §3 选取规则），修订场景而不是宣称"aggressive 也安全"。

---

## 2. 场景与 fixture（确定性、本地、无网络）

### 2.1 Fixture（提交进仓库，内容固定；时间戳/临时路径一律去掉）

| 文件/命令 | 大小 | 内容要点 | 用途 |
| :-- | :-- | :-- | :-- |
| `bench/fixture/unique.txt` | ~12,000 chars（300 行） | C1 在 ~58% 深度（第 173 行）：`ORBITAL_CODE=7F3A-Q9`；C2 在 ~80% 深度：`SERVICE_PORT_MAP: atlas=7042, beacon=7043` | 唯一大文件 read；conservative 必须**一个字不动**；aggressive trim 会丢中部 |
| `bench/fixture/duplicate.txt` | ~9,500 chars | C4 在 ~70% 深度（第 210 行）：`MAINTENANCE_TOKEN=ZR-88` | 被**逐字读两遍**；conservative 可 drop 旧副本（新副本保留） |
| `node bench/fixture/verify.mjs` | 小型 stderr | 确定性失败：`exit 42`、首行 `ERR_BENCH_42: checksum mismatch`、detail 含 `fixture/unique.txt:173` | 失败证据；C3 = `ERR_BENCH_42` + `exit 42` |
| `node bench/fixture/log.mjs` | ~8,000 chars，40 块 | 38 块相同 `heartbeat ok`；C5 在 ~65% 深度（单个唯一行）：`BACKUP_SLOT=blue-17` | 单条**输出内部**高重复日志；C5 只出现在中部唯一行 |

### 2.2 调用序列（scenario prompt 要求按序执行；harness 校验）

1. `read bench/fixture/unique.txt`（唯一大读，C1/C2）
2. `read bench/fixture/duplicate.txt`（第一次，后面会被 drop）
3. `node bench/fixture/verify.mjs`（预期失败，C3）
4. `node bench/fixture/log.mjs`（C5）
5. `read bench/fixture/duplicate.txt`（第二次，逐字相同；**保留**这份）
6. 至少 7 条小型核对调用（如 `wc -l`、`ls`、`git status` 等），把 setup 输出"变老"，使 `protectRecent` 不保护它们并满足触发阈值。

**触发校验（必须显式断言）**：默认 `everyNToolCalls=12` 且新增字符 ≥`minChars=24000`；setup 累计约 40k 字符、总调用 ≥12 次 → 应触发 1 次。conservative 运行必须存在 ≥1 条 `status='applied'` 的 plugin record，且其中 ≥1 条 `op='drop'`、`evidence.kind='duplicate'`。**若 conservative 零替换 → 判定为阈值/实现缺陷（见 §7 D1），token 对比无效，不是"策略安全"。**

**有效 run 判定**：上述 5 条 setup 调用（按工具名+规范化参数匹配）全部出现、至少 7 条额外调用、最终答案为可解析 JSON。否则无效，重跑（最多 2 次），无效 run 不计入统计并记录原因。

---

## 3. 5 个事实校验点怎么选

### 3.1 选取规则（缺一不可）

1. **唯一字面量**：期望值只出现在目标 fixture 中，不能从文件名/其它输出/常识推断；随机串（如 `7F3A-Q9`、`ZR-88`、`blue-17`）避免"猜对"。
2. **精确可判**：答案格式固定为 JSON 字段，grader 做**字段级精确匹配**（大小写/空白归一化），不做语义评分；避免"模型措辞不同"被判错/判对。
3. **靶向策略差异**：每个点放在某策略会改动/不改动的区域——C1/C2 在唯一大文件**中部**（aggressive trim 头+尾时必丢；conservative 禁 trim 必留）；C3 在失败输出；C4 在重复文件**保留副本**中部；C5 在日志**中部唯一行**（整条日志在 conservative 不可 drop/trim；aggressive trim 会丢）。
4. **保守可证**：C4 这类来自"重复内容"的点，**必须同时存在于被删旧副本与被保留新副本**（逐字相同）；conservative 删旧副本不影响答案。C1/C2/C3/C5 所在整条结果在 conservative 下不满足任何可 drop 条件（非重复/非被覆盖/非空）。
5. **互不泄露**：5 个答案不能由同一个事实推出，也不能出现在 setup 提示词/文件名/错误信息里（C3 的错误码只出现在失败 stderr，不出现在 prompt）。
6. **组成硬约束（本任务强制）**：5 个点必须满足 **≥2 个来自"唯一大 read"、1 个来自失败命令的精确错误文本、≥2 个来自重复内容/高重复日志**（本设计为 C1/C2、C3、C4/C5）。这样 aggressive 若 trim 唯一 read 会可观测退化，而 conservative 保持 5/5。

### 3.2 建议的 5 个点（组成：2×唯一大 read + 1×失败精确错误 + 2×重复/高重复日志）

| ID | 期望答案（JSON 字段） | 来源 | baseline | conservative | aggressive（预期） |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **C1** | `unique_code: "7F3A-Q9"` | `unique.txt` 第 173 行（中部） | ✅ | ✅（唯一大读禁 trim） | ❌ 高概率丢失（trim 头+尾） |
| **C2** | `atlas_port: 7042` | `unique.txt` ~80% 深度 | ✅ | ✅ | ❌ 高概率丢失 |
| **C3** | `failure: "ERR_BENCH_42 / exit 42"` | `verify.mjs` stderr | ✅ | ✅（失败不删/不 trim） | 大概率保留（v0.1 规则仍保命令/退出码/首错误行） |
| **C4** | `maint_token: "ZR-88"` | `duplicate.txt` 保留副本（第 210 行） | ✅ | ✅（旧副本被 drop，事实仍在保留副本） | 可能 ❌（若 trim 保留副本中部；或误删保留副本） |
| **C5** | `backup_slot: "blue-17"` | `log.mjs` 第 ~65% 行 | ✅ | ✅（日志整条不可 drop/trim） | ❌ 高概率丢失（trim 头+尾+计数） |

**答案格式（scenario 明确要求）**：

```json
{"unique_code":"7F3A-Q9","atlas_port":7042,"failure":"ERR_BENCH_42/exit 42","maint_token":"ZR-88","backup_slot":"blue-17"}
```

grader：解析 JSON；每个字段做字面匹配（`failure` 接受 `ERR_BENCH_42` 与 `exit 42` 以 `/\s*\/\s*/` 或同字段两 token 匹配，规则写死）。任何字段缺失/错值 = 该点 fail。

### 3.3 为什么 baseline 与 conservative 能保证 5/5（构造性论证）

- **baseline**：无任何替换，5 点全部在原始上下文 → 5/5（除非模型本身不会做，见 G6）。
- **conservative**：只 drop 三类整条结果；本场景中唯一满足的是 duplicate（第 2 次 read 与第 1 次逐字相同 → 删第 1 次、留第 2 次）。C4 在保留副本中；C1/C2/C5 所在结果没有任何可 drop 依据；C3 是失败证据。因此**只要实现正确，5/5 是构造保证**；若 conservative 失败 → 实现/提示词 bug（不是策略风险）。
- **规划器截断不改变事实校验**：规划器截断/整批失败 = 本轮无替换，conservative 退化为 baseline 级行为 → 5/5 仍成立；截断问题单独由 G7 判定（见 §4.1），不计入 C1–C5 失败。
- **[推断]** 这也是 benchmark 的核心：conservative 的"不降质量"来自"只删有副本的整条结果"这一结构，而不是模型判断力；因此可在小样本下用构造性论证 + 实测双重确认。

### 3.4 为什么 aggressive 应有可观测退化

- C1/C2 位于 12k 字符文件的第 58%/80%：v0.1 aggressive 的 trim 目标是"头+尾+错误段+计数"，≤min(50%, 300 tokens/1200 chars)，中部事实必然落在裁剪区。
- C5 位于 8k 日志第 65%：同理。
- C4 取决于 aggressive 是否 trim 保留副本；即使保留，C1/C2/C5 仍足以构成退化。
- C3 按 v0.1 失败证据规则大概率保留——**不要把 C3 计入退化预期**；若某次 aggressive 也 5/5，记录为"本轮未退化"，不要修改场景去追打，只有连续 R 次 5/5 才修订校验点（G5）。

---

## 4. 指标矩阵（除 token 还记录什么）

| 指标 | 定义/计算 | 用途/门禁 |
| :-- | :-- | :-- |
| `answer_checkpoints` | C1–C5 逐点布尔 + 总分 0–5 | G1 |
| `answer_correctness` | 5 字段全部匹配（=5/5）；记录原始答案 JSON | G1 |
| `repeated_read_count` | 同一工具+规范化参数的调用中，后出现者计数；分 `total` 与 `post_setup`（排除场景脚本要求的第 2 次 duplicate read） | G4；[R8] 的隐藏重读成本 |
| `folded_tool_chars` | 最终 surface 上所有 `tool/result` 的 text 字符数之和（模型可见的折叠后工具文本） | G2 硬门禁 |
| `final_context_tokens` | `ctx.tokenMeter` 对最终请求的估算 token（与 dsh 同口径） | G2 辅助（中位降幅 ≥5%） |
| `failure_evidence_retention` | 所有 `isError` 结果替换后仍含：命令原文、退出码、首个错误行；C3 字段通过 | G3 |
| `billed_tokens` | provider usage：input/output/cache hit/miss | 成本与缓存分析 |
| `plugin_records` | 每条记录 `status/op/kind/index/charsBefore/charsAfter` | G3 合法性、触发校验 |
| `drop_legality` | 每条 drop 的 `duplicateOf`/`replaces` 指向的 callId 在保留 surface 中且内容逐字相同/更新轮次成立 | G3 |
| `tool_calls_total` / `model_steps` / `wall_ms` | 会话统计 | G4 |
| `refetch_after_drop` | drop 后是否再次出现与被删目标相同工具+参数的调用 | G4（应为 0；否则 stub 语义有问题） |
| `cache_hit_rate` / `cost_cny` | 按 [R35] 价格与 cache 字段计算 | 报告项（保守策略不应显著恶化缓存） |
| `invalid_run_reason` | setup 缺失/答案不可解析/零替换等 | 统计清洗 |
| `planner_calls` | 每个 run 的规划器 LLM 调用次数（正常 1 次；重试另计） | G7 基础 |
| `planner_prompt_tokens` / `planner_completion_tokens` | 每次规划器调用 provider usage 的 prompt/completion tokens（无 usage 时用 tokenMeter 估算并标 `est`） | G7、成本 |
| `planner_duration_ms` | 规划器调用墙钟时长（p50/p90） | G7 观测 |
| `finish_reason_hist` | 规划器调用 `finishReason` 直方图（`stop/tool_calls/length/max_tokens/error`） | G7 |
| `truncated_batches` | `finishReason∈{length,max_tokens}` 或 JSON 不完整导致整批失败的次数 | G7 硬门禁（conservative=0） |
| `failed_batches` | 规划器未产出 applied 计划的批次数 + 原因分类（truncated/parse/timeout/validation/no-model） | 诊断项；截断类直接触发 G7 失败 |
| `applied_batches` / `dropped_chars` | 成功精简批次数与 drop 字符数 | G7（≥1 次精简）、G2 |

> 必记（plan §5）：答案校验点、重复 read 次数、总 token、折叠后工具文本字符数、prune/replace 数量；本设计在此基础上补 final_context_tokens、failure_evidence_retention、refetch_after_drop、cache/cost、触发合法性。

### 4.1 规划器截断/超预算（v0.1.0 生产回归，必测）

**回归背景**：v0.1.0 的规划子 Agent 在长会话中思考过长、触达输出 token 上限，**整批计划失败**（生产统计：约 20 次里大多失败，不是偶发抖动）。v0.2.0 改为直调 LLM + `reasoningEffort: off` + planner `maxOutputTokens: 4096` + 极简 JSON prompt；benchmark 必须证明该失败模式消失，且 conservative 在"至少发生一次精简"的前提下仍 5/5。

**判定规则（G7）**：

1. conservative 的 `truncated_batches` 在**每次有效 run 都必须为 0**；出现 1 次即不通过（不论答案是否碰巧 5/5）。
2. conservative 必须在 run 中**至少发生 1 次成功精简**（`applied_batches ≥ 1` 且实际 drop ≥1；与 G0 触发校验一致）；否则视为"截断规避了工作"或阈值 no-op，不通过。
3. `planner_completion_tokens` 应显著低于 `maxOutputTokens=4096`；**[推断]** 建议观测 p90 ≤ 60%（>80% 视为接近触顶，需调 prompt/预算或拆分计划）——该比例是运维经验阈值，可按实测分布调整；仅作诊断告警，不单独否决。
4. **不对 aggressive 断言不截断**：aggressive 允许更大计划/trim 输出，截断与整批失败只记录、报告，不构成门禁。
5. 若 `finishReason`/usage 在该 dsh 版本不可见：benchmark 按 **fail-closed** 处理（conservative G7 不通过），报告标注"无法观测规划器截断"；不得用答案 5/5 代替该门禁。

---

## 5. 避免把随机性误判为策略退化

### 5.1 固定项（每次 run 相同）

- 模型/供应商/版本固定并记录；**主 Agent**：`temperature=0`、`top_p=1`、`reasoningEffort=off`、`maxOutputTokens=2048`、`maxSteps` 固定（建议 40）、超时固定 120s。
- **规划器调用**：`reasoningEffort=off`、`maxOutputTokens=4096`、极简 JSON prompt、超时固定（建议 60s）；每次调用记录 `prompt/completion tokens` 与 `finishReason`（见 §4.1）。
- 同一 fixture commit、同一工作目录布局（固定临时路径模板，去掉随机目录名）、无网络；`verify.mjs`/`log.mjs` 输出完全确定（无时间戳/随机数/PID）。
- 同一系统提示、同一工具集、同一 scenario prompt；两个模式只有插件开关/policy 不同。
- 顺序：`repeat` 循环内 **B/C/A 轮换**（避免时钟漂移/缓存预热只偏向某一模式）；同一台机器同一次 CI job。

### 5.2 重复次数与判定阈值（成本可控）

| 阶段 | 每模式 run 数 | 用途 | 判定 |
| :-- | :-- | :-- | :-- |
| PR smoke | **2**（共 6 run） | 场景可行/触发/截断基线 | 只作方向性证据；不用于发布结论 |
| Release（默认） | **5**（共 15 run） | 非劣证明主证据 | G1–G4 全过才允许默认开启 |
| Nightly/周任务 | 5（或 20） | 稳定性趋势 | 记录通过率与退化分布 |

- **重复下限**：每个模式至少 **2 次有效 run**，**或**整个判定采用确定性校验点——本设计的 C1–C5 与截断判定均为**字符串精确包含/精确计数**，不依赖语义评分，满足该条件；release 仍推荐 R=5 以覆盖退化分布。
- **成本不允许重复时的降级**：若只能 1 次/模式，必须在报告与 `docs/benchmark.md` 明确写：**"单次运行仅作方向性证据，硬门禁只设 baseline/conservative 5/5 与规划器截断=0"**；不得据此宣称非劣/统计显著。
- **失败重跑规则**：仅"无效 run"（setup 缺失/答案不可解析）可重跑；**有效 run 的失败不得重跑洗白**。baseline 有效 run 任一 <5/5 → 先修场景（G6），不得归因策略。
- **统计诚实**：R=5 且 0 失败时，95% 置信上界仍约 45%（二项），所以结论只能写"非劣演示（non-inferiority demo），不是统计显著"；要更强结论用 R=20（0/20 → 上界约 14%）。
- **成本估算**（[R35] DeepSeek off-peak：cache hit $0.003/M、miss $0.15/M、output $0.6/M；按每 run ~120k input（80% hit）+ ~2k output）：约 **$0.006–0.01/run ≈ ¥0.04–0.07/run**；15 run ≈ **¥0.6–1.0**，与 plan §5 "单轮 ≤¥1" 同量级；R=20 × 2 模式作为周任务约 ¥2–3。

### 5.3 归因矩阵（先排除工具/场景问题，再谈策略）

| 现象 | 归因 | 处理 |
| :-- | :-- | :-- |
| baseline <5/5 或 repeat 间不一致 | 场景歧义/模型能力/答案格式 | 修 fixture/prompt；不得归因策略 |
| conservative <5/5 而 baseline 5/5 | **策略/实现缺陷** | 阻塞发布，查 drop 合法性/stub/prompt |
| conservative 5/5 但 token 未降 | 触发/阈值（如 C-1 的 20% cap）/窗口 | 查 plugin record 与触发日志；属实现问题 |
| conservative repeated read ↑ | stub 诱发重读（C-4） | 检查 stub 是否指向保留副本 |
| aggressive 也 5/5（连续 R 次） | 校验点太浅/可猜 | 加深校验点位置或增加依赖聚合的点；不追打单次 |
| 所有模式 token/答案无差异 | 插件未启用/模型未跟随 | 先验 G0 |

---

## 6. 产物与 CI

- Artifact JSON（每 run 一条）：`{mode, repeat, model, startedAt, valid, invalidReason, answerRaw, checks:{C1..C5}, score, metrics:{…}, planner:{calls,promptTokens,completionTokens,durationMs,finishReasons,truncatedBatches,failedBatches,appliedBatches}, pluginRecords:[…], planSummaries:[…]}`。
- `docs/benchmark.md`：自动生成 3 行汇总表（模式 × 5/5 通过率、median folded chars、median repeated reads、median final_context_tokens、**planner truncated batches / median planner completion tokens**、cache hit、cost）+ 结论段（引用本文门禁）。
- CI：`.github/workflows/benchmark.yml`，`workflow_dispatch` + `v*` tag 触发；`fail-fast=false`，aggressive 为 report-only；artifact 保留 14 天；基线 commit 打标签便于复现。
- 安全：日志不落 fixture 原文全文（只落哈希/字符数/替换摘要），不上传 API key。

---

## 7. 与 `docs/plan-v0.2.md` §5 的差异与修正建议

| ID | plan §5 现状 | 问题 | 建议 |
| :-- | :-- | :-- | :-- |
| **D1（critical）** | conservative "单批最多 drop 20% 目标 char" | 与整条 drop 语义冲突：删一条重复 read = 该目标 100% char；**本场景候选约 39k chars（unique 12k + duplicate 9.5k×2 + log 8k），删一条 9.5k 重复 read = 24% > 20% → conservative 永远 no-op**，benchmark 的 token 门禁必失败 | 改为**条数/证据约束**（见 slimming-policy §10.4 C-1）：单批 drop ≤ `min(maxTargets, ceil(候选数/2))`；char 比例只用于 trim 预算 |
| **D2** | 场景 4 "一段高重复日志输出（可安全 drop 重复块）" | conservative 只能 drop 整条结果，块内重复无法处理 → conservative 无法从该场景获益，场景与策略不匹配 | 场景 4 改为**两次逐字相同的整条日志输出**（drop 旧、留新）；块内重复只作 aggressive 演示 |
| **D3** | 每种模式跑一次 | 单次无法区分随机性；且未先验证"conservative 真的触发/替换" | 单次仅作 smoke；释放门禁要求每模式 ≥2 次（本设计确定性校验点满足下限）或按 §5.2 写"方向性证据"降级声明；release 推荐 R=5；先验 G0 |
| **D4** | aggressive 不设门禁 | 合理；但需明确"可观测退化"的判定 | 用 G5：中位 <5 且 ≥1 点在 ≥半数 run 缺失；连续 R 次不退化则修订校验点 |
| **D5** | conservative token "必须 < baseline" | 阈值太弱（差 1 char 也算过） | 保留硬条件（每次 run <），另加"中位降幅 ≥10%"作为有效性信号 |
| **D6** | 未要求 drop stub 指向保留副本 | 主 Agent 可能重跑，反复读会污染指标/答案 | benchmark 断言每条 drop stub 含保留目标 callId 且 `refetch_after_drop=0`（依赖 slimming-policy C-4 的实现） |
| **D7** | 成本目标按三次会话 | 三会话=1 模式 1 次，不足以证明 | 按 §5.2 成本估算，15 run 仍在 ¥1 量级；保留每次 run 的 billed cost 记录 |
| **D8（critical）** | plan §5 未包含规划器截断/超预算 | v0.1.0 真实回归：规划子 Agent 思考过长触顶、整批失败（约 20 次里大多失败）；v0.2.0 的直调 LLM/`reasoningEffort:off`/`maxOutputTokens:4096` 改动若无该指标则无法证明修复；"整批失败=无替换"还会被误读为"保守策略安全" | 增加 G7（conservative 截断=0 且 applied_batches≥1）；记录 planner prompt/completion tokens、时长、finishReason 直方图、失败整批原因；aggressive 截断只报告不断言；plan §7 验收清单同步加"planner truncation=0" |

---

## 8. 风险与不确定性（[推断] 标注）

1. **[推断]** "conservative 5/5 由构造保证"成立的前提是 fixture 的两次 read **逐字相同**且 conservative 的 drop 校验实现正确；任何去重实现 bug 会直接暴露为 conservative 失败。
2. **[推断]** aggressive 的退化是概率性的（模型可能恰好保留中段），所以 G5 用多次 run 的中位数/占比，不用单次判定。
3. 模型/厂商可能忽略 `seed`/temperature=0 仍非完全确定；本设计不依赖单次结果，靠重复 + 归因矩阵。
4. benchmark 只覆盖一个复合场景，不能替代 30–50 任务 A/B（报告 §11 的 A/B-1/A/B-3 等）；发布说明应写成"复合场景非劣 + 已有 20 条回归用例"，不宣称广泛质量结论。
5. 成本估算依赖 off-peak 价格 [R35]；峰值/缓存命中变化会改变金额，CI 需记录实际 billed usage。
6. **[推断]** 规划器 usage/`finishReason` 能否从 dsh 会话事件/diagnostics 稳定读取取决于 v0.2.0 实现；benchmark 按 fail-closed 处理，必要时在 plan 中要求 host 将 planner 调用元数据写入 plugin record/diagnostics（§4.1 第 5 条）。
