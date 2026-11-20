import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Config,
  ConfigError,
  DEFAULT_CONFIG,
  agentOptionsOverride,
  promptLocaleOf,
  recordModel,
  resolveConfig,
} from '../lib/config.js'

test('empty configuration resolves to the documented defaults', () => {
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
  assert.equal(resolveConfig({}).enabled, true)
  assert.deepEqual(resolveConfig({}).model, { provider: 'inherit', model: 'inherit', reasoningEffort: 'inherit', maxOutputTokens: 2048 })
})

test('the schema accepts an empty object and applies defaults', () => {
  const parsed = Config({})
  assert.equal(parsed.everyNToolCalls, 8)
  assert.equal(parsed.minChars, 24000)
  assert.equal(parsed.model.maxOutputTokens, 2048)
})

test('partial overrides merge onto the defaults without leaking unknown keys', () => {
  const config = resolveConfig({ everyNToolCalls: 4, minChars: 0, model: { provider: 'p', model: 'm', reasoningEffort: 'high', maxOutputTokens: 0 } })
  assert.equal(config.everyNToolCalls, 4)
  assert.equal(config.minChars, 0)
  assert.deepEqual(config.model, { provider: 'p', model: 'm', reasoningEffort: 'high', maxOutputTokens: 0 })
  assert.equal(Object.isFrozen(config), true)
  assert.equal(Object.isFrozen(config.model), true)
})

test('cross-field validation rejects unusable combinations', () => {
  assert.throws(() => resolveConfig({ everyNToolCalls: 0, minChars: 0 }), (error) => error instanceof ConfigError && error.code === 'no-trigger')
  assert.throws(() => resolveConfig({ model: { provider: 'p', model: 'inherit' } }), (error) => error.code === 'partial-model-override')
  assert.throws(() => resolveConfig({ model: { provider: 'inherit', model: 'm' } }), (error) => error.code === 'partial-model-override')
  assert.throws(() => resolveConfig({ timeoutMs: 10 }), (error) => error.code === 'bad-timeout')
  assert.throws(() => resolveConfig({ maxTargets: 0 }), (error) => error.code === 'bad-max-targets')
  assert.throws(() => resolveConfig({ maxTargets: 1000 }), (error) => error.code === 'bad-max-targets')
  assert.throws(() => resolveConfig({ forkProvider: '' }), (error) => error.code === 'bad-fork-provider')
  assert.throws(() => resolveConfig({ unknownKey: true }), (error) => error.code === 'unknown-config-key')
  assert.throws(() => resolveConfig({ model: { backend: 'x' } }), (error) => error.code === 'unknown-model-key')
})

test('agentOptionsOverride only emits what the config overrides', () => {
  assert.deepEqual(agentOptionsOverride(resolveConfig({})), { maxTokens: 2048 })
  const override = agentOptionsOverride(resolveConfig({ model: { provider: 'p', model: 'm', reasoningEffort: 'low', maxOutputTokens: 512 } }))
  assert.deepEqual(override, { provider: 'p', model: 'm', reasoningEffort: 'low', maxTokens: 512 })
  // reasoningEffort=inherit must be omitted, maxOutputTokens=0 must be omitted.
  const partial = agentOptionsOverride(resolveConfig({ model: { provider: 'p', model: 'm', maxOutputTokens: 0 } }))
  assert.deepEqual(partial, { provider: 'p', model: 'm' })
  assert.equal('reasoningEffort' in partial, false)
})

test('recordModel reports inheritance and effective route', () => {
  assert.deepEqual(recordModel(resolveConfig({}), { provider: 'deepseek', model: 'deepseek-chat' }), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    inherited: true,
  })
  assert.deepEqual(recordModel(resolveConfig({}), undefined), { provider: 'inherit', model: 'inherit', inherited: true })
  assert.deepEqual(
    recordModel(resolveConfig({ model: { provider: 'openai', model: 'gpt-x' } }), { provider: 'deepseek', model: 'deepseek-chat' }),
    { provider: 'openai', model: 'gpt-x', inherited: false },
  )
  assert.equal(promptLocaleOf(resolveConfig({ promptLocale: 'en' })), 'en')
  assert.equal(promptLocaleOf(resolveConfig({ promptLocale: 'auto' })), 'zh')
})
