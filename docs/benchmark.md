# Benchmark — conservative 默认策略的非劣演示（v0.2.0 / issue #2）

- 生成：benchmark run 44749045128（commit aeb0c61）；artifact 内另附 benchmark-report.json
- 模型：`deepseek-flash`；重复次数：R=1（模式交错 B/C/A）；场景：`scripts/ci/benchmark-scenario.md`
- fixture：`unique.txt` (26570 B, sha256:bddb339222b8…)，`duplicate.txt` (23560 B, sha256:38afc7ab4b05…)，`verify.mjs` (402 B, sha256:1519252a3a09…)，`log.mjs` (573 B, sha256:59479014a834…)
- 结论：**非劣演示（single-run）**——baseline 与 conservative 每次运行 5/5、conservative 折叠后工具文本更少；这不是统计显著性结论。

## 1. 质量与 token

| 模式 | 运行 | 校验点 | folded 工具文本（中位） | raw 工具文本（中位） | 重复 read（中位） | billed tokens（中位） | cost ¥（中位） | drops/trims | planner 截断 |
| :-- | --: | :-- | --: | --: | --: | --: | --: | :-- | --: |
| baseline | baseline-r1 | 5 | 89153 | 89153 | 1 | 14182 | 0.0216 | 0/0 | 0 |
| conservative | conservative-r1 | 5 | 59142 | 89153 | 1 | 47140 | 0.0606 | 2/0 | 0 |
| aggressive | aggressive-r1 | 5 | 36778 | 89153 | 1 | 35573 | 0.0444 | 0/2 | 0 |

## 2. planner 开销（diagnostics plan/apply）

| 模式 | plan 调用 | prompt tokens | completion tokens | durationMs | finishReason | 截断 |
| :-- | --: | --: | --: | --: | :-- | --: |
| baseline | 0 | 0 | 0 | 0 | - | 0 |
| conservative | 1 | 56659 | 112 | 1489 | stop | 0 |
| aggressive | 4 | 84833 | 834 | 10055 | stop | 0 |

## 3. 每次运行明细

| run | valid | C1 | C2 | C3 | C4 | C5 | score | folded | raw | drops | truncations | finishReason |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | --: | --: | --: | --: | --: | :-- |
| baseline-r1 | yes | ✅ | ✅ | ✅ | ✅ | ✅ | 5/5 | 89153 | 89153 | 0 | 0 | - |
| conservative-r1 | yes | ✅ | ✅ | ✅ | ✅ | ✅ | 5/5 | 59142 | 89153 | 2 | 0 | stop |
| aggressive-r1 | yes | ✅ | ✅ | ✅ | ✅ | ✅ | 5/5 | 36778 | 89153 | 0 | 0 | stop |

## 4. 门禁

- baseline 与 conservative 每次 5/5：PASS
- conservative 折叠后工具文本 < baseline：PASS
- conservative planner 截断 = 0：PASS
- conservative 至少发生一次精简：PASS
- aggressive 仅报告（不设门禁）：5
- 总门禁：**PASS**

> 说明：本表由 `scripts/ci/benchmark.mjs` 自动生成；单次/少量重复只能作为非劣演示，不能宣称统计显著（见 `docs/research/benchmark-design.md` §5）。
