# @ds-hu/dsh-context-slimmer-tool-result

Tool-result slimmer — module 1 of the [Context Slimmer](https://github.com/ds-hu/dsh-context-slimmer) bundle.

A background fork subagent periodically reviews **older tool results** in a session and asks the
main agent's context to keep only what still matters: successful and relevant evidence stays
byte-identical, wholly irrelevant or recoverable results are dropped, redundant bulk is trimmed,
and failure evidence is preserved. The main agent only sees the slimmed results; the chat
transcript keeps the original tool cards; one extra chat row ("已精简工具调用结果" / "Tool results
slimmed") reports what happened.

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

Shown as a form in the Plugins panel (schema from `@ds-hu/dsh-context-slimmer-core/config`):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch of this module. |
| `everyNToolCalls` | `8` | Slim after this many newly settled tool results; `0` disables the count trigger. |
| `minChars` | `24000` | Also slim when that many new tool-result characters accumulated; `0` disables. |
| `protectRecent` | `2` | The most recent K tool results are never touched. |
| `maxTargets` | `12` | Maximum candidates one run may review (1–64). |
| `triggerOnErrorOnly` | `false` | Only run when the batch contains failures. |
| `minTargetChars` | `256` | Results smaller than this are never candidates. |
| `timeoutMs` | `120000` | Background planner timeout; timeout means no-op. |
| `forkProvider` | `fork` | Subagent provider used for the planner. |
| `promptLocale` | `zh` | Planner prompt language (`zh` / `en`). |
| `model.provider` / `model.model` | `inherit` | `inherit` follows the main agent's current route. |
| `model.reasoningEffort` | `null` | Optional effort override for the planner. |
| `model.maxOutputTokens` | `2048` | Planner output cap. |

## How it works

1. On `agent/pre-step` (after the previous tool batch settled, before the next request is
   assembled) the module counts newly settled results per session.
2. When a threshold is crossed it starts a **managed fork subagent** whose seed is the parent's
   completed-turn history, so it judges the work with full context. The chain is natively
   structured-output constrained; every native tool of that child is restricted and guarded away.
3. The returned plan is validated atomically (`drop`/`trim` only, `trim` bounded to
   `min(300 tokens, 50% of the original)`), then each accepted result is replaced by appending
   `compaction/prune` + a surface-`replace` `tool/result` — both log-only for the human transcript.
4. The batch summary rides in `compaction/prune.data.contextSlimmer`; the bundle's client half
   renders it as the chat row. If a future Harness rejects that additive field, the module falls
   back to the official three-field prune event: replacements still land, only the row disappears.

The full protocol, threat model, research basis and compatibility notes live in the repository's
[`docs/`](https://github.com/ds-hu/dsh-context-slimmer/tree/main/docs).

## Requirements

- DeepSeek Harness `>=0.2.0 <0.3.0`
- Node.js `>=24.9.0`
- The Harness Web UI for the extra chat row (the host half works headless without it)

## License

MIT © ds-hu
