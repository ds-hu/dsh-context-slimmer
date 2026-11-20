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
| `.github/workflows/publish.yml` | tag push → npm publish order + GitHub Release (see §7) |
| `scripts/ci/prepare-profile.sh` | builds the temporary DSH profiles, links the local packages, writes the generated `cordis.patch.yml`, probes `GET /models` |
| `scripts/ci/run-scenario.sh` | runs one real fixed headless session, collects the plain-JSONL log, registers the session for the Web GUI |
| `scripts/ci/assert-slimming.mjs` | offline hard gate over the session log (`--self-test` for CI) |
| `scripts/ci/screenshot.mjs` | opens `dsh web`, captures the Chinese chat row + Plugins panel |
| `scripts/ci/scan-secrets.sh` | credential-shaped-material scanner (also invoked with `--publish`) |

All helpers support `--dry-run` (validate wiring, no network/model cost), use
`set -euo pipefail`, and skip cleanly with exit code `3` when
`DEEPSEEK_API_KEY` is absent.

---

## 2. Required repository secrets / settings

| Name | Used by | Notes |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `verify.yml` → e2e, `prepare-profile.sh` probe, `run-scenario.sh` | Only value that costs money. Never printed, never written to a file. |
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
`node --check` both `.mjs` helpers → `node assert-slimming.mjs --self-test
--allow-builtin-fold` → both helper `--dry-run`s → Ruby YAML parse of every
workflow → `scan-secrets.sh`.

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
6. `run-scenario.sh` — one real headless session (read large fixture → failing
   `bash false` → optional `web_search` → `bash sleep 25`) so the plugin's
   asynchronous fork batch has a deterministic window to land before the
   one-shot session exits
7. `assert-slimming.mjs` — **hard gate**; a failure fails the job
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
| `slimmer_config` | see below | JSON written into the plugin row config |
| `include_web_search` | `true` | Adds one `web_search` step (costs one extra model turn) |
| `screenshot` | `true` | Starts `dsh web` and captures screenshots |
| `run_e2e` | `true` | Rehearsal switch: run only the static job |

CI plugin config comes from `scripts/ci/slimmer-config.default.json` (the
`workflow_dispatch` input `slimmer_config` overrides it when set). Current schema
defaults overridden so a 3-tool-call scenario triggers exactly one batch:

```json
{
  "enabled": true,
  "everyNToolCalls": 3,
  "minChars": 0,
  "protectRecent": 1,
  "maxTargets": 6,
  "minTargetChars": 0,
  "timeoutMs": 180000,
  "forkProvider": "fork",
  "promptLocale": "zh",
  "model": { "provider": "inherit" }
}
```

`minChars: 0` disables the size trigger, so `everyNToolCalls: 3` is the only
trigger; the scenario produces exactly four tool results (read fixture, failed
bash, web_search, `sleep 25`), so exactly one batch triggers at the third result
and the fourth step keeps the process alive long enough for the plugin's
asynchronous fork batch to land. `protectRecent: 1` keeps the newest result
safe; `minTargetChars: 0` lets even the small failing-command result be treated
as a target (extra evidence, no extra cost).

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
fork the probe is non-billed, no inference). If `DEEPSEEK_BASE_URL` is set, the
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

The fold uses the installed dsh-session module (authoritative). `--allow-builtin-fold`
is only for environments without dsh (the static self-test uses it as a fallback).
`--self-test` builds a positive fixture (must pass) and a negative fixture without
the prune/replacement (must fail), for both fold modes.

`--min-replacements`, `--min-savings-chars`, `--min-reduction-ratio`,
`--require-shadow-price/--no-require-shadow-price` and `--strict-stream` make the
thresholds adjustable **without touching workflow code**.

### UI text (screenshots)

`screenshot.mjs` opens the session by clicking the sidebar row
(`[role="treeitem"][data-row-key="session:<id>"]`) because the Web app has no deep
link, dismisses startup notices/sign-in, waits up to `SLIMMER_UI_TIMEOUT_MS`
(45 s) for the localized row text `已精简工具调用结果`, then captures:

* `verify-chat-zh.png` — full Chinese chat view with the slimming row,
* `verify-chat-detail.png` — the row after a click (best effort),
* `verify-plugins.png` — the native Plugins panel (module card/toggle),
* `verify-sidebar-missing.png` — only when the session is not listed at all.

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

**Timeouts**: `static` 15 min, `gate` 5 min, `e2e` 45 min. Inside e2e:
`timeout 900` around the model session, 120 s for the web URL to appear, 45 s for
the UI row text, 30 s per Playwright navigation step. `concurrency` cancels
superseded PR runs.

**Artifacts** (`verify-evidence-<run_id>`, always, 14 days):
`verify-session.jsonl` (plain session log), `scenario.jsonl` (headless NDJSON
stream), `scenario.stderr.log`, `scenario-summary.json`,
`assert-report.txt` / `assert-report.json`, `screenshot-report.json`, PNGs,
`web.log`, `workspace-store.json`, `child-sessions/` (every subagent/fork session copied
whole plus a compact `summary.json` with the child's model, tool calls,
`structured_output` arguments/results and stop reason), `profile-*/` (composed
dumps, generated patch, model probe). The assertion report is also echoed to the job summary.

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

One e2e run, default inputs:

| Item | Tokens (approx) | Notes |
| --- | --- | --- |
| main agent, turn 1 (system + scenario) | 4–8 k in | prompt cached where possible |
| main agent, tool turns ×3 | 4–10 k in / <1 k out | fixture read dominates |
| background fork slim agent | 6–12 k in / <1 k out | sees candidate results + prompt, output is a small plan |
| title generation etc. | disabled or negligible | `session-title-llm` disabled in the CI profile |
| **total** | **~20–40 k tokens** | at DeepSeek-Flash pricing this is well under **¥1/run** |

`reasoningEffort: off`, `maxTokens: 2048`, `everyNToolCalls: 2`,
`protectRecent: 1`, one batch, no retries, no exploration, no `web_search`
unless requested. The ¥10 budget allows well over a dozen runs; day-to-day
rehearsals use `run_e2e: false` (static only, ¥0).

---

## 9. Local self-check commands and results

Zero-cost checks run on the current tree (Node 22 locally; CI pins Node 24):

```bash
for f in scripts/ci/*.sh; do bash -n "$f"; done                       # OK
node --check scripts/ci/assert-slimming.mjs                           # OK
node --check scripts/ci/screenshot.mjs                                # OK
node scripts/ci/assert-slimming.mjs --self-test                        # SELF-TEST PASS
for f in .github/workflows/*.yml; do ruby -ryaml -e 'YAML.parse_stream(File.read(ARGV[0]))' "$f"; done  # OK
bash scripts/ci/scan-secrets.sh                                       # OK: no credential-shaped material
bash scripts/ci/scan-secrets.sh --publish                             # OK: tarballs clean too
bash scripts/ci/prepare-profile.sh --dry-run                          # OK (validates wiring)
bash scripts/ci/run-scenario.sh --dry-run                             # OK, no call
node scripts/ci/screenshot.mjs --dry-run ...                          # OK
node scripts/ci/assert-slimming.mjs --dry-run ...                     # OK
npm run test:core                                                     # 0 tests until core/test lands
npm run test:module                                                   # pass
npm run test:pack                                                     # pack dry-run OK

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
```

Additionally verified against real local dsh `0.2.2-rc.1` without any API call:

* `dsh --version`, `dsh --help`, `dsh headless --help`, `dsh web --help`,
  `dsh plugin --help` — command grammar used by the workflows;
* profile init offline, symlink composition, `--dump-config` parsing and the
  `skipping profile bundle` guard;
* `foldSurface`/`deriveEventMessage` against a real enriched session log
  (including chained compaction replacements): `surface-replacement`,
  `shadow-price-precedes-replace`, `derived-context-shrank` all pass on
  pre-existing built-in pruning events, which validates the checks beyond the
  synthetic fixture;
* Web GUI selectors (sidebar `data-row-key`, Plugins button, `已精简工具调用结果`
  locale string) against an isolated local GUI;
* `GET /models` probe code paths via `--dry-run` and a local stub.

**待验证（首次真实 CI 运行后才能确认）**

1. `@deepseek-ai/dsh@0.2.2-rc.1` install and profile boot **on the GitHub
   runner with Node 24** (local integration run used Node 22; composition and
   `--help` boot passed, so only the runner environment differs).
2. `forkProvider: "fork"` mounting the managed-fork background agent inside the
   headless profile; the child session's native `structured_output` tool call is
   expected there, not in the parent log.
3. The real plugin event names/shape (`compaction/prune` +
   `data.contextSlimmer.role=summary`, `status: "applied"`) and whether the
   additive field is accepted by this exact dsh build (degradation path exists).
4. The exact plugin row id discovered from `--dump-config` (currently
   `context-slimmer-tool-result`; not hard-coded anywhere).
5. Whether the `/models` response lists `deepseek-flash`; otherwise the script
   falls back to the first listed id and prints it (free probe).
6. Headless session visibility in the Web GUI sidebar on the runner
   (locally verified via a seeded `workspace.json`).
7. Actual token spend of one run versus the ¥1 estimate (no local real calls
   were made).
8. `node --test` globs once `packages/core/test/` exists (currently empty; the
   static job treats this as a warning during bring-up).
9. `dsh plugin --profile ... add <path>` alternative install method
   (`--install-method=dsh-plugin`) is implemented but untested until pnpm is on
   the runner (the workflow default is the symlink method).

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
7. **A failed/empty background batch is invisible from the parent log.** The
   plugin's fork batch starts (the parent log records `subagent/catalog` for
   `childId: context-slimmer-…`) but can end in `no-op`/`rejected`/`failed`
   without touching the parent transcript, so the only parent-side symptom is
   `slimmer-prune-record: 0` in the assertion report. The one-shot session does
   not wait on the batch, so a longer scenario alone does not prove anything.
   Fix: `run-scenario.sh` now copies every sibling subagent session directory to
   `child-sessions/` and writes `summary.json` with the child's model, tool
   calls, `structured_output` arguments/results and stop reason. The scenario
   keeps its `sleep 25` step (harmless scheduling buffer) but the actionable
   evidence is the child session.
8. **Headless sessions are not auto-registered in the Web GUI.** `run-scenario.sh`
   seeds `$DSH_HOME/storages/workspace.json` with the workspace path + session id
   so `screenshot.mjs` can click the sidebar row (there is no deep link).

## 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `skipping profile bundle` in the e2e logs | dsh version does not satisfy the plugin's `engines.dsh`; pin `dsh_version` in the dispatch |
| `slimmer-prune-record` / `slimmer-summary-consistent` fails | the harness rejected the additive `contextSlimmer` field (degraded plain prune), the summary is a no-op/rejected batch, or the trigger did not fire; check `profile-*/cordis.patch.yml` config and `scenario.jsonl` tool count |
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
