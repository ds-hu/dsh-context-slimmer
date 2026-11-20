/**
 * @file Browser half (client bundle) of `@ds-hu/dsh-context-slimmer-tool-result`.
 *
 * The DSH client-module system executes this file as a classic script at page
 * boot; it must only register a lazy factory with `window.__ModuleLoader__`.
 * Every browser side effect (stylesheet mount, locale dictionary, Conversation
 * Definition, keyed Chat renderer) runs later from `apply(ctx)` and is owned by
 * that plugin fiber through `ctx.effect` / `ctx.slots.inject`.
 *
 * Data flow (see docs/ui-notes.md for the evidence trail):
 *   1. The Host half rewrites each slimmed tool result with a native
 *      `tool/result` replacement event (`surfaceOp: {op:'replace'}`) and, as the
 *      native shadow-price protocol requires, appends a `compaction/prune` event
 *      immediately before it. This plugin extends that prune payload with
 *      `data.contextSlimmer` (owner-defined JSON): `role: 'item'` on each
 *      replacement's prune event and the aggregate `role: 'summary'` on the last
 *      one of a batch.
 *   2. The Conversation assembler forwards every durable Session event to the
 *      registered Definition's `match`; the summary event becomes a Chat-target
 *      Context whose State is the batch summary snapshot.
 *   3. `buildViewNode` materializes one Chat row Node (`anchorSeq` = summary event
 *      seq) through the same `chatNode(context, kind, anchorSeq, data)` defaults
 *      as the native compaction marker, so the row sits in the conversational
 *      flow right after the rewritten results.
 *   4. The keyed `conversation.chat.node` slot dispatches that Node to
 *      {@link SlimRow}, which renders a native-compaction-style one-line row
 *      with an expandable detail body.
 *
 * This bundle is hand-written on purpose: the only runtime module it requests is
 * `react` (a baseline entry of the shell's frozen module table), so it needs no
 * build step, no `dsh.client.external` entry, and no `@deepseek-ai` runtime
 * imports beyond the Cordis services injected by `apply`.
 *
 * @module dsh-context-slimmer/client
 */

window.__ModuleLoader__.load({
  id: '@ds-hu/dsh-context-slimmer-tool-result',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** Package id: must equal `package.json#name` (the module-graph row id). */
    const PACKAGE_ID = '@ds-hu/dsh-context-slimmer-tool-result';

    /** Conversation Definition kind, Chat Node kind, and renderer slot key. */
    const NODE_KIND = 'context-slimmer-tool-result';

    /**
     * Primary data channel: the official shadow-price event the Host must append
     * immediately before each `tool/result` replacement. Its payload is
     * owner-defined JSON, so this plugin extends it with `data.contextSlimmer`
     * (the native pruner's own prune events carry no such key and are ignored).
     */
    const PRUNE_TYPE = 'compaction/prune';

    /**
     * Secondary channel, forward-compatibility placeholder only:
     * `tool/result.data.meta`. The current session validator forbids changing a
     * replacement's `meta`, so this branch never fires against today's runtime.
     */
    const TOOL_RESULT_TYPE = 'tool/result';

    /** Presentation payload key used by both channels. */
    const META_KEY = 'contextSlimmer';

    /** `role` marking the last event of a batch: it carries the aggregate summary. */
    const SUMMARY_ROLE = 'summary';

    /** Client locale namespace owned by this bundle. */
    const LOCALE_NS = 'context-slimmer';

    /** Keyed Chat renderer slot declared by `@deepseek-ai/dsh-client-ui-chat`. */
    const CHAT_NODE_SLOT = 'conversation.chat.node';

    /** Stylesheet ownership id (also the client-modules eviction marker). */
    const CSS_ID = PACKAGE_ID + '/SlimRow.css';

    /** Debug flag read from the page global; no output unless explicitly set. */
    const DEBUG_FLAG = '__CTXSLIM_DEBUG__';

    /** Maximum detail rows rendered for one batch (extra rows collapse to a counter). */
    const DETAIL_ITEM_LIMIT = 40;

    // #region helpers

    /**
     * Whether a value is a plain non-array object.
     * @param value - candidate value.
     * @returns whether the value can be treated as a JSON object.
     */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * Read a non-empty trimmed string field.
     * @param value - candidate value.
     * @returns trimmed string, or null when absent/blank.
     */
    function readString(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    }

    /**
     * Read a finite integer field.
     * @param value - candidate value.
     * @returns finite integer, or null when absent/invalid.
     */
    function readInteger(value) {
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : null;
    }

    /**
     * Read a finite non-negative number field (char counts tolerate large values).
     * @param value - candidate value.
     * @returns finite non-negative number, or null when absent/invalid.
     */
    function readCount(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    }

    /**
     * Format a count with comma thousands separators (locale-neutral grouping,
     * identical in zh and en dictionaries, so no Intl lookup is needed).
     * @param value - non-negative number.
     * @returns display string.
     */
    function formatCount(value) {
      const text = String(Math.trunc(value));
      return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /**
     * Sum one nullable numeric field across normalized items.
     * @param items - normalized item list.
     * @param field - numeric field name.
     * @returns sum of the present values.
     */
    function sumField(items, field) {
      let total = 0;
      for (const item of items) {
        const value = item[field];
        if (typeof value === 'number') total += value;
      }
      return total;
    }

    /**
     * Read the page-level debug switch without assuming a browser environment.
     * @returns whether conditional debug output is enabled.
     */
    function debugEnabled() {
      try {
        if (typeof window !== 'undefined' && window !== null && window[DEBUG_FLAG] === true) return true;
        if (typeof globalThis !== 'undefined' && globalThis[DEBUG_FLAG] === true) return true;
      } catch (error) {
        /* A hostile global must never break rendering. */
      }
      return false;
    }

    /**
     * Emit conditional debug output (never `console.log`, never in production).
     * @param args - diagnostic values.
     */
    function debug(...args) {
      if (!debugEnabled()) return;
      try {
        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          console.debug('[context-slimmer]', ...args);
        }
      } catch (error) {
        /* Debug output is best-effort only. */
      }
    }

    // #endregion

    // #region batch normalization

    /** Status values the renderer understands; anything else falls back by payload shape. */
    const KNOWN_STATUS = Object.freeze({
      applied: true,
      'no-op': true,
      rejected: true,
      failed: true,
    });

    /**
     * Normalize one `meta.contextSlimmer` batch-summary payload into the stable
     * shape the row renders. Every field is optional at runtime: payloads
     * written by an older or newer Host build must degrade to a readable row
     * instead of throwing.
     * @param raw - untrusted payload (`event.data.meta.contextSlimmer`).
     * @returns normalized batch snapshot.
     */
    function normalizeSummary(raw) {
      const batch = isRecord(raw) ? raw : {};
      const rawItems = Array.isArray(batch.items) ? batch.items : [];
      const items = [];
      for (let index = 0; index < rawItems.length; index += 1) {
        const entry = rawItems[index];
        if (!isRecord(entry)) continue;
        items.push({
          index: readInteger(entry.index),
          callId: readString(entry.callId),
          toolName: readString(entry.toolName),
          op: readString(entry.op),
          reason: readString(entry.reason),
          charsBefore: readCount(entry.charsBefore),
          charsAfter: readCount(entry.charsAfter),
          replacementSeq: readInteger(entry.replacementSeq),
        });
      }

      const rawTotals = isRecord(batch.totals) ? batch.totals : {};
      let charsBefore = readCount(rawTotals.charsBefore);
      let charsAfter = readCount(rawTotals.charsAfter);
      if (charsBefore === null) charsBefore = sumField(items, 'charsBefore');
      if (charsAfter === null) charsAfter = sumField(items, 'charsAfter');
      const rawSaved = readCount(rawTotals.charsSaved);
      const charsSaved = rawSaved === null ? Math.max(0, charsBefore - charsAfter) : rawSaved;

      const rawModel = isRecord(batch.model) ? batch.model : {};
      const rawTrigger = isRecord(batch.trigger) ? batch.trigger : {};
      const rawStatus = readString(batch.status);
      const status = rawStatus !== null && KNOWN_STATUS[rawStatus] === true
        ? rawStatus
        : items.length > 0
          ? 'applied'
          : 'no-op';

      return {
        version: readInteger(batch.v) === null ? readInteger(batch.version) : readInteger(batch.v),
        batchId: readString(batch.batchId) === null ? readString(batch.runId) : readString(batch.batchId),
        startedAt: readInteger(batch.startedAt) === null ? readInteger(batch.createdAt) : readInteger(batch.startedAt),
        finishedAt: readInteger(batch.finishedAt),
        status,
        items,
        totals: {
          items: readCount(rawTotals.items) === null ? items.length : readCount(rawTotals.items),
          charsBefore,
          charsAfter,
          charsSaved,
        },
        model: {
          provider: readString(rawModel.provider),
          model: readString(rawModel.model),
          inherited: rawModel.inherited === true,
        },
        trigger: {
          everyNToolCalls: readCount(rawTrigger.everyNToolCalls),
          minChars: readCount(rawTrigger.minChars),
          observedCalls: readCount(rawTrigger.observedCalls),
          observedChars: readCount(rawTrigger.observedChars),
        },
      };
    }

    // #endregion

    // #region locale dictionaries

    /** Simplified Chinese row copy (UI language zh). */
    const ZH = Object.freeze({
      'row.title': '已精简工具调用结果',
      'row.items.one': '1 项',
      'row.items.other': '{count} 项',
      'row.saved': '释放 {chars} 字符',
      'row.noop': '本次无改动',
      'row.skipped': '已跳过（模型未返回有效计划）',
      'row.expand': '展开明细',
      'row.collapse': '收起明细',
      'row.empty': '无明细',
      'row.more': '…还有 {count} 项',
      'row.model': '模型：{model}',
      'row.model.inherited': '模型：继承主 Agent',
      'row.trigger': '触发：新增工具结果 {calls} 条、{chars} 字符',
      'item.unknownTool': '工具',
      'item.chars': '{before}→{after}',
      'item.charsMissing': '字符数未知',
    });

    /** English row copy (the fallback locale for every other UI language). */
    const EN = Object.freeze({
      'row.title': 'Tool results slimmed',
      'row.items.one': '1 item',
      'row.items.other': '{count} items',
      'row.saved': '{chars} chars freed',
      'row.noop': 'No changes this run',
      'row.skipped': 'Skipped (the model returned no valid plan)',
      'row.expand': 'Show details',
      'row.collapse': 'Hide details',
      'row.empty': 'No details',
      'row.more': '…and {count} more',
      'row.model': 'Model: {model}',
      'row.model.inherited': 'Model: inherited from the main agent',
      'row.trigger': 'Triggered after {calls} new tool results and {chars} chars',
      'item.unknownTool': 'tool',
      'item.chars': '{before}→{after}',
      'item.charsMissing': 'chars unknown',
    });

    /** Last-resort translator replaced by the bound locale service in `apply`. */
    let fallbackTranslate = (key) => key;

    // #endregion

    // #region Conversation Definition (event -> Chat node)

    /**
     * Test whether one event is a model-surface replacement (native field on the
     * event envelope, visible to the Client): the Host rewrites history through
     * this operation instead of appending, so the user-visible transcript keeps
     * its original tool card.
     * @param event - Client Session event.
     * @returns whether the event replaces an earlier surface node.
     */
    function isReplacementEvent(event) {
      return isRecord(event) && isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace';
    }

    /**
     * Read this plugin's payload off the primary channel: the shadow-price
     * `compaction/prune` event that precedes every replacement.
     * @param event - Client Session event.
     * @returns the `contextSlimmer` payload, or null when the event is not ours.
     */
    function prunePayloadOf(event) {
      if (!isRecord(event) || event.type !== PRUNE_TYPE) return null;
      const data = event.data;
      if (!isRecord(data)) return null;
      const payload = data[META_KEY];
      return isRecord(payload) ? payload : null;
    }

    /**
     * Read this plugin's payload off the secondary channel:
     * `tool/result.data.meta.contextSlimmer` on a surface replacement.
     *
     * Forward-compatibility placeholder only: the current session validator
     * (`assertToolResultRewrite` in `dsh-session`) compares the replacement data
     * with the original data and exempts only `message.content`, so the Host can
     * never add/change `meta` on a replacement. This branch therefore never fires
     * against today's runtime; it exists so the client needs no change if a
     * future DSH release relaxes that rule.
     *
     * @param event - Client Session event.
     * @returns the `contextSlimmer` payload, or null when the event is not ours.
     */
    function replacementPayloadOf(event) {
      if (!isRecord(event) || event.type !== TOOL_RESULT_TYPE || !isReplacementEvent(event)) return null;
      const data = event.data;
      if (!isRecord(data)) return null;
      const meta = data.meta;
      if (!isRecord(meta)) return null;
      const payload = meta[META_KEY];
      return isRecord(payload) ? payload : null;
    }

    /**
     * Read this plugin's batch payload from whichever supported channel the
     * event uses.
     * @param event - Client Session event.
     * @returns the `contextSlimmer` payload, or null when the event is unrelated.
     */
    function slimmerPayloadOf(event) {
      return prunePayloadOf(event) ?? replacementPayloadOf(event);
    }

    /**
     * Claim the last event of one slimming batch and derive its stable Context id.
     *
     * Only the `role: 'summary'` event carries the aggregate batch facts; the
     * earlier `role: 'item'` events of the batch are ignored, so one batch renders
     * exactly one row. The id is `context-slimmer:<batchId>` so a Host that ever
     * re-emits the same batch updates the same row; payloads without a batchId
     * fall back to the event seq, which is equally stable.
     *
     * @param event - Client Session event.
     * @returns match identity, or null when the event is unrelated.
     */
    function matchSlimmingEvent(event) {
      const payload = slimmerPayloadOf(event);
      if (payload === null || readString(payload.role) !== SUMMARY_ROLE) return null;
      const batchId = readString(payload.batchId);
      const suffix = batchId === null ? 'seq-' + String(event.seq) : batchId;
      return { id: 'context-slimmer:' + suffix, role: 'start' };
    }

    /**
     * Snapshot one matched batch summary as Definition State.
     * @param event - matched Client Session event.
     * @returns immutable State (anchor seq + normalized summary payload).
     */
    function snapshotOf(event) {
      const source = isRecord(event) ? event : {};
      return {
        anchorSeq: typeof source.seq === 'number' ? source.seq : 0,
        time: typeof source.time === 'number' ? source.time : null,
        summary: normalizeSummary(slimmerPayloadOf(source)),
      };
    }

    /**
     * Resolve the business Location the engine handed to a Context.
     * @param context - assembled Context.
     * @returns engine-owned Location (never undefined).
     */
    function locationOf(context) {
      if (isRecord(context)) {
        if (isRecord(context.start) && isRecord(context.start.location)) return context.start.location;
        if (Array.isArray(context.matches)) {
          for (const match of context.matches) {
            if (isRecord(match) && isRecord(match.location)) return match.location;
          }
        }
      }
      return { kind: 'session' };
    }

    /**
     * Business Definition turning one batch summary into one Chat row Node.
     *
     * The produced Node mirrors the native compaction marker exactly: the same
     * `chatNode(context, kind, anchorSeq, data)` defaults as
     * `dsh-client-ui-chat`'s `compactionDefinition` (visible, no `groupTree`
     * override), so the row participates in the Chat flow at its anchor position
     * like a first-class native row instead of being re-parented into a
     * Turn-process group.
     */
    const definition = Object.freeze({
      kind: NODE_KIND,
      target: 'chat',
      match: matchSlimmingEvent,
      start(context, match) {
        return snapshotOf(match.event);
      },
      update(context, match) {
        return snapshotOf(match.event);
      },
      buildViewNode(context) {
        const state = context === undefined || context === null ? undefined : context.state;
        if (!isRecord(state) || typeof state.anchorSeq !== 'number') return null;
        const node = {
          key: context.key,
          kind: NODE_KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: state.anchorSeq,
          location: locationOf(context),
          visibility: 'visible',
          data: state.summary,
        };
        debug('built node', { seq: node.anchorSeq, status: node.data.status, items: node.data.items.length });
        return node;
      },
    });

    // #endregion

    // #region presentation helpers

    /**
     * Label describing how many items a batch reports.
     * @param count - reported item count.
     * @param t - translator.
     * @returns localized count label.
     */
    function itemsLabel(count, t) {
      return count === 1 ? t('row.items.one') : t('row.items.other', { count: formatCount(count) });
    }

    /**
     * One-line summary after the row title.
     * @param batch - normalized batch.
     * @param t - translator.
     * @returns localized summary text.
     */
    function summaryText(batch, t) {
      if (batch.status === 'applied') {
        return itemsLabel(batch.totals.items, t) + ' · ' + t('row.saved', { chars: formatCount(batch.totals.charsSaved) });
      }
      if (batch.status === 'no-op') return t('row.noop');
      return t('row.skipped');
    }

    /**
     * Trailing model attribution, when the batch carries one.
     * @param batch - normalized batch.
     * @param t - translator.
     * @returns localized model line, or null when unknown.
     */
    function modelText(batch, t) {
      const model = batch.model;
      if (model.provider !== null && model.model !== null) {
        return t('row.model', { model: model.provider + '/' + model.model });
      }
      if (model.inherited) return t('row.model.inherited');
      return null;
    }

    /**
     * Trigger statistics line, only for an applied run that recorded them.
     * @param batch - normalized batch.
     * @param t - translator.
     * @returns localized trigger line, or null when unavailable.
     */
    function triggerText(batch, t) {
      if (batch.status !== 'applied') return null;
      const trigger = batch.trigger;
      if (trigger.observedCalls === null && trigger.observedChars === null) return null;
      return t('row.trigger', {
        calls: formatCount(trigger.observedCalls === null ? 0 : trigger.observedCalls),
        chars: formatCount(trigger.observedChars === null ? 0 : trigger.observedChars),
      });
    }

    /**
     * Build the ordered `·`-separated facts describing one slimmed result.
     * @param item - normalized item.
     * @param position - zero-based position inside the batch list.
     * @param t - translator.
     * @returns fact descriptors `{ kind, text }`.
     */
    function itemFacts(item, position, t) {
      const facts = [{
        kind: 'index',
        text: '#' + String(item.index === null ? position : item.index),
      }, {
        kind: 'tool',
        text: item.toolName === null ? t('item.unknownTool') : item.toolName,
      }];
      if (item.op !== null) facts.push({ kind: 'op', text: item.op });
      if (item.charsBefore === null && item.charsAfter === null) {
        facts.push({ kind: 'chars', text: t('item.charsMissing') });
      } else {
        facts.push({
          kind: 'chars',
          text: t('item.chars', {
            before: item.charsBefore === null ? '—' : formatCount(item.charsBefore),
            after: item.charsAfter === null ? '—' : formatCount(item.charsAfter),
          }),
        });
      }
      if (item.reason !== null) facts.push({ kind: 'reason', text: item.reason });
      return facts;
    }

    // #endregion

    // #region icons

    /**
     * Leading "compressing context lines" glyph used at rest.
     * @returns inline SVG element.
     */
    function ContextGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
      }, h('path', {
        d: 'M3 4.25h10M4.5 8h7M6.25 11.75h3.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
      }));
    }

    /**
     * Leading disclosure chevron shown on hover/focus/expand.
     * @param props - `{ open }` current disclosure state.
     * @returns inline SVG element.
     */
    function DisclosureGlyph(props) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': true,
        focusable: 'false',
      }, h('path', {
        d: props.open === true ? 'M4 6.25 8 10.25 12 6.25' : 'M6.5 4 10.5 8 6.5 12',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }));
    }

    // #endregion

    // #region row component

    /** Structural class names; every rule lives in {@link CSS_TEXT}. */
    const cls = Object.freeze({
      row: 'ctxslim-row',
      button: 'ctxslim-button',
      leading: 'ctxslim-leading',
      contextIcon: 'ctxslim-context',
      disclosureIcon: 'ctxslim-disclosure',
      title: 'ctxslim-title',
      sep: 'ctxslim-sep',
      summary: 'ctxslim-summary',
      body: 'ctxslim-body',
      items: 'ctxslim-items',
      item: 'ctxslim-item',
      itemSep: 'ctxslim-item-sep',
      more: 'ctxslim-more',
      meta: 'ctxslim-meta',
    });

    /**
     * Render one `#index tool · op · before→after · reason` detail row.
     * @param item - normalized item.
     * @param position - zero-based position inside the batch list.
     * @param t - translator.
     * @returns React element.
     */
    function itemRow(item, position, t) {
      const facts = itemFacts(item, position, t);
      const children = [];
      for (let index = 0; index < facts.length; index += 1) {
        if (index > 0) {
          children.push(h('span', {
            key: 'sep-' + String(index),
            className: cls.itemSep,
            'aria-hidden': true,
          }, '·'));
        }
        children.push(h('span', {
          key: 'fact-' + String(index),
          className: 'ctxslim-item-' + facts[index].kind,
          'data-ctxslimmer-fact': facts[index].kind,
        }, facts[index].text));
      }
      return h('div', {
        key: 'item-' + String(position),
        className: cls.item,
        'data-ctxslimmer-item': '',
        'data-op': item.op === null ? '' : item.op,
      }, children);
    }

    /**
     * One Chat row: a native-compaction-style header button plus an optional
     * detail body. The header stays keyboard operable through the native button
     * semantics (`Enter`/`Space`) and exposes `aria-expanded`.
     * @param props - keyed renderer props: `{ node, t }` (+ owner props we ignore).
     * @returns React element.
     */
    function SlimRow(props) {
      const node = isRecord(props) ? props.node : undefined;
      const t = isRecord(props) && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const batch = normalizeSummary(isRecord(node) ? node.data : undefined);
      const [expanded, setExpanded] = React.useState(false);

      const hasItems = batch.items.length > 0;
      const model = modelText(batch, t);
      const trigger = triggerText(batch, t);
      const statusDetail = batch.status !== 'applied';
      const expandable = hasItems || model !== null || trigger !== null || statusDetail;
      const open = expandable && expanded === true;
      const summary = summaryText(batch, t);

      const headerChildren = [
        h('span', {
          key: 'leading',
          className: cls.leading,
          'aria-hidden': true,
        }, [
          h('span', {
            key: 'context',
            className: cls.contextIcon,
            'data-ctxslimmer-icon': 'context',
          }, h(ContextGlyph)),
          h('span', {
            key: 'disclosure',
            className: cls.disclosureIcon,
            'data-ctxslimmer-disclosure': open ? 'expanded' : 'collapsed',
          }, h(DisclosureGlyph, { open })),
        ]),
        h('span', { key: 'title', className: cls.title }, t('row.title')),
        h('span', { key: 'sep', className: cls.sep, 'aria-hidden': true }),
        h('span', {
          key: 'summary',
          className: cls.summary,
          'data-ctxslimmer-summary': '',
        }, summary),
      ];

      const button = h('button', {
        key: 'toggle',
        type: 'button',
        className: cls.button,
        'data-ctxslimmer-toggle': '',
        disabled: !expandable,
        'aria-expanded': expandable ? open : undefined,
        onClick: () => {
          if (!expandable) return;
          setExpanded((value) => value !== true);
        },
      }, headerChildren);

      const children = [button];

      if (open) {
        const body = [];
        if (statusDetail) {
          body.push(h('div', {
            key: 'status',
            className: cls.meta,
            'data-ctxslimmer-status': batch.status,
          }, summary));
        }
        if (hasItems) {
          const visible = batch.items.slice(0, DETAIL_ITEM_LIMIT);
          const rows = visible.map((item, position) => itemRow(item, position, t));
          body.push(h('div', { key: 'items', className: cls.items }, rows));
          if (batch.items.length > visible.length) {
            body.push(h('div', {
              key: 'more',
              className: cls.more,
            }, t('row.more', { count: formatCount(batch.items.length - visible.length) })));
          }
        } else if (!statusDetail) {
          body.push(h('div', { key: 'empty', className: cls.meta }, t('row.empty')));
        }
        if (trigger !== null) {
          body.push(h('div', {
            key: 'trigger',
            className: cls.meta,
            'data-ctxslimmer-trigger': '',
          }, trigger));
        }
        if (model !== null) {
          body.push(h('div', {
            key: 'model',
            className: cls.meta,
            'data-ctxslimmer-model': '',
          }, model));
        }
        children.push(h('div', { key: 'body', className: cls.body }, body));
      }

      return h('div', {
        className: cls.row,
        'data-ctxslimmer-row': '',
        'data-kind': NODE_KIND,
        'data-status': batch.status,
        'data-expanded': open ? 'true' : 'false',
      }, children);
    }

    /** Memoized renderer (React.memo is optional so structural tests can call it). */
    const SlimRowView = typeof React.memo === 'function' ? React.memo(SlimRow) : SlimRow;

    /** Test/dev display name for React DevTools. */
    try {
      SlimRowView.displayName = 'ContextSlimmerToolResultRow';
    } catch (error) {
      /* Frozen memo wrappers are acceptable. */
    }

    // #endregion

    // #region stylesheet

    /**
     * Row stylesheet, matching the native "context compacted" marker row:
     * 24px tertiary header line, 13px secondary typography, 2px dot separators,
     * a 22px-indented detail body, and theme tokens only (no fixed palette), so
     * light/dark themes and content-font scaling apply automatically.
     */
    const CSS_TEXT = [
      '.ctxslim-row{box-sizing:border-box;width:100%;min-width:0;padding:2px 0}',
      '.ctxslim-button{box-sizing:border-box;width:100%;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font:inherit;text-align:left;background:0 0;border:none;align-items:center;padding:0;transition:color .1s;display:flex}',
      '.ctxslim-button:not(:disabled){cursor:pointer}',
      '.ctxslim-button:disabled{cursor:default}',
      '.ctxslim-button:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '@media (hover:hover){.ctxslim-button:not(:disabled):hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}}',
      '.ctxslim-leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;place-items:center;margin-right:6px;display:inline-grid}',
      '.ctxslim-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
      '.ctxslim-context,.ctxslim-disclosure{grid-area:1/1;justify-content:center;align-items:center;display:inline-flex}',
      '.ctxslim-disclosure,.ctxslim-button:not(:disabled):focus-visible .ctxslim-context{opacity:0}',
      '.ctxslim-button:not(:disabled):focus-visible .ctxslim-disclosure{opacity:1}',
      '.ctxslim-row[data-expanded="true"] .ctxslim-context{opacity:0}',
      '.ctxslim-row[data-expanded="true"] .ctxslim-disclosure{opacity:1}',
      '@media (hover:hover){.ctxslim-button:not(:disabled):hover .ctxslim-context{opacity:0}.ctxslim-button:not(:disabled):hover .ctxslim-disclosure{opacity:1}}',
      '.ctxslim-title{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;flex:none}',
      '.ctxslim-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}',
      '.ctxslim-summary{min-width:0;color:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));text-overflow:ellipsis;white-space:nowrap;flex:auto;overflow:hidden}',
      '.ctxslim-row[data-status="no-op"] .ctxslim-button,.ctxslim-row[data-status="rejected"] .ctxslim-button,.ctxslim-row[data-status="failed"] .ctxslim-button{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
      '.ctxslim-body{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(22px + var(--dsh-content-font-delta-secondary,0px))}',
      '.ctxslim-items{flex-direction:column;gap:2px;min-width:0;display:flex}',
      '.ctxslim-item{display:flex;flex-wrap:wrap;align-items:baseline;min-width:0;gap:0 6px;overflow-wrap:anywhere}',
      '.ctxslim-item-sep{color:var(--dsw-alias-label-caption);flex:none}',
      '.ctxslim-item-index{color:var(--dsw-alias-label-caption);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}',
      '.ctxslim-item-tool{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}',
      '.ctxslim-item-op{color:var(--dsw-alias-label-caption)}',
      '.ctxslim-item-chars{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}',
      '.ctxslim-item-reason{color:var(--dsw-alias-label-caption);min-width:0}',
      '.ctxslim-meta{color:var(--dsw-alias-label-caption);font-size:var(--dsh-content-font-size-tertiary,12px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}',
      '.ctxslim-more{color:var(--dsw-alias-label-caption)}',
      '@media (prefers-reduced-motion:reduce){.ctxslim-button{transition:none}}',
    ].join('');

    /**
     * Mount (or adopt) this bundle's stylesheet. Owned by the plugin fiber via
     * `ctx.effect`; a tag we adopted from an earlier materialization is never
     * removed on dispose, while the client-modules unload sweep removes tags by
     * `data-plugin` anyway.
     * @returns idempotent cleanup.
     */
    function mountStyles() {
      if (typeof document === 'undefined' || document === null || !document.head) return () => {};
      const selector = 'style[data-plugin-css="' + CSS_ID + '"]';
      let tag = null;
      try {
        tag = document.querySelector(selector);
      } catch (error) {
        tag = null;
      }
      const created = tag === null || tag === undefined;
      try {
        if (created) {
          tag = document.createElement('style');
          tag.dataset.plugin = PACKAGE_ID;
          tag.dataset.pluginCss = CSS_ID;
          tag.textContent = CSS_TEXT;
          document.head.appendChild(tag);
        } else if (typeof tag.textContent === 'string' && tag.textContent !== CSS_TEXT) {
          tag.textContent = CSS_TEXT;
        }
      } catch (error) {
        return () => {};
      }
      return () => {
        if (!created || tag === null || typeof tag !== 'object') return;
        try {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        } catch (error) {
          /* The unload path already removes owned tags by data-plugin. */
        }
      };
    }

    // #endregion

    // #region plugin entry

    /** Cordis services required before this client half can activate. */
    const inject = ['slots', 'locale', 'uiConversation'];

    /**
     * Mount the client half: dictionaries, Conversation Definition, stylesheet,
     * and the keyed Chat renderer. Everything is owned by the plugin fiber; a
     * reload or unload releases each contribution through its `ctx.effect`.
     * @param ctx - client root context (the plugin's own fiber context).
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, {
        zh: ZH,
        en: EN,
      }), 'context-slimmer: client dictionaries');

      if (typeof ctx.locale.bind === 'function') {
        fallbackTranslate = ctx.locale.bind(LOCALE_NS);
      }

      ctx.uiConversation.events.register(definition);

      ctx.effect(() => mountStyles(), 'context-slimmer: row stylesheet');

      ctx.slots.inject(CHAT_NODE_SLOT, () => ctx.slots.register({
        name: CHAT_NODE_SLOT,
        key: NODE_KIND,
        locale: LOCALE_NS,
      }, SlimRowView));

      debug('client half activated', {
        kind: NODE_KIND,
        channels: [PRUNE_TYPE, TOOL_RESULT_TYPE],
        metaKey: META_KEY,
        slot: CHAT_NODE_SLOT,
      });
    }

    // #endregion

    return {
      inject,
      apply,
      /**
       * Structural test surface consumed by `test/client-smoke.test.mjs`; not part of
       * the plugin contract and safe to ignore from the Host.
       */
      __ctxslimTest: {
        PACKAGE_ID,
        NODE_KIND,
        PRUNE_TYPE,
        TOOL_RESULT_TYPE,
        META_KEY,
        SUMMARY_ROLE,
        LOCALE_NS,
        CHAT_NODE_SLOT,
        CSS_ID,
        dictionaries: { zh: ZH, en: EN },
        definition,
        matchSlimmingEvent,
        prunePayloadOf,
        replacementPayloadOf,
        normalizeSummary,
        SlimRow,
        SlimRowView,
      },
    };
  },
});
