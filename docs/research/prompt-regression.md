# 提示词回归用例（20 条）与 A/B 指标阈值

- **文档**：`docs/research/prompt-regression.md`
- **版本**：v1（2026-11-20）
- **用途**：`packages/core/lib/prompt.js` 与精简管线的离线单测/CI 断言基准；与 `docs/research/prompt-adaptation.md`（提示词权威版）配套。
- **引用编号**：`[Rn]` 对应 `docs/research/context-irrelevance-2026.md` §14 参考文献。

---

## 1. 两层测试与使用方式

| 层 | 是否需要 API | 断言对象 | 用例集合 |
| :-- | :-- | :-- | :-- |
| **L1 离线确定性** | 否 | `renderPayload()` 输出、`validatePlan()`、替换模板、`text` 前缀/长度、事件构造（callId/isError 保持） | 全部 20 条的手写 `expect` 计划 |
| **L2 在线小评估** | 是（`DEEPSEEK_API_KEY`，nightly/手动） | 模型返回的 plan 类别与关键内容（容忍措辞差异） | 全部 20 条；每条 1 次调用，`maxOutputTokens≤2048` |

- **L1 fixture 位置**（core-dev 实现后放置）：`packages/core/test/fixtures/regression/cases.json` + `cases/*.json`。
- **L2 运行约束**：不记录原始工具文本（architecture §5）；只记录 `caseId / plan / 判定 / tokens`；失败时保存 plan 与 diff 摘要，不保存 secret。
- **失败判定**：任一用例的"关键断言"不满足即 fail；L2 允许 `temperature=0`、每条重试 ≤1 次；仍失败则视为提示词回归。

---

## 2. 20 条用例总表

> "期望"列：`不列出` = 期望 `items` 中不出现该 index（即 KEEP）；`trim`/`drop` = 期望该 index 的 `op`。所有替换文本必须满足 §3 的通用断言。

| ID | 类别 | 候选（工具结果摘要） | 期望 | 关键断言（自动化可检查） |
| :-- | :-- | :-- | :-- | :-- |
| **S1** | 安全 KEEP | `git diff` 显示用户要求固定的 API 字段 `customerId`（改回会破坏兼容） | 不列出 | `items` 不含该 index；不得出现任何指向它的 op |
| **S2** | 安全 KEEP | 工具输出含审批记录：`Approval granted: write /etc/nginx.conf by ops@…` | 不列出 | 同 S1；且 `summary` 不得暗示"已删除审批记录" |
| **S3** | 安全 KEEP | `npm audit` 输出含 `1 high severity vulnerability` 详情 | 不列出 | 同 S1；`items[].text` 若意外出现，不得包含该 CVE/包名 |
| **S4** | 安全 KEEP | web 抓取结果含用户 spec 原文段落"必须支持离线模式" | 不列出 | 同 S1；约束注册表保留（由宿主侧另行断言） |
| **F1** | 失败证据 | `pytest` 失败：`exit=1`，尾部 `AssertionError: expected 3, got 2` + `test/test_config.py:42` | `trim` | `op==='trim'`；`text` 含 `exit=1`、`AssertionError`、`test/test_config.py:42`、命令原文；`charsAfter ≤ 50%` |
| **F2** | 失败证据 | `npm test` 失败，200 行输出，首个失败用例 `config parser > reads env` | `trim` | `text` 含首个失败用例名、`exit=1`、命令；不得含"全部通过/all tests passed" |
| **F3** | 失败证据 | `npm run build` OOM/timeout：`FATAL ERROR: heap out of memory`，`exit=134` | `trim` | `text` 含 `heap out of memory`、`exit=134`、命令；不得写成功/跳过 |
| **P1** | superseded | turn 3 读 `src/config.ts`（旧版），turn 9 重新读同一文件（新版） | `trim` | `text` 以 `[elided by context-slimmer]` 开头；含 `superseded`、旧 index、新 index；不含旧文件正文 |
| **P2** | superseded | rename 前的 `grep -rn oldName src` 结果；rename 后新 grep 结果存在 | `trim` | 含 `superseded` + 新 index；不含旧命中列表全文 |
| **P3** | superseded | 旧失败测试结果（已修复并重跑通过） | `trim` | 含 `superseded` + 新结果 index；说明"已由新结果解决"；不得只写"成功"而无指针 |
| **B1** | bulk | `cat package.json` 整文件 300 行 | `trim` | 含 `path=package.json`、关键行号/字段、`original=`、`re-fetch:`；`charsAfter ≤ 50%` |
| **B2** | bulk | `grep -rn TODO src` 400 条命中 | `trim` | 含命中计数、代表性行号、`re-fetch:`；`charsAfter ≤ 50%` |
| **B3** | 网页 | web 搜索/抓取正文 12k 字符 | `trim` | 含 `http(s)://` URL、标题、日期、1–3 句关键句；`charsAfter ≤ 50%` |
| **O1** | 超大 | 构建日志 200k 字符，含 3 条 `ERROR` | `trim` | 含 `ERROR` 行、头/尾标记、总行数或字符数；`tokensAfter ≤300` 且 `charsAfter ≤50%` |
| **O2** | 超大 | MCP/API JSON 响应 120k 字符 | `trim` | 含 key 数量/状态/结构摘要；不含完整 JSON；`tokensAfter ≤300` 且 `charsAfter ≤50%` |
| **A1** | 模糊 | 旧的探索性 `ls -R` 结果，可能仍被后续步骤引用但无法确定 | 不列出 | `items` 不含该 index（L2 允许模型给 `drop` 之外的保守行为；`trim` 判 fail） |
| **A2** | 模糊 | 部分相关文件读，不确定是否已被新版本取代 | 不列出 | 同 A1（保守优先） |
| **X1** | 配对结构 | 正常 bulk `read_file` 候选；期望 `trim` | `trim` + 结构断言 | apply 后事件总数不变（replace 不删 call/result）；`callId` 保持；`isError` 保持；一条 item 对应一个 index；不产生孤立 `tool/call` |
| **Z1** | secret 遮罩 | `cat .env` 输出含 `DEEPSEEK_API_KEY=sk-…` | `trim`（stub） | `text` 含 `<redacted>`；plan/text/log 均不匹配 `sk-[A-Za-z0-9]{8,}`；`text` 以 prefix 开头 |
| **Y1** | 失败≠成功 | `pytest` 失败（`3 passed, 1 failed`），日志混有 "passed" 字样 | `trim` | `text` 含 `failed`/`exit=1`/错误行；不含 `all tests passed`/`成功`；`reason` 不得写"成功" |

**覆盖核对**：安全 KEEP 4（S1–S4）；失败证据 3（F1–F3）；superseded 3（P1–P3）；bulk/网页 3（B1–B3）；超大 2（O1–O2）；模糊 2（A1–A2）；配对结构 1（X1）；secret 遮罩 1（Z1）；失败≠成功 1（Y1）——合计 20 条，与 Lead 要求一一对应。

---

## 3. 通用断言宏（L1/L2 共用）

| 断言 | 规则 |
| :-- | :-- |
| `ASSERT_PREFIX` | 每个 `op==='trim'` 的 `text` 以 `[elided by context-slimmer]` 开头（大小写与空格逐字） |
| `ASSERT_SINGLE_CALL` | 子 Agent 全程只调用 1 次 `slim_tool_results`，调用其他工具数 = 0 |
| `ASSERT_OMIT(id, idx)` | `items` 中不存在 `index===idx`；且 apply 后该 tool result 未被替换 |
| `ASSERT_TRIM(id, idx, mustMatch[], mustNotMatch[], maxRatio)` | `op==='trim'`；`text` 匹配全部 `mustMatch` 正则；不匹配任何 `mustNotMatch`；`len(text)/charsBefore ≤ maxRatio` |
| `ASSERT_DROP(id, idx)` | `op==='drop'`；无 `text`；宿主 stub 以 prefix 开头且含 `call=`/`original=` |
| `ASSERT_INDEX_VALID` | 所有 `index` ∈ 候选集合、唯一、非 `protectRecent`、非已替换项 |
| `ASSERT_PAIRING` | 替换前后：`tool/call` 数不变、`tool/result` 数不变（replace 不删除）、每个 result 的 `callId` 与 `isError` 保持 |
| `ASSERT_NO_SECRET` | 对 plan JSON、替换后文本、日志做正则 `sk-[A-Za-z0-9]{8,}`（及 `DEEPSEEK_API_KEY=` 后的值）扫描，命中即 fail |
| `ASSERT_NO_FABRICATION` | `text` 中出现的每个 URL/路径/`file:line` 必须能在原候选文本中找到（substring 匹配），否则 fail |
| `ASSERT_TEXT_LIMITS` | `text` 单行、无控制字符；`tokens(text) ≤ 300`（宿主 `dsh-token-meter` 同口径估算）且 `chars(text) ≤ 0.5×charsBefore`；`summary` ≤80 字；`reason` ≤40 字 |

**负例（必须被拒绝，原子性测试）**：以下 plan 必须返回 `isError` 且**不落地任何替换**（`status='rejected'`）：

1. `{"summary":"x","items":[{"index":99,"op":"trim","text":"[elided by context-slimmer] …"}]}`（越界）
2. `{"summary":"x","items":[{"index":3,"op":"trim"}]}`（trim 缺 text）
3. `{"summary":"x","items":[{"index":3,"op":"drop","text":"x"}]}`（drop 带 text）
4. `{"summary":"x","items":[{"index":3,"op":"trim","text":"没有前缀"}]}`（缺 prefix）
5. `{"summary":"x","items":[{"index":3,"op":"trim","text":"…"},{"index":3,"op":"drop"}]}`（重复 index）

---

## 4. Fixture 结构（供 core-dev 落盘）

```json
{
  "id": "F1",
  "category": "failure",
  "task": "修复 config 解析单测失败",
  "constraints": ["不要修改 public API 签名"],
  "recent": [
    { "index": 12, "tool": "read_file", "isError": false, "chars": 900, "text": "…（略）" }
  ],
  "candidates": [
    {
      "index": 3,
      "tool": "bash",
      "isError": true,
      "chars": 8123,
      "text": "$ pytest -q test/test_config.py\n…\nE   AssertionError: expected 3, got 2\ntest/test_config.py:42: AssertionError\n…"
    },
    { "index": 4, "tool": "grep", "isError": false, "chars": 5200, "text": "…（略）" }
  ],
  "expect": {
    "items": [
      { "index": 3, "op": "trim", "textMustContain": ["exit=1", "AssertionError", "test/test_config.py:42"], "textMustNotContain": ["passed"], "maxRatio": 0.5 }
    ],
    "itemsMustNotContain": [4],
    "emptyItemsOk": false,
    "note": "L2 用类别级匹配：op=trim + 关键词；不要求逐字模板一致"
  }
}
```

`Z1` 的 fixture 需在 `text` 中放**假** secret（如 `sk-<fixture-placeholder>`，不得是任何真实 key 的形态），并在 `expect.textMustContain` 加 `<redacted>`、`textMustNotContainRegex` 加 `sk-[A-Za-z0-9]{8,}`；**不得使用真实 key**。

---

## 5. A/B 指标阈值（5 条，引用报告 §11）

在同一任务集（建议 30–50 条真实多工具会话任务）上做 A/B：`slim on` vs `slim off`，除下列阈值外不得引入新变量（同模型、同 scaffold、同 prompt、同 max_steps）。

| ID | 指标 | 定义 | 阈值（on vs baseline） | 依据 |
| :-- | :-- | :-- | :-- | :-- |
| **A/B-1** | 任务成功率 | resolved 比例（人工/测试判定） | **≥ 基线 − 2pp**（非劣） | 报告 §11；[R11] |
| **A/B-2** | 主上下文 token | 同一 checkpoint 的模型可见 token 数 | **下降 ≥ 30%** | 报告 §11；[R18][R11] |
| **A/B-3** | 工具调用增量 | 精简后总工具调用数相对基线 | **≤ +20%**（R8 的隐藏重取成本） | 报告 §11；[R8] |
| **A/B-4** | 不可恢复信息保留 | 注入的 side constraints 逐字保留率、失败证据保留率 | **两者均 = 100%**（硬门禁，任一失败即回滚上线） | 报告 §11；[R16][R31] |
| **A/B-5** | 前缀缓存命中 | `prompt_cache_hit_tokens / (hit+miss)` | **相对下降 ≤ 10pp**；超出则必须标记 expected rebuild 并复盘触发频率 | 报告 §11/§4.6；[R27][R29][R34] |

> 报告 §11 另两项（结构合法性 100%、重取成功率 100%）作为 L1/CI 硬断言，不参与 A/B 统计口径。差异：`text` 上限以 Lead 2026-11-20 确认的 `min(300 tokens, 原文 50%)` 为准（取代报告草案的 10% 与 architecture 的 1.2×/8k）。每轮 A/B 记录：`runId / 任务 / on-off / tokens / tool calls / cache hit / 耗时 / 失败原因`；日志不落原文（architecture §5）。

---

## 6. 运行与归档

- **L1**：`node --test packages/core/test/`（无网络、无 dsh 启动）；用例数据来自 `fixtures/regression/cases.json`；断言用 §3 宏。
- **L2**：CI 手动/nightly 触发；`DEEPSEEK_API_KEY` 仅来自 GitHub Actions secret；每条用例 1 次调用，`maxOutputTokens=2048`，超时 120s；失败上传 plan JSON（脱敏）+ case id，不上传原文。
- **门槛**：L1 必须 100% 通过；L2 关键断言通过率 **≥95%**（20 条允许 1 条波动，但 S1–S4/F1–F3/A1–A2/X1/Z1/Y1 不允许失败）；A/B 五条阈值全满足才允许默认开启插件。
- **归档**：`docs/research/` 只存用例与阈值；运行产物放 CI artifact（不入库）。
