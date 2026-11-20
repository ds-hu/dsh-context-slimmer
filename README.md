# Context Slimmer

Native [DeepSeek Harness](https://github.com/deepseek-ai/dsh) plugin bundle that keeps an agent's
context lean **without rewriting the conversation users saw**. It ships as a set of fully
independent feature modules: every module is its own npm package and its own Loader row, so the
native Plugins panel can enable, disable and configure each one on its own.

The first module is **Tool-result slimmer**: every N tool calls (or when enough new output
accumulated) a background fork subagent — seeded with the full completed-turn history and
natively restricted to structured output only — decides which stale tool results still earn their
tokens. The main agent's next request sees only the slimmed results; the chat transcript keeps the
original tool cards untouched; and one extra row, modelled on the native "Context compacted" row,
reports what was slimmed.

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
compression is dangerous — it deletes constraints and failure evidence, and rewrites history the
user already saw. This plugin therefore splits the problem in three:

1. **Judge with full context, not a summary of it.** A fork subagent inherits the completed-turn
   history, so "is this result still relevant?" is answered by a model that has seen the task.
2. **Never rewrite the human transcript.** Replacements are model-only surface events
   (`surfaceOp: replace`), exactly like the official tool-result pruner; append-origin events keep
   the user-visible cards intact and fork/resume replay stays sound.
3. **Prefer keeping over deleting.** Successful and relevant results stay byte-identical; failures
   keep their exact evidence; only clearly recoverable or irrelevant bulk is dropped, and
   ambiguous cases stay untouched.

The underlying literature review, DSH protocol map and slimming policy are in [`docs/`](docs/).

## Modules

| Module | Package | Row id | Status |
|---|---|---|---|
| Tool-result slimmer | `@ds-hu/dsh-context-slimmer-tool-result` | `context-slimmer-tool-result` | shipped in `0.1.x` |
| Future modules | separate `packages/*` | separate rows | planned — each module stays independently switchable |

The shared pure library `@ds-hu/dsh-context-slimmer-core` is deliberately **not** a Loader row:
the Plugins panel cannot toggle it and no module can unmount it by accident.

## Install

```bash
dsh plugin --profile <profile> add @ds-hu/dsh-context-slimmer
```

The bundle patch inserts one row per module; each row resolves its own package from the profile.
Restart the profile (or let the live patch reload) and open **Plugins** — the bundle and its module
row appear with a native toggle and a generated configuration form.

Do **not** copy the rows into your own `cordis.patch.yml`: a duplicate `id` makes the profile fail
to boot (`entry <id> already exists`). Customize through the row config in the panel instead.

## Configuration (tool-result slimmer)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch of this module. |
| `everyNToolCalls` | `8` | Slim after this many newly settled tool results (`0` disables). |
| `minChars` | `24000` | Also slim when this many new result characters accumulated (`0` disables). |
| `protectRecent` | `2` | Most recent K results are never touched. |
| `maxTargets` | `12` | Max candidates reviewed per run (1–64). |
| `triggerOnErrorOnly` | `false` | Only run when the batch contains failures. |
| `minTargetChars` | `256` | Smaller results are never candidates. |
| `timeoutMs` | `120000` | Planner timeout; a timeout is a no-op. |
| `model.provider` / `model.model` | `inherit` | `inherit` follows the main agent's live route. |
| `model.reasoningEffort` | `null` | Optional planner effort override. |
| `model.maxOutputTokens` | `2048` | Planner output cap. |

## How it works (short)

1. `agent/pre-step` — after the previous tool batch settled, before the next request is assembled —
   counts newly settled tool results per session.
2. Above threshold, a managed **fork** subagent is started with the parent's completed-turn seed and
   a native `outputSchema`; its seed keeps the parent prompt prefix byte-identical (KV-cache
   friendly, append-only).
3. Its native tools are hidden with `agent.ctx.tools.restrict()` and a `tools/pre-execute` guard, so
   it can only return the structured plan.
4. The plan is validated atomically by pure host code, then each accepted result receives
   `compaction/prune` + a surface replacement `tool/result`. The batch summary rides in the prune
   event's additive `contextSlimmer` field and drives the extra chat row.
5. Any failure — model, timeout, invalid plan, append error — is a no-op for the main agent.

Full protocol, safety rules and compatibility fallbacks: [`docs/protocol.md`](docs/protocol.md) and
[`docs/dev-notes.md`](docs/dev-notes.md).

## Compatibility & honest limitations

- Requires DSH `>=0.2.0 <0.3.0` and Node.js `>=24.9.0`.
- The extra chat row consumes an **additive JSON field on the official log-only
  `compaction/prune` event**. The host half detects a stricter future validator and degrades to the
  official three-field event: replacements still land, only the row disappears.
- The background child is created through the managed fork activation path, which exposes the
  parent's tool *schemas* to it; every execution is denied by a scoped restriction plus a
  pre-execute guard. Its only usable tool is the native `structured_output`.
- No API keys, tool-result text or user content are logged by the plugin; the stored batch summary
  contains indices, sizes, model identity and the model-written one-line reasons only.
- The client half makes no network requests and does not read session content beyond the event
  payload.

## Screenshots (captured from a real DSH run in CI)

All screenshots come from a real DeepSeek Harness instance started in GitHub Actions (real model session + `dsh web`):

The native-looking row in the conversation flow (`已精简工具调用结果 · 1 项 · 释放 24,181 字符`):

![chat row](https://github.com/ds-hu/dsh-context-slimmer/releases/download/v0.1.0/verify-chat-zh.png)

Expanded detail of the applied plan (item / trigger / model):

![detail](https://github.com/ds-hu/dsh-context-slimmer/releases/download/v0.1.0/verify-chat-detail.png)

The trajectory shows what the model actually sees after replacement (`[elided by context-slimmer]`):

![trajectory](https://github.com/ds-hu/dsh-context-slimmer/releases/download/v0.1.0/verify-trajectory.png)

The module in the native Plugins panel (toggle/config per module):

![plugins](https://github.com/ds-hu/dsh-context-slimmer/releases/download/v0.1.0/verify-plugins.png)

## Development

```bash
npm install          # workspaces: bundle + core + module
npm test             # offline unit tests (no dsh, no API calls)
npm run test:core
node --test packages/tool-result-slimmer/test/*.test.mjs
```

Real end-to-end verification (headless session with a live model + Web UI screenshot of the row)
runs in GitHub Actions; see [`.github/workflows/verify.yml`](.github/workflows/verify.yml) and
[`docs/ci.md`](docs/ci.md).

## License

MIT © ds-hu
