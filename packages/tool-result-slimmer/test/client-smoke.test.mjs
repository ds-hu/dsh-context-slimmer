/**
 * Offline smoke test for the hand-written client bundle.
 *
 * It simulates the browser's `window.__ModuleLoader__` registration, materializes
 * the factory with a structural `react` mock (no real React rendering), runs
 * `apply(ctx)` against a mocked Cordis client context, and inspects the
 * registered Conversation Definition, keyed Chat renderer, dictionaries and
 * element tree. It also guards the bundle format (classic script, `react` as the
 * only module request, no `console.log`, no network APIs).
 *
 * The fixture mirrors the Host half's protocol: each `tool/result` surface
 * replacement is preceded by a native `compaction/prune` event whose owner-defined
 * payload carries `data.contextSlimmer`. The last prune of a batch uses
 * `role: 'summary'` and holds the aggregate facts; native pruner prune events
 * carry no `contextSlimmer` and therefore must not match.
 *
 * Run directly (`node test/client-smoke.test.mjs`) or through the Node test runner
 * (`node --test test/client-smoke.test.mjs`).
 *
 * @module dsh-context-slimmer/test/client-smoke
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BUNDLE_URL = new URL('../lib/client.js', import.meta.url);
const PACKAGE_ID = '@ds-hu/dsh-context-slimmer-tool-result';
const PRUNE_TYPE = 'compaction/prune';
const TOOL_RESULT_TYPE = 'tool/result';
const META_KEY = 'contextSlimmer';
const SUMMARY_ROLE = 'summary';
const LOCALE_NS = 'context-slimmer';

const source = readFileSync(BUNDLE_URL, 'utf8');

/* ------------------------------------------------------------------ *
 * Bundle-format guards
 * ------------------------------------------------------------------ */

assert.ok(
  /window\.__ModuleLoader__\.load\(/.test(source),
  'bundle registers itself through window.__ModuleLoader__.load()',
);
assert.ok(source.includes(PACKAGE_ID), 'bundle carries the package id');
assert.ok(!/^\s*(?:import|export)\s/m.test(source), 'bundle is a classic script, never ESM');
assert.ok(!/plugin:context-slimmer/.test(source), 'bundle contains no plugin-record event type');

const requestedModules = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
assert.deepEqual(
  [...new Set(requestedModules)],
  ['react'],
  'only the baseline `react` module is requested (no dsh runtime imports, no external list needed)',
);
assert.ok(!/console\.log\s*\(/.test(source), 'no console.log in plugin code');
assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/.test(source), 'client half performs no network requests');

/* ------------------------------------------------------------------ *
 * Fake module loader + structural React
 * ------------------------------------------------------------------ */

let registration = null;
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = {
  load(value) {
    registration = value;
  },
};

/** Compare effect dependency lists the way React does. */
const depsEqual = (left, right) => {
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

/**
 * Minimal hook runtime: per-component-pool state slots, dependency-tracked
 * effects, and a dirty flag so a render helper can flush state updates. It is
 * deliberately not React: it reproduces only the hook contract the bundle uses
 * (`useState`, `useEffect`, `useRef`), which is enough to drive interactions and
 * assert the rendered tree.
 */
function createHookRuntime() {
  const slots = [];
  const cleanups = new Map();
  let cursor = 0;
  let dirty = false;
  let pendingEffects = [];
  const runtime = {
    reset() {
      slots.length = 0;
      cleanups.clear();
      cursor = 0;
      dirty = false;
      pendingEffects = [];
    },
    resetRender() {
      cursor = 0;
      pendingEffects = [];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      }
      const slot = slots[index];
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value;
          dirty = true;
        }
      };
      return [slot.value, set];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] = { deps };
        pendingEffects.push({ index, effect });
        return;
      }
      const slot = slots[index];
      if (deps === undefined || !depsEqual(slot.deps, deps)) {
        slot.deps = deps;
        pendingEffects.push({ index, effect });
      }
    },
    flushEffects() {
      const queued = pendingEffects;
      pendingEffects = [];
      for (const { index, effect } of queued) {
        const previous = cleanups.get(index);
        if (typeof previous === 'function') previous();
        const cleanup = effect();
        cleanups.set(index, cleanup);
      }
    },
    takeDirty() {
      const value = dirty;
      dirty = false;
      return value;
    },
    unmount() {
      for (const cleanup of cleanups.values()) {
        if (typeof cleanup === 'function') cleanup();
      }
      cleanups.clear();
    },
  };
  return runtime;
}

const hookRuntime = createHookRuntime();

const ReactMock = {
  createElement(type, props, ...children) {
    return { __element: true, type, props: props ?? {}, children };
  },
  memo(component) {
    const wrapped = (props) => component(props);
    wrapped.__memo = true;
    return wrapped;
  },
  useState: (...args) => hookRuntime.useState(...args),
  useRef: (...args) => hookRuntime.useRef(...args),
  useEffect: (...args) => hookRuntime.useEffect(...args),
};

const factoryRequire = (specifier) => {
  if (specifier === 'react') return ReactMock;
  throw new Error(`unexpected module request: ${specifier}`);
};

(0, eval)(source); // eslint-disable-line no-eval -- simulates the script loader
assert.ok(registration !== null, 'bundle called __ModuleLoader__.load()');
assert.equal(registration.id, PACKAGE_ID, 'registration id equals the package name');
assert.equal(typeof registration.factory, 'function', 'registration exposes a factory');

// No `document` exists yet: the factory itself must stay side-effect free.
const mod = registration.factory(factoryRequire);
assert.equal(typeof mod, 'object');
assert.equal(typeof mod.apply, 'function', 'exports.apply');
assert.deepEqual(mod.inject, ['slots', 'locale', 'uiConversation'], 'exports.inject is the service list');

const T = mod.__ctxslimTest;
assert.ok(T && typeof T === 'object', 'structural test surface exported');
assert.equal(T.PACKAGE_ID, PACKAGE_ID);
assert.equal(T.PRUNE_TYPE, PRUNE_TYPE);
assert.equal(T.META_KEY, META_KEY);
assert.equal(T.CHAT_NODE_SLOT, 'conversation.chat.node');

/* ------------------------------------------------------------------ *
 * Mock client context (only the surface the bundle uses)
 * ------------------------------------------------------------------ */

const fakeDocument = {
  head: {
    children: [],
    appendChild(tag) {
      this.children.push(tag);
      tag.parentNode = this;
      return tag;
    },
    removeChild(tag) {
      const index = this.children.indexOf(tag);
      if (index >= 0) this.children.splice(index, 1);
      tag.parentNode = null;
      return tag;
    },
  },
  createElement() {
    return { dataset: {}, textContent: '' };
  },
  querySelector() {
    return null;
  },
};
globalThis.document = fakeDocument;

const effects = [];
const localeRegistrations = [];
const definitions = [];
const slotRegistrations = [];
const injectedSlotNames = [];
let currentLocale = 'zh';

const interpolate = (template, params) => {
  if (typeof template !== 'string' || params === undefined || params === null) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};
const translate = (key, params) => {
  const dictionaries = localeRegistrations[0] === undefined ? { zh: {}, en: {} } : localeRegistrations[0].dicts;
  const template = dictionaries[currentLocale]?.[key] ?? dictionaries.en?.[key] ?? key;
  return interpolate(template, params);
};

const ctx = {
  effect(fn, label) {
    const dispose = fn();
    effects.push({ label, dispose });
    return dispose;
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, dicts });
      return () => {};
    },
    bind(ns) {
      assert.ok(typeof ns === 'string' && ns.length > 0);
      return translate;
    },
  },
  uiConversation: {
    events: {
      register(definition) {
        definitions.push(definition);
        return () => {};
      },
    },
  },
  slots: {
    inject(name, callback) {
      injectedSlotNames.push(name);
      callback();
      return () => {};
    },
    register(options, Component) {
      slotRegistrations.push({ options, Component });
      return () => {};
    },
  },
};

mod.apply(ctx);

/* ------------------------------------------------------------------ *
 * apply() registrations
 * ------------------------------------------------------------------ */

assert.deepEqual(
  injectedSlotNames,
  ['conversation.chat.node', 'plugins.row.config'],
  'waits for both keyed slot declarations (Chat row + Plugins config row)',
);
assert.equal(definitions.length, 1, 'one Conversation Definition registered');
assert.equal(slotRegistrations.length, 2, 'one keyed Chat renderer and one Plugins config renderer registered');
assert.equal(localeRegistrations.length, 1, 'dictionaries registered in one call');
assert.equal(localeRegistrations[0].ns, LOCALE_NS);
for (const locale of ['zh', 'en']) {
  assert.equal(typeof localeRegistrations[0].dicts[locale], 'object', `dictionary for ${locale}`);
}
assert.deepEqual(
  Object.keys(localeRegistrations[0].dicts.zh).sort(),
  Object.keys(localeRegistrations[0].dicts.en).sort(),
  'zh/en dictionaries carry identical key sets',
);
assert.ok(effects.length >= 2, 'stylesheet + dictionaries registered as owned effects');
assert.ok(
  effects.every((effect) => typeof effect.dispose === 'function'),
  'every effect returns a disposer',
);

// Stylesheet mount: one tag owned by this package, with the expected tokens.
assert.equal(fakeDocument.head.children.length, 1, 'one stylesheet tag mounted');
const styleTag = fakeDocument.head.children[0];
assert.equal(styleTag.dataset.plugin, PACKAGE_ID, 'style tag carries the package ownership marker');
assert.ok(styleTag.textContent.includes('--dsw-alias-label-tertiary'), 'stylesheet uses theme tokens');
assert.ok(styleTag.textContent.includes('.ctxslim-row'), 'stylesheet carries the row rules');
assert.ok(styleTag.textContent.includes('.ctxslim-config-form'), 'stylesheet carries the config form rules');

const definition = definitions[0];
assert.equal(definition.kind, T.NODE_KIND, 'definition kind is the renderer key');
assert.equal(definition.target, 'chat');
assert.equal(typeof definition.match, 'function');
assert.equal(typeof definition.buildViewNode, 'function');

const slot = slotRegistrations[0];
assert.deepEqual(slot.options, {
  name: 'conversation.chat.node',
  key: T.NODE_KIND,
  locale: LOCALE_NS,
});
assert.equal(typeof slot.Component, 'function', 'renderer component registered');

const configSlot = slotRegistrations[1];
assert.equal(T.PLUGIN_CONFIG_SLOT, 'plugins.row.config');
assert.equal(T.PLUGIN_CONFIG_KEY, '@ds-hu/dsh-context-slimmer#context-slimmer-tool-result');
assert.deepEqual(configSlot.options, {
  name: 'plugins.row.config',
  key: T.PLUGIN_CONFIG_KEY,
  locale: LOCALE_NS,
});
assert.equal(typeof configSlot.Component, 'function', 'Plugins row config renderer registered');

/* ------------------------------------------------------------------ *
 * Definition matching: primary compaction/prune channel
 * ------------------------------------------------------------------ */

/** Build one native-shaped `compaction/prune` event with our payload attached. */
const pruneEvent = (seq, payload, options = {}) => ({
  type: PRUNE_TYPE,
  seq,
  time: 1700000000000 + seq,
  data: {
    shadowedRange: { start: options.replacedSeq ?? 5, end: options.replacedSeq ?? 5 },
    shadowedSeqs: [options.replacedSeq ?? 5],
    shadowedTokenCount: 1234,
    ...(payload === undefined ? {} : { [META_KEY]: payload }),
  },
});

/** Build one secondary-channel `tool/result` surface replacement (forward compat). */
const replacementEvent = (seq, payload, options = {}) => ({
  type: TOOL_RESULT_TYPE,
  seq,
  time: 1700000000000 + seq,
  data: {
    turn: 3,
    step: 4,
    message: {
      content: [{ type: 'text', text: '[elided by context-slimmer]' }],
      isError: false,
    },
    meta: payload === undefined ? {} : { [META_KEY]: payload },
  },
  surfaceOp: { op: 'replace', startSeq: options.replacedSeq ?? 5, endSeq: options.replacedSeq ?? 5 },
  sourceEventSeqs: [options.replacedSeq ?? 5],
});

const SAMPLE_SUMMARY = {
  v: 1,
  batchId: 'batch-1',
  role: SUMMARY_ROLE,
  status: 'applied',
  startedAt: 1700000000000,
  finishedAt: 1700000001000,
  trigger: { everyNToolCalls: 8, minChars: 24000, observedCalls: 8, observedChars: 30000 },
  model: { provider: 'deepseek', model: 'deepseek-v4.1-flash', inherited: false },
  items: [
    {
      index: 0,
      callId: 'call-a',
      toolName: 'bash',
      op: 'drop',
      reason: '与任务无关',
      charsBefore: 8123,
      charsAfter: 48,
      replacementSeq: 20,
    },
    {
      index: 3,
      callId: 'call-b',
      toolName: 'read_file',
      op: 'trim',
      reason: '只保留相关片段',
      charsBefore: 2000,
      charsAfter: 500,
      replacementSeq: 21,
    },
  ],
  totals: { items: 2, charsBefore: 10123, charsAfter: 548, charsSaved: 9575 },
};

assert.equal(definition.match(null), null);
assert.equal(definition.match({ type: 'compaction/summary', seq: 1, data: {} }), null);
assert.equal(
  definition.match(pruneEvent(1)),
  null,
  'a native compaction/prune event without contextSlimmer never matches',
);
assert.equal(
  definition.match(pruneEvent(2, { ...SAMPLE_SUMMARY, role: 'item' })),
  null,
  'per-item prune events (role: item) do not render a row',
);
assert.equal(
  definition.match(pruneEvent(3, { ...SAMPLE_SUMMARY, role: undefined })),
  null,
  'a payload without role is not claimed',
);
assert.equal(
  definition.match(replacementEvent(4, undefined)),
  null,
  'a plain tool/result replacement without the secondary payload is ignored',
);

const event = pruneEvent(12, SAMPLE_SUMMARY, { replacedSeq: 5 });
assert.deepEqual(definition.match(event), { id: 'context-slimmer:batch-1', role: 'start' });

// Missing batchId falls back to the stable seq-based identity.
assert.deepEqual(
  definition.match(pruneEvent(7, { role: SUMMARY_ROLE, status: 'no-op' })),
  { id: 'context-slimmer:seq-7', role: 'start' },
);

// Secondary channel: kept as a forward-compatibility placeholder (it cannot fire
// against today's session validator, but a future runtime relaxation needs no
// client change).
assert.deepEqual(
  definition.match(replacementEvent(9, SAMPLE_SUMMARY)),
  { id: 'context-slimmer:batch-1', role: 'start' },
  'forward-compat: tool/result replacement meta is still understood',
);

/* ------------------------------------------------------------------ *
 * Node materialization (mirrors the native compaction chatNode)
 * ------------------------------------------------------------------ */

const location = { kind: 'step', turn: { turn: 3 }, step: { turn: 3, step: 4 } };
const state = definition.start({}, { event, location });
assert.equal(state.anchorSeq, 12, 'anchorSeq is the compaction/prune event seq');
assert.equal(state.summary.status, 'applied');
assert.equal(state.summary.batchId, 'batch-1');
assert.equal(state.summary.items.length, 2);
assert.equal(state.summary.totals.charsSaved, 9575);

const node = definition.buildViewNode({
  key: 'chat:context-slimmer:batch-1',
  kind: definition.kind,
  id: 'context-slimmer:batch-1',
  state,
  start: { event, location },
  matches: [{ event, location }],
});
assert.ok(node !== null);
assert.equal(node.target, 'chat');
assert.equal(node.kind, T.NODE_KIND, 'node kind equals the keyed renderer key');
assert.equal(node.key, 'chat:context-slimmer:batch-1');
assert.equal(node.id, 'context-slimmer:batch-1');
assert.equal(node.anchorSeq, 12);
assert.equal(node.visibility, 'visible');
assert.equal(Object.hasOwn(node, 'groupTree'), false, 'no groupTree override: matches the native compaction row');
assert.equal(node.location, location, 'node location comes from the engine-owned match location');
assert.equal(node.data, state.summary, 'data is the normalized batch summary');

// Session-level fallback location: session start, no Turn/Step coordinates.
assert.deepEqual(
  definition.buildViewNode({ key: 'k', kind: definition.kind, id: 'i', state, matches: [] }).location,
  { kind: 'session' },
  'unresolved location falls back to session',
);

assert.equal(
  definition.buildViewNode({ key: 'k', kind: definition.kind, id: 'i', state: undefined, matches: [] }),
  null,
  'no State materializes no node',
);

// `update` accumulates the latest batch snapshot for the same Context id.
const updated = definition.update(
  { key: 'chat:context-slimmer:batch-1', id: 'context-slimmer:batch-1', state },
  { event: pruneEvent(15, { ...SAMPLE_SUMMARY, status: 'rejected', items: [] }), role: 'start', location },
);
assert.equal(updated.anchorSeq, 15);
assert.equal(updated.summary.status, 'rejected');

/* ------------------------------------------------------------------ *
 * Structural element tree inspection (no real React rendering)
 * ------------------------------------------------------------------ */

const walk = (value, out = []) => {
  if (value === null || value === undefined || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, out);
    return out;
  }
  if (value.__element === true) {
    out.push(value);
    for (const child of value.children) walk(child, out);
  }
  return out;
};
const collectText = (value) => {
  const parts = [];
  const visit = (current) => {
    if (current === null || current === undefined) return;
    if (typeof current === 'string') {
      parts.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (typeof current === 'object' && current.__element === true) {
      for (const child of current.children) visit(child);
    }
  };
  visit(value);
  return parts.join('\n');
};
const findAll = (value, predicate) => walk(value, []).filter(predicate);
/** Direct element children, flattening the arrays our `h(type, props, children)` calls pass. */
const childrenOf = (element) => {
  const out = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value !== null && typeof value === 'object' && value.__element === true) out.push(value);
  };
  for (const child of element.children) visit(child);
  return out;
};
/**
 * Render one component with the shared hook runtime until state/effects settle.
 * Call `hookRuntime.reset()` first for a fresh component mount.
 */
const renderComponent = (component, props) => {
  let tree;
  let guard = 0;
  do {
    hookRuntime.resetRender();
    tree = component(props);
    hookRuntime.flushEffects();
  } while (hookRuntime.takeDirty() && guard++ < 16);
  return tree;
};
const findByAttribute = (tree, attribute) => findAll(tree, (element) => element.props[attribute] !== undefined);
const findField = (tree, name) => findAll(tree, (element) => element.props['data-field'] === name)[0];

hookRuntime.reset();
const renderChatRow = (props) => renderComponent(slot.Component, props);
const collapsed = renderChatRow({ node, t: translate });
assert.equal(collapsed.type, 'div');
assert.equal(collapsed.props['data-ctxslimmer-row'], '');
assert.equal(collapsed.props['data-status'], 'applied');
assert.equal(collapsed.props['data-expanded'], 'false');
assert.equal(childrenOf(collapsed).length, 1, 'collapsed row renders only its header');

const collapsedText = collectText(collapsed);
assert.ok(collapsedText.includes('已精简工具调用结果'), 'zh title');
assert.ok(collapsedText.includes('2 项'), 'zh item count');
assert.ok(collapsedText.includes('释放 9,575 字符'), 'zh saved-character summary');

const toggle = childrenOf(collapsed)[0];
assert.equal(toggle.type, 'button');
assert.equal(toggle.props.type, 'button', 'native button keeps Enter/Space keyboard support');
assert.equal(toggle.props['aria-expanded'], false, 'collapsed disclosure exposes aria-expanded=false');
assert.equal(toggle.props.disabled, false, 'expandable row is enabled');

toggle.props.onClick();
const expanded = renderChatRow({ node, t: translate });
assert.equal(expanded.props['data-expanded'], 'true');
assert.equal(childrenOf(expanded).length, 2, 'expanded row renders a body');
const expandedToggle = childrenOf(expanded)[0];
assert.equal(expandedToggle.props['aria-expanded'], true, 'expanded disclosure exposes aria-expanded=true');

const expandedText = collectText(expanded);
assert.ok(expandedText.includes('#0'), 'first item index');
assert.ok(expandedText.includes('bash'), 'first item tool name');
assert.ok(expandedText.includes('drop'), 'op is shown verbatim');
assert.ok(expandedText.includes('8,123→48'), 'character counts are grouped');
assert.ok(expandedText.includes('与任务无关'), 'item reason');
assert.ok(expandedText.includes('#3'), 'second item keeps its payload index');
assert.ok(expandedText.includes('read_file'));
assert.ok(expandedText.includes('trim'));
assert.ok(expandedText.includes('2,000→500'));
assert.ok(expandedText.includes('模型：deepseek/deepseek-v4.1-flash'), 'model attribution line last');

const itemRows = findAll(expanded, (element) => element.props['data-ctxslimmer-item'] !== undefined);
assert.equal(itemRows.length, 2, 'one detail row per item');
assert.equal(findAll(expanded, (element) => element.props['data-ctxslimmer-model'] !== undefined).length, 1);
assert.equal(findAll(expanded, (element) => element.props['data-ctxslimmer-trigger'] !== undefined).length, 1);

/* ------------------------------------------------------------------ *
 * Status variants and degraded payloads
 * ------------------------------------------------------------------ */

const renderSummary = (payload, seq, options = {}) => {
  const recordEvent = pruneEvent(seq ?? 20, payload, options);
  const recordState = definition.start({}, { event: recordEvent });
  const recordNode = definition.buildViewNode({
    key: 'k-' + String(recordEvent.seq),
    id: 'i',
    state: recordState,
    start: { event: recordEvent, location },
    matches: [{ event: recordEvent, location }],
  });
  assert.ok(recordNode !== null);
  hookRuntime.reset();
  return renderComponent(slot.Component, { node: recordNode, t: translate });
};

const noopRow = renderSummary({ batchId: 'batch-2', role: SUMMARY_ROLE, status: 'no-op', items: [], totals: { items: 0, charsSaved: 0 } }, 21);
assert.equal(noopRow.props['data-status'], 'no-op');
assert.ok(collectText(noopRow).includes('本次无改动'), 'no-op row reads as an uneventful run (gray, forward compatibility)');

const rejectedRow = renderSummary({ batchId: 'batch-3', role: SUMMARY_ROLE, status: 'rejected', items: [] }, 22);
assert.equal(rejectedRow.props['data-status'], 'rejected');
assert.ok(collectText(rejectedRow).includes('已跳过（模型未返回有效计划）'), 'rejected row reads as skipped');

// Unknown status falls back by payload shape; unknown fields are ignored.
const unknownStatusRow = renderSummary({
  batchId: 'batch-4',
  role: SUMMARY_ROLE,
  status: 'weird',
  items: [{ toolName: 'grep', op: 'drop', charsBefore: 10, charsAfter: 0 }],
}, 23);
assert.equal(unknownStatusRow.props['data-status'], 'applied', 'payload with items degrades to applied');

// A malformed/absent payload renders a quiet no-op row instead of throwing.
const malformedRow = renderSummary(undefined, 24);
assert.equal(malformedRow.props['data-status'], 'no-op');
assert.ok(collectText(malformedRow).includes('本次无改动'));

const normalized = T.normalizeSummary({ items: [{ charsBefore: 100 }], totals: { charsAfter: 25 } });
assert.equal(normalized.items.length, 1);
assert.equal(normalized.items[0].charsAfter, null);
assert.equal(normalized.totals.charsBefore, 100, 'totals fall back to item sums');
assert.equal(normalized.totals.charsSaved, 75, 'saved count falls back to before-after');

/* ------------------------------------------------------------------ *
 * English locale
 * ------------------------------------------------------------------ */

currentLocale = 'en';
hookRuntime.reset();
const englishRow = renderComponent(slot.Component, { node, t: translate });
const englishText = collectText(englishRow);
assert.ok(englishText.includes('Tool results slimmed'), 'en title');
assert.ok(englishText.includes('2 items'), 'en item count');
assert.ok(englishText.includes('9,575 chars freed'), 'en saved-character summary');

currentLocale = 'zh';

/* ------------------------------------------------------------------ *
 * Native Plugins panel: `plugins.row.config` renderer (v0.2)
 * ------------------------------------------------------------------ */

/** Host-resolved section fixture: only volatile fields, schema defaults applied. */
const CONFIG_VALUE = Object.freeze({
  enabled: true,
  everyNToolCalls: 8,
  minChars: 24000,
  protectRecent: 2,
  minTargetChars: 256,
  maxTargets: 12,
  policy: 'conservative',
  includeSubagents: true,
  triggerOnErrorOnly: false,
  timeoutMs: 120000,
  model: Object.freeze({ provider: 'inherit', model: 'inherit', reasoningEffort: 'inherit', maxOutputTokens: 2048 }),
});

const CONFIG_FIELD_NAMES = T.CONFIG_FIELDS.map((spec) => spec.name);

/** Fake `ConfigPageForm`: one snapshot plus a recording `mutate`. */
const makeForm = (options = {}) => {
  const value = 'value' in options ? options.value : CONFIG_VALUE;
  const calls = [];
  return {
    state: {
      status: options.status ?? 'ready',
      value,
      base: undefined,
      user: undefined,
      revision: options.revision ?? 7,
      writable: options.writable !== false,
    },
    calls,
    mutate(ops, expectedRevision) {
      calls.push({ ops, expectedRevision });
      if (options.failure instanceof Error) return Promise.reject(options.failure);
      return Promise.resolve(options.accepted === false ? false : true);
    },
  };
};

/** The slot component dispatches owner props to the two leaf views. */
hookRuntime.reset();
assert.equal(T.ConfigView({ view: 'summary', form: undefined, t: translate }).type, T.ConfigSummary, 'summary view dispatches to ConfigSummary');
assert.equal(T.ConfigView({ view: 'page', form: undefined, t: translate }).type, T.ConfigPage, 'page view dispatches to ConfigPage');

const configPageProps = (form, props = {}) => ({ form, t: translate, ...props });
const configSummaryProps = (form, props = {}) => ({ form, t: translate, ...props });
const mountConfigSummary = (form) => {
  hookRuntime.reset();
  return renderComponent(T.ConfigSummary, configSummaryProps(form));
};
const mountConfigPage = (form) => {
  hookRuntime.reset();
  return renderComponent(T.ConfigPage, configPageProps(form));
};
const paintConfigPage = (form) => renderComponent(T.ConfigPage, configPageProps(form));

/** Dispatch one control's change/click after re-reading the latest tree. */
const changeFieldValue = (tree, name, value) => {
  const control = findField(tree, name);
  assert.ok(control !== undefined, `data-field=${name} is rendered`);
  control.props.onChange({ target: { value } });
  return control;
};
const toggleCheckbox = (tree, name, checked) => {
  const control = findField(tree, name);
  assert.ok(control !== undefined, `data-field=${name} is rendered`);
  control.props.onChange({ target: { checked } });
  return control;
};
/** Whether a field's control is disabled (segmented options are buttons). */
const controlDisabled = (tree, name) => {
  const control = findField(tree, name);
  if (name === 'policy') {
    const options = findAll(control, (element) => element.type === 'button');
    return options.length > 0 && options.every((element) => element.props.disabled === true);
  }
  return control.props.disabled === true;
};
const clickOption = (tree, name, label) => {
  const control = findField(tree, name);
  assert.ok(control !== undefined, `data-field=${name} is rendered`);
  const options = findAll(control, (element) => element.type === 'button');
  const target = options.find((element) => collectText(element) === label);
  assert.ok(target !== undefined, `option "${label}" is rendered for ${name}`);
  target.props.onClick();
};

/* Summary view: one line, with no-form/loading/unavailable fallbacks. */
const summary = mountConfigSummary(makeForm());
assert.equal(summary.type, 'span');
assert.equal(summary.props['data-ctxslim-config'], '');
assert.equal(summary.props['data-ctxslim-view'], 'summary');
assert.equal(summary.props['data-ctxslim-status'], 'ready');
assert.equal(collectText(summary), '每 8 次调用 · 保守策略 · 模型跟随当前 Agent');

const disabledSummary = mountConfigSummary(makeForm({ value: { ...CONFIG_VALUE, enabled: false } }));
assert.equal(collectText(disabledSummary), '已停用 · 每 8 次调用 · 保守策略 · 模型跟随当前 Agent');

const explicitModelSummary = mountConfigSummary(makeForm({
  value: { ...CONFIG_VALUE, model: { ...CONFIG_VALUE.model, provider: 'deepseek', model: 'deepseek-v4.1-flash' } },
}));
assert.equal(collectText(explicitModelSummary), '每 8 次调用 · 保守策略 · 模型 deepseek/deepseek-v4.1-flash');

const noFormSummary = mountConfigSummary(undefined);
assert.equal(noFormSummary.props['data-ctxslim-status'], 'no-form');
assert.ok(collectText(noFormSummary).includes('没有可编辑的 Host 配置'));

const loadingSummary = mountConfigSummary(makeForm({ status: 'loading', value: undefined }));
assert.equal(loadingSummary.props['data-ctxslim-status'], 'loading');
assert.equal(collectText(loadingSummary), '正在加载配置…');

const unavailableSummary = mountConfigSummary(makeForm({ status: 'unavailable', value: undefined }));
assert.equal(unavailableSummary.props['data-ctxslim-status'], 'unavailable');
assert.ok(collectText(unavailableSummary).includes('配置不可用'));

/* Page view: every field, native controls, pending-save wiring. */
const pageForm = makeForm();
let page = mountConfigPage(pageForm);
assert.equal(page.type, 'div');
assert.equal(page.props['data-ctxslim-config'], '');
assert.equal(page.props['data-ctxslim-view'], 'page');
assert.equal(page.props['data-ctxslim-status'], 'ready');
assert.equal(page.props['data-ctxslim-dirty'], 'false');
assert.equal(page.props['data-ctxslim-writable'], 'true');
assert.equal(findByAttribute(page, 'data-ctxslim-readonly').length, 0, 'writable page shows no read-only banner');

const renderedFields = findAll(page, (element) => element.props['data-field'] !== undefined);
assert.deepEqual(
  renderedFields.map((element) => element.props['data-field']),
  CONFIG_FIELD_NAMES,
  'every documented field carries its data-field hook, in form order',
);
for (const name of CONFIG_FIELD_NAMES) {
  const control = findField(page, name);
  assert.ok(control !== undefined, `data-field=${name} is rendered`);
  assert.equal(controlDisabled(page, name), false, `${name} is editable`);
}
assert.equal(renderedFields.length, 14, 'thirteen scalar fields plus the optional reasoning-effort override');
const save = findByAttribute(page, 'data-ctxslim-save')[0];
assert.equal(save.type, 'button');
assert.equal(save.props.type, 'button');
assert.equal(save.props.disabled, true, 'save is disabled until the draft differs');
assert.ok(collectText(page).includes('触发阈值：新增工具调用数'), 'field labels come from the dictionary');

/* Editing marks the draft dirty and enables the single save action. */
changeFieldValue(page, 'everyNToolCalls', '20');
page = paintConfigPage(pageForm);
assert.equal(page.props['data-ctxslim-dirty'], 'true');
assert.equal(findByAttribute(page, 'data-ctxslim-save')[0].props.disabled, false);
assert.ok(collectText(page).includes('有未保存的修改'));

/* Invalid numbers surface inline errors and block saving. */
changeFieldValue(page, 'everyNToolCalls', '');
page = paintConfigPage(pageForm);
const numberError = findByAttribute(page, 'data-ctxslim-field-error').filter((element) => element.props['data-ctxslim-field-error'] === 'everyNToolCalls');
assert.equal(numberError.length, 1, 'empty number shows an inline error');
assert.ok(collectText(page).includes('请输入整数'));
assert.equal(findByAttribute(page, 'data-ctxslim-save')[0].props.disabled, true);

changeFieldValue(page, 'everyNToolCalls', '999');
page = paintConfigPage(pageForm);
assert.ok(collectText(page).includes('请输入 1 到 200 之间的整数'), 'range error names the documented bounds');

/* One atomic mutate carries only changed fields, nested model paths included. */
const saveForm = makeForm();
let formPage = mountConfigPage(saveForm);
changeFieldValue(formPage, 'everyNToolCalls', '20');
formPage = paintConfigPage(saveForm);
clickOption(formPage, 'policy', '激进');
formPage = paintConfigPage(saveForm);
toggleCheckbox(formPage, 'includeSubagents', false);
formPage = paintConfigPage(saveForm);
changeFieldValue(formPage, 'model.provider', 'deepseek');
formPage = paintConfigPage(saveForm);
changeFieldValue(formPage, 'model.model', 'deepseek-v4.1-flash');
formPage = paintConfigPage(saveForm);
changeFieldValue(formPage, 'model.reasoningEffort', 'high');
formPage = paintConfigPage(saveForm);
changeFieldValue(formPage, 'model.maxOutputTokens', '4096');
formPage = paintConfigPage(saveForm);
assert.equal(findByAttribute(formPage, 'data-ctxslim-save')[0].props.disabled, false, 'valid edits enable save');

findByAttribute(formPage, 'data-ctxslim-save')[0].props.onClick();
const savingPage = paintConfigPage(saveForm);
assert.equal(savingPage.props['data-ctxslim-status'], 'ready');
assert.equal(findByAttribute(savingPage, 'data-ctxslim-save')[0].props['aria-busy'], true, 'pending mutation marks the save busy');
assert.equal(findByAttribute(savingPage, 'data-ctxslim-save')[0].props.disabled, true, 'pending mutation disables the save button');

await Promise.resolve();
await Promise.resolve();
const savedPage = paintConfigPage(saveForm);
assert.equal(saveForm.calls.length, 1, 'one atomic mutate call for the whole edit');
assert.equal(saveForm.calls[0].expectedRevision, 7, 'mutate carries the snapshot revision fence');
assert.deepEqual(saveForm.calls[0].ops, [
  { op: 'set', path: ['everyNToolCalls'], value: 20 },
  { op: 'set', path: ['policy'], value: 'aggressive' },
  { op: 'set', path: ['includeSubagents'], value: false },
  { op: 'set', path: ['model', 'provider'], value: 'deepseek' },
  { op: 'set', path: ['model', 'model'], value: 'deepseek-v4.1-flash' },
  { op: 'set', path: ['model', 'reasoningEffort'], value: 'high' },
  { op: 'set', path: ['model', 'maxOutputTokens'], value: 4096 },
]);
const savedMessage = findByAttribute(savedPage, 'data-ctxslim-message')[0];
assert.equal(savedMessage.props['data-ctxslim-message'], 'saved');
assert.ok(collectText(savedPage).includes('已保存'));

/* A refreshed Host snapshot clears the draft but keeps the saved message. */
const acceptedValue = {
  ...CONFIG_VALUE,
  everyNToolCalls: 20,
  policy: 'aggressive',
  includeSubagents: false,
  model: { ...CONFIG_VALUE.model, provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', maxOutputTokens: 4096 },
};
const refreshedForm = makeForm({ value: acceptedValue, revision: 8 });
const refreshedPage = paintConfigPage(refreshedForm);
assert.equal(refreshedPage.props['data-ctxslim-dirty'], 'false', 'accepted Host snapshot clears the dirty draft');
assert.equal(findField(refreshedPage, 'model.provider').props.value, 'deepseek');

/* Refusal: keep edits, tell the user the page refreshed, show failure. */
const refusedForm = makeForm({ accepted: false });
let refusedPage = mountConfigPage(refusedForm);
changeFieldValue(refusedPage, 'everyNToolCalls', '30');
refusedPage = paintConfigPage(refusedForm);
findByAttribute(refusedPage, 'data-ctxslim-save')[0].props.onClick();
await Promise.resolve();
await Promise.resolve();
refusedPage = paintConfigPage(refusedForm);
const refusedMessage = findByAttribute(refusedPage, 'data-ctxslim-message')[0];
assert.equal(refusedMessage.props['data-ctxslim-message'], 'failed');
assert.ok(collectText(refusedPage).includes('已刷新，请重试'), 'revision conflict / refusal tells the user to retry');
assert.equal(refusedPage.props['data-ctxslim-dirty'], 'true', 'refused edits stay in the draft');

/* Transport rejection: keep edits and surface the failure. */
const errorForm = makeForm({ failure: new Error('socket closed') });
let errorPage = mountConfigPage(errorForm);
changeFieldValue(errorPage, 'everyNToolCalls', '30');
errorPage = paintConfigPage(errorForm);
findByAttribute(errorPage, 'data-ctxslim-save')[0].props.onClick();
await Promise.resolve();
await Promise.resolve();
errorPage = paintConfigPage(errorForm);
assert.ok(collectText(errorPage).includes('socket closed'), 'transport failure detail is surfaced');
assert.equal(errorPage.props['data-ctxslim-dirty'], 'true');

/* Provider/model pair: one side alone is rejected before mutate. */
const pairForm = makeForm();
let pairPage = mountConfigPage(pairForm);
changeFieldValue(pairPage, 'model.provider', 'deepseek');
pairPage = paintConfigPage(pairForm);
const pairErrors = findByAttribute(pairPage, 'data-ctxslim-field-error');
assert.equal(pairErrors.length, 2, 'both model fields flag the incomplete pair');
assert.ok(collectText(pairPage).includes('必须同时填写'));
assert.equal(findByAttribute(pairPage, 'data-ctxslim-save')[0].props.disabled, true);
assert.equal(pairForm.calls.length, 0, 'invalid draft never reaches mutate');

/* Read-only deployment: controls disabled, no save action, banner shown. */
const readonlyPage = mountConfigPage(makeForm({ writable: false }));
assert.equal(readonlyPage.props['data-ctxslim-writable'], 'false');
for (const name of CONFIG_FIELD_NAMES) {
  assert.equal(controlDisabled(readonlyPage, name), true, `${name} disabled when the Host is read-only`);
}
assert.equal(findByAttribute(readonlyPage, 'data-ctxslim-save').length, 0, 'read-only page offers no save action');
assert.ok(collectText(readonlyPage).includes('只读'));

/* Status fallbacks and the missing-form fallback. */
const loadingPage = mountConfigPage(makeForm({ status: 'loading', value: undefined }));
assert.equal(loadingPage.props['data-ctxslim-status'], 'loading');
assert.ok(collectText(loadingPage).includes('正在加载配置'));
assert.equal(findAll(loadingPage, (element) => element.props['data-field'] !== undefined).length, 0);

const unavailablePage = mountConfigPage(makeForm({ status: 'unavailable', value: undefined }));
assert.equal(unavailablePage.props['data-ctxslim-status'], 'unavailable');
assert.ok(collectText(unavailablePage).includes('配置不可用'));

const noFormPage = mountConfigPage(undefined);
assert.equal(noFormPage.props['data-ctxslim-status'], 'no-form');
assert.equal(findByAttribute(noFormPage, 'data-ctxslim-no-form').length, 1);
assert.ok(collectText(noFormPage).includes('没有可编辑的 Host 配置'), 'row without volatile settings explains itself');

/* Pure helpers: defaults, nested paths, and the empty-means-inherit rule. */
const fallbackDraft = T.buildDraft({});
assert.equal(fallbackDraft.everyNToolCalls, '12');
assert.equal(fallbackDraft.policy, 'conservative');
assert.equal(fallbackDraft.minTargetChars, '4096');
assert.equal(fallbackDraft['model.provider'], '', 'inherit routes render as an empty input');
assert.equal(fallbackDraft['model.reasoningEffort'], 'inherit');

const inheritBase = { ...CONFIG_VALUE, model: { ...CONFIG_VALUE.model, provider: 'deepseek', model: 'deepseek-v4.1-flash' } };
const clearedModelDraft = T.buildDraft(inheritBase);
clearedModelDraft['model.provider'] = '';
clearedModelDraft['model.model'] = '';
assert.deepEqual(T.buildOps(T.buildDraft(inheritBase), clearedModelDraft), [
  { op: 'set', path: ['model', 'provider'], value: 'inherit' },
  { op: 'set', path: ['model', 'model'], value: 'inherit' },
], 'clearing both model inputs writes inherit back');

assert.deepEqual(T.buildOps(T.buildDraft(CONFIG_VALUE), T.buildDraft(CONFIG_VALUE)), [], 'unchanged draft produces no ops');
assert.equal(
  T.validateDraft({ ...T.buildDraft(CONFIG_VALUE), 'model.provider': 'deepseek' }).errors['model.model'],
  'modelPair',
);

/* Every config copy key is present in both dictionaries. */
const CONFIG_COPY_KEYS = [
  'config.loading', 'config.unavailable', 'config.noForm', 'config.readOnly',
  'config.save', 'config.saving', 'config.saved', 'config.failed', 'config.failedRefresh',
  'config.dirty', 'config.invalidNumber', 'config.invalidRange', 'config.modelPair',
  'config.invalidPolicy', 'config.invalidOption', 'config.model.placeholder', 'config.policySuffix',
  'config.summary.disabled', 'config.summary.calls', 'config.summary.modelInherit', 'config.summary.model',
];
for (const spec of T.CONFIG_FIELDS) {
  for (const suffix of ['label', 'hint']) CONFIG_COPY_KEYS.push('config.' + spec.name + '.' + suffix);
  if (spec.kind === 'segmented') for (const option of spec.options) CONFIG_COPY_KEYS.push('config.policy.' + option);
  if (spec.kind === 'select') for (const option of spec.options) CONFIG_COPY_KEYS.push('config.reasoning.' + option);
}
for (const locale of ['zh', 'en']) {
  for (const key of CONFIG_COPY_KEYS) {
    assert.equal(typeof T.dictionaries[locale][key], 'string', `${locale} carries ${key}`);
  }
}

/* English copy for the page and its save action. */
currentLocale = 'en';
const englishPage = mountConfigPage(makeForm());
assert.equal(findByAttribute(englishPage, 'data-ctxslim-save')[0].children.join(''), 'Save');
assert.ok(collectText(englishPage).includes('Enable tool-result slimming'));
assert.ok(collectText(englishPage).includes('Slimming policy'));
assert.ok(collectText(englishPage).includes('Reasoning effort'));
currentLocale = 'zh';

/* ------------------------------------------------------------------ *
 * Teardown
 * ------------------------------------------------------------------ */

hookRuntime.unmount();
for (const effect of effects) effect.dispose();
delete globalThis.document;

process.stdout.write('client-smoke: ok (bundle format, definition, renderer, locale, styles, config page)\n');
