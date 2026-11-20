import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Config,
  ConfigError,
  DEFAULT_CONFIG,
  INHERIT,
  POLICIES,
  promptLocaleOf,
  recordModel,
  resolveConfig,
  resolveModelTarget,
  unwrapVolatile,
  unwrapVolatileDeep,
} from '../lib/config.js'

/** Build one cosmokit volatile reference double. */
function volatileRef(value) {
  return { get: () => value }
}

test('empty configuration resolves to the documented 0.2.0 defaults', () => {
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.everyNToolCalls, 12)
  assert.equal(config.minChars, 24000)
  assert.equal(config.protectRecent, 3)
  assert.equal(config.maxTargets, 4)
  assert.equal(config.minTargetChars, 4096)
  assert.equal(config.policy, 'conservative')
  assert.equal(config.includeSubagents, true)
  assert.deepEqual(config.model, { provider: '', model: '', reasoningEffort: 'inherit', maxOutputTokens: 0 })
})

test('the schema accepts an empty object, defaults policy/effort/AND thresholds', () => {
  const parsed = resolveConfig({})
  assert.equal(parsed.policy, 'conservative')
  assert.equal(parsed.includeSubagents, true)
  assert.equal(parsed.everyNToolCalls, 12)
  assert.equal(parsed.model.reasoningEffort, 'inherit')
  assert.equal(parsed.model.maxOutputTokens, 0)
  assert.equal(POLICIES.includes(parsed.policy), true)
  // Volatile fields resolve to cosmokit wrappers; resolveConfig unwraps them.
  const raw = Config({})
  assert.equal(typeof raw.enabled.get, 'function')
  assert.equal(raw.enabled.get(), true)
  assert.equal(raw.model.maxOutputTokens.get(), 0)
})

test('partial overrides merge onto the defaults without leaking unknown keys', () => {
  const config = resolveConfig({
    policy: 'balanced',
    includeSubagents: false,
    everyNToolCalls: 4,
    minChars: 0,
    model: { provider: 'p', model: 'm', reasoningEffort: 'high', maxOutputTokens: 0 },
  })
  assert.equal(config.policy, 'balanced')
  assert.equal(config.includeSubagents, false)
  assert.equal(config.everyNToolCalls, 4)
  assert.equal(config.minChars, 0)
  assert.deepEqual(config.model, { provider: 'p', model: 'm', reasoningEffort: 'high', maxOutputTokens: 0 })
  assert.equal(Object.isFrozen(config), true)
  assert.equal(Object.isFrozen(config.model), true)
})

test('cross-field validation rejects unusable combinations', () => {
  assert.throws(() => resolveConfig({ everyNToolCalls: 0, minChars: 0 }), (error) => error instanceof ConfigError && error.code === 'no-trigger')
  assert.throws(() => resolveConfig({ model: { provider: 'p', model: '' } }), (error) => error.code === 'partial-model-override')
  assert.throws(() => resolveConfig({ model: { provider: '', model: 'm' } }), (error) => error.code === 'partial-model-override')
  assert.throws(() => resolveConfig({ policy: 'yolo' }), (error) => error.code === 'bad-config')
  assert.throws(() => resolveConfig({ maxTargets: 21 }), (error) => error.code === 'bad-max-targets')
  assert.throws(() => resolveConfig({ timeoutMs: 10 }), (error) => error.code === 'bad-timeout')
  assert.throws(() => resolveConfig({ unknownKey: true }), (error) => error.code === 'unknown-config-key')
  assert.throws(() => resolveConfig({ model: { nope: 1 } }), (error) => error.code === 'unknown-model-key')
})

test('legacy "inherit" is treated as not configured', () => {
  const config = resolveConfig({ model: { provider: INHERIT, model: INHERIT, maxOutputTokens: 100 } })
  assert.deepEqual(config.model, { provider: '', model: '', reasoningEffort: 'inherit', maxOutputTokens: 100 })
})

test('model route resolution follows config -> request header -> agent options', () => {
  const configured = resolveConfig({ model: { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'high' } })
  assert.deepEqual(resolveModelTarget(configured, { provider: 'h-p', model: 'h-m', reasoningEffort: 'max' }, { provider: 'a-p', model: 'a-m' }), {
    provider: 'cfg-p',
    model: 'cfg-m',
    reasoningEffort: 'high',
    inherited: false,
  })
  const inherited = resolveConfig({})
  // Default reasoningEffort 'inherit' copies the MAIN route effort (thinking on).
  assert.deepEqual(resolveModelTarget(inherited, { provider: 'h-p', model: 'h-m', reasoningEffort: 'max' }, { provider: 'a-p', model: 'a-m' }), {
    provider: 'h-p',
    model: 'h-m',
    reasoningEffort: 'max',
    inherited: true,
  })
  // An explicit value overrides the inherited effort.
  assert.deepEqual(resolveModelTarget(resolveConfig({ model: { reasoningEffort: 'off' } }), { provider: 'h-p', model: 'h-m', reasoningEffort: 'max' }, undefined), {
    provider: 'h-p',
    model: 'h-m',
    reasoningEffort: 'off',
    inherited: true,
  })
  // No main-route effort anywhere -> omit the option (adapter default).
  assert.deepEqual(resolveModelTarget(inherited, { provider: 'h-p', model: 'h-m' }, undefined), {
    provider: 'h-p',
    model: 'h-m',
    inherited: true,
  })
  assert.deepEqual(resolveModelTarget(inherited, undefined, { provider: 'a-p', model: 'a-m', reasoningEffort: 'low' }), {
    provider: 'a-p',
    model: 'a-m',
    reasoningEffort: 'low',
    inherited: true,
  })
  assert.equal(resolveModelTarget(inherited, undefined, undefined), null)
  // A half-configured header level is skipped, never merged.
  assert.deepEqual(resolveModelTarget(inherited, { provider: 'h-p' }, { provider: 'a-p', model: 'a-m' }), {
    provider: 'a-p',
    model: 'a-m',
    inherited: true,
  })
})

test('every panel field is volatile (dsh-settings form contract)', () => {
  const json = Config.toJSON()
  const assertVolatile = (nodeId, prefix) => {
    const node = json.refs[nodeId]
    assert.equal(node?.meta?.volatile, true, `${prefix} must be volatile`)
    for (const [key, childId] of Object.entries(node.dict ?? {})) assertVolatile(childId, `${prefix}.${key}`)
  }
  const root = json.refs[json.uid]
  for (const key of ['enabled', 'everyNToolCalls', 'minChars', 'protectRecent', 'maxTargets', 'triggerOnErrorOnly', 'minTargetChars', 'timeoutMs', 'policy', 'includeSubagents', 'promptLocale', 'diagnosticsFile']) {
    assertVolatile(root.dict[key], key)
  }
  // Nested model fields are volatile; the enclosing object must NOT be volatile
  // (schemastery rejects volatile fields under a volatile ancestor).
  const modelNode = json.refs[root.dict.model]
  assert.equal(modelNode.meta?.volatile, undefined)
  for (const key of ['provider', 'model', 'reasoningEffort', 'maxOutputTokens']) {
    assertVolatile(modelNode.dict[key], `model.${key}`)
  }
})

test('recordModel keeps provider/model and inherited flag; locale helper works', () => {
  const config = resolveConfig({ model: { provider: 'p', model: 'm' } })
  assert.deepEqual(recordModel(config, resolveModelTarget(config, undefined, undefined)), {
    provider: 'p',
    model: 'm',
    inherited: false,
  })
  assert.deepEqual(recordModel(resolveConfig({}), { provider: 'h-p', model: 'h-m', inherited: true }), {
    provider: 'h-p',
    model: 'h-m',
    inherited: true,
  })
  assert.equal(promptLocaleOf(resolveConfig({ promptLocale: 'en' })), 'en')
  assert.equal(promptLocaleOf(resolveConfig({ promptLocale: 'auto' })), 'zh')
})


test('resolveConfig deep-unwraps volatile references from the Loader', () => {
  const input = {
    enabled: volatileRef(false),
    everyNToolCalls: volatileRef(3),
    minChars: volatileRef(0),
    protectRecent: volatileRef(1),
    maxTargets: volatileRef(2),
    triggerOnErrorOnly: volatileRef(true),
    minTargetChars: volatileRef(10),
    timeoutMs: volatileRef(5000),
    policy: volatileRef('balanced'),
    includeSubagents: volatileRef(false),
    promptLocale: volatileRef('en'),
    diagnosticsFile: volatileRef('/tmp/x.jsonl'),
    model: {
      provider: volatileRef('p'),
      model: volatileRef('m'),
      reasoningEffort: volatileRef('off'),
      maxOutputTokens: volatileRef(1024),
    },
  }
  const config = resolveConfig(input)
  assert.equal(config.enabled, false)
  assert.equal(config.everyNToolCalls, 3)
  assert.equal(config.minChars, 0)
  assert.equal(config.triggerOnErrorOnly, true)
  assert.equal(config.policy, 'balanced')
  assert.equal(config.includeSubagents, false)
  assert.equal(config.promptLocale, 'en')
  assert.equal(config.diagnosticsFile, '/tmp/x.jsonl')
  assert.deepEqual(config.model, { provider: 'p', model: 'm', reasoningEffort: 'off', maxOutputTokens: 1024 })
  // The original input must not be mutated.
  assert.equal(typeof input.enabled.get, 'function')

  // Plain input stays byte-identical in behaviour.
  assert.deepEqual(resolveConfig({ enabled: false, policy: 'aggressive' }), {
    ...DEFAULT_CONFIG,
    enabled: false,
    policy: 'aggressive',
  })
})

test('unwrapVolatileDeep recurses through arrays/plain objects and keeps other values', () => {
  assert.deepEqual(unwrapVolatileDeep({ a: [volatileRef(1)], b: { c: volatileRef('x') }, d: null, e: 2 }), {
    a: [1],
    b: { c: 'x' },
    d: null,
    e: 2,
  })
  assert.equal(unwrapVolatile(true), true)
  assert.equal(unwrapVolatile(volatileRef('v')), 'v')
  // A volatile reference returning the wrong type still fails schema validation.
  assert.throws(() => resolveConfig({ enabled: volatileRef('yes') }), (error) => error instanceof ConfigError && error.code === 'bad-config')
  assert.throws(() => resolveConfig({ policy: volatileRef('yolo') }), (error) => error.code === 'bad-config')
  assert.throws(() => resolveConfig({ model: { model: volatileRef(7) } }), (error) => error.code === 'bad-config')
})
