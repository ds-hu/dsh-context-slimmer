# CI / verification

This document describes the two GitHub Actions workflows and the `scripts/ci/*`
helpers that verify `@ds-hu/dsh-context-slimmer` end to end. The design goal is
simple: **one real, cost-capped DSH session must prove that the plugin slimmed a
tool result through the harness-native replacement protocol, and the user-visible
transcript must be unchanged.** Everything else (screenshots, reports, logs)
exists to make a failure debuggable without re-running the paid step.

CI never needs a local DSH profile, never prints or stores the API key, and never
mutates the user's real `$DSH_HOME`. It uses a throw-away home
(`$RUNNER_TEMP/dsh-home`) and a throw-away profile.

---

## 1. Files

| Path | Purpose |
| --- | --- |
| `.github/workflows/verify.yml` | `static` + `gate` + `e2e` jobs (see §3) |
| `.github/workflows/benchmark.yml` | v0.2.0 baseline/conservative/aggressive benchmark (see §12.4) |
| `.github/workflows/publish.yml` | tag push → npm publish order + GitHub Release (see §7) |
| `scripts/ci/prepare-profile.sh` | builds the temporary DSH profiles, links the local packages, writes the generated `cordis.patch.yml`, probes `GET /models` |
| `scripts/ci/run-scenario.sh` | runs one real fixed headless session, collects the plain-JSONL log, registers the session for the Web GUI |
| `scripts/ci/assert-slimming.mjs` | offline hard gate over the session log (`--self-test` for CI) |
| `scripts/ci/screenshot.mjs` | opens `dsh web`, captures the Chinese chat row + Plugins panel + v0.2.0 config page |
| `scripts/ci/benchmark.mjs` | composite benchmark: modes, 5 checkpoints, hard gates, generated markdown/report (§12.4) |
| `scripts/ci/benchmark-scenario.md` + `scripts/ci/bench/fixture/` | deterministic composite benchmark prompt and fixtures (unique/duplicate files, failing command, repeated log) |
| `scripts/ci/slimmer-config.default.json` | the v0.2.0 conservative row config used by both workflows (see §3) |
| `scripts/ci/scan-secrets.sh` | credential-shaped-material scanner (also invoked with `--publish`) |

All helpers support `--dry-run` (validate wiring, no network/model cost), use
`set -euo pipefail`, and skip cleanly with exit code `3` when
`DEEPSEEK_API_KEY` is absent.

---

## 2. Required repository secrets / settings

| Name | Used by | Notes |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `verify.yml` → e2e, `benchmark.yml` → benchmark, `prepare-profile.sh` probe, `run-scenario.sh` | Only value that costs money. Never printed, never written to a file. |
| `NPM_TOKEN` | `publish.yml` | npm automation token with publish rights on `@ds-hu`. Injected as `NODE_AUTH_TOKEN` via `actions/setup-node`'s `registry-url`. |

Both are configured in the `ds-hu/dsh-context-slimmer` repository settings.

**Fork pull requests do not receive repository secrets.** That is why `verify.yml`
has a separate `gate` job which writes `has_secret=true/false` to a job output,
and the paid `e2e` job has `needs: [static, gate]` +
`if: needs.gate.outputs.has_secret == 'true'`. Secrets cannot be referenced in a
job-level `if:`, hence the gate job. On a fork PR the workflow still runs the
`static` job; `e2e` is skipped and the check stays green.

---

## 3. `verify.yml` jobs and manual dispatch inputs

### `static` (no secrets, every push/PR incl. forks)

checkout → setup Node **24** (`dsh` declares `engines.node >= 24.9.0`) →
`npm ci` when `package-lock.json` exists, otherwise `npm install --no-audit --no-fund`
→ `npm run test:core` / `test:module` / `test:pack` (each tolerant during
bring-up and logged as a warning) → `bash -n scripts/ci/*.sh` →
`node --check` every `scripts/ci/*.mjs` → `assert-slimming.mjs --self-test
--allow-builtin-fold` + `benchmark.mjs --self-test` → `prepare-profile.sh` /
`run-scenario.sh` / `benchmark.mjs` / `screenshot.mjs` `--dry-run` → Ruby YAML
parse of every workflow → `scan-secrets.sh`.

The static job intentionally does not need the `@deepseek-ai/dsh` install: every
check it runs is offline.

### `e2e` (needs `DEEPSEEK_API_KEY`, skipped on forks)

1. checkout, setup Node 24, cache `~/.npm` + `~/.cache/ms-playwright`
2. `npm ci` (fallback `npm install`), install the **exact** `@deepseek-ai/dsh`
   version (`dispatch` input, else derived from the repo manifests, else the
   current pin `0.2.2-rc.1`)
3. install Playwright 1.64.1 + Chromium (best effort; failure disables only the
   screenshot steps, never the log gate)
4. `prepare-profile.sh --profile ci-headless --template headless --probe-model`
   (creates the profile, links the workspace packages, probes `/models`)
5. `prepare-profile.sh --profile ci-web --template web --no-probe-model`
6. `run-scenario.sh` — one real headless session that reads the large fixture
   twice (byte-identical pair), runs eight deterministic small commands, then
   failing `bash false`, the optional `web_search` and `bash sleep 25`. The
   conservative AND-trigger (≥12 new results AND ≥24,000 new chars) fires and
   the `sleep 25` gives the host-side direct planner batch a deterministic
   window to land before the one-shot session exits.
7. `assert-slimming.mjs` — **hard gate**: the log protocol checks plus
   `--require-no-subagents` (zero `subagent/*` events) and `--diagnostics`
   (`no-planner-truncated` / `planner-observability`); a failure fails the job
8. `dsh web` (localhost, tokenized URL parsed from its log) +
   `screenshot.mjs` — UI text assertions are non-fatal (see §5)
9. upload `verify-evidence-<run_id>` with `if: always()`; write the assertion
   report into the job summary

### Dispatch inputs

| Input | Default | Effect |
| --- | --- | --- |
| `model` | `''` | Overrides the probed model id |
| `dsh_version` | `''` | Exact `@deepseek-ai/dsh` version to install |
| `node_version` | `24` | Node major used by both jobs |
| `slimmer_config` | `scripts/ci/slimmer-config.default.json` | JSON written into the plugin row config |
| `include_web_search` | `true` | Adds one `web_search` step (costs one extra model turn) |
| `screenshot` | `true` | Starts `dsh web` and captures screenshots |
| `run_e2e` | `true` | Rehearsal switch: run only the static job |

CI plugin config comes from `scripts/ci/slimmer-config.default.json` (the
`workflow_dispatch` input `slimmer_config` overrides it when set). It carries the
v0.2.0 conservative defaults so the scenario exercises production behaviour:

```json
{
  "enabled": true,
  "policy": "conservative",
  "everyNToolCalls": 12,
  "minChars": 24000,
  "protectRecent": 3,
  "minTargetChars": 4096,
  "maxTargets": 4,
  "timeoutMs": 180000,
  "includeSubagents": true,
  "triggerOnErrorOnly": false,
  "promptLocale": "zh",
  "model": {},
  "diagnosticsFile": "/tmp/ci-artifacts/slimmer-diagnostics.jsonl"
}
```

The trigger is an **AND**: at least 12 new tool results *and* at least 24,000 new
characters since the last run. The scenario produces 13 calls and ~51k
characters, so it fires exactly once: the two byte-identical large reads are
eligible targets (both above `minTargetChars: 4096`), while `protectRecent: 3`
keeps the newest three results (failed command / web search / sleep, or the last
three deterministic calls when `include_web_search` is off) out of the target
set. `model: {}` inherits the main route's provider/model effort and keeps
the output-token cap at the route default. The diagnostics file is what the hard
gate reads for the `planner-truncated` and planner-usage assertions.

---

## 4. What the profile looks like (and why)

`prepare-profile.sh` never installs the plugin from the registry. It:

1. initializes a profile from the shipped template **offline**:
   `dsh --profile ci-headless --from-default-profile headless --dump-config`
   (writes `package.json`, `pnpm-workspace.yaml`, `cordis.patch.yml: []`);
2. discovers every npm workspace package name from the repo manifests and
   symlinks each package into `<profile>/node_modules/<name>` (the root bundle
   package included). This is the read-only "source directly runnable" path the
   project already supports; `--install-method=dsh-plugin` keeps the official
   `dsh plugin --profile <p> add <path>` route as an alternative;
3. adds the bundle package to `dsh.profile.bundles` and records `file:` deps in
   the profile manifest;
4. runs `--dump-config` once, parses the **composed** profile to discover the
   plugin's row ids (no hard-coded ids), and refuses to continue if the launcher
   logs `skipping profile bundle` (a dsh engines/peer mismatch would silently
   produce a profile without the plugin);
5. writes `<profile>/cordis.patch.yml` with only the rows that exist in the dump:

| Generated row | Reason |
| --- | --- |
| `llm-deepseek` `{apiKeyEnv: DEEPSEEK_API_KEY, reasoningEffort: off, maxTokens: 2048, models:[{id,name,contextWindow}]}` | cheapest effort, small output cap, explicit route |
| `agent-default-model` `{provider: deepseek-official, model: <probed>}` | headless one-shot agent route |
| `session-persistence-jsonl` `{root: !!js dshHomePath('sessions'), compression: none}` | plain JSONL session logs for assertions/artifacts |
| `compaction-basic`, `command-compact`, `tool-result-pruner`, `session-title-llm`, `image-offload` → `disabled: true` | the plugin's own prune/replace events must be the only compression evidence |
| plugin row(s) → `config: <SLIMMER_CONFIG_JSON>` | CI thresholds from §3 |

The profile is composed a second time to validate the patch before the paid run,
and the headless profile is smoke-tested with `dsh --profile ci-headless --help`
(no model call) so a bad config schema or missing row fails before spending
money.

Model resolution: `GET https://api.deepseek.com/models` with **both**
`x-api-key` and `Authorization: Bearer` (the official endpoint accepts either;
for the probe is non-billed, no inference). If `DEEPSEEK_BASE_URL` is set, the
probe derives the root and tries `<root>/models` and `<root>/v1/models`. The
chosen model is `DSH_TEST_MODEL` if set (an unlisted id fails fast unless
`ALLOW_UNLISTED_MODEL=1`), otherwise `deepseek-flash` when listed, otherwise the
first listed id. CI does **not** set `DEEPSEEK_BASE_URL`, so the official default
is used.

---

## 5. The assertion protocol (`assert-slimming.mjs`)

The plugin's final protocol has no separate plugin-record event: each slimming
round writes the UI payload as the additive `contextSlimmer` field of the
`compaction/prune` event that the harness requires before every surface
replacement. `role: "item"` marks a per-replacement prune, `role: "summary"`
carries the whole batch and is the row data the Web UI renders. The host degrades
to a plain prune if a harness build rejects the additive field, so the UI is not
load-bearing.

Checks over the plain session log (all hard unless noted):

| Check | Pass condition |
| --- | --- |
| `session-log-contiguous` | events have contiguous seqs 0..N-1 |
| `session-lifecycle` | session header with id |
| `tool-activity` | ≥1 tool/call and ≥2 tool/result (original + replacement) events |
| `no-subagent-events` | zero `subagent/*` events in the main session log (v0.2.0 planner is a direct `ctx.llm.stream()` call, not a managed fork); `--allow-subagents` is only for deliberate regression tests |
| `slimmer-prune-record` | ≥1 `compaction/prune` with `data.contextSlimmer`; ≥1 `role: "summary"` |
| `slimmer-summary-consistent` | summary `status: "applied"`, non-empty `items`, every `items[].replacementSeq` is a real tool/result replacement of a smaller result, `totals.charsSaved > 0` |
| `surface-replacement` | the plugin's tool/result replacements carry `surfaceOp: {op:"replace"}`, and `sourceEventSeqs` resolve back to append-origin events (directly or through an earlier replacement of the same node) |
| `other-replacements` | warning: no non-tool-result surface replacements (built-in compaction appears disabled) |
| `shadow-price-precedes-replace` | every plugin replacement is immediately preceded by a `compaction/prune` with `contextSlimmer` covering the cited original(s) |
| `transcript-append-only` | append-origin surface nodes are unique and hash-stable |
| `transcript-not-rewritten` | every replacement is appended after the events it shadows |
| `no-user-visible-rewrite` | warning: user/message count (policy notices legitimately add some; the append transcript hash is the real unchanged-proof) |
| `stream-cross-check` | every tool result the headless NDJSON stream reported exists in the log with the same callId |
| `derived-context-shrank` | folding the log with the installed `@deepseek-ai/dsh-session` `foldSurface` + `deriveEventMessage` shows the replaced tool text materially smaller: total savings ≥ 256 chars and best reduction ≥ 20% |
| `projected-tool-context-smaller` | folded model-visible tool text < raw append tool-result text |
| `planner-diagnostics-present` | with `--diagnostics`, the file contains at least one plan/apply/result record; an empty or missing file cannot silently pass the truncation gate |
| `no-planner-truncated` | with `--diagnostics`, no `planner-truncated` record and no plan record with `finishReason=max-tokens`/`length` (the v0.1.0 regression) |
| `planner-observability` | warning: plan/apply records carry `usage` (prompt/completion tokens), `durationMs` and `finishReason`; the report aggregates them once per planner call |

The fold uses the installed dsh-session module (authoritative). `--allow-builtin-fold`
is only for environments without dsh (the static self-test uses it as a fallback).
`--self-test` builds a positive fixture (must pass) and a negative fixture without
the prune/replacement (must fail), for both fold modes.

`--min-replacements`, `--min-savings-chars`, `--min-reduction-ratio`,
`--require-shadow-price/--no-require-shadow-price`, `--strict-stream`,
`--diagnostics` and `--require-no-subagents/--allow-subagents` make the
thresholds adjustable **without touching workflow code**.

### UI text (screenshots)

`screenshot.mjs` opens the session by clicking the sidebar row
(`[role="treeitem"][data-row-key="session:<id>"]`) because the Web app has no deep
link, dismisses startup notices/sign-in, waits up to `SLIMMER_UI_TIMEOUT_MS`
(45 s) for the localized row text `已精简工具调用结果`, then captures:

* `verify-chat-zh.png` — full Chinese chat view with the slimming row,
* `verify-chat-detail.png` — the row after a click (best effort),
* `verify-trajectory.png` — the trajectory tab showing the replacement text,
* `verify-plugins.png` — the native Plugins panel (module card/toggle),
* `verify-plugin-config.png` — the v0.2.0 config page: bundle detail → module row
  detail, then the form hook `[data-ctxslim-config]` + `data-field` inputs
  (`everyNToolCalls`, `model.provider`, `model.maxOutputTokens`, …) + save button
  `[data-ctxslim-save]`. The viewport is temporarily enlarged so the shot shows
  all 14 fields and the save button; DOM counts are recorded in
  `screenshot-report.json.pluginConfig`,
* `verify-sidebar-missing.png` — only when the session is not listed at all.

`screenshot.mjs` also checks that the page does not show a `N 个子智能体` counter
(`report.subagentCounter`: absent / zero / present / text-present). Both UI
signals are recorded but non-fatal; the log + diagnostics gate decides pass/fail.

When the row text is missing the script still captures everything, records
`ui_assert_status: "skipped-timeout"` in `screenshot-report.json`, and exits 0.
The workflow adds a `::warning::` annotation. This is deliberate: the UI is
allowed to be unstable; log assertions are the hard gate.

For the script to see the session, `run-scenario.sh` pre-seeds
`$DSH_HOME/storages/workspace.json` with the workspace path and session id
(headless sessions do not register themselves in the GUI's workspace store).

---

## 6. Caching, timeouts, artifacts, diagnostics

**Caches** (`actions/cache@v4`): `~/.npm` (both jobs), `~/.cache/ms-playwright`
(e2e, Chromium is the slow part).

**Timeouts**: `static` 15 min, `gate` 5 min, `e2e` 45 min, `benchmark` 90 min.
Inside e2e: `timeout 900` around the model session, 120 s for the web URL to
appear, 45 s for the UI row text, 30 s per Playwright navigation step.
`concurrency` cancels superseded PR runs.

**Artifacts** (`verify-evidence-<run_id>`, always, 14 days):
`verify-session.jsonl` (plain session log), `scenario.jsonl` (headless NDJSON
stream), `scenario.stderr.log`, `scenario-summary.json`,
`assert-report.txt` / `assert-report.json`, `screenshot-report.json`, PNGs,
`web.log`, `workspace-store.json`, `slimmer-diagnostics.jsonl` (planner
`trigger` / `llm-*` / `plan` / `validate` / `apply` / `no-op` records with
usage, duration and finish reason), `child-sessions/` (legacy debug copy; the
v0.2.0 planner is a direct LLM call and opens no subagent session, so this is
normally absent), `profile-*/` (composed dumps, generated patch, model probe).
The assertion report is also echoed to the job summary. The benchmark workflow
uploads `benchmark-evidence-<run_id>` with `benchmark.md`,
`benchmark-summary.md`, `benchmark-report.json` and the three per-mode run
directories.

**Diagnostics when the paid step fails**, in order:
1. `assert-report.txt` in the job summary lists every check with the failing
   detail and metrics;
2. `scenario.stderr.log` and `scenario.jsonl` show the run's exit stage;
3. `profile-*/composed-final.yml` + `cordis.patch.yml` prove the plugin row was
   composed with which config;
4. `model-probe.txt` / `model-probe.tsv` record the `/models` outcome;
5. re-run locally with `--dry-run` first, then the real scripts (below).

---

## 7. `publish.yml`

Trigger: tag push `v<version>` (must equal the root `package.json` version), or
manual dispatch with `dry_run: true` (default) to rehearse.

Steps: checkout (`fetch-depth: 0`) → Node 24 + npm registry auth →
`npm ci`/`npm install` → tag/version match → `npm test` (hard) →
`scan-secrets.sh --publish` (tracked files **and** the packed tarballs) →
`npm pack --dry-run` per package → publish in dependency order
(`packages/core` → `packages/tool-result-slimmer` → root bundle) with
`--access public`, skipping versions already on the registry (idempotent re-runs)
→ best-effort download of the latest successful `verify` artifact from `main` →
`gh release create` (or `upload --clobber`) with `CHANGELOG.md` notes when
present, attaching `verify-chat-zh.png` / `verify-plugins.png`.

Permissions: `contents: write` (release + assets) and `actions: read`
(download the verify artifact). `NPM_TOKEN` is only used as
`NODE_AUTH_TOKEN` inside npm steps.

---

## 8. Cost estimate (budget ¥10)

Measured on the v0.2.0 green runs (DeepSeek-Flash pricing):

| Job | What runs | Measured cost |
| --- | --- | --- |
| `verify` e2e | one main session (13 tool calls, ~51k tool-result chars, ~335k session tokens with ~89% cache hits) + one direct planner call (≈44k prompt / <100 completion tokens) | a few ¥0.01s per run; well under **¥0.2/run** |
| `benchmark` | three sessions (baseline / conservative / aggressive), R=1 | **¥0.13 total** (baseline ¥0.0216 + conservative ¥0.0606 + aggressive ¥0.0444); R=3 extrapolates to ≈¥0.4 < ¥1 |
| rehearsals | `run_e2e: false`, dry-runs, self-tests | ¥0 |

The main session spends most of its tokens on the two large fixture reads and
~89% of the prompt is prefix-cached; the planner prompt is the only new
inference per batch. `reasoningEffort: off` and `maxTokens: 2048` apply to the
main session; the planner inherits the route with `model: {}` (no output cap
override). The ¥10 budget allows dozens of verify runs plus several benchmark
rounds.

---

## 9. Local self-check commands and results

Zero-cost checks (Node 22 locally; CI pins Node 24). The `static` job runs the
offline subset on every push:

```bash
for f in scripts/ci/*.sh; do bash -n "$f"; done
for f in scripts/ci/*.mjs; do node --check "$f"; done
node scripts/ci/assert-slimming.mjs --self-test --allow-builtin-fold   # SELF-TEST PASS
node scripts/ci/benchmark.mjs --self-test                              # SELF-TEST PASS
CI_ARTIFACTS_DIR=/tmp/ci-dry node scripts/ci/benchmark.mjs --dry-run   # OK, no call
CI_ARTIFACTS_DIR=/tmp/ci-dry node scripts/ci/screenshot.mjs --dry-run  # OK, no browser
DSH_HOME=/tmp/dsh-ci-home CI_ARTIFACTS_DIR=/tmp/ci-artifacts \
  bash scripts/ci/prepare-profile.sh --dry-run                         # OK (validates wiring)
CI_ARTIFACTS_DIR=/tmp/ci-artifacts bash scripts/ci/run-scenario.sh --dry-run  # OK, no call
for f in .github/workflows/*.yml; do ruby -ryaml -e 'YAML.parse_stream(File.read(ARGV[0]))' "$f"; done  # OK
bash scripts/ci/scan-secrets.sh                                        # OK: no credential-shaped material
bash scripts/ci/scan-secrets.sh --publish                              # OK: tarballs clean too
npm run test:core && npm run test:module && npm run test:pack          # run by the static job
```

`assert-slimming.mjs --self-test` builds a positive fixture, a negative fixture
without the prune/replacement, a `subagent/*` negative fixture, and diagnostics
fixtures (healthy plan/apply → pass; `planner-truncated` → fail; empty file →
fail). `benchmark.mjs --self-test` builds synthetic baseline and conservative
sessions and checks checkpoint grading, fold-based tool-text metrics, planner
aggregation, truncation invalidation and the gate evaluation — all offline.

**Real zero-cost integration run** (not a dry-run) against the current packages
and the installed `dsh 0.2.2-rc.1`:

```bash
DSH_HOME=/tmp/dsh-ci-home CI_ARTIFACTS_DIR=/tmp/ci-artifacts \
  bash scripts/ci/prepare-profile.sh --profile ci-headless --template headless --no-probe-model
```

Result: profile initialized offline → the three workspace packages were
symlinked into the profile → the bundle was selected → `--dump-config` discovered
the row `context-slimmer-tool-result` (`@ds-hu/dsh-context-slimmer-tool-result`)
→ the generated patch (model route, plain-JSONL persistence, isolation rows,
plugin config from §3) composed and validated → `dsh --profile ci-headless
--help` booted the composed profile. No network call, no key, no model spend.
This exercises the exact path `verify.yml` takes up to the paid session; only the
model call itself remains unverified.

Additionally verified locally without any API call:

* `dsh --version`, `dsh --help`, `dsh headless --help`, `dsh web --help`,
  `dsh plugin --help` — command grammar used by the workflows;
* profile init offline, symlink composition, `--dump-config` parsing and the
  `skipping profile bundle` guard;
* `foldSurface`/`deriveEventMessage` against a real enriched session log
  (including chained compaction replacements): `surface-replacement`,
  `shadow-price-precedes-replace`, `derived-context-shrank` all pass on
  pre-existing built-in pruning events, which validates the checks beyond the
  synthetic fixture;
* Web GUI selectors against an isolated local GUI: sidebar `data-row-key`, the
  Plugins button, the `已精简工具调用结果` locale string, and the v0.2.0 config
  page hooks (`[data-ctxslim-config]`, the 14 `data-field` inputs,
  `[data-ctxslim-save]`) plus the absence of a `个子智能体` counter;
* `GET /models` probe code paths via `--dry-run` and a local stub.

**v0.2.0 final verification — the latest green `verify` + `benchmark` runs on
`main` are the release evidence.** The authoritative numbers live in each run's
job summary and uploaded artifacts (`verify-evidence-<run_id>`,
`benchmark-evidence-<run_id>`), not in this file. A green round must show:

1. dsh `0.2.2-rc.1` installs and boots on the runner with Node 24: both profile
   preparations and the `dsh web` server succeed.
2. The planner is a direct `ctx.llm.stream()` call: the main session log has
   **zero** `subagent/*` events (no `forkProvider`, no child session), and the
   `no-subagent-events` check passes. `child-sessions/` is normally empty.
3. The protocol shape is accepted by this build: ≥1 `compaction/prune` with
   `data.contextSlimmer` (`role=summary`, `status=applied`) + the matching
   `tool/result` replacement with its shadow-price prune and
   `sourceEventSeqs`; `derived-context-shrank` and
   `projected-tool-context-smaller` pass (v0.2.0 green runs replaced a duplicate
   read: 24,638 → 122 chars, ~24.5k chars saved).
4. Row id discovered dynamically = `context-slimmer-tool-result`; nothing is
   hard-coded.
5. `/models` probe resolves `deepseek-flash` (ctx 1,048,576). The scenario uses
   `deepseek-flash` with `reasoningEffort=off`, `maxTokens=2048`; the planner
   inherits the main route (`model: {}`) and writes plan/apply records with
   `usage`, `durationMs`, `finishReason` to `slimmer-diagnostics.jsonl`;
   `no-planner-truncated` passes (v0.2.0 green runs: ≈44k prompt tokens, ~100
   completion tokens, `finishReason=stop`, 0 truncations).
6. Session visible in the Web GUI sidebar after seeding `workspace.json`:
   `session.status=opened-exact`, `ui_assert_status=found`,
   `pluginsPanel.status=found`. `verify-chat-zh.png` shows
   `已精简工具调用结果 · 1 项 · 释放 ~2.4 万字符`; `verify-plugin-config.png`
   shows the config page with `data-ctxslim-status=ready`, all 14 `data-field`
   inputs and the save button; `report.subagentCounter` is `absent`.
7. Benchmark job: baseline and conservative every run 5/5; conservative folded
   tool text < baseline (first v0.2.0 green run: 59,142 < 89,153, **−33.7%**);
   conservative planner truncations = 0 and ≥1 drop; total cost ≈¥0.13 < ¥1.
   The conclusion wording stays “非劣演示（single-run / R=N）”, never statistical
   significance.
8. Offline tests pass in the static job (`npm run test:core`, `test:module`,
   `test:pack`).
9. Not yet exercised: `--install-method=dsh-plugin` and the `publish.yml` real
   publish path (needs `NPM_TOKEN` and a `v*` tag; only dry-run/self-checks are
   covered so far).

**Observed UI detail.** Older replayed (v0.1.0) sessions painted the plugin row
only in the DOM until the activity group was expanded; the screenshot script
still expands every collapsed group (verb-prefixed labels plus
`[aria-expanded="false"]`) and verifies true painting with `elementFromPoint`
before declaring the row visible. v0.2.0 green runs show the row directly in the
chat view (`已精简工具调用结果 · 1 项 · 释放 …`).

---

## 10. Bring-up pitfalls (found and fixed while bringing CI up)

These are worth remembering because they are bash/GitHub-Actions/Node traps, not
plugin bugs:

1. **Bash `${VAR:-{...JSON...}}` corrupts the value.** If the default word of a
   parameter expansion contains `}`, bash appends the trailing braces *even when
   the variable is set*: `SLIMMER_CONFIG_JSON="${SLIMMER_CONFIG_JSON:-{...}}"` +
   an exported, perfectly valid config produced a value with `}}}` at the end and
   `JSON.parse` failed with `position 237`. Fix in `prepare-profile.sh`:
   `SLIMMER_CONFIG_JSON="${SLIMMER_CONFIG_JSON-}"` plus an explicit
   `if [[ -z ... ]]` assignment. The script additionally trims stray bytes after
   the final `}` and logs a `WARNING: ... stray byte(s)` line, so a future
   environment quirk shows up in the log instead of failing silently.
2. **`}}` inside a GitHub Actions expression literal.** A dispatch-input default
   like `${{ inputs.slimmer_config || '{"enabled":true,"model":{"provider":"inherit"}}' }}`
   contains `}}`, which closes the expression early (the workflow log showed the
   JSON truncated/mangled and the paid e2e job failing before the model call).
   Fix: the default JSON now lives in `scripts/ci/slimmer-config.default.json`;
   the dispatch input is forwarded as a plain string reference
   (`SLIMMER_CONFIG_JSON_INPUT: ${{ inputs.slimmer_config }}`) and the step reads
   the file when it is empty.
3. **`runner` context is not available in a job-level `env:` block.** The e2e job
   uses literal `/tmp/...` paths (artifacts/home/env file) instead of
   `${{ runner.temp }}`; steps export them via `$GITHUB_ENV` when a per-step path
   is needed.
4. **ESM `import()` ignores `NODE_PATH`.** The workflow installs Playwright
   globally, so `screenshot.mjs` falls back to `createRequire(npm root -g)`
   before giving up; otherwise screenshots would be skipped on every run.
5. **Multi-frame zstd session logs.** Node's `zlib` zstd decoder only returns the
   first frame; `assert-slimming.mjs` shells out to the `zstd` CLI (the CI profile
   also sets `compression: none`, producing plain JSONL directly).
6. **Replacement chains.** A replacement may cite an earlier replacement of the
   same node (a second slimming round), not only the append-origin event; the
   assertion resolves `sourceEventSeqs` back to the append origin before checking
   the transcript. Built-in compaction summaries cite log-only events
   (`compaction/start`, `compaction/summary`), which is why plugin replacements
   are scoped to `tool/result` surface events.
7. **A failed/no-op planner batch is invisible from the parent transcript.** The
   direct planner call can end in `no-op` / `rejected` / `failed` without
   touching the parent transcript, so the only log-level symptom is
   `slimmer-prune-record: 0` in the assertion report. Fix: CI configures
   `diagnosticsFile`, so the artifact keeps the batch's `trigger`, `llm-*`,
   `plan`, `validate`, `apply` and `no-op` records — the hard gate reads them for
   `planner-truncated` / usage; `run-scenario.sh` keeps its `sleep 25` step so a
   background batch has a deterministic window to land before the one-shot
   session exits. Conservative additionally has a host-side deterministic
   duplicate fallback when the planner returns an empty plan (plan §9.5).
   `child-sessions/` is no longer evidence: v0.2.0 opens no subagent session and
   the gate asserts zero `subagent/*` events.
8. **Headless sessions are not auto-registered in the Web GUI.** `run-scenario.sh`
   seeds `$DSH_HOME/storages/workspace.json` with the workspace path + session id
   so `screenshot.mjs` can click the sidebar row (there is no deep link).

## 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `skipping profile bundle` in the e2e logs | dsh version does not satisfy the plugin's `engines.dsh`; pin `dsh_version` in the dispatch |
| `slimmer-prune-record` / `slimmer-summary-consistent` fails | the harness rejected the additive `contextSlimmer` field (degraded plain prune), the summary is a no-op/rejected batch, or the trigger did not fire; check `profile-*/cordis.patch.yml` config, `scenario.jsonl` tool count and `slimmer-diagnostics.jsonl` (`trigger`/`no-op`/`llm-error`) |
| `no-subagent-events` fails | the planner forked a subagent again (v0.1.0 regression); the main log contains `subagent/*` events — check the plan and the host entry wiring |
| `planner-diagnostics-present` fails | `diagnosticsFile` is unset or points elsewhere than the artifact path (`$CI_ARTIFACTS_DIR/slimmer-diagnostics.jsonl`); an empty file never counts as “no truncation” |
| `no-planner-truncated` fails | the planner hit its output cap before emitting JSON (`planner-truncated`, often shared with reasoning tokens); lower `reasoningEffort`, raise the planner `maxOutputTokens`, or shorten the prompt |
| `derived-context-shrank` fails | the plugin's replacement did not actually shrink content, or the fold resolved nothing; `assert-report.json.metrics.reductions` shows before/after chars |
| e2e timed out | `timeout 900`; reduce steps (`include_web_search: false`), or raise `timeoutMs`/scenario timeout |
| UI text missing but logs pass | expected on a UI regression; look at `verify-chat-zh.png`, fix selectors or the locale string; the job stays green by design |
| `npm ci` fails after dependency changes | no `package-lock.json` committed → workflow falls back to `npm install`; commit the lockfile to get `npm ci` |
| screenshots skipped | Playwright install failure (`ENABLE_SCREENSHOTS=0`), see the install step warning |

Manual local rehearsal (paid step last):

```bash
export DSH_HOME=/tmp/dsh-ci-home CI_ARTIFACTS_DIR=/tmp/ci-artifacts
scripts/ci/prepare-profile.sh --profile ci-headless --template headless --probe-model --dry-run
scripts/ci/run-scenario.sh --dry-run
# then, with a key and dsh installed:
scripts/ci/prepare-profile.sh --profile ci-headless --template headless --probe-model
scripts/ci/run-scenario.sh
node scripts/ci/assert-slimming.mjs --session-log "$CI_ARTIFACTS_DIR/verify-session.jsonl"
```

---

## 12. v0.2.0 changes (planner is a direct LLM call; conservative default; benchmark)

v0.2.0 (see `docs/plan-v0.2.md`) removes the managed-fork planner and changes the
default policy to `conservative`. The CI changes below supersede the v0.1.0
sections where they differ (the historical notes are kept for context).

### 12.1 `assert-slimming.mjs` (hard gate)

- New required check **`no-subagent-events`**: the main session log must contain
  zero `subagent/*` events (the v0.2.0 planner is a direct `ctx.llm.stream()`
  call). Disable with `--allow-subagents` only for a deliberate regression test.
- New `--diagnostics <file>` check over `slimmer-diagnostics.jsonl`:
  - required **`planner-diagnostics-present`** — the diagnostics file must
    actually contain plan/apply/result records; an empty or missing file must
    not silently pass the truncation gate.
  - required **`no-planner-truncated`** — no record may indicate
    `planner-truncated` / `finishReason=max-tokens|length` for a plan record.
    This is the v0.1.0 production regression (planner output budget exhausted).
  - advisory **`planner-observability`** — plan/apply records should carry
    `usage` (prompt/completion tokens), `durationMs` and `finishReason`; the
    report's `metrics.planner` aggregates them.
- The existing checks are unchanged: prune record, summary consistency,
  `sourceEventSeqs` replacement, shadow-price adjacency, append-only transcript,
  fold-based `derived-context-shrank`, stream cross-check.
- The legacy `child-sessions/` capture is kept only for debugging compatibility
  and is **not an assertion input**; the v0.2.0 direct planner opens no subagent
  session, so it is normally empty and no `structured_output` tool call is
  expected (the `no-subagent-events` check proves the absence).
- New required **`planner-diagnostics-present`** and **`no-planner-truncated`**
  checks cover the diagnostics file (see §5); they are hard gates, not advisories.

### 12.2 `screenshot.mjs` (non-fatal UI evidence)

- `verify-plugin-config.png`: opens Plugins → installed bundle detail → module
  row detail and asserts the v0.2.0 config form:
  `[data-ctxslim-config]`, `data-field="everyNToolCalls"`,
  `data-field="model.provider"`, `data-field="model.maxOutputTokens"`,
  `data-field*="reasoningEffort"` and the save button `data-ctxslim-save`.
  Status/selector counts are recorded in `screenshot-report.json.pluginConfig`.
- New `subagentCounter` report field: the UI must not show a
  `N 个子智能体` counter (catalog empty ⇒ hidden). `status: absent` expected;
  a nonzero counter is recorded and warned about (the log gate remains hard).
- Everything stays non-fatal: a missing form only warns and still uploads the
  screenshots; log assertions decide pass/fail.

### 12.3 `slimmer-config.default.json` (CI profile config)

Now the v0.2.0 conservative defaults: `policy: conservative`,
`everyNToolCalls: 12`, `minChars: 24000` (trigger is AND), `protectRecent: 3`,
`minTargetChars: 4096`, `maxTargets: 4`, `includeSubagents: true`,
`model: {}` (inherit provider/model/reasoning effort and the 0 = no-cap
output budget; the 0.1.0 `provider: inherit` sentinel is accepted but clearer
as an empty object), diagnostics enabled.
The e2e scenario (`run-scenario.sh`) now reads the large fixture twice, makes
eight deterministic small calls, runs the expected-failing command and then the
`sleep 25` window — so the conservative trigger (≥12 results **and**
≥24,000 chars) fires and only the duplicate read is a legal drop.

### 12.4 `benchmark.yml` + `scripts/ci/benchmark.mjs` (new job)

- One deterministic composite scenario (`scripts/ci/benchmark-scenario.md` +
  `scripts/ci/bench/fixture/`) with 5 answer checkpoints (C1/C2 unique file
  middle, C3 failure evidence, C4 kept duplicate copy, C5 unique log line).
- Modes: `baseline` (plugin disabled), `conservative` (v0.2.0 defaults),
  `aggressive` (v0.1 lossy, report-only), interleaved B/C/A.
- Push defaults to R=1; `workflow_dispatch` accepts `repetitions=3`. Any
  conservative run that performs no drop or reports `planner-truncated` is an
  **invalid run** (the whole round is rerun once, then the job fails).
- Hard gates: baseline & conservative 5/5 every run; conservative folded tool
  text < baseline; conservative planner truncations = 0. `aggressive` is not
  gated.
- Outputs: `benchmark-report.json`, `benchmark.md` / `benchmark-summary.md`,
  copied into the single `benchmark-evidence-<run_id>` artifact root
  (`tmp/ci-artifacts/…`; copy `benchmark.md` to `docs/benchmark.md` when
  releasing) and a job-summary table that includes planner prompt/completion
  tokens, duration, finishReason and truncations.
- Conclusion wording is “非劣演示（single-run / R=N）”, never statistical
  significance (see `docs/research/benchmark-design.md` §5).

### 12.5 Local dry-runs (no key, no model calls)

```bash
bash -n scripts/ci/*.sh
for f in scripts/ci/*.mjs; do node --check "$f"; done
node scripts/ci/assert-slimming.mjs --self-test --allow-builtin-fold
CI_ARTIFACTS_DIR=/tmp/ci-dry node scripts/ci/benchmark.mjs --self-test
CI_ARTIFACTS_DIR=/tmp/ci-dry node scripts/ci/benchmark.mjs --dry-run
CI_ARTIFACTS_DIR=/tmp/ci-dry node scripts/ci/screenshot.mjs --dry-run
```

Real paid runs (`verify.yml` e2e, `benchmark.yml`) stay gated on
`DEEPSEEK_API_KEY` and are triggered by the Lead after core/ui land the v0.2.0
host/client changes.
