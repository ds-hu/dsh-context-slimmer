# Context Slimmer

Native [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin bundle that keeps an agent's
context lean **without rewriting the conversation users saw**. It ships as a set of fully
independent feature modules: every module is its own npm package and its own Loader row, so the
native Plugins panel can enable, disable and configure each one on its own.

The first module is **Tool-result slimmer**: every N tool calls **and** enough new output, a hidden
planner model — a direct `ctx.llm.stream()` call with the session's full context, no subagent
session — decides which stale tool results are provably redundant. The main agent's next request
sees only the slimmed results; the chat transcript keeps the original tool cards untouched; and one
extra row, modelled on the native "Context compacted" row, reports what was slimmed.

```
Before                              After the slimmer ran
┌──────────────────────────┐        ┌──────────────────────────┐
│ tool read  12.4k chars   │        │ tool read  [elided …]    │  ← model surface
│ tool grep   8.1k chars   │  ───►  │ tool grep  [elided …]    │     (replace events)
│ tool test   failure …    │        │ tool test  failure …     │  ← exact evidence kept
└──────────────────────────┘        └──────────────────────────┘
   chat transcript unchanged           + "Tool results slimmed · 2 · 20,500 chars"
```

## Why

Research on agent context in 2026 is unambiguous: most agent tokens are tool observations, and
*competing* stale observations hurt accuracy far more than longer but neutral context. Yet naive
compression is dangerous — it deletes constraints and failure evidence, rewrites history the user
already saw, and can trigger costly re-reads. This plugin therefore splits the problem in four:

1. **Judge with full context, not a summary of it.** The planner receives the session's derived
   messages, so "is this result still relevant?" is answered by a model that has seen the task.
2. **Never rewrite the human transcript.** Replacements are model-only surface events
   (`surfaceOp: replace`), exactly like the official tool-result pruner; append-origin events keep
   the user-visible cards intact and fork/resume replay stays sound.
3. **Conservative by default.** The default `conservative` policy only performs whole-result drops
   whose safety the host can re-verify: duplicate reads, results superseded by a later successful
   retry, empty outputs. Unique long reads and failure evidence are never touched, and trimming is
   rejected outright. `balanced`/`aggressive` are explicit opt-ins.
4. **Cheap and invisible.** One direct model call instead of a fork subagent: no child session, no
   `subagent/*` events, no "N subagents" counter, nothing the main agent can list.

The underlying literature review, DSH protocol map, slimming policy and benchmark design are in
[`docs/`](docs/).

## Modules

| Module | Package | Row id | Status |
|---|---|---|---|
| Tool-result slimmer | `@ds-hu/dsh-context-slimmer-tool-result` | `context-slimmer-tool-result` | shipped in `0.2.x` |
| Future modules | separate `packages/*` | separate rows | planned — each module stays independently switchable |

The shared pure library `@ds-hu/dsh-context-slimmer-core` is deliberately **not** a Loader row:
the Plugins panel cannot toggle it and no module can unmount it by accident.

## Install

```bash
dsh plugin --profile <profile> add @ds-hu/dsh-context-slimmer
```

The bundle patch inserts one row per module; each row resolves its own package from the profile.
Restart the profile (or let the live patch reload) and open **Plugins** — the bundle and its module
row appear with a native toggle. Click the module title to open its configuration page.

Do **not** copy the rows into your own `cordis.patch.yml`: a duplicate `id` makes the profile fail
to boot (`entry <id> already exists`). Customize through the row config in the panel instead.

## Configuration (tool-result slimmer)

Everything below is editable in the native Plugins panel (click the module title) and applied live;
saving writes the profile's `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch of this module. |
| `everyNToolCalls` | `12` | Fire only after this many newly settled tool results (`0` disables the check). |
| `minChars` | `24000` | Fire only after this many new result characters accumulated (`0` disables the check). Both checks are ANDed. |
| `protectRecent` | `3` | Most recent K results are never touched. |
| `maxTargets` | `4` | Max candidates reviewed per run (1–20). |
| `minTargetChars` | `4096` | Smaller results are never candidates. |
| `triggerOnErrorOnly` | `false` | Only run when the batch contains failures. |
| `timeoutMs` | `120000` | Planner hard timeout; a timeout is a no-op. |
| `policy` | `conservative` | `conservative` / `balanced` / `aggressive`. |
| `includeSubagents` | `true` | Also slim subagent sessions (including agent-team members). |
| `model.provider` / `model.model` | empty = inherit | Follows the current agent route; or pin a route. |
| `model.reasoningEffort` | `inherit` | `inherit` copies the route's effort (keeps thinking); or `off`/`low`/`medium`/`high`/`max`. |
| `model.maxOutputTokens` | `0` | `0` = model default (no cap). A positive value caps the whole completion **including reasoning tokens** — too small a value can truncate the planner (v0.1.0 regression, fixed in 0.2.0). |

Advanced fields not on the panel page (`promptLocale`, `diagnosticsFile`) can be set in the row's
config section of the profile `cordis.patch.yml`.

## How it works (short)

1. `agent/pre-step` — after the previous tool batch settled, before the next request is assembled —
   counts newly settled tool results per session, for the root agent and (by default) subagents.
2. When both thresholds are crossed, the host sends **one hidden planner call** via
   `ctx.llm.stream()`: session-derived messages + tool history + a compact candidate list. No
   subagent activation, no tools, no `purpose`.
3. The plan is validated atomically by pure host code. Under `conservative`, each `drop` needs
   evidence the host re-checks (`duplicateOf` / `supersededBy` / `empty`); `trim` is rejected.
4. Accepted results receive `compaction/prune` + a surface replacement `tool/result`. The batch
   summary rides in the prune event's additive `contextSlimmer` field and drives the extra chat row.
5. Any failure — model, timeout, invalid plan, policy rejection, append error — is a no-op for the
   main agent. An explicit `maxOutputTokens` truncation retries once without the cap, then gives up.

Full protocol, safety rules and compatibility fallbacks: [`docs/protocol.md`](docs/protocol.md),
[`docs/architecture.md`](docs/architecture.md) and [`docs/dev-notes.md`](docs/dev-notes.md).

## Benchmark

A CI benchmark compares the plugin disabled (baseline), `conservative` (default) and `aggressive` on
a deterministic scenario with five exact fact checkpoints. `conservative` must keep all five facts
while folding meaningfully more tool text than the baseline, and must never hit a planner truncation.
Results are produced by [`.github/workflows/benchmark.yml`](.github/workflows/benchmark.yml) and
published to [`docs/benchmark.md`](docs/benchmark.md) (single-run results are directional, not
statistical proof).

## Compatibility & honest limitations

- Requires DSH `>=0.2.0 <0.3.0` and Node.js `>=24.9.0`.
- The extra chat row consumes an **additive JSON field on the official log-only
  `compaction/prune` event**. The host half detects a stricter future validator and degrades to the
  official three-field event: replacements still land, only the row disappears.
- The planner is a direct LLM call: it never creates a subagent session, so the WebUI "N subagents"
  counter and the main agent's subagent tools cannot see it. It does receive the session's derived
  messages (no tools are exposed to it).
- An explicit `model.maxOutputTokens` is a **total** completion budget including reasoning tokens;
  leave it at `0` unless you have a cost bound in mind.
- `includeSubagents: false` also skips agent-team members, because they are subagent-origin sessions
  too.
- The custom panel page replaces the auto-generated form, so `promptLocale`/`diagnosticsFile` are not
  editable there (their values are preserved; edit them in `cordis.patch.yml`).
- No API keys, tool-result text or user content are logged by the plugin; diagnostics contain
  counts, model identity, timings and model-written one-line reasons only.
- The client half makes no network requests and does not read session content beyond the event
  payload.

## Screenshots (captured from a real DSH run in CI)

All screenshots come from a real DeepSeek Harness instance started in GitHub Actions (real model session + `dsh web`):

The native-looking row in the conversation flow (`已精简工具调用结果 · 1 项 · 释放 24,181 字符`):

![chat row](docs/screenshots/chat-row-zh.png)

Expanded detail of the applied plan (item / trigger / model):

![detail](docs/screenshots/chat-detail-zh.png)

The trajectory shows what the model actually sees after replacement (`[elided by context-slimmer]`):

![trajectory](docs/screenshots/trajectory-zh.png)

The native configuration page opened from the module row in the Plugins panel:

![config](docs/screenshots/config-panel-zh.png)

The module in the native Plugins panel (toggle/config per module):

![plugins](docs/screenshots/plugins-panel-zh.png)

## Development

```bash
npm install          # workspaces: bundle + core + module
npm test             # offline unit tests (no dsh, no API calls)
npm run test:core
node --test packages/tool-result-slimmer/test/*.test.mjs
```

Real end-to-end verification (headless session with a live model + Web UI screenshot of the row and
the configuration page) and the benchmark run in GitHub Actions; see
[`.github/workflows/verify.yml`](.github/workflows/verify.yml),
[`.github/workflows/benchmark.yml`](.github/workflows/benchmark.yml) and [`docs/ci.md`](docs/ci.md).

## License

MIT © ds-hu
