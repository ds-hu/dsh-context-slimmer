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

    /** Keyed configuration slot declared by the native Plugins page. */
    const PLUGIN_CONFIG_SLOT = 'plugins.row.config';

    /** `<bundle package>#<row id>`: the key `rowConfigKey()` composes for our row. */
    const PLUGIN_CONFIG_KEY = '@ds-hu/dsh-context-slimmer#context-slimmer-tool-result';

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
     * Normalize one `contextSlimmer` batch-summary payload into the stable shape
     * the row renders. Every field is optional at runtime: payloads written by an
     * older or newer Host build must degrade to a readable row instead of throwing.
     * @param raw - untrusted payload (`compaction/prune.data.contextSlimmer`; the
     *   forward-compat `tool/result.data.meta.contextSlimmer` shares this shape).
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
      'row.empty': '无明细',
      'row.more': '…还有 {count} 项',
      'row.model': '模型：{model}',
      'row.model.inherited': '模型：继承主 Agent',
      'row.trigger': '触发：新增工具结果 {calls} 条、{chars} 字符',
      'item.unknownTool': '工具',
      'item.chars': '{before}→{after}',
      'item.charsMissing': '字符数未知',
      'config.loading': '正在加载配置…',
      'config.unavailable': '配置不可用（当前部署未提供该行配置）',
      'config.readOnly': '当前部署为只读，配置无法保存。',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.saved': '已保存',
      'config.failed': '保存失败：Host 未接受这些值，已保留供你修改。',
      'config.dirty': '有未保存的修改',
      'config.invalidNumber': '请输入整数。',
      'config.invalidRange': '请输入 {min} 到 {max} 之间的整数。',
      'config.modelPair': '模型 provider 与 model 必须同时填写，或同时留空（inherit）。',
      'config.invalidPolicy': '请选择有效策略。',
      'config.summary.disabled': '已停用',
      'config.summary.calls': '每 {count} 次调用',
      'config.summary.modelInherit': '模型跟随当前 Agent',
      'config.summary.model': '模型 {model}',
      'config.policySuffix': '策略',
      'config.enabled.label': '启用工具结果精简',
      'config.enabled.hint': '关闭后该模块仍挂载，但不监听事件、不触发精简。',
      'config.everyNToolCalls.label': '触发阈值：新增工具调用数',
      'config.everyNToolCalls.hint': '自上次精简以来新增的工具结果达到该数量时考虑触发（1–200）。',
      'config.minChars.label': '触发阈值：新增字符数',
      'config.minChars.hint': '新增工具结果字符数达到该值时考虑触发；与调用数阈值同时满足才会触发。',
      'config.protectRecent.label': '保护最近结果数',
      'config.protectRecent.hint': '最新的 N 条工具结果永不作为精简目标（0–50）。',
      'config.minTargetChars.label': '最小目标字符数',
      'config.minTargetChars.hint': '短于该字符数的结果不会被改写，避免无收益替换。',
      'config.maxTargets.label': '单批最大目标数',
      'config.maxTargets.hint': '一次精简最多改写的结果条数（1–20）。',
      'config.policy.label': '精简策略',
      'config.policy.hint': '保守：仅删除重复、被覆盖或空输出；均衡：允许有限裁剪；激进：有损模式。',
      'config.policy.conservative': '保守',
      'config.policy.balanced': '均衡',
      'config.policy.aggressive': '激进',
      'config.includeSubagents.label': '同时精简子 Agent 会话',
      'config.includeSubagents.hint': '开启后子 Agent 的工具结果也按相同规则精简。',
      'config.triggerOnErrorOnly.label': '仅含失败时触发',
      'config.triggerOnErrorOnly.hint': '观测窗口中至少有一条失败的调用时才触发，适合嘈杂的长构建。',
      'config.timeoutMs.label': '单次精简超时（毫秒）',
      'config.timeoutMs.hint': '1000–600000；超时则不落地任何替换。',
      'config.model.provider.label': '模型 provider',
      'config.model.provider.hint': '留空表示跟随当前 Agent（inherit）。',
      'config.model.model.label': '模型 id',
      'config.model.model.hint': '留空表示跟随当前 Agent（inherit）；与 provider 需同时填写。',
      'config.model.maxOutputTokens.label': '输出 token 上限',
      'config.model.maxOutputTokens.hint': '0 表示交给路由决定。',
      'config.model.placeholder': 'inherit（跟随当前 Agent）',
      'config.noForm': '该模块没有可编辑的 Host 配置（Host Config 需声明 .volatile() 字段）。',
      'config.failedRefresh': '保存被拒绝：配置可能已在别处更新，页面已刷新，请重试。',
      'config.invalidOption': '请选择有效选项。',
      'config.model.reasoningEffort.label': '推理强度',
      'config.model.reasoningEffort.hint': '跟随当前 Agent 时使用主会话的推理强度。',
      'config.reasoning.inherit': '跟随当前 Agent',
      'config.reasoning.off': '关闭',
      'config.reasoning.low': '低',
      'config.reasoning.medium': '中',
      'config.reasoning.high': '高',
      'config.reasoning.max': '最高',
    });

    /** English row copy (the fallback locale for every other UI language). */
    const EN = Object.freeze({
      'row.title': 'Tool results slimmed',
      'row.items.one': '1 item',
      'row.items.other': '{count} items',
      'row.saved': '{chars} chars freed',
      'row.noop': 'No changes this run',
      'row.skipped': 'Skipped (the model returned no valid plan)',
      'row.empty': 'No details',
      'row.more': '…and {count} more',
      'row.model': 'Model: {model}',
      'row.model.inherited': 'Model: inherited from the main agent',
      'row.trigger': 'Triggered after {calls} new tool results and {chars} chars',
      'item.unknownTool': 'tool',
      'item.chars': '{before}→{after}',
      'item.charsMissing': 'chars unknown',
      'config.loading': 'Loading configuration…',
      'config.unavailable': 'Configuration unavailable (this deployment does not expose this row).',
      'config.readOnly': 'This deployment is read-only; changes cannot be saved.',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.saved': 'Saved',
      'config.failed': 'Save failed: the Host did not accept these values; they are kept for you to correct.',
      'config.dirty': 'Unsaved changes',
      'config.invalidNumber': 'Enter an integer.',
      'config.invalidRange': 'Enter an integer between {min} and {max}.',
      'config.modelPair': 'Model provider and model must both be set, or both be left empty (inherit).',
      'config.invalidPolicy': 'Choose a valid policy.',
      'config.summary.disabled': 'Disabled',
      'config.summary.calls': 'Every {count} tool calls',
      'config.summary.modelInherit': 'Model follows the current Agent',
      'config.summary.model': 'Model {model}',
      'config.policySuffix': '',
      'config.enabled.label': 'Enable tool-result slimming',
      'config.enabled.hint': 'When off the module stays mounted but installs no listener and never runs a slim pass.',
      'config.everyNToolCalls.label': 'Trigger: new tool calls',
      'config.everyNToolCalls.hint': 'Consider a pass once this many new tool results accumulated since the last run (1–200).',
      'config.minChars.label': 'Trigger: new characters',
      'config.minChars.hint': 'Consider a pass once this many new tool-result characters accumulated; both triggers must be met.',
      'config.protectRecent.label': 'Protected recent results',
      'config.protectRecent.hint': 'The newest N tool results are never rewritten (0–50).',
      'config.minTargetChars.label': 'Minimum target characters',
      'config.minTargetChars.hint': 'Results shorter than this are never rewritten; a rewrite there saves nothing.',
      'config.maxTargets.label': 'Maximum targets per pass',
      'config.maxTargets.hint': 'At most this many results are rewritten per pass (1–20).',
      'config.policy.label': 'Slimming policy',
      'config.policy.hint': 'Conservative: drop only duplicates, superseded results, or empty output. Balanced: limited trimming. Aggressive: lossy.',
      'config.policy.conservative': 'Conservative',
      'config.policy.balanced': 'Balanced',
      'config.policy.aggressive': 'Aggressive',
      'config.includeSubagents.label': 'Slim subagent sessions too',
      'config.includeSubagents.hint': 'When on, subagent tool results are slimmed under the same rules.',
      'config.triggerOnErrorOnly.label': 'Only when something failed',
      'config.triggerOnErrorOnly.hint': 'Only run a pass when the window contains at least one failed tool result.',
      'config.timeoutMs.label': 'Pass timeout (ms)',
      'config.timeoutMs.hint': '1000–600000; on timeout nothing is replaced.',
      'config.model.provider.label': 'Model provider',
      'config.model.provider.hint': 'Leave empty to follow the current Agent (inherit).',
      'config.model.model.label': 'Model id',
      'config.model.model.hint': 'Leave empty to follow the current Agent (inherit); set together with the provider.',
      'config.model.maxOutputTokens.label': 'Output token cap',
      'config.model.maxOutputTokens.hint': '0 lets the route decide.',
      'config.model.placeholder': 'inherit (follow the current Agent)',
      'config.noForm': 'This module exposes no editable Host configuration (its Host Config needs .volatile() fields).',
      'config.failedRefresh': 'Save refused: the configuration may have changed elsewhere; the page refreshed — try again.',
      'config.invalidOption': 'Choose a valid option.',
      'config.model.reasoningEffort.label': 'Reasoning effort',
      'config.model.reasoningEffort.hint': 'Inherit uses the main session\'s reasoning effort.',
      'config.reasoning.inherit': 'Inherit',
      'config.reasoning.off': 'Off',
      'config.reasoning.low': 'Low',
      'config.reasoning.medium': 'Medium',
      'config.reasoning.high': 'High',
      'config.reasoning.max': 'Max',
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
      configForm: 'ctxslim-config-form',
      configRow: 'ctxslim-config-row',
      configHead: 'ctxslim-config-head',
      configLabel: 'ctxslim-config-label',
      configStatus: 'ctxslim-config-status',
      configFailed: 'ctxslim-config-failed',
      configSaved: 'ctxslim-config-saved',
      configDirty: 'ctxslim-config-dirty',
      configFooter: 'ctxslim-config-footer',
      save: 'ctxslim-save',
      input: 'ctxslim-input',
      hint: 'ctxslim-hint',
      invalid: 'ctxslim-invalid',
      switchControl: 'ctxslim-switch',
      switchThumb: 'ctxslim-switch-thumb',
      checkboxInput: 'ctxslim-checkbox-input',
      segmented: 'ctxslim-segmented',
      segmentedTab: 'ctxslim-segmented-tab',
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
     * Row stylesheet, matching the native "context compacted" marker row
     * (`CompactionItem` in `dsh-client-ui-chat/lib/client.js:5102-5160`): 24px
     * tertiary header line, 13px secondary typography, 2px dot separators, a
     * 22px-indented detail body, and the same sticky expanded header. Theme tokens
     * only (no fixed palette), so light/dark themes and content-font scaling apply
     * automatically.
     */
    const CSS_TEXT = [
      '.ctxslim-row{--dsh-compaction-header-height:calc(24px + var(--dsh-content-font-delta,0px));box-sizing:border-box;width:100%;min-width:0;padding:2px 0}',
      '.ctxslim-button{box-sizing:border-box;width:100%;height:var(--dsh-compaction-header-height);min-width:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font:inherit;text-align:left;background:0 0;border:none;align-items:center;padding:0;transition:color .1s;display:flex}',
      '.ctxslim-row:has(.ctxslim-body) .ctxslim-button{z-index:7;background:var(--dsw-alias-bg-base);border-radius:0;position:sticky;top:0}',
      '.ctxslim-button:not(:disabled){cursor:pointer}',
      '.ctxslim-button:disabled{cursor:default}',
      '.ctxslim-button:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '@media (hover:hover){.ctxslim-button:not(:disabled):hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}}',
      '@media (hover:hover){.ctxslim-row:has(.ctxslim-body) .ctxslim-button:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}}',
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
      '.ctxslim-body{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:var(--dsh-compaction-header-height)}',
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
      '.ctxslim-config{box-sizing:border-box;width:100%;min-width:0}',
      '.ctxslim-config-form{flex-direction:column;display:flex}',
      '.ctxslim-config-row{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.ctxslim-config-row+.ctxslim-config-row{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.ctxslim-config-head{display:flex;align-items:center;gap:8px}',
      '.ctxslim-config-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.ctxslim-config-status{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.ctxslim-config-status[data-ctxslim-readonly]{margin:0 0 12px}',
      '.ctxslim-config-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
      '.ctxslim-config-saved{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.ctxslim-config-dirty{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.ctxslim-config-footer{display:flex;align-items:center;gap:8px;padding-top:16px}',
      '.ctxslim-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.ctxslim-save:disabled{opacity:.4;cursor:default}',
      '.ctxslim-save:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.ctxslim-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.ctxslim-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ctxslim-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.ctxslim-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
      '.ctxslim-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.ctxslim-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}',
      '.ctxslim-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}',
      '.ctxslim-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}',
      '.ctxslim-switch:disabled{cursor:default;opacity:.5}',
      '.ctxslim-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.ctxslim-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}',
      '.ctxslim-switch[aria-checked=false] .ctxslim-switch-thumb{background:var(--dsw-alias-switch-thumb)}',
      '.ctxslim-switch[aria-checked=true] .ctxslim-switch-thumb{transform:translate(16px)}',
      '.ctxslim-checkbox-input{flex:0 0 auto;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.ctxslim-checkbox-input:disabled{cursor:default;opacity:.5}',
      '.ctxslim-checkbox-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.ctxslim-segmented{box-sizing:border-box;position:relative;width:100%;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}',
      '.ctxslim-segmented-tab{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;transition:color .12s ease}',
      '.ctxslim-segmented-tab[aria-checked=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}',
      '@media (hover:hover){.ctxslim-segmented-tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}}',
      '.ctxslim-segmented-tab:disabled{cursor:default;opacity:.4}',
      '.ctxslim-segmented-tab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '@media (prefers-reduced-motion:reduce){.ctxslim-switch-thumb,.ctxslim-segmented-tab{transition:none}}',
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


    // #region plugin configuration page (native Plugins panel)

    /** Policy values offered by the strategy control, in escalation order. */
    const POLICY_VALUES = Object.freeze(['conservative', 'balanced', 'aggressive']);

    /** Sentinel a model route stores when it follows the current Agent. */
    const INHERIT_VALUE = 'inherit';

    /** Reasoning-effort values the optional model override exposes. */
    const REASONING_VALUES = Object.freeze([INHERIT_VALUE, 'off', 'low', 'medium', 'high', 'max']);

    /**
     * Documented v0.2 defaults. The Host serves a schema-resolved section, so
     * these only fill gaps while a snapshot is stale or a field is new.
     */
    const CONFIG_FALLBACKS = Object.freeze({
      enabled: true,
      everyNToolCalls: 12,
      minChars: 24000,
      protectRecent: 3,
      minTargetChars: 4096,
      maxTargets: 4,
      policy: 'conservative',
      includeSubagents: true,
      triggerOnErrorOnly: false,
      timeoutMs: 120000,
      model: Object.freeze({ provider: '', model: '', reasoningEffort: INHERIT_VALUE, maxOutputTokens: 0 }),
    });

    /**
     * One editable configuration field. `name` is both the data-field hook CI
     * asserts on and the settings path name; nested model fields keep their
     * dotted display name and nested `path`.
     */
    const CONFIG_FIELDS = Object.freeze([
      Object.freeze({ name: 'enabled', path: ['enabled'], kind: 'switch' }),
      Object.freeze({ name: 'everyNToolCalls', path: ['everyNToolCalls'], kind: 'number', min: 1, max: 200, step: 1 }),
      Object.freeze({ name: 'minChars', path: ['minChars'], kind: 'number', min: 0, max: 10000000, step: 1000 }),
      Object.freeze({ name: 'protectRecent', path: ['protectRecent'], kind: 'number', min: 0, max: 50, step: 1 }),
      Object.freeze({ name: 'minTargetChars', path: ['minTargetChars'], kind: 'number', min: 0, max: 1000000, step: 1 }),
      Object.freeze({ name: 'maxTargets', path: ['maxTargets'], kind: 'number', min: 1, max: 20, step: 1 }),
      Object.freeze({ name: 'policy', path: ['policy'], kind: 'segmented', options: POLICY_VALUES }),
      Object.freeze({ name: 'includeSubagents', path: ['includeSubagents'], kind: 'checkbox' }),
      Object.freeze({ name: 'triggerOnErrorOnly', path: ['triggerOnErrorOnly'], kind: 'checkbox' }),
      Object.freeze({ name: 'timeoutMs', path: ['timeoutMs'], kind: 'number', min: 1000, max: 600000, step: 1000 }),
      Object.freeze({ name: 'model.provider', path: ['model', 'provider'], kind: 'text', inherit: true }),
      Object.freeze({ name: 'model.model', path: ['model', 'model'], kind: 'text', inherit: true }),
      Object.freeze({ name: 'model.reasoningEffort', path: ['model', 'reasoningEffort'], kind: 'select', options: REASONING_VALUES }),
      Object.freeze({ name: 'model.maxOutputTokens', path: ['model', 'maxOutputTokens'], kind: 'number', min: 0, max: 1000000, step: 1 }),
    ]);

    /**
     * Read one nested value from a Host configuration section.
     * @param value - section value (untrusted JSON).
     * @param path - settings path.
     * @returns raw value, or undefined when absent.
     */
    function readPath(value, path) {
      let current = value;
      for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
      }
      return current;
    }

    /**
     * Fallback value for one field path.
     * @param path - settings path.
     * @returns documented default.
     */
    function fallbackAt(path) {
      return readPath(CONFIG_FALLBACKS, path);
    }

    /**
     * Normalize a raw field value into the controlled-input shape: booleans for
     * toggles, strings for numbers/text, and an empty string for `inherit` model
     * routes (so the placeholder can explain the empty state).
     * @param spec - field descriptor.
     * @param value - Host section value.
     * @returns editable draft value.
     */
    function draftValue(spec, value) {
      const raw = readPath(value, spec.path);
      const fallback = fallbackAt(spec.path);
      const resolved = raw === undefined || raw === null ? fallback : raw;
      if (spec.kind === 'switch' || spec.kind === 'checkbox') return resolved === true;
      if (spec.kind === 'segmented' || spec.kind === 'select') return spec.options.includes(resolved) ? resolved : fallback;
      if (spec.kind === 'number') {
        return typeof resolved === 'number' && Number.isFinite(resolved) ? String(resolved) : String(fallback);
      }
      if (spec.inherit === true && resolved === INHERIT_VALUE) return '';
      return typeof resolved === 'string' ? resolved : '';
    }

    /**
     * Build the complete editable draft from one Host section.
     * @param value - Host configuration section (undefined before the first read).
     * @returns draft keyed by field name.
     */
    function buildDraft(value) {
      const draft = {};
      for (const spec of CONFIG_FIELDS) draft[spec.name] = draftValue(spec, value);
      return draft;
    }

    /**
     * Whether two drafts carry identical field values.
     * @param left - first draft.
     * @param right - second draft.
     * @returns whether they edit the same values.
     */
    function draftsEqual(left, right) {
      for (const spec of CONFIG_FIELDS) {
        if (left[spec.name] !== right[spec.name]) return false;
      }
      return true;
    }

    /**
     * Parse one field's draft value and range-check it.
     * @param spec - field descriptor.
     * @param text - draft value.
     * @returns `{ ok: true, value }` or `{ ok: false, code }`.
     */
    function parseField(spec, text) {
      if (spec.kind === 'switch' || spec.kind === 'checkbox') return { ok: true, value: text === true };
      if (spec.kind === 'segmented' || spec.kind === 'select') {
        return spec.options.includes(text) ? { ok: true, value: text } : { ok: false, code: spec.kind === 'segmented' ? 'policy' : 'option' };
      }
      if (spec.kind === 'text') {
        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (spec.inherit === true && trimmed === '') return { ok: true, value: INHERIT_VALUE };
        return { ok: true, value: trimmed };
      }
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!/^\d+$/.test(trimmed)) return { ok: false, code: 'number' };
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed < spec.min || parsed > spec.max) return { ok: false, code: 'range' };
      return { ok: true, value: parsed };
    }

    /**
     * Validate a whole draft, including the provider/model pair rule the Host
     * cross-field check enforces.
     * @param draft - editable draft.
     * @returns `{ ok, errors, values }` with errors keyed by field name.
     */
    function validateDraft(draft) {
      const errors = {};
      const values = {};
      for (const spec of CONFIG_FIELDS) {
        const parsed = parseField(spec, draft[spec.name]);
        if (parsed.ok) values[spec.name] = parsed.value;
        else errors[spec.name] = parsed.code;
      }
      const provider = values['model.provider'];
      const model = values['model.model'];
      if (provider !== undefined && model !== undefined && (provider === INHERIT_VALUE) !== (model === INHERIT_VALUE)) {
        errors['model.provider'] = 'modelPair';
        errors['model.model'] = 'modelPair';
      }
      return { ok: Object.keys(errors).length === 0, errors, values };
    }

    /**
     * Build the ordered `set` operations that turn the accepted draft into the
     * edited one. Only changed fields are written; nested model fields keep their
     * nested `path`.
     * @param base - draft of the accepted Host section.
     * @param draft - edited draft.
     * @returns atomic settings path operations.
     */
    function buildOps(base, draft) {
      const parsed = validateDraft(draft);
      const ops = [];
      for (const spec of CONFIG_FIELDS) {
        if (draft[spec.name] === base[spec.name]) continue;
        const value = parsed.values[spec.name];
        if (value === undefined) continue;
        ops.push({ op: 'set', path: spec.path.slice(), value });
      }
      return ops;
    }

    /**
     * Human-readable validation message for one field error code.
     * @param code - error code.
     * @param spec - field descriptor.
     * @param t - translator.
     * @returns localized message.
     */
    function fieldErrorText(code, spec, t) {
      if (code === 'range') return t('config.invalidRange', { min: spec.min, max: spec.max });
      if (code === 'modelPair') return t('config.modelPair');
      if (code === 'policy') return t('config.invalidPolicy');
      if (code === 'option') return t('config.invalidOption');
      return t('config.invalidNumber');
    }

    /**
     * The one-line summary the Plugins page shows for this row.
     * @param value - Host configuration section.
     * @param t - translator.
     * @returns display fragments to join with ` · `.
     */
    function summaryParts(value, t) {
      const parts = [];
      if (readPath(value, ['enabled']) === false) parts.push(t('config.summary.disabled'));
      const calls = Number(draftValue(CONFIG_FIELDS[1], value));
      parts.push(t('config.summary.calls', { count: formatCount(Number.isFinite(calls) ? calls : CONFIG_FALLBACKS.everyNToolCalls) }));
      const rawPolicy = readPath(value, ['policy']);
      const policy = POLICY_VALUES.includes(rawPolicy) ? rawPolicy : CONFIG_FALLBACKS.policy;
      parts.push(t('config.policy.' + policy) + t('config.policySuffix'));
      const provider = readPath(value, ['model', 'provider']);
      const model = readPath(value, ['model', 'model']);
      if (typeof provider === 'string' && provider !== '' && provider !== INHERIT_VALUE) {
        parts.push(t('config.summary.model', { model: provider + '/' + (typeof model === 'string' ? model : '') }));
      } else {
        parts.push(t('config.summary.modelInherit'));
      }
      return parts;
    }

    /**
     * Render one configuration row: label, control, hint, and inline error.
     * @param spec - field descriptor.
     * @param draft - current draft.
     * @param errors - validation errors keyed by field name.
     * @param disabled - whether the control is read-only or busy.
     * @param t - translator.
     * @param onChange - (field name, next value) handler.
     * @returns row element with `data-field` for CI.
     */
    function configFieldRow(spec, draft, errors, disabled, t, onChange) {
      const id = 'ctxslim-cfg-' + spec.name.replace(/\./g, '-');
      const label = t('config.' + spec.name + '.label');
      const error = errors[spec.name];
      const children = [];
      if (spec.kind === 'switch') {
        children.push(h('div', { key: 'head', className: cls.configHead }, [
          h('label', { key: 'label', className: cls.configLabel, htmlFor: id }, label),
          h('button', {
            key: 'switch',
            id,
            type: 'button',
            role: 'switch',
            className: cls.switchControl,
            'aria-checked': draft[spec.name] === true,
            'aria-label': label,
            'data-field': spec.name,
            'data-ctxslim-input': spec.name,
            disabled,
            onClick: () => onChange(spec.name, !(draft[spec.name] === true)),
          }, h('span', { className: cls.switchThumb })),
        ]));
      } else if (spec.kind === 'checkbox') {
        children.push(h('div', { key: 'head', className: cls.configHead }, [
          h('label', { key: 'label', className: cls.configLabel, htmlFor: id }, label),
          h('input', {
            key: 'input',
            id,
            type: 'checkbox',
            className: cls.checkboxInput,
            checked: draft[spec.name] === true,
            'aria-label': label,
            'data-field': spec.name,
            'data-ctxslim-input': spec.name,
            disabled,
            onChange: (event) => onChange(spec.name, Boolean(event && event.target && event.target.checked)),
          }),
        ]));
      } else if (spec.kind === 'segmented') {
        children.push(h('div', { key: 'head', className: cls.configHead }, [
          h('span', { key: 'label', className: cls.configLabel }, label),
        ]));
        children.push(h('div', {
          key: 'segments',
          className: cls.segmented,
          role: 'radiogroup',
          'aria-label': label,
          'data-field': spec.name,
          'data-ctxslim-input': spec.name,
        }, spec.options.map((option) => h('button', {
          key: option,
          type: 'button',
          role: 'radio',
          className: cls.segmentedTab,
          'aria-checked': draft[spec.name] === option,
          disabled,
          onClick: () => onChange(spec.name, option),
        }, t('config.policy.' + option)))));
      } else if (spec.kind === 'select') {
        children.push(h('div', { key: 'head', className: cls.configHead }, [
          h('label', { key: 'label', className: cls.configLabel, htmlFor: id }, label),
        ]));
        children.push(h('select', {
          key: 'input',
          id,
          className: cls.input,
          value: draft[spec.name],
          'data-field': spec.name,
          'data-ctxslim-input': spec.name,
          disabled,
          'aria-invalid': error === undefined ? undefined : true,
          'aria-describedby': error === undefined ? undefined : id + '-error',
          onChange: (event) => onChange(spec.name, event && event.target ? String(event.target.value) : ''),
        }, spec.options.map((option) => h('option', { key: option, value: option }, t('config.reasoning.' + option)))));
      } else {
        children.push(h('div', { key: 'head', className: cls.configHead }, [
          h('label', { key: 'label', className: cls.configLabel, htmlFor: id }, label),
        ]));
        children.push(h('input', {
          key: 'input',
          id,
          className: cls.input,
          type: spec.kind === 'number' ? 'number' : 'text',
          inputMode: spec.kind === 'number' ? 'numeric' : undefined,
          min: spec.kind === 'number' ? spec.min : undefined,
          max: spec.kind === 'number' ? spec.max : undefined,
          step: spec.kind === 'number' ? spec.step : undefined,
          value: draft[spec.name],
          placeholder: spec.inherit === true ? t('config.model.placeholder') : undefined,
          'data-field': spec.name,
          'data-ctxslim-input': spec.name,
          disabled,
          'aria-invalid': error === undefined ? undefined : true,
          'aria-describedby': error === undefined ? undefined : id + '-error',
          onChange: (event) => onChange(spec.name, event && event.target ? String(event.target.value) : ''),
        }));
      }
      children.push(h('p', { key: 'hint', className: cls.hint }, t('config.' + spec.name + '.hint')));
      if (error !== undefined) {
        children.push(h('p', {
          key: 'error',
          id: id + '-error',
          className: cls.invalid,
          role: 'alert',
          'data-ctxslim-field-error': spec.name,
        }, fieldErrorText(error, spec, t)));
      }
      return h('div', {
        key: spec.name,
        className: cls.configRow,
        'data-ctxslim-kind': spec.kind,
      }, children);
    }

    /**
     * `view: 'summary'`: the read-only one-liner the Plugins page shows beside
     * the row (and as its description fallback).
     * @param props - owner props `{ form, t }`.
     * @returns inline summary element.
     */
    function ConfigSummary(props) {
      const form = props === undefined ? undefined : props.form;
      const t = props !== undefined && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const state = form && isRecord(form.state) ? form.state : undefined;
      const status = form === undefined ? 'no-form' : (state !== undefined && typeof state.status === 'string' ? state.status : 'unavailable');
      let text;
      if (status === 'no-form') text = t('config.noForm');
      else if (status === 'loading') text = t('config.loading');
      else if (status !== 'ready' || state.value === undefined) text = t('config.unavailable');
      else text = summaryParts(state.value, t).join(' · ');
      const attributes = {
        'data-ctxslim-config': '',
        'data-ctxslim-view': 'summary',
        'data-ctxslim-status': status,
      };
      if (status !== 'ready') attributes.role = 'status';
      return h('span', attributes, text);
    }

    /**
     * `view: 'page'`: the editable form with its single atomic save action.
     *
     * The component stages edits locally, writes only changed paths in one
     * `form.mutate(ops, revision)` call, and keeps edits on refusal or transport
     * failure (the Host's recovery read is shown by the next snapshot). Read-only
     * deployments disable every control and hide the save action; `loading` and
     * `unavailable` snapshots render status text instead of inputs.
     * @param props - owner props `{ form, t }`.
     * @returns form element with `data-ctxslim-config` and `data-field` hooks.
     */
    function ConfigPage(props) {
      const form = props === undefined ? undefined : props.form;
      const t = props !== undefined && typeof props.t === 'function' ? props.t : fallbackTranslate;
      const state = form && isRecord(form.state) ? form.state : undefined;
      const status = form === undefined ? 'no-form' : (state !== undefined && typeof state.status === 'string' ? state.status : 'unavailable');
      const value = state === undefined ? undefined : state.value;
      const writable = state !== undefined && state.writable === true;
      const [draft, setDraft] = React.useState(() => buildDraft(value));
      const [editing, setEditing] = React.useState(false);
      const [saveState, setSaveState] = React.useState({ status: 'idle', detail: null });

      React.useEffect(() => {
        if (status !== 'ready' || editing) return;
        setDraft((previous) => {
          const next = buildDraft(value);
          return draftsEqual(previous, next) ? previous : next;
        });
      }, [value, status]);

      const base = buildDraft(value);
      const dirty = !draftsEqual(draft, base);
      const validation = validateDraft(draft);
      const saving = saveState.status === 'saving';
      const disabled = !writable || saving;

      const updateDraft = (name, nextValue) => {
        setDraft((previous) => {
          if (previous[name] === nextValue) return previous;
          const next = { ...previous };
          next[name] = nextValue;
          return next;
        });
        setEditing(true);
        setSaveState((previous) => (previous.status === 'saving' ? previous : { status: 'idle', detail: null }));
      };

      const handleSave = () => {
        if (!writable || saving || !dirty) return;
        const check = validateDraft(draft);
        if (!check.ok) return;
        const ops = buildOps(base, draft);
        if (ops.length === 0) return;
        setSaveState({ status: 'saving', detail: null });
        let settlement;
        try {
          settlement = Promise.resolve(form.mutate(ops, state === undefined ? undefined : state.revision));
        } catch (error) {
          setSaveState({ status: 'failed', detail: error instanceof Error ? error.message : String(error) });
          return;
        }
        settlement.then((accepted) => {
          if (accepted === false) {
            setSaveState({ status: 'failed', detail: null, refresh: true });
            setEditing(false);
            return;
          }
          setSaveState({ status: 'saved', detail: null, refresh: false });
          setEditing(false);
        }, (error) => {
          setSaveState({ status: 'failed', detail: error instanceof Error ? error.message : String(error), refresh: false });
        });
      };

      const rootAttributes = {
        'data-ctxslim-config': '',
        'data-ctxslim-view': 'page',
        'data-ctxslim-status': status,
      };
      if (status === 'no-form') {
        return h('div', rootAttributes, h('p', {
          className: cls.configStatus,
          role: 'status',
          'data-ctxslim-no-form': '',
        }, t('config.noForm')));
      }
      if (status === 'loading') {
        return h('div', rootAttributes, h('p', { className: cls.configStatus, role: 'status', 'data-ctxslim-loading': '' }, t('config.loading')));
      }
      if (status !== 'ready' || value === undefined) {
        return h('div', rootAttributes, h('p', { className: cls.configStatus, role: 'status', 'data-ctxslim-unavailable': '' }, t('config.unavailable')));
      }

      const body = [];
      if (!writable) {
        body.push(h('p', {
          key: 'readonly',
          className: cls.configStatus,
          role: 'status',
          'data-ctxslim-readonly': '',
        }, t('config.readOnly')));
      }
      body.push(h('div', { key: 'form', className: cls.configForm }, CONFIG_FIELDS.map((spec) => (
        configFieldRow(spec, draft, validation.errors, disabled, t, updateDraft)
      ))));

      const footer = [];
      if (saveState.status === 'failed') {
        footer.push(h('p', {
          key: 'message',
          className: cls.configFailed,
          role: 'status',
          'data-ctxslim-message': 'failed',
        }, saveState.refresh === true ? t('config.failedRefresh') : (saveState.detail === null ? t('config.failed') : t('config.failed') + ' ' + saveState.detail)));
      } else if (saveState.status === 'saved') {
        footer.push(h('p', {
          key: 'message',
          className: cls.configSaved,
          role: 'status',
          'data-ctxslim-message': 'saved',
        }, t('config.saved')));
      } else if (dirty) {
        footer.push(h('p', {
          key: 'message',
          className: cls.configDirty,
          role: 'status',
          'data-ctxslim-message': 'dirty',
        }, t('config.dirty')));
      }
      if (writable) {
        footer.push(h('button', {
          key: 'save',
          type: 'button',
          className: cls.save,
          'data-ctxslim-save': '',
          'aria-busy': saving,
          disabled: !dirty || !validation.ok || saving,
          onClick: handleSave,
        }, saving ? t('config.saving') : t('config.save')));
      }
      body.push(h('div', { key: 'footer', className: cls.configFooter }, footer));

      return h('div', {
        ...rootAttributes,
        'data-ctxslim-dirty': dirty ? 'true' : 'false',
        'data-ctxslim-writable': writable ? 'true' : 'false',
      }, body);
    }

    /**
     * Slot entry point: dispatch `plugins.row.config` owner props to the summary
     * line or the configuration page.
     * @param props - owner props plus the injected locale seat.
     * @returns summary or page element.
     */
    function ConfigView(props) {
      const owner = isRecord(props) ? props : {};
      if (owner.view === 'summary') return h(ConfigSummary, { form: owner.form, t: owner.t });
      return h(ConfigPage, { form: owner.form, t: owner.t });
    }

    /** Memoized configuration renderer (memo is optional for structural tests). */
    const ConfigViewView = typeof React.memo === 'function' ? React.memo(ConfigView) : ConfigView;

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

      ctx.slots.inject(PLUGIN_CONFIG_SLOT, () => ctx.slots.register({
        name: PLUGIN_CONFIG_SLOT,
        key: PLUGIN_CONFIG_KEY,
        locale: LOCALE_NS,
      }, ConfigViewView));

      debug('client half activated', {
        kind: NODE_KIND,
        channels: [PRUNE_TYPE, TOOL_RESULT_TYPE],
        metaKey: META_KEY,
        slot: CHAT_NODE_SLOT,
        configSlot: PLUGIN_CONFIG_SLOT,
        configKey: PLUGIN_CONFIG_KEY,
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
        PLUGIN_CONFIG_SLOT,
        PLUGIN_CONFIG_KEY,
        CSS_ID,
        CONFIG_FIELDS,
        CONFIG_FALLBACKS,
        dictionaries: { zh: ZH, en: EN },
        definition,
        matchSlimmingEvent,
        prunePayloadOf,
        replacementPayloadOf,
        normalizeSummary,
        buildDraft,
        draftsEqual,
        validateDraft,
        buildOps,
        summaryParts,
        ConfigView,
        ConfigViewView,
        ConfigSummary,
        ConfigPage,
        SlimRow,
        SlimRowView,
      },
    };
  },
});
