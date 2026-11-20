# Client half — `@ds-hu/dsh-context-slimmer-tool-result`

Browser-side contribution of the tool-result slimmer module: it draws **one Chat
row per slimming batch** (`已精简工具调用结果 · N 项 · 释放 X 字符`) in the
conversational flow, styled like the native "context compacted" marker, with an
expandable per-item detail body.

The row is presentation only. It never writes to the session, never fetches
anything, and never changes the user-visible tool cards: the Host half rewrites
only the model-facing surface (a native `tool/result` replacement), so the
transcript keeps the original cards and this row merely reports what changed.

- Source: `lib/client.js` (hand-written bundle, **no build step**)
- Manifest: `package.json` → `exports["./client"]`, `dsh.client`
- Tests: `test/client-smoke.test.mjs` (`node --test`)
- Design notes / evidence: `docs/ui-notes.md` in the repository root

---

## Bundle format

`lib/client.js` is a classic script executed by the DSH client-module loader at
page boot. It only registers a lazy factory; everything else happens later, when
the plugin fiber calls `apply(ctx)`:

```js
window.__ModuleLoader__.load({
  id: '@ds-hu/dsh-context-slimmer-tool-result', // must equal package.json name
  factory: (require) => {
    const React = require('react'); // the only module request
    // ... registration helpers, dictionaries, styles, component ...
    return { inject, apply, __ctxslimTest };
  },
});
```

`react` is a baseline entry of the shell's frozen module table, so no
`dsh.client.external` entry is needed. The bundle must stay ESM-free (no
`import`/`export`) and must not log with `console.log`; conditional diagnostics
are gated behind `window.__CTXSLIM_DEBUG__ === true` and use `console.debug`.

`package.json` declares only hints for the Loader:

```json
"dsh": {
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-chat",
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-renderer"
    ]
  }
}
```

`dsh.client.inject` is a package-name list (component availability), not Cordis
service injection. The real services this bundle needs are declared in its
exported `inject`:

```js
const inject = ['slots', 'locale', 'uiConversation'];
```

---

## What `apply(ctx)` does

1. **Dictionaries** — `ctx.locale.register('context-slimmer', { zh, en })`
   (ownership: `ctx.effect`). `en` is the fallback for other UI languages.
2. **Conversation Definition** — `ctx.uiConversation.events.register(definition)`
   (ownership: the registry wraps it in the caller's `ctx.effect`).
3. **Stylesheet** — one owned `<style data-plugin="<pkg>" data-plugin-css="…">`
   tag, removed on dispose (client-module unload sweeps `style[data-plugin]` too).
4. **Chat renderer** — keyed registration in the Chat slot:

   ```js
   ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
     name: 'conversation.chat.node',
     key: 'context-slimmer-tool-result', // == definition.kind == node.kind
     locale: 'context-slimmer',          // injects `t` into the component
   }, SlimRowView));
   ```

---

## Data contract

The Client sees the batch summary on the **official `compaction/prune` event**
that the Host must append immediately before every `tool/result` surface
replacement (native shadow-price protocol). The plugin attaches an
owner-defined payload under `data.contextSlimmer`:

```jsonc
{
  "type": "compaction/prune",
  "seq": 123,
  "data": {
    "shadowedRange": { "start": 5, "end": 5 },
    "shadowedSeqs": [5],
    "shadowedTokenCount": 1234,
    "contextSlimmer": {
      "v": 1,
      "batchId": "batch-…",
      "role": "summary",          // 'item' on earlier prunes of the same batch
      "status": "applied",
      "startedAt": 0,
      "finishedAt": 0,
      "trigger": { "everyNToolCalls": 8, "minChars": 24000, "observedCalls": 8, "observedChars": 30000 },
      "model": { "provider": "deepseek", "model": "deepseek-v4.1-flash", "inherited": false },
      "items": [
        {
          "index": 0, "callId": "…", "toolName": "bash", "op": "drop",
          "reason": "…", "charsBefore": 8123, "charsAfter": 48, "replacementSeq": 20
        }
      ],
      "totals": { "items": 1, "charsBefore": 8123, "charsAfter": 48, "charsSaved": 8075 }
    }
  }
}
```

- `match` claims only `role === 'summary'` → one row per batch (`id = context-slimmer:<batchId>`).
- Native tool-result-pruner prune events carry no `contextSlimmer` and never match;
  the native compaction row only matches `compaction/start|summary|end`, so there
  is no duplicate row.
- `tool/result.data.meta.contextSlimmer` is also read as a **forward-compatibility
  placeholder**; it never fires today because the session validator forbids
  changing `meta` on a replacement (`assertToolResultRewrite`). Do not rely on it.

The produced Node mirrors the native compaction row exactly:

```js
{
  key: context.key,
  kind: 'context-slimmer-tool-result',
  id: context.id,
  target: 'chat',
  anchorSeq: event.seq,   // summary prune seq — tail of the current turn
  location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'session' },
  visibility: 'visible',
  data: normalizedSummary,
}
```

No `groupTree` override (same as the native `chatNode(...)` call). The Node is
durable: after a page reload the assembler replays the prune events and the row
is rebuilt.

---

## Rendering notes

- Collapsed: one line, native-compaction typography — leading icon (context glyph
  that swaps to a disclosure chevron on hover/focus/expand), title, 2px dot
  separator, `N 项 · 释放 X 字符`. The whole line is a native `<button>` with
  `aria-expanded`; keyboard activation is the browser default. The icon is an
  inline-SVG approximation of the primitives glyph (`IconApiOutlineRegular` /
  chevrons) to avoid declaring `dsh.client.external`; geometry matches the native
  16px seat. An expanded long body keeps the native sticky header behavior.
- Expanded body: one line per item (`#index toolName · op · charsBefore→charsAfter
  · reason`, max 40 rendered, then `…还有 N 项`), then trigger statistics and
  `模型：{provider}/{model}` last. `op` is printed verbatim (`drop`/`trim`).
- Non-`applied` statuses render gray (`本次无改动` / `已跳过…`) for forward
  compatibility; today the Host only emits summaries for applied batches.
- Tokens only (`--dsw-alias-label-tertiary`, `--dsw-alias-label-caption`,
  `--dsw-alias-interactive-bg-hover(-solid)`, `--dsw-alias-bg-base`,
  `--dsw-radius-sm`, `--dsw-focus-ring-color`, `--dsh-content-font-*`), so
  light/dark themes and the content-font scale apply automatically. All classes
  are prefixed `ctxslim-`.
- e2e hooks: `data-ctxslimmer-row`, `data-ctxslimmer-toggle`,
  `data-ctxslimmer-summary`, `data-ctxslimmer-item`, `data-ctxslimmer-model`,
  `data-ctxslimmer-trigger`, `data-ctxslimmer-status`, `data-status`,
  `data-expanded`.
- Copy lives in the in-bundle `zh`/`en` dictionaries (`row.*`, `item.*`); the
  `locale/*.json` files are read by the DSH Loader for the native plugin-panel
  title/description (via `dsh-app-boot`), not by this bundle.

---

## Debugging

Enable verbose client diagnostics from the browser console:

```js
window.__CTXSLIM_DEBUG__ = true; // then reload the page
```

You will see `[context-slimmer]` `console.debug` lines for activation and node
materialization.

If the row does not appear:

1. Check that the module row is enabled and the page was reloaded (client plugin
   reloads are picked up by the module loader; a hard reload is the safe check).
2. In the session jsonl, confirm `compaction/prune` events exist and the last one
   of the batch has `data.contextSlimmer.role === "summary"`.
3. Confirm the event type is exactly `compaction/prune` and the payload key is
   exactly `contextSlimmer` — `match` is strict.
4. If the Definition never materializes a Node, check for a console error during
   `apply(ctx)` (a duplicate `kind` registration is a hard error).

---

## Testing

```bash
cd packages/tool-result-slimmer
node --check lib/client.js
npm run test:module          # node --test test/*.test.mjs
```

`test/client-smoke.test.mjs` is fully offline: it fakes
`window.__ModuleLoader__`, materializes the factory with a structural `react`
mock (no real rendering), mocks the Cordis client context, and asserts the
registration surface, Definition matching (positive + native-prune negative),
Node shape, dictionaries, and the rendered element tree for zh/en and for the
degraded payload branches.

Keep `lib/client.js` hand-written: no bundler, no JSX, no extra runtime imports.
If a richer UI element is ever needed, prefer `@deepseek-ai/dsh-client-ui-primitives`
(already a baseline module, would require a `dsh.client.external` entry) over
adding a build step — but check `docs/ui-notes.md` first.
