# Benchmark — conservative 默认策略的非劣演示（v0.2.0 / issue #2）

> 本文件由 `scripts/ci/benchmark.mjs` 在真实 CI 运行后自动生成（候选内容写到
> `/tmp/ci-artifacts/benchmark.md`，workflow 通过 `--write-doc` 同步到本路径并作为
> artifact 上传）。CI 只生成、不自动提交；发布前从 artifact 取回并提交。
>
> 最近一次真实运行：_尚未运行（等 core/ui 的 v0.2.0 实现落地后由 Lead 触发
> `benchmark.yml`）_。

## 场景与方法（摘要）

- 单一复合场景 `scripts/ci/benchmark-scenario.md`，一次会话覆盖四类输出：
  1. 唯一大文件 `scripts/ci/bench/fixture/unique.txt`（26,570 B，中部含 C1/C2）；
  2. 重复大文件 `scripts/ci/bench/fixture/duplicate.txt`（23,560 B，读两遍，保留副本含 C4）；
  3. 确定性失败命令 `node scripts/ci/bench/fixture/verify.mjs`（`ERR_BENCH_42` / exit 42 = C3）；
  4. 两条逐字相同的高重复日志 `node scripts/ci/bench/fixture/log.mjs`（唯一行 `BACKUP_SLOT=blue-17` = C5），
     尾部再加 3 条无关调用把重复对推出 `protectRecent`。
- 5 个校验点写成最终 JSON：`unique_code` / `atlas_port` / `failure` /
  `maint_token` / `backup_slot`，CI 做字段级精确匹配。
- 三模式：`baseline`（插件 disabled）、`conservative`（v0.2.0 默认策略）、
  `aggressive`（v0.1 lossy 策略，仅报告）。push 默认 R=1，`workflow_dispatch`
  可设 `repetitions=3`；交错执行 B/C/A。
- 硬门禁：baseline 与 conservative 每次 5/5；conservative 折叠后工具文本 <
  baseline；conservative planner 截断 = 0 且至少发生一次 drop；aggressive 不设门禁。
- 结论措辞：**非劣演示（single-run / R=N）**，不是统计显著。

## 生成方式

```bash
# CI（真实 API 调用，受 secret gate 保护）
gh workflow run benchmark.yml -f repetitions=1
# 本地 dry-run（无网络、无模型调用）
node scripts/ci/benchmark.mjs --dry-run
```

产物：`/tmp/ci-artifacts/benchmark-report.json`（每次 run 全量指标）、
`/tmp/ci-artifacts/benchmark.md`（本文件内容）、`/tmp/ci-artifacts/benchmark-summary.md`
（job summary 表格）。
