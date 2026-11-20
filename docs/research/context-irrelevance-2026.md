# 无关上下文对 Agent 表现的影响：2026 年文献调研与精简策略报告

- **项目**：dsh-context-slimmer（DeepSeek Harness 插件）
- **文档**：`docs/research/context-irrelevance-2026.md`
- **调研时间**：2026-11-20（检索窗口截至 2026-11-20；含 2025–2024 关键背景工作）
- **用途**：为插件的「后台模型选择性丢弃/精简最近 N 次工具结果」提示词提供有据可依的设计基础
- **配套文档**：`docs/research/slimming-policy.md`（可直接嵌入 system prompt 的规则集 + QA 验收标准）

## 0. 证据分级与方法

本报告只把**本次实际抓取到并核对过原文/摘要**的材料当作证据。证据分为五级：

| 级别 | 含义 | 本文使用方式 |
| :-- | :-- | :-- |
| **A** | 一手、可复核：arXiv 摘要或 HTML 全文抓取成功，数字逐条核对；或厂商官方文档/官方模型卡 | 可作为核心论断依据 |
| **B** | 一手但属预印本、且实验规模有限/未经同行评审 | 引用时标注"预印本"，结论降权 |
| **C** | 2025 及以前的经典背景工作 | 仅用于背景与机制铺垫 |
| **D** | 厂商工程博客/产品文档（Anthropic、DeepSeek、LangChain、OpenHands、Manus、Cognition） | 作为"业界做法"证据，不当作独立实验证据 |
| **E** | 二手博客、SEO 文章、论坛/逆向分析 | **不作为证据**；仅出现在"未核实清单" |

全文引用编号 `[R1]…[R44]` 对应第 14 节参考文献表；每条关键论断后附编号，A/B/C/D 级参考文献的 URL 均为本次实际抓取；E 级为检索结果中出现的链接，仅用于标注未核实来源。无法核实的内容统一列入第 12 节，正文不使用。

**一句话结论**：2026 年的证据越来越支持"**问题的关键不是长度，而是竞争**"——中性填充几乎无害，语义上"像证据/像答案"的干扰、过期状态、自相矛盾的旧结果才会显著破坏判断 [R3][R4][R8]；与此同时，**工具观测占 Agent 上下文的绝大部分（约 84%）** [R18]，因此工具结果是收益最高、也最需要谨慎处理的精简对象。对 Agent 而言，"丢掉什么"比"留下多少"更重要：**保留可重算的原始证据与约束，丢掉可重推的结论与 bulk**，是 2026 年文献给出的最一致的原则 [R13][R16][R31]。

---

## 1. 摘要（TL;DR）

1. **长度本身有影响，但不是主因。** 在 5 个模型、126,473 次试验中：中性填充到 32K token 时小模型准确率仍为 0.97–1.00；但换成"与证据同格式"的干扰句后掉到 **0.16–0.33**；只要出现 1 条"给同一个 key 一个竞争值"的陈述，损失放大 **9–110 倍** [R3]。
2. **模型内部有一个可测量量在追踪失败**：留在证据上的注意力质量（attention mass）可解释最高 **58%** 的损失方差，而 log 长度最多解释 **8%** [R3]。即：**语义竞争 > 长度**。
3. **干扰是"第一滴墨"式的非线性**：在固定长度上下文里，前 **10%** 的 hard distractor 造成陡峭下降，之后边际影响很小；过滤的收益主要来自"缩短长度"而非"去掉干扰"，要把 hard distractor 比例降到接近 0 才有实质恢复 [R4]。**要么整类清掉，要么别指望部分修剪有大收益。**
4. **即使检索完美，长度仍会伤性能**：5 个开源/闭源模型在数学、QA、代码任务上，随输入变长性能下降 **13.9%–85%**，且把无关 token 全部 mask 掉仍会下降；简单缓解法是"先复述证据再答题" [R23]。
5. **Agent 的问题主要在工具观测**：SWE-agent 的上下文里**约 84% 的 token 是环境观测** [R18]；Manus 测得 Agent 平均输入/输出 token 比约 **100:1**，且上下文每步只追加 [R31]。
6. **Agent 场景的失败形态是"提前放弃/不确定"**：4 个旗舰模型 × 3 个基准上，模型在**远未耗尽窗口**时就 give up 或给出不确定的错误答案（inconclusive search failure）；7 种上下文管理方法之所以有效，是因为它们把峰值上下文长度压下来、把模型推回继续探索 [R7]。
7. **精简能同时提升成功率与效率（有直接定量证据）**：企业费用录入场景，全量历史 71.0% 完成率/1,480,996 token/14.56h；只保留最近 5 组工具调用 → **79.0%/535,274 token/5.39h**；再加摘要 → **91.6%/99.64% 金额正确率/553,374 token/5.79h** [R11]。
8. **"丢结果"不如"丢 bulk、留证据"**：Squeez 用 2B LoRA 提取器在删除 **92%** 输入 token 的同时达到 **0.86 recall / 0.80 F1**，比 zero-shot 35B 模型 recall 高 **11 点** [R6]；观察遮蔽（observation masking）在 SWE-bench Verified 上把成本减半、解出率与 LLM 摘要相当甚至略好 [R18]。
9. **过度精简有真实代价，且任务完成率指标会掩盖它**：压缩后交互成本上升（检索调用 21.0→**63.9** 次，p=.002），但完成率统计上不变；更微妙的是，把保留内容换成"语义无关内容"会使检索调用再增 **57%**（p<.001）[R8]。**空的/干净的占位比模糊或无关的摘要更好。**
10. **压缩最危险的是丢掉"侧约束"**：6 类压缩器平均只保留 **17%** 的用户侧约束；某收件箱实验中，压缩后 **30/100** 个会话出现"未经确认就删邮件"，压缩前为 0 [R16]。→ 用户意图/权限约束必须**逐字、独立注册、永不摘要**。
11. **记忆系统保留"结论"而丢掉"依据"会产生 brittle memory**：模型会把陈旧结论当作自信答案；保留"可重算来源"、丢弃"可重推结论"的 source-first 策略能在同等预算下恢复可纠正性 [R13]。
12. **前缀缓存是精简的隐藏成本项**：Claude Code 官方文档明确"前缀任意位置变化都会导致其后全部重算，没有按文件/分段缓存" [R27]；DeepSeek 缓存按**完整前缀单元**匹配，且 cache hit 与 miss 价差约 **50×**（$0.003 vs $0.15 / M token，off-peak）[R34][R35]。→ 精简必须**低频、批量、在自然边界触发**，并接受一次 rebuild。
13. **DeepSeek-V4.1-Flash 让"长上下文 Agent"在工程上更可行，但不改变注意力竞争规律**：1M 上下文、890 B/token KV cache（约为 V4-Flash 的 1/4）、KVC 压缩是其技术报告的标题主题 [R1][R2]；官方 Agent 评测使用 1M 上下文 + 最多 500 步、且 DSH Minimal scaffold 是其中一种 harness [R2]。→ 我们的插件与官方 harness 的上下文工程方向一致，可用官方数字做基线。

---

## 2. 问题定义：什么算"无关上下文"

"无关上下文"在 2026 年文献里至少被拆成四种不同现象，混为一谈会导致策略错误：

| 类型 | 定义 | 对模型的作用 | 关键证据 |
| :-- | :-- | :-- | :-- |
| **中性填充（neutral filler）** | 与任务无语义关联、也不竞争答案的 token | 在受控设置下几乎无害；但会拉长距离、抬高成本 | 32K 中性填充下准确率维持 0.97–1.00 [R3] |
| **竞争性干扰（competition / hard distractor）** | 语义上"像证据"、"像答案"，与正确证据争夺同一 key 或同一结论 | 显著且非线性地破坏判断；注意力被稀释 | 同格式干扰使准确率降至 0.16–0.33；1 条竞争陈述损失放大 9–110× [R3]；前 10% hard distractor 造成主要损失 [R4] |
| **过期/被推翻上下文（stale / superseded）** | 曾经正确、后来被新观测或新决策取代的旧状态 | 模型可能按旧值行动、重复旧错误、产生"会话惯性" | 旧观测被新结果推翻后仍留在上下文；会话惯性来自对角注意力与自我模仿 [R5]；"lossy memory 保留错误结论" [R13] |
| **纯噪声/无引用（irrelevant noise）** | 与当前目标、计划、最近决策没有任何引用关系的工具输出 | 主要浪费 token/成本，并轻微稀释注意力；风险低于竞争性干扰，但会放大"首滴墨"效应 | 语义无关内容被保留反而使检索调用 +57% [R8]；84% 观测占比 [R18] |

对插件最实用的操作性定义：

> **一个工具结果对"下一步动作"的价值 = 它是否仍提供（a）不可从别处廉价重算的事实，或（b）决策所需的证据，或（c）失败/约束/安全信号。**
> 三者皆无 → 可丢；只有批量内容而事实/指针可保留 → 可精简；含 (b)(c) 或属于用户意图 → 不可动。

需要特别区分两类"相关"：
- **任务相关性**：与用户目标有关；决定"要不要留一个指针"。
- **执行相关性（execution-relevant state）**：下一步执行/验证所需的精确状态（当前文件版本、失败命令、权限、未完成 TODO）；决定"必须逐字留什么" [R8][R16]。

---

## 3. 机制分类与定量证据

### 3.1 机制一：注意力竞争与稀释（attention dilution / competition）

**机制。** Transformer 的 softmax 注意力权重是归一化的：上下文越长、竞争 token 越多，分配给"唯一相关证据"的质量份额越难保持。Anthropic 在 2025 年把这表述为"attention budget"：每引入一个新 token 都在消耗注意力预算，且 n 个 token 有 n² 对关系，上下文越长，捕获这些关系的能力越被摊薄 [R26]。2026 年的工作把这条直觉做成了可测量量：

- **R3（Length Is Cheap, Competition Is Not, arXiv:2611.04169，2026-11-03）**：5 个开源模型（0.5B–3B、4 个家族）、126,473 次试验。中性填充在 32K 内不伤准确率（0.97–1.00）；同格式干扰句把准确率压到 **0.16–0.33**；1 条"rival value"陈述把损失放大 **9–110×**，且每多一条 rival 继续叠加。**证据上的注意力质量可解释最高 58% 的损失方差；log 长度最多 8%。** 论文还复现了"长度本身有害"的 masked-filler 协议（MMLU 30K 时掉 11–18 分），但指出该协议在检索任务中失败：32K 时 mask 掉填充会掉 45 个准确率点，而同样的填充**可见**时反而无损。
  → 对插件：**不要把"长"当作唯一判断依据；要优先识别"与当前证据竞争语义"的旧结果**（过期值、旧版本文件、被推翻的结论、另一套候选答案）。
- **R4（The First Drop of Ink, arXiv:2605.10828，2026-05-11/v2 08-20）**：固定长度下改变 hard distractor 比例，得到非线性曲线：**前 10% 造成陡降，后续边际很小**；理论分析表明金标文档上的注意力是 hard distractor 比例的凸函数（注意力 logit 边际 Δe≈7–10 vs Δh≈2–3）。结论：**过滤的收益主要来自上下文长度下降，而不是"去掉一部分干扰"**；要实质恢复需把 hard 比例降到近 0。
  → 对插件：**按"类"整体清理**（例如"所有已被新读取代的旧文件内容"整类替换），胜过对单条结果做 20% 的局部修剪。
- **R21（Lost in the Middle, TACL）**：相关信息位于长上下文中部时性能显著下降；首尾更好 [R21]。Manus 用"反复重写 todo.md 把目标复述到上下文末尾"来对抗 lost-in-the-middle [R31]。
- **R22（GSM-IC, ICML 2023）**：加入无关信息后数学推理准确率"dramatically decreased"；self-consistency 与"忽略无关信息"指令可部分缓解 [R22]。

### 3.2 机制二：长度本身（length-only degradation）

- **R23（Context Length Alone Hurts…, EMNLP 2025 Findings, arXiv:2510.05381）**：5 个开源/闭源模型、数学/QA/代码任务；即使**完美检索**，随输入变长性能仍下降 **13.9%–85%**；把无关 token 换成空白、甚至全部 mask 掉仍下降；把所有证据放在问题之前也不救。缓解法：让模型先**复述**检索到的证据再作答（RULER 上 GPT-4o 最高 +4%）[R23]。
- **R24（Chroma Context Rot, 2025-07-14）**：18 个模型（含 GPT-4.1、Claude 4、Gemini 2.5、Qwen3）；模型并不均匀使用上下文，输入越长性能越不可靠；NIAH 只测词面检索，不足以代表真实长上下文能力 [R24]。
- **R2（DeepSeek-V4.1-Flash 模型卡）**：1M 上下文、CED 架构、prefill 仅激活 8B、decode 16B；890 B/token 的 KV cache（约为 V4-Flash 的 1/4）；技术报告标题即 "Pushing the Limits of KV Cache Compression" [R2]。**更长的窗口降低了"必须压缩"的硬约束，但没有消除注意力竞争**——这恰好解释了为什么 2026 年 industry 仍在做 selective context management 而不是"直接塞满 1M"。

### 3.3 机制三：Agent 特有的是"上下文污染→行为惯性→错误重复"

- **R5（Mitigating Conversational Inertia in Multi-Turn Agents, ICML 2026, arXiv:2602.03664）**：通过注意力分析发现 **conversational inertia**——模型对"自己先前的回复"有强对角注意力，产生模仿偏差，限制探索；**上下文越长惯性越强**；同一状态下长上下文生成的动作比短上下文更"惯性"。作者用 Context Preference Learning 校准偏好，并在推理时用上下文管理在轮次边界清理历史，以"切断错误传播" [R5]。
  → 对插件：工具结果的**旧结论/旧尝试**即使"成功"也可能通过模仿偏差把主 Agent 锁进重复路径；精简应优先去掉"重复的相似动作-观测对"，并保留"失败证据 + 已尝试清单"以避免重试。
- **R20（Why Do Multi-Agent LLM Systems Fail? / MAST, arXiv:2503.13657）**：1600+ 标注轨迹、7 个框架、14 种失败模式/3 大类、标注者间 kappa 0.88；指出失败常来自系统设计与**错误在 agent 间传播**，不是单点模型能力 [R20]。单 Agent 也会跨轮传播，且上下文是唯一传播介质。
- **R14（Silent Failure / Entropy Principle, arXiv:2606.08162，预印本）**：基于 4 万+ 受控试验与 10 万+ 生产交互，提出"系统熵随交互轮次单调增长"（S(t)=S0·e^{αt}）[R14]。**该文属 B 级预印本，公式与结论请谨慎对待**；但它指出的现象（无外部触发、无对抗输入的静默退化）与 R5/R7 相互印证。
- **R7（Diagnosing and Mitigating Context Rot in Long-horizon Search, arXiv:2606.29718，v3 2026-10）**：4 个旗舰模型 × 3 个基准；发现模型在**远未耗尽窗口**时就 give up 或给出不确定的错答（inconclusive search failure），连简单/中等难度查询也会提前终止；7 种上下文管理方法（3 类）本质上是 **test-time scaling**：通过降低峰值上下文长度把模型推回继续探索；并行采样 + 行为感知过滤可再提升 **2.6%–4.9%** [R7]。

### 3.4 机制四：长上下文同时损害"监控/校验"能力（对插件尤其重要）

- **R15（Classifier Context Rot, arXiv:2605.12366，2026-05-12）**：把前沿模型当"安全分类器"审阅超长轨迹时，危险动作若出现在 800K token 的 benign 活动之后，Opus 4.6 / GPT-5.4 / Gemini 3.1 漏检率提高 **2×–30×**；Opus 4.6 在 MonitorBench 上的 recall 从 98.6% 降到 88%（800K benign prefill）；周期性提醒可部分缓解 [R15]。
  → 两个直接推论：① 主 Agent 在超长上下文中做"自我校验"不可靠，工具结果精简不能破坏可供事后审计的**安全证据**；② 我们的后台精简模型本身也是长上下文阅读者，**不能假设它能在 1M token 里可靠找到该保留的东西**——必须显式提供"当前目标 + 约束注册表 + 最近 N 条原文"，并分批处理。

### 3.5 机制五：无关/膨胀上下文不一定降低完成率，但会抬高交互成本

- **R9（Evaluating AGENTS.md, arXiv:2602.11988，v3 2026-09）**：上下文文件总体上**不提升**任务成功率，却使推理成本平均上升 **>20%**；跨模型、跨 agent、LLM 生成与开发者手写文件均成立。指令类内容被很好遵循，但"仓库概览"类内容无益 [R9]。
- **R8（What Does Context Compression Cost an Agent?, arXiv:2608.16370，2026-08-17）**：受控 24 轮工具使用环境、3 模型 × 2 任务域。压缩后**检索调用在全部 6 个对比中都上升**；GPT-5.5 完成率 80%→85%（p=1.0，不显著），但检索调用 **21.0→63.9**（p=.002）；DeepSeek 仅在 10× 压缩时完成率显著下降；随机保留与"事后最优 oracle"相当——**选哪些丢不是最关键，丢掉的"状态类别"才是**；把保留状态换成语义无关内容会使检索再增 **57%**（p<.001）而完成率无显著变化；ALFWorld 中滑动压缩没有检索激增，说明该代价是**环境相关**的 [R8]。
- **R11（Less Context, Better Agents, arXiv:2606.10209，2026-06）**：企业费用录入、MCP 工具、4 种 GPT-5 配置、50 任务：无用户模型 8.0%；全量历史 71.0%（1,480,996 token / 14.56h）；**只保留最近 5 组工具调用/响应 → 79.0%（535,274 token / 5.39h）**；裁剪+自动摘要 → **91.6% 完成、99.64% 金额正确、553,374 token / 5.79h**；Claude Sonnet 4.5 上有跨模型证据 [R11]。
  → **正确做法的收益是"双赢"，不是"用质量换成本"**。

### 3.6 机制六：上下文压缩的收益来自哪里（压缩方法证据）

- **R18（The Complexity Trap, arXiv:2508.21433，v3 2025-10）**：SWE-agent + SWE-bench Verified、5 种模型配置，并给出向 OpenHands 的初步泛化证据。**观测 token 约占上下文 84%**；简单 observation masking **把成本减半**、解出率与 LLM summarization 相当甚至略高；二者混合再降 **7%/11%** 成本。作者据此质疑"一律上 LLM 摘要"的趋势 [R18]。
- **R19（ACON, ICML 2026, arXiv:2510.00615）**：在自然语言空间优化"压缩指南"，用失败分析迭代改进，再蒸馏到小模型；AppWorld/OfficeBench/Multi-objective QA 上峰值 token 降 **26–54%** 且成功率高于既有压缩基线；小模型最高 **+46%** 性能（缓解上下文分心）[R19]。
- **R6（Squeez, arXiv:2604.04979，2026-04）**：把"任务条件化工具输出修剪"定义为 benchmark（11,477 例，618 例人工测试集）；Qwen 3.5 2B LoRA 达 **0.86 recall / 0.80 F1，同时删除 92% 输入 token**；比 zero-shot Qwen 3.5 35B A3B 的 recall 高 **11 点**，远超启发式基线 [R6]。
- **R12（ContextBench, arXiv:2602.05892，2026-02）**：1,136 个 issue 任务、66 个仓库、8 种语言；编码 Agent **一致偏好 recall 而非 precision**（检索过多），"精巧 scaffold"只带来边际收益（The Bitter Lesson of coding agents），"探索到的上下文"与"实际利用的上下文"存在大缺口 [R12]。
  → 对插件：**后台模型不是"总结器"，而是"任务条件化的证据选择器"**；应追求"保留最小充分证据块"，并显式输出指针以便重取。

---

## 4. Agent 多轮工具调用场景的特殊性

通用长上下文结论不能直接套到 Agent 上，原因有六条，每条都有 2026 年证据支撑：

### 4.1 工具观测占绝对多数，且信息密度高于对话碎片

- 84% 的 Agent 上下文 token 是环境观测 [R18]；Agent 平均输入/输出约 100:1，每步只追加 action+observation [R31]。
- **AgentLongBench（arXiv:2601.20730，2026-01）**：用 lateral thinking puzzle 做可环境回滚的长上下文 Agent 基准（32K–4M），发现"静态检索强、动态信息综合弱"，退化由**解决查询所需的最小 token 数**驱动；**大工具响应里的高信息密度，比长对话的记忆碎片更棘手** [R10]。
  → 插件应把 90% 的预算放在工具结果上，而不是对话/推理文本。

### 4.2 同一条结果的价值随步骤变化，且"何时变"不可预知

Manus 的经验：Agent 必须基于全部历史状态预测下一步动作，**无法可靠预测哪条观测在 10 步后会变成关键**；因此任何不可逆压缩都有风险，压缩策略必须是**可恢复的**（网页丢正文但保 URL；文档丢内容但保路径）[R31]。这正是我们"替换文本必须带重取指针"的理论依据。

### 4.3 失败证据是"负样本"，删掉它等于重新开启同一个坑

- Manus 明确主张"Keep the Wrong Stuff In"：错误一旦被隐藏，模型失去证据，无法调整先验，错误恢复能力是真正的 Agent 能力标志 [R31]。
- Reclaim Evaluation（arXiv:2606.25449）：保留错误结论、丢掉推导来源会产生 **brittle memory**——模型会自信地重复陈旧值；空记忆反而会弃权；"source-first（保留可重算来源、丢弃可重推结论）"能在同等预算下恢复可纠正性，并在 3 个记忆系统、MultiWOZ、τ-bench 上复现 [R13]。
- 会话惯性实验表明，重复的"自相似动作-观测对"会强化模仿偏差 [R5]。
  → 精简规则必须区分：**删"重复过程"、保"失败事实与精确证据"**。

### 4.4 峰值上下文（而非平均上下文）决定失败模式

长期搜索任务中，模型真正的失败是"提前放弃/不确定"，而上下文管理之所以有用，是因为它**压低峰值长度**、把模型推回继续探索 [R7]。这说明触发时机应看**峰值/阈值**，不是简单按"每 N 次"均匀触发；至少要让触发点与上下文压力挂钩（详见第 9 节）。

### 4.5 压缩本身有交互成本，完成率指标会掩盖它

R8 显示压缩后检索调用上升、完成率不变；且"语义无关的保留内容"比"干净的空缺"更糟（检索 +57%）[R8]。对 Agent 而言，最坏情况不是"少了一条信息"，而是"留了一条**看起来相关但语义错位**的信息"，模型会据此走错路、再花调用把状态找回来。

### 4.6 前缀缓存把"编辑历史"变成显式成本

- Claude Code 官方文档：API 按请求**开头的前缀**精确匹配；**前缀中任何位置变化都会导致其后全部内容重算**，不存在按文件/分段缓存；切换模型、切换 effort 也会整体重算 [R27]。
- Anthropic context editing 文档：`clear_tool_uses_*` 会**使缓存前缀失效**；建议用 `clear_at_least` 确保每次清理足够多的 token 才值得破坏缓存；thinking block 保留时可保住缓存 [R25]。
- DeepSeek：缓存按"完整 cache prefix unit"匹配，后续请求必须**完整匹配**某个已持久化的前缀单元才算命中；命中情况由 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 报告；缓存 best-effort、几小时到几天内清除 [R34]。
- DeepSeek 官方定价（off-peak，deepseek-flash）：cache hit **$0.003** / M tokens，cache miss **$0.15** / M tokens，输出 $0.6 / M；即 hit 比 miss 便宜约 **50×**（peak 同比例：$0.006 vs $0.3）[R35]。

**一个便于插件决策的近似模型（本报告推导，非文献结论）**：设上下文总长 T、在位置 p 处改写（删除 R 个 token，R ≤ p），此后还需 m 轮。改写导致下一轮重算 (T−p) 个 token 的 miss 成本；每轮节省 R 个 token 的 hit 成本。忽略输出与增长，**盈亏平衡轮数 ≈ 50·(T−p)/R**（用 DeepSeek off-peak 比例；Anthropic/OpenAI 比例不同但同量级）。含义：

- **在上下文末尾附近做精简才容易回本**；对很老的、位于前部的结果做大改写，单次缓存重建可能吃掉几十轮的节省。
- **务必批量、低频**（例如每 20–50 次工具调用一次，或接近阈值时一次），不要每轮小改。
- **精简的首要理由应是"质量与窗口"，不是"省钱"**；省钱只有在"不精简就会溢出、或要跑很多轮"时才成立。
- 触发时可与"自然缓存断点"对齐：新用户任务、`/clear` 类操作、compaction 事件等。

---

## 5. 工具结果分类学与逐类精简策略（决策表）

分类维度有两个：**（A）对下一步的价值**（保留必要性）、**（B）可恢复性**（能否用指针+重取替代）。插件对每个候选结果先分类，再选动作。

**动作集（只允许这四种）**：
- `KEEP`：原文保留（可只保留首尾，但关键证据块逐字保留）；
- `TRIM`：保留头/尾/错误段/命中块，中间用一行 `...[trimmed N lines]...` 占位；
- `REPLACE`：替换为"事实摘要 + 来源指针 + 重取指令"；
- `DROP`：替换为一行占位 stub（工具名、参数、结果类型、原文 token 数、重取方式），不保留内容。

| # | 类别 | 识别信号 | 默认动作 | 必须逐字保留 | 允许丢弃 | 备注 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | **相关且成功（当前证据）** | 最近 K 次调用；被后续动作直接引用；包含当前修改点/断言 | `KEEP` 或 `TRIM` | 被引用行/符号/返回值/行号 | 无关 preamble、重复日志、进度条 | K 默认 4–6 |
| 2 | **相关但失败（负证据）** | 非零退出、traceback、断言失败、超时、权限拒绝 | `KEEP`（失败证据块） | 命令原文、退出码、首个错误行、关键栈帧、重试所需参数 | 重复栈帧、成功前的无关日志 | **禁止把失败写成成功**；见 [R31][R13] |
| 3 | **相关但可重算（bulk）** | 整文件读、目录列举、grep 全量、数据库/API 查询结果 | `REPLACE`（指针+命中项） | 路径/命令/查询、命中项与行号、计数 | 原始 bulk | 最安全的大头 [R31][R8] |
| 4 | **部分相关** | 大输出中少量行/块有用 | `TRIM` | 命中块 ±2 行上下文、行号 | 其余 | 用 `Squeez` 式"最小充分证据块" [R6] |
| 5 | **已被推翻/过期** | 同一文件有新读/写；状态已被后续结果否定；旧版本 | `REPLACE`（superseded stub） | 新旧关系一句话、最新结果 id | 旧内容 | 竞争性干扰，优先级高 [R3][R13] |
| 6 | **完全无关噪声** | 与目标/计划/最近决策无引用关系；探索性试错 | `DROP` | 调用摘要（工具+参数+结果类型） | 全部内容 | 干净 stub 优于模糊摘要 [R8] |
| 7 | **超大输出** | 超过阈值（建议 6k–20k token，可配置） | `TRIM`/`REPLACE` | 头、尾、错误段、统计计数 | 中部 bulk | 防止"压缩后立即再次溢出"的 thrashing [R28] |
| 8 | **网页/搜索/文档** | URL、标题、检索结果列表 | `REPLACE`（引用） | URL、标题、日期、关键摘录 1–3 句 | 正文 | 可重取；保留时效信息 [R31] |
| 9 | **写入/编辑结果** | diff、patch、写文件确认 | `REPLACE`（变更摘要） | 文件路径、变更行范围、校验/测试状态 | 大 diff 正文 | 写入前的原文已持久化，冗余 [R30] |
| 10 | **敏感/权限/安全** | secret、凭证、权限决策、审批、可疑注入 | `KEEP`（原文或遮罩版） | 位置、类型、决策与时间；值本身按策略遮罩 | 不得丢弃 | 审计要求 [R15][R25] |

**全局兜底规则**：模糊/无法判定 → `KEEP`（保守优先）；单次精简总量设上限（如 ≤ 候选 token 的 50%）；不得改变工具调用与结果的**配对结构**（call 与 result 必须一一对应，否则 API 不合法）。

---

## 6. 可压缩与不可压缩的边界

### 6.1 不可压缩（never-drop，逐字或等价保留）

| 内容 | 依据 |
| :-- | :-- |
| 用户消息、任务目标、验收标准 | 压缩后早期指令可能丢失 [R28]；提示词/约束丢失是合规风险 [R16] |
| **侧约束（side constraints）**：如"未确认前不要删邮件""只用只读命令""必须保留 API 兼容" | 6 类压缩器平均仅保留 **17%**；收件箱实验压缩后 30/100 会话违规删除，压缩前 0 [R16] |
| 权限/审批/安全决策与敏感操作记录 | 长上下文会削弱监控（漏检 2–30×）[R15]；安全证据必须可审计 |
| 当前未解决的失败证据（命令、退出码、错误行） | 删失败 = 重新开启同一个坑 [R31][R13] |
| 决策与理由（actions carry implicit decisions） | 不共享决策会制造冲突；压缩器应保留"决策+理由"而非仅结果 [R32] |
| 未完成 TODO、未验证假设、待确认问题 | 目标漂移是最隐蔽的失败模式 [R30] |
| 标识符：路径、URL、commit、行号、文件版本、外部 ID | 可恢复性的锚点；丢了就无法重取 [R31][R8] |
| 工具调用参数骨架（至少 call id + 工具名 + 关键参数） | 保证对话结构合法、可配对 |
| 最近 K 次工具调用原文 | 保护当前执行状态与缓存尾部 [R27] |

### 6.2 可压缩（drop/trim/replace）

- 成功但已被后续步骤消费的**中间观测**（尤其大文件全读、日志全量、目录树）；
- 重复/近似重复内容（同一命令多次重跑、同一文件多次读、重复栈帧）；
- 可重算的查询结果（grep/glob/SQL/API 列表）——保留查询与命中即可；
- 搜索网页正文（保 URL/标题/日期/关键句）；
- 已被新版本取代的旧文件内容、旧 diff；
- 与当前目标无引用关系的探索性输出；
- 已写入文件的全文（写后读冗余）——LangChain Deep Agents 对 >20k token 的工具响应直接落盘并以"路径 + 前 10 行预览"替代 [R30]。

### 6.3 边界判定中的三个易错点

1. **"成功"≠"可丢"。** 一个成功调用的**返回值**可能是后续比较/验证的唯一依据；判断依据应是"是否被引用/是否可重算"，不是成功与否。
2. **"失败"≠"可丢"。** 失败证据几乎总是负样本；只有在"同一失败已完整保留一次且新失败只是重复"时才可合并。
3. **"长"≠"无关"。** 中性填充在受控条件下几乎无害 [R3]；真正该优先清的是**竞争语义**（旧值/旧版本/被否定的结论）[R3][R4]。

---

## 7. 过度精简的风险与失败模式

| 失败模式 | 机制 | 证据 | 对插件的防线 |
| :-- | :-- | :-- | :-- |
| **侧约束丢失 → 违规操作** | 摘要保留任务、丢掉约束 | 17% 保留率；30/100 违规删邮件 [R16] | 独立"约束注册表"，永不摘要；逐字保留 |
| **brittle memory（留结论丢来源）** | 模型把陈旧结论当自信答案 | 保留错误结论+丢来源比空记忆更糟 [R13] | 保留可重算来源；替换文本禁止只留结论 |
| **隐藏交互成本** | 删掉需重取的状态 → 检索调用上升 | 21.0→63.9 次（p=.002）；完成率不变 [R8] | 保留指针；监控重取率；做 re-fetch 基线对比 |
| **语义错位的"残渣"** | 保留内容与原意不同 → 更糟 | 语义无关保留使检索 +57% [R8] | 不确定就丢干净或留原文；禁止"模糊改写" |
| **目标漂移/提前宣布完成** | 摘要丢了意图 | Deep Agents 称"最隐蔽的失败模式" [R30]；压缩后早期指令丢失 [R28] | 目标/TODO 永不摘要；验收标准保留 |
| **摘要幻觉（把失败说成成功）** | 摘要模型过度概括 | 压缩错误会影响下游行为 [R16][R13] | 摘要必须引用原文片段；失败状态单独字段 |
| **缓存反噬** | 频繁改写前缀 → 每次 rebuild | 前缀精确匹配、任意位置变化全重算 [R27]；clear 会失效缓存 [R25] | 批量、低频、阈值触发；接受一次 rebuild |
| **错误精简导致 thrashing** | 精简后单条大输出又立刻填满 | Claude Code 对"压缩后立即再满"停止自动压缩并报错 [R28] | 超大输出先截断/落盘；设单条上限 |
| **可审计性下降 / 合规问题** | 安全证据被摘要掉 | 长上下文监控漏检 2–30× [R15]；审计需要原始记录 [R25] | 安全类永不改；保留"原文可追溯 id" |

**一条经验法则**：**把"可重推翻的结论"尽量删掉，把"可重算的来源"尽量留下** [R13]；把"确定无关"整类清掉，把"可能相关"留给保守动作 [R4][R8]。

---

## 8. 业界系统做法对照

| 系统 | 触发/策略 | 保留什么 | 丢弃/替换什么 | 缓存处理 | 证据 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **Anthropic API context editing** | `clear_tool_uses_20250919`：默认 input_tokens 达 100k 触发；默认保留最近 3 组 tool use；可设 `clear_at_least`、`exclude_tools`；`clear_tool_inputs` 默认 false（只清结果不清参数） | 最近工具调用；被 exclude 的工具 | 按时间从旧到新清工具结果，替换为占位文本 | 明确会使前缀缓存失效；用 clear_at_least 保证每次清足够多才值得 | [R25] |
| **Anthropic thinking clearing** | `clear_thinking_20251015`；`keep` 默认 1 turn | 可配置保留最近 N 轮 thinking | 更早 thinking 块 | 保留 thinking 时缓存可保住；清除则失效 | [R25] |
| **Anthropic compaction（SDK）** | 阈值（默认 100k）生成结构化续接摘要，替换整个历史 | 任务/状态/发现/下一步/要保留的上下文 | 原始历史 | 摘要会重写前缀 | [R25] |
| **Anthropic 官方建议** | 上下文是有限资源、边际收益递减；无关内容会降低模型专注；用"最小高信号 token 集"；JIT 检索/渐进披露 | 高信号 token、指针 | 预加载的大块数据 | — | [R26] |
| **Claude Code** | 自动 compaction + 清理旧工具结果；`/compact [focus]`；`/autocompact` 设窗口；子代理/ fork 隔离 | CLAUDE.md、auto memory、最近读过的至多 5 个文件（>5k token 只回路径）、skill 正文（每 skill ≤5k、总 ≤25k） | 会话历史被摘要；早期详细指令可能丢失 | 前缀精确匹配，任意变化全重算；模型/effort 切换也重算；把 compaction/清工具结果计为 expected rebuild | [R27][R28][R29][R36] |
| **LangChain Deep Agents** | 三档：>20k token 工具响应立即落盘；上下文到 **85%** 窗口时把旧 write/edit 参数落盘；仍不够才摘要 | 文件系统原始记录；"session intent + artifacts + next steps"摘要；前 10 行预览 | 大工具响应正文、旧工具参数 | 落盘替换为指针（前缀会变） | [R30] |
| **OpenHands condenser** | 事件数阈值触发，保留前 `keep_first` 个事件（system/初始 user），其余摘要 | 最近消息、用户目标、关键文件、技术规格 | 较早事件 | — | [R33] |
| **Manus** | KV-cache 命中率是第一指标；append-only、稳定前缀、确定性序列化；文件系统作为外部上下文；压缩必须可恢复 | 目标（todo.md 复述）、URL/路径指针、错误证据 | 网页正文（保 URL）、文档内容（保路径）、无关 bulk | 不改前缀、不动态增删工具（会破坏缓存） | [R31] |
| **Cognition/Devin** | 单线程线性 Agent；共享完整轨迹；需要压缩时用专门训练的小模型压缩"动作+对话"为关键决策 | 所有相关决策与完整轨迹 | 历史压缩为关键事件 | — | [R32] |
| **DeepSeek-V4.1-Flash（官方）** | 1M 上下文 + 高效 KV（890 B/token，~1/4 V4-Flash）；Agent 评测用 1M 上下文、max_steps=500；DSH Minimal 是官方 harness 之一 | 长窗口本身 | — | 前缀缓存单元匹配；hit/miss 约 50× 价差 | [R1][R2][R34][R35] |
| **Claude Code "microcompact"** | 社区逆向/博客声称：在 auto-compact 之前做"无 LLM 的外科式清理"（先清工具结果/thinking） | — | — | — | **未核实，见第 12 节；不作设计依据** [R38][R39] |

**对照结论**：主流系统几乎没有"每轮让 LLM 重写历史"的做法。它们共同的三条是：① **优先清工具观测**（不是对话）；② **保留可恢复指针/落盘**；③ **低频、阈值触发、接受一次缓存代价**。我们的插件把"主 Agent 无感知"作为目标，属于更激进的路线，因此更需要保守的 must-keep 清单与安全阀。

---

## 9. 对插件设计的直接结论（可执行）

以下 12 条是把上述证据翻译成工程决策的结论，括号内为直接依据。

1. **触发：批量 + 低频 + 压力感知。** 不要"每 N 次就小改一次"。推荐双条件触发：`工具调用数 ≥ N` **且**（上下文 token ≥ 阈值 或 峰值压力接近窗口）；一次处理"最旧的一大段"，而不是每轮改一点。依据：前缀任意变化全量重算 [R27]；Anthropic 建议用 `clear_at_least` 保证单次清理量才值得破坏缓存 [R25]；峰值上下文决定失败模式 [R7]。
2. **与 compaction 协调，避免双重压缩。** 若 harness 已有 compaction，精简应在其之前/之间错开，避免同一轮既改写工具结果又生成摘要；两者叠加会使"丢失内容"不可归因 [R25][R28]。
3. **后台模型输入必须"显式重述"，不能只靠完整上下文。** 给精简模型的应是：任务目标 + 验收标准 + 约束注册表 + 最近 K 条原文 + 当前未解决失败 + 当前 TODO + 候选批次（每批 20–40 条）。原因：它本身也会 context rot，长轨迹中"找到该保留什么"不可靠 [R15][R3]。
4. **输出结构化决策，不输出自由文本。** 每条含 `tool_call_id`、`class`、`action`、`replacement_text`、`keep_evidence[]`、`recoverable{how,ref}`、`reason`、`confidence`、`original_tokens`、`est_tokens_saved`。插件侧做 schema 校验、越界回退（不合法 → KEEP）。
5. **约束注册表（constraint registry）独立且永不摘要。** 从用户轮次一次性抽取，版本化，固定注入；每次精简都把它附在末尾（"末尾位置 + Direct/Strict 措辞"更利于保留）[R16]。这是 2026 年最被低估的一条：摘要器平均只保留 17% 侧约束 [R16]。
6. **失败证据政策：保留失败事实，合并重复过程。** 每条未解决失败保留：命令原文、退出码、首个错误行、关键栈帧、重试所需参数；同一失败的后续重复调用只保留一行"第 n 次重试，仍失败，证据同上"。依据：Keep the Wrong Stuff In [R31]；source-first [R13]；会话惯性/重复 [R5]。
7. **替换文本要"自描述、可重取、不可误读"。** 用明确的 `[elided by context-slimmer]` 前缀，写清 call id、工具、参数、结果类型、原文 token 数、重取指令；不要把改写内容伪装成原始输出（防模型把摘要当证据）。Anthropic 的 placeholder 做法同源 [R25]；干净的空缺优于模糊摘要 [R8]。
8. **"主 Agent 无感知"的正确含义**：不暴露插件/机制、不改变 tool_use↔tool_result 配对、不改变工具参数语义；但**替换文本本身必须诚实标注"已省略，可重取"**。否则模型会基于缺失信息编造（compaction 后错误自信的机制见 [R13]）。
9. **不可压缩白名单硬编码为代码级 guard**，不只写在提示词里：用户消息、约束、权限/安全、当前失败、TODO、标识符、最近 K 条、工具调用骨架。任何越界决策由插件拒绝并回退 KEEP（对齐 Anthropic `exclude_tools` 的思路 [R25]）。
10. **缓存策略显式化。** 记录精简前后的 `prompt_cache_hit_tokens`/`miss` [R34]，把精简引发的重建标记为 "expected rebuild"（Claude Code 的做法 [R29]）；用近似公式 `盈亏平衡轮数 ≈ 50·(T−p)/R` 做配置评估（推导见 4.6）；在长会话中优先选择"改写位置尽量靠后、一次删足够多"。
11. **安全阀与可回滚。** 置信度阈值（低于阈值 → KEEP）；单次精简上限（≤50% 候选 token）；最小保留比例（例如至少保留最近 30% 与全部证据类）；dry-run 模式；原文 sidecar（保存被替换的原文与哈希，按 session 事件 id 可回滚），便于审计与 A/B。
12. **验收要测"隐藏成本"，不能只看 token。** 除任务成功率外，必须测：重取/检索调用增量（R8 的核心指标）、约束保留率（R16）、失败证据保留率、cache hit rate、以及"精简后 1–2 轮内的错误恢复率"。指标目标见第 11 节。

### 与 DeepSeek-V4.1-Flash 的结合点

- 官方 Agent 评测使用 **1M 上下文 + max_steps=500**，并以 **DSH Minimal** 作为 harness 之一（DeepSWE v1.1 72.6、Terminal-Bench 2.1 90.6）[R2]。插件的触发阈值、步数预算应能与之对齐（例如按"步数/上下文双预算"配置）。
- **890 B/token** 的 KV cache（1/4 于 V4-Flash）意味着 1M 上下文约 **~890 MB** KV/序列 [R2]；压缩对显存/吞吐有实际收益，因此"值不值得压"要同时看质量与容量，而不只是 API 账单。
- DeepSeek 前缀缓存按**完整前缀单元**匹配、hit/miss 约 **50×** 价差 [R34][R35]：同样的精简动作在 DeepSeek 上的缓存代价比 Anthropic 更"惩罚性"，更应批量低频。
- **不要依赖小模型做大规模语义判断**：Squeez 用 2B 模型做成"任务条件化证据提取"可达 0.86 recall，但它是**窄任务监督训练**的结果 [R6]；通用后台模型在长上下文里仍会退化 [R15]。因此提示词要给**明确的分类规则和决策顺序**，而不是让模型自由发挥。

---

## 10. 给插件的精简提示词草案（中英双版）

> 用途：作为后台精简模型（fork 完整上下文、带结构化输入）的 system prompt。实际插件中应把 `{...}` 占位符替换为运行时数据，并把第 11 节验收标准写进测试。

### 10.1 English system prompt (draft)

```text
You are the CONTEXT CURATOR for a tool-using coding agent. Your only job is to remove
tokens from OLD tool results without changing any fact, decision, or constraint. You do
not solve the task. You never talk to the user.

INPUT you receive:
- TASK: the user's goal and acceptance criteria.
- CONSTRAINTS: verbatim user side-constraints and permissions. Treat as immutable.
- RECENT: the most recent tool calls/results (verbatim). Never modify these.
- CANDIDATES: older tool results, each with tool_call_id, tool name, args, turn index,
  token count, and content.

For EACH candidate, choose exactly one action:
  KEEP    keep as-is (optionally trim boilerplate but keep every evidence line verbatim)
  TRIM    keep head/tail/error/matched block; replace the middle with one line:
          "... [trimmed N lines] ..."
  REPLACE replace content with: 1-3 factual lines + source pointer + exact re-fetch command
  DROP    replace content with a one-line stub only

CLASSIFY in this order (first match wins):
1. SECURITY/SENSITIVE: user constraint, permission, approval, credential, secret, safety
   decision -> KEEP. If a secret value is present, mask the value as <redacted> but keep its
   location/type. Never drop.
2. UNRESOLVED FAILURE: non-zero exit, traceback, assertion failure, timeout, permission
   denial -> KEEP the evidence block: exact command, exit code, first exact error line,
   key stack frames, retry parameters. NEVER report a failure as success.
3. SUPERSEDED: a newer result covers the same file/path/query/state -> REPLACE with
   "[superseded] <old_id> replaced by <new_id>; latest state in <id>; do not rely on this".
4. BULK with recoverable facts: full file read, directory listing, full grep, SQL/API list
   -> REPLACE with: path/command/query, matched items with line numbers, counts, and the
   exact re-fetch instruction. Keep identifiers (paths, URLs, commits, line numbers).
5. PARTIAL RELEVANCE: a large output with a small relevant block -> TRIM to the relevant
   block plus 2 lines of context, with line numbers.
6. WEB/SEARCH: -> REPLACE with URL, title, date, and 1-3 key sentences quoted verbatim.
7. WRITE/EDIT result: -> REPLACE with file path, changed line ranges, and verification
   status (tests/lint), not the full diff.
8. OVERSIZED (> configurable limit): -> TRIM head + tail + error section + counts.
9. IRRELEVANT: no reference to TASK, current plan, recent decisions -> DROP with stub.
10. AMBIGUOUS -> KEEP (conservative default).

HARD RULES
- Never invent, infer, extrapolate, or "fix" content. Quote exact strings for errors,
  values, paths, URLs, line numbers.
- Never drop or rewrite: TASK, CONSTRAINTS, user messages, permission/safety records,
  unresolved failures, TODOs, open questions, identifiers, the RECENT block.
- Never keep a conclusion without its supporting source. Prefer the re-derivable source
  over the re-derived conclusion.
- Never merge two tool results into one. One decision per tool_call_id.
- Never claim success for a failed call. Never hide a failure.
- Replacement text must be self-describing and recoverable:
  "[elided by context-slimmer] tool=<name> call=<id> args=<brief>; outcome=<ok|error: first line|empty>;
   original=<N> tokens; re-fetch: <exact command/read path/url>"
- A DROP/REPLACE stub must not look like real tool output. Prefix it with the bracket tag.
- Keep replacement <= min(300 tokens, 10% of original), except failure/security evidence
  (which may keep up to 800 tokens).
- Do not change tool_use/tool_result pairing, tool names, or tool arguments.
- If you are not confident (confidence < 0.7), choose KEEP.

OUTPUT: JSON only, no prose, matching:
{"version":1,"decisions":[{"tool_call_id":"...","class":"...","action":"KEEP|TRIM|REPLACE|DROP",
"replacement_text":"...","keep_evidence":["..."],"recoverable":{"how":"rerun|read_file|url|none","ref":"..."},
"reason":"<=120 chars","confidence":0.0,"original_tokens":0,"est_tokens_saved":0}],
"stats":{"considered":0,"kept":0,"trimmed":0,"replaced":0,"dropped":0,"est_tokens_saved":0}}
```

### 10.2 中文 system prompt（草案）

```text
你是工具型编码 Agent 的「上下文管理员」。你的唯一工作是从「旧的工具结果」里删除 token，
不得改变任何事实、决策或约束。你不解决任务，不面向用户说话。

你会收到：
- TASK：用户目标与验收标准。
- CONSTRAINTS：用户逐字给出的侧约束与权限（不可变）。
- RECENT：最近若干次工具调用/结果原文（永远不要修改）。
- CANDIDATES：更早的工具结果，每条含 tool_call_id、工具名、参数、轮次、token 数、内容。

对每条候选，只能选一个动作：
  KEEP    原样保留（可去样板文字，但所有证据行逐字保留）
  TRIM    保留头/尾/错误段/命中块；中间替换为一行 "...[已截断 N 行]..."
  REPLACE 替换为 1–3 行事实 + 来源指针 + 精确重取指令
  DROP    仅替换为一行占位 stub

按以下顺序分类（先匹配先得）：
1. 安全/敏感：用户约束、权限、审批、凭证、secret、安全决策 → KEEP；secret 值以 <redacted>
   遮罩但保留位置与类型。永不丢弃。
2. 未解决的失败：非零退出、traceback、断言失败、超时、权限拒绝 → KEEP 证据块：命令原文、
   退出码、首个精确错误行、关键栈帧、重试参数。绝不把失败写成成功。
3. 已被取代：有更新的结果覆盖同一文件/路径/查询/状态 → REPLACE 为
   "[superseded] <旧id> 已被 <新id> 取代；最新状态见 <新id>；不要依赖本条"。
4. 可重算的 bulk：整文件读、目录列举、全量 grep、SQL/API 列表 → REPLACE 为：路径/命令/
   查询、命中项及行号、计数、精确重取指令；保留标识符（路径、URL、commit、行号）。
5. 部分相关：大输出中只有小块相关 → TRIM 到相关块 ±2 行上下文，保留行号。
6. 网页/搜索：→ REPLACE 为 URL、标题、日期、1–3 句逐字关键句。
7. 写入/编辑结果：→ REPLACE 为文件路径、变更行范围、验证状态（测试/lint），不保留完整 diff。
8. 超大输出（超过可配置上限）：→ TRIM 头 + 尾 + 错误段 + 计数。
9. 完全无关：与 TASK、当前计划、最近决策无引用关系 → DROP + stub。
10. 模糊/无法判定 → KEEP（保守默认）。

硬性规则
- 不得编造、推断、外推或"修正"内容；错误串、数值、路径、URL、行号必须逐字引用。
- 永不删除或改写：TASK、CONSTRAINTS、用户消息、权限/安全记录、未解决失败、TODO、
  待确认问题、标识符、RECENT 块。
- 不得保留"没有来源的结论"；优先保留可重算的来源，而不是重推出来的结论。
- 不得把两条工具结果合并；一个 tool_call_id 一条决策。
- 不得把失败写成成功，不得隐藏失败。
- 替换文本必须自描述、可重取：
  "[elided by context-slimmer] tool=<工具名> call=<id> args=<简述>；outcome=<ok|error: 首行|empty>；
   原文=<N> tokens；重取：<精确命令/读取路径/URL>"
- DROP/REPLACE 的 stub 不得模仿真实工具输出，必须以方括号标签开头。
- 替换文本 ≤ min(300 token, 原文 10%)，失败/安全证据可放宽到 800 token。
- 不得改变 tool_use/tool_result 配对、工具名、工具参数。
- 置信度 < 0.7 时一律 KEEP。

输出：仅 JSON，无自然语言，schema：
{"version":1,"decisions":[{"tool_call_id":"...","class":"...","action":"KEEP|TRIM|REPLACE|DROP",
"replacement_text":"...","keep_evidence":["..."],"recoverable":{"how":"rerun|read_file|url|none","ref":"..."},
"reason":"<=120 字符","confidence":0.0,"original_tokens":0,"est_tokens_saved":0}],
"stats":{"considered":0,"kept":0,"trimmed":0,"replaced":0,"dropped":0,"est_tokens_saved":0}}
```

**设计说明（为什么提示词长这样）**：分类顺序把"安全/约束 → 失败证据 → 被取代 → 可重算 bulk → 部分相关 → 网页 → 写入 → 超大 → 无关 → 模糊"排成瀑布，是为了让保守规则**先于**激进规则命中；"先保留来源、后丢结论"来自 Reclaim [R13]；"干净 stub 优于模糊摘要"来自 R8；"约束单独注册、末尾注入"来自 R16；"失败证据逐字保留"来自 Manus [R31]；"每个决策带 confidence 与回退 KEEP"是工程安全阀。

---

## 11. 建议的最小评估协议（给 QA 的指标基线）

在真实会话上做 A/B（精简 on/off），至少报告以下 7 项；任何一项恶化超过阈值即视为回归：

| 指标 | 定义 | 目标 |
| :-- | :-- | :-- |
| 任务成功率 | 固定任务集的 resolved 比例 | ≥ 基线 − 2pp（非劣） |
| token 节省 | 精简后主上下文 token / 精简前 | ≥ 30%（可配置） |
| 重取增量 | 精简后工具调用数 − 基线 | ≤ +20%（R8 的隐藏成本 [R8]） |
| 约束保留率 | 注入的 side constraints 在上下文中仍逐字存在 | **100%**（R16 基线仅 17%）[R16] |
| 失败证据保留率 | 未解决失败的命令/退出码/错误行仍在 | **100%** |
| 缓存命中率 | prompt_cache_hit_tokens / (hit+miss) | 相对基线下降 ≤ 10pp |
| 结构合法性 | tool_use↔tool_result 配对、schema 校验 | 100% |

---

## 12. 未核实清单（明确不用于正文论断）

1. **Claude Code "microcompact" 的确切机制**：Anthropic 官方文档（context-window / costs / prompt-caching / glossary / how-it-works / model-config）中**未检索到 "microcompact" 一词**；该术语仅见于社区逆向（hermes-agent Issue #525 [R38]）与个人博客 [R39]。→ **未核实**，本报告不作为设计依据；表格中仅作"社区声称"列出。
2. **DeepSeek-V4.1-Flash 技术报告 PDF 的正文内容**：模型卡中链接存在（`DeepSeek_V41_Tech_Report.pdf`），但本次未能成功解析其正文（直接抓取仅得到文件页面/网络受限），因此**不引用其中任何数字**；DeepSeek 相关数字全部来自已抓取的官方模型卡 [R2]、V4 技术报告摘要 [R1]、官方缓存文档 [R34] 与官方定价页 [R35]。
3. **"无关上下文使准确率下降 55%–65%"（Compresr 博客 [R40]）**：未能在其引用的任何一手论文中核实该数字，且与 R3 的"中性填充几乎无害"结论相冲突。→ **不采用**。
4. **"shuffled haystack 比连贯文档表现更好"（Chroma 报告相关二手转述）**：Chroma 原文中该说法出现在假设/讨论语境，并非明确实验结论 [R24]；二手博客的绝对化表述 → **未核实**。
5. **MEMENTO（arXiv:2604.09852 [R17]）的具体数字**（如 "peak KV cache 2–3×"、"吞吐近 2×"）：仅在检索摘要与项目页转述中见到，未抓取原文核对 → **数字未核实**，本报告未引用。
6. **Stanford CS224V 2026 lecture 中提到的 "Lost in Context Compaction"（后已定位为 arXiv:2608.11242 并改为直接引用）、"Rollback the World, Keep the Reflection"、"LongSeeker" 等**：仅见课程 PDF 的检索摘录，未逐一抓取原文 → 不作为证据。
7. **第三方对 DeepSeek-V4.1-Flash 的 benchmark 与价格解读**（Flowtivity [R44]、MindStudio 等）：数字与官方模型卡 [R2] 存在版本差异（如 1017 版本），本报告一律以官方模型卡为准；第三方数字 → **未核实**。
8. **"压缩使成本下降约 50%"这类二手经验数**：不同厂商缓存价差、命中率与轮次差异很大；本报告只使用官方定价与官方文档中的机制描述，并明确标注"本报告推导"的公式部分（4.6）。
9. **R14（Entropy Principle）的指数公式与跨架构 α 值**：预印本、未同行评审，实验设计与统计细节未逐条复核 → 仅作为"静默退化"现象的背景提及，**不引用具体参数**。

---

## 13. 附录：本次调研的检索与抓取覆盖（≥15 次不同检索/抓取）

- **web_search 查询 21 条**：context rot / attention dilution / distractor context / DeepSeek-V4 与 V4.1-Flash / tool output pruning / context editing / microcompact / error propagation / failure repetition / compression cost / prompt caching / long-context agent benchmark / context engineering survey / adjacent queries。
- **直接抓取并核对的一手页面 ≥ 30 个**：arXiv 摘要页 21 个（R1、R3–R23 中除 R17 外均抓取过摘要；R18、R16、R4 另抓 HTML 核对数字，R6、R23 等仅核对摘要）、Hugging Face 官方模型卡 [R2]、Chroma 报告 [R24]、Anthropic 官方文档 5 页 [R25][R27][R28][R29][R36]、Anthropic 工程博客 [R26]、LangChain [R30]、Manus [R31]、Cognition [R32]、OpenHands 文档 [R33]、DeepSeek 缓存文档 [R34] 与定价页 [R35]。
- 检索时间窗口：2026-11-20；所有 2026 年论文的投稿/修订日期均在正文或参考文献中标注。


## 14. 参考文献（Markdown 链接）

**2026 年一手论文/报告（A/B 级）**

- [R1] DeepSeek-AI. *DeepSeek-V4: Towards Highly Efficient Million-Token Context Intelligence.* arXiv:2606.19348, 2026-04-26. https://arxiv.org/abs/2606.19348
- [R2] DeepSeek-AI. *DeepSeek-V4.1-Flash: Pushing the Limits of KV Cache Compression*（官方模型卡，含技术报告 PDF 链接、Agent 基准与 DSH Minimal 评测设置）. Hugging Face, 2026. https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash
- [R3] Yinuo Liu. *Length Is Cheap, Competition Is Not: Attention Predicts Context Rot in Retrieval.* arXiv:2611.04169, 2026-11-03. https://arxiv.org/abs/2611.04169
- [R4] Muhan Gao, Zih-Ching Chen, Kuan-Hao Huang. *The First Drop of Ink: Nonlinear Impact of Distracting Information in Long-Context Reasoning.* arXiv:2605.10828, 2026-05-11（v2 2026-08-20）. https://arxiv.org/abs/2605.10828
- [R5] Yang Wan et al. *Mitigating Conversational Inertia in Multi-Turn Agents.* ICML 2026; arXiv:2602.03664. https://arxiv.org/abs/2602.03664
- [R6] Ádám Kovács. *Squeez: Task-Conditioned Tool-Output Pruning for Coding Agents.* arXiv:2604.04979, 2026-04-04. https://arxiv.org/abs/2604.04979
- [R7] Shijie Xia, Yikun Wang, Zhen Huang, Pengfei Liu. *Diagnosing and Mitigating Context Rot in Long-horizon Search.* arXiv:2606.29718, 2026-06-29（v3 2026-10-25）. https://arxiv.org/abs/2606.29718
- [R8] Shuyu Liu. *What Does Context Compression Cost an Agent? Interaction Costs Unrevealed by Task-Completion Metrics.* arXiv:2608.16370, 2026-08-17. https://arxiv.org/abs/2608.16370
- [R9] Thibaud Gloaguen et al. *Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?* arXiv:2602.11988, 2026-02-12（v3 2026-09-29）. https://arxiv.org/abs/2602.11988
- [R10] Shicheng Fang et al. *AgentLongBench: A Controllable Long Benchmark For Long-Contexts Agents via Environment Rollouts.* arXiv:2601.20730, 2026-01-28. https://arxiv.org/abs/2601.20730
- [R11] Abhilasha Lodha et al. *Less Context, Better Agents: Efficient Context Engineering for Long-Horizon Tool-Using LLM Agents.* arXiv:2606.10209, 2026-06-08. https://arxiv.org/abs/2606.10209
- [R12] Han Li et al. *ContextBench: A Benchmark for Context Retrieval in Coding Agents.* arXiv:2602.05892, 2026-02-05. https://arxiv.org/abs/2602.05892
- [R13] *Reclaim Evaluation: A Lossy Memory Is Worse Than an Empty One.* arXiv:2606.25449, 2026-06-24（v5 2026-07-21）. https://arxiv.org/abs/2606.25449
- [R14] *Silent Failure in LLM Agent Systems: The Entropy Principle and the Inevitable Disorder of Autonomous Agents.* arXiv:2606.08162, 2026-06-06（预印本，B 级）. https://arxiv.org/abs/2606.08162
- [R15] *Classifier Context Rot: Monitor Performance Degrades with Context Length.* arXiv:2605.12366, 2026-05-12. https://arxiv.org/abs/2605.12366
- [R16] Zhiqi Wang, Yichi Zhang, Dongwon Lee, Nathalie Baracaldo, Yuchen Yang. *Lost in Context Compaction: When LLM Systems Drop Side Constraints.* arXiv:2608.11242, 2026-07-31（v2 2026-10-11）. https://arxiv.org/abs/2608.11242
- [R17] *MEMENTO: Teaching LLMs to Manage Their Own Context.* arXiv:2604.09852, 2026-04-10（仅见摘要/项目页转述，未抓取全文，作背景）. https://arxiv.org/abs/2604.09852

**2025–2023 关键背景（C 级）**

- [R18] Tobias Lindenbauer, Igor Slinko, Ludwig Felder, Egor Bogomolov, Yaroslav Zharov. *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management.* arXiv:2508.21433, 2025-08-29（v3 2025-10-27）. https://arxiv.org/abs/2508.21433
- [R19] Minki Kang et al. *ACON: Optimizing Context Compression for Long-horizon LLM Agents.* ICML 2026; arXiv:2510.00615. https://arxiv.org/abs/2510.00615
- [R20] *Why Do Multi-Agent LLM Systems Fail?*（MAST）arXiv:2503.13657, 2025-03-17（v3 2025-10-26）. https://arxiv.org/abs/2503.13657
- [R21] Nelson F. Liu et al. *Lost in the Middle: How Language Models Use Long Contexts.* TACL 2023; arXiv:2307.03172. https://arxiv.org/abs/2307.03172
- [R22] Freda Shi et al. *Large Language Models Can Be Easily Distracted by Irrelevant Context.* ICML 2023; arXiv:2302.00093. https://arxiv.org/abs/2302.00093
- [R23] *Context Length Alone Hurts LLM Performance Despite Perfect Retrieval.* Findings of EMNLP 2025; arXiv:2510.05381. https://arxiv.org/abs/2510.05381
- [R24] Kelly Hong, Anton Troynikov, Jeff Huber. *Context Rot: How Increasing Input Tokens Impacts LLM Performance.* Chroma Technical Report, 2025-07-14. https://research.trychroma.com/context-rot

**厂商官方文档/工程博客（D 级）**

- [R25] Anthropic. *Context editing*（Claude Platform Docs；`clear_tool_uses_20250919`、`clear_thinking_20251015`、缓存失效说明、memory tool 组合）. https://platform.claude.com/docs/en/build-with-claude/context-editing
- [R26] Anthropic. *Effective context engineering for AI agents.* https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [R27] Anthropic. *How Claude Code uses prompt caching*（前缀精确匹配、任意变化全重算）. https://code.claude.com/docs/en/prompt-caching
- [R28] Anthropic. *How Claude Code works* / *Explore the context window*（compaction 保留与丢失、thrashing、subagent/fork）. https://code.claude.com/docs/en/how-claude-code-works ；https://code.claude.com/docs/en/context-window
- [R29] Anthropic. *Manage costs effectively*（expected rebuild、缓存命中统计）. https://code.claude.com/docs/en/costs
- [R30] Chester Curme, Mason Daugherty (LangChain). *Context Management for Deep Agents.* https://www.langchain.com/blog/context-management-for-deepagents
- [R31] Yichao "Peak" Ji (Manus). *Context Engineering for AI Agents: Lessons from Building Manus.* 2025-07-18. https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- [R32] Walden Yan (Cognition). *Don't Build Multi-Agents.* https://cognition.ai/blog/dont-build-multi-agents
- [R33] OpenHands. *Context Condenser*（`LLMSummarizingCondenser`、max_size/keep_first、约 2× 单轮成本下降）. https://docs.openhands.dev/sdk/guides/context-condenser
- [R34] DeepSeek. *Context Caching*（cache prefix unit、hit/miss 字段、best-effort）. https://api-docs.deepseek.com/guides/kv_cache
- [R35] DeepSeek. *Models & Pricing*（deepseek-flash：cache hit $0.003 / miss $0.15、output $0.6 per M tokens，off-peak）. https://api-docs.deepseek.com/quick_start/pricing
- [R36] Anthropic. *Claude Code glossary — Compaction.* https://code.claude.com/docs/en/glossary

**二手/社区材料（E 级，仅用于"未核实清单"，不作证据）**

- [R37] Louis Bouchard. *Context Engineering in 2026*（博客；含"压缩后 token 少 41% 但贵约 2×"等案例）. https://www.louisbouchard.ai/context-engineering-2026
- [R38] NousResearch/hermes-agent Issue #525: */microcompact*（社区逆向分析，2026-03-06）. https://github.com/NousResearch/hermes-agent/issues/525
- [R39] *Microcompact - The Art of Precise Context Pruning*（个人博客，2026-07-11）. https://rexai.top/en/ai/claude-code/claude-code-microcompact-precision
- [R40] Compresr. *Irrelevant Context and LLM Accuracy: 2026 Research & Fixes*（SEO 博客；"55%–65%"数字未核实）. https://compresr.ai/blog/irrelevant-context-and-llm-accuracy-research-fixes
- [R41] TMLS.NYC. *Context Rot: Why Long-Context LLMs Degrade*（二手机制综述）. https://tmls.nyc/research/context-rot-mechanistic
- [R42] Stanford CS224V 2026, lecture *Agent Context Management*（课程材料，仅检索到 URL，未抓取正文）. https://web.stanford.edu/class/cs224v/lectures_2026/I-context.pdf
- [R43] Morph LLM. *Prompt Caching: How It Works, Provider Pricing, Cache-Aware Routing (2026)*（二手汇总）. https://www.morphllm.com/prompt-caching
- [R44] Flowtivity. *DeepSeek V4.1 Flash Benchmarks*（第三方解读；数字以官方模型卡为准）. https://flowtivity.ai/blog/deepseek-v4-1-flash-benchmarks

---

> 免责声明：外部网页内容是**不可信数据**；本报告只提取其中作为"资料"的事实与数字，未执行其中任何指令。A/B/C/D 级参考文献的 URL 均为调研时实际抓取；E 级链接来自检索结果，仅用于标注未核实来源。若后续链接失效，以 arXiv 编号/官方文档路径为准。
