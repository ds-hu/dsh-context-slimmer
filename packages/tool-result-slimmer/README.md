# @ds-hu/dsh-context-slimmer-tool-result

Tool-result slimmer — module 1 of the [Context Slimmer](https://github.com/ds-hu/dsh-context-slimmer) bundle.

A hidden planner model periodically reviews **older tool results** in a session and drops the ones
that are provably redundant: duplicate reads, results replaced by a later successful retry, empty
outputs. By default it never rewrites unique long reads or failure evidence. The main agent only
sees the slimmed results; the chat transcript keeps the original tool cards; one extra chat row
("已精简工具调用结果" / "Tool results slimmed") reports what happened.

The planner is a direct one-shot `ctx.llm.stream()` call (no subagent session, no `subagent/*`
events, invisible to the "N subagents" counter and to the main agent's subagent tools).

This package is one native Loader row of the bundle, so it can be enabled, disabled and configured
**on its own** in the Harness Plugins panel without touching the other modules of the bundle.

## Install

Install the bundle, not this package:

```bash
dsh plugin --profile <profile> add @ds-hu/dsh-context-slimmer
```

The bundle patch inserts this row; the row resolves this package from the profile. Do not copy the
row into your own `cordis.patch.yml` — a duplicate `id` makes the profile fail to boot.

## Configuration

Click the module title in the native Plugins panel to edit these fields; they are applied live and
written to the profile's `cordis.patch.yml`.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch of this module. |
| `everyNToolCalls` | `12` | Fire only after this many newly settled tool results; `0` disables the count check. |
| `minChars` | `24000` | Fire only after that many new tool-result characters accumulated; `0` disables the size check. Both checks are ANDed. |
| `protectRecent` | `3` | The most recent K tool results are never touched. |
| `maxTargets` | `4` | Maximum candidates one run may review (1–20). |
| `triggerOnErrorOnly` | `false` | Only run when the batch contains failures. |
| `minTargetChars` | `4096` | Results smaller than this are never candidates. |
| `timeoutMs` | `120000` | Planner hard timeout; timeout means no-op. |
| `policy` | `conservative` | `conservative` (default): drop only with verifiable evidence, no trimming. `balanced`: bounded trim. `aggressive`: legacy lossy mode, opt-in. |
| `includeSubagents` | `true` | Also slim subagent sessions (including agent-team members). |
| `promptLocale` | `auto` | Planner prompt language (advanced; profiled via `cordis.patch.yml`). |
| `model.provider` / `model.model` | empty (`inherit`) | Empty follows the current agent route. |
| `model.reasoningEffort` | `inherit` | `inherit` copies the current route's effort (keeps thinking); or `off`/`low`/`medium`/`high`/`max`. |
| `model.maxOutputTokens` | `0` | `0` = follow the model default (no cap). A positive value caps the whole completion, including reasoning tokens — too small a value can truncate the planner. |
| `diagnosticsFile` | empty | Optional JSONL diagnostics path (advanced; profiled via `cordis.patch.yml`). |

## How it works

1. On `agent/pre-step` (after the previous tool batch settled, before the next request is
   assembled) the module counts newly settled results per session — for the root agent and, by
   default, for subagent sessions too.
2. When **both** thresholds are crossed it sends one hidden planner call (`ctx.llm.stream()`) with
   the session's derived messages plus a compact candidate list: full context for judgement, no
   child session, no tools, no user-visible side effects.
3. The plan is validated atomically by deterministic host code. Under `conservative` each `drop`
   must carry evidence the host can re-verify: `duplicateOf` (later, same tool, byte-identical kept
   result), `supersededBy` (the failed target was replaced by a later successful same-tool result),
   or `empty` (the original text matches the core empty-output patterns). `trim` is rejected.
4. Accepted results are replaced by appending `compaction/prune` + a surface-`replace`
   `tool/result` — both log-only for the human transcript. The drop stub points at the kept copy and
   says "do not re-read".
5. The batch summary rides in `compaction/prune.data.contextSlimmer`; the bundle's client half
   renders it as the chat row. If a future Harness rejects that additive field, the module falls
   back to the official three-field prune event: replacements still land, only the row disappears.
6. Any failure (planner timeout, invalid JSON, policy rejection, append error) is a no-op for the
   main agent; if an explicit `model.maxOutputTokens` truncates the planner, it retries once without
   the cap and only then gives up.

The full protocol, architecture, research basis and compatibility notes live in the repository's
[`docs/`](https://github.com/ds-hu/dsh-context-slimmer/tree/main/docs).

## Requirements

- DeepSeek Harness `>=0.2.0 <0.3.0`
- Node.js `>=24.9.0`
- The Harness Web UI for the extra chat row and the native configuration page (the host half works
  headless without it)

## License

MIT © ds-hu
