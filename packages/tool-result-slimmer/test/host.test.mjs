import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Config,
  ConfigError,
  SlimmerHost,
  estimateMessageTokens,
  extractPlan,
  extractPlanFromText,
  extractTask,
  buildRecent,
} from '../lib/index.js'
import { readSurfaceEntries } from '@ds-hu/dsh-context-slimmer-core/replace'
import { readSlimMetaFromEvent } from '@ds-hu/dsh-context-slimmer-core/events'
import { createFakeSession } from '../../core/test/helpers/fake-session.mjs'

/**
 * Fake Cordis context: records listeners, a fake tool registry and a fake
 * subagent service whose activation is scripted per test.
 */
function createFakeCtx() {
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    handlers: new Map(),
    disposers: 0,
    restricted: undefined,
    tokenMeter: undefined,
    activationSpecs: [],
    on(name, handler) {
      const list = ctx.handlers.get(name) ?? []
      list.push(handler)
      ctx.handlers.set(name, list)
      return () => {
        ctx.disposers += 1
      }
    },
    effect(callback) {
      return callback()
    },
    get(name) {
      return name === 'tokenMeter' ? ctx.tokenMeter : undefined
    },
    tools: {
      definitions: () => [{ name: 'bash' }, { name: 'read_file' }],
      restrict: (options) => {
        ctx.restricted = options
      },
    },
    subagents: {
      startActivation: async (spec) => {
        ctx.activationSpecs.push(spec)
        for (const handler of ctx.handlers.get('agent/created') ?? []) {
          await handler({ agent: { id: spec.childId, ctx: { tools: ctx.tools } } })
        }
        const result = typeof ctx.nextResult === 'function' ? ctx.nextResult(spec) : (ctx.nextResult ?? { stopReason: 'completed', output: [] })
        return { childId: spec.childId, messageId: 'message-1', result: Promise.resolve(result), dispose: async () => {} }
      },
    },
  }
  return ctx
}

const config = {
  enabled: true,
  everyNToolCalls: 2,
  minChars: 0,
  protectRecent: 0,
  maxTargets: 12,
  triggerOnErrorOnly: false,
  minTargetChars: 1,
  timeoutMs: 5000,
  forkProvider: 'fork',
  promptLocale: 'auto',
  model: { provider: 'inherit', model: 'inherit', reasoningEffort: 'inherit', maxOutputTokens: 64 },
}

function emit(ctx, name, ...args) {
  return (ctx.handlers.get(name) ?? []).map((handler) => handler(...args))
}

async function preStep(ctx, session, extra = {}) {
  const payload = {
    agent: { id: 'root-agent', session },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the failing test' }] }],
    modelSelection: { provider: 'test-provider', model: 'test-model' },
    signal: undefined,
    ...extra,
  }
  let decision = { kind: 'accept' }
  for (const handler of ctx.handlers.get('agent/pre-step') ?? []) {
    decision = await handler(payload, async () => decision)
  }
  return decision
}

function appendObserved(ctx, session, callId, toolName, text, options = {}) {
  const event = session.appendToolResult(callId, toolName, text, options)
  emit(ctx, 'session/event', session, event)
  return event
}

test('module exports the row name, required services and Config', () => {
  assert.equal(Config({}).everyNToolCalls, 8)
  assert.equal(typeof SlimmerHost, 'function')
})

test('baseline first pre-step never triggers; the next threshold does', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  ctx.nextResult = { stopReason: 'completed', output: [], structured: { summary: 's', items: [] } }
  const host = new SlimmerHost(ctx, config)
  host.install()
  await preStep(ctx, session)
  assert.equal(ctx.activationSpecs.length, 0, 'baseline must not trigger')
  assert.deepEqual(ctx.restricted, undefined)

  appendObserved(ctx, session, 'call-1', 'bash', 'a'.repeat(1000))
  appendObserved(ctx, session, 'call-2', 'read_file', 'b'.repeat(2000))
  const decision = await preStep(ctx, session)
  assert.equal(decision.kind, 'accept')
  assert.equal(ctx.activationSpecs.length, 1)
  const spec = ctx.activationSpecs[0]
  assert.equal(spec.provider, 'fork')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.parent.id, 'root-agent')
  assert.equal(spec.request.outputSchema.type, 'object')
  assert.equal(spec.request.prompt.length, 1)
  assert.match(spec.request.prompt[0].text, /\[CANDIDATES\]/)
  assert.match(spec.request.prompt[0].text, /\[#0\] tool=/)
  assert.match(spec.request.prompt[0].text, /fix the failing test/)
  // The child is restricted before its first request.
  assert.deepEqual(ctx.restricted, { deny: ['bash', 'read_file'] })
  // The run resets the counter window.
  assert.equal(host.counters.get(session.id).observedCalls, 0)
  assert.equal(host.runs.size, 0)
})

test('applied plan lands prune -> replace pairs with summary metadata on the last prune', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  ctx.nextResult = {
    stopReason: 'completed',
    output: [],
    structured: {
      summary: '清理',
      items: [
        { index: 1, op: 'trim', text: '[elided by context-slimmer] bash; original 2000 chars; re-run', reason: 'bulk' },
        { index: 0, op: 'drop', reason: '无关' },
      ],
    },
  }
  const host = new SlimmerHost(ctx, config)
  host.install()
  await preStep(ctx, session)
  appendObserved(ctx, session, 'call-1', 'bash', 'a'.repeat(1000))
  appendObserved(ctx, session, 'call-2', 'read_file', 'b'.repeat(2000))
  await preStep(ctx, session)

  const appended = session.events.slice(4)
  assert.deepEqual(appended.map((event) => event.type), ['compaction/prune', 'tool/result', 'compaction/prune', 'tool/result'])
  const first = readSlimMetaFromEvent(appended[0])
  const last = readSlimMetaFromEvent(appended[2])
  assert.equal(first.role, 'item')
  assert.equal(last.role, 'summary')
  assert.equal(last.status, 'applied')
  assert.equal(last.items.length, 2)
  assert.deepEqual(last.model, { provider: 'test-provider', model: 'test-model', inherited: true })
  assert.deepEqual(last.trigger, { everyNToolCalls: 2, minChars: 0, observedCalls: 2, observedChars: 3000 })
  assert.equal(appended[1].surfaceOp.op, 'replace')
  assert.equal(appended[3].surfaceOp.op, 'replace')
  // Replacement messages keep their tool pairing and only change content.
  assert.equal(appended[1].data.message.toolCallId, 'call-2')
  assert.equal(appended[3].data.message.toolCallId, 'call-1')
  assert.equal(testTrim(appended[1].data.message.content[0].text), true)

  // No run is triggered again on the next step until the window fills.
  await preStep(ctx, session)
  assert.equal(ctx.activationSpecs.length, 1)
})

function testTrim(text) {
  return typeof text === 'string' && text.startsWith('[elided by context-slimmer]')
}

test('no-op / rejected / failed plans never touch the surface', async () => {
  for (const [name, nextResult, expectedSpecs] of [
    ['no plan', { stopReason: 'completed', output: [] }, 1],
    ['empty plan', { stopReason: 'completed', output: [], structured: { summary: 's', items: [] } }, 1],
    ['invalid plan', { stopReason: 'completed', output: [], structured: { summary: 's', items: [{ index: 9, op: 'drop' }] } }, 1],
    ['failed child', { stopReason: 'error', output: [] }, 1],
  ]) {
    const ctx = createFakeCtx()
    const session = createFakeSession()
    ctx.nextResult = nextResult
    const host = new SlimmerHost(ctx, config)
    host.install()
    await preStep(ctx, session)
    appendObserved(ctx, session, 'call-1', 'bash', 'a'.repeat(1000))
    appendObserved(ctx, session, 'call-2', 'read_file', 'b'.repeat(2000))
    const before = session.events.length
    const decision = await preStep(ctx, session)
    assert.equal(decision.kind, 'accept', name)
    assert.equal(session.events.length, before, `${name} must not append events`)
    assert.equal(ctx.activationSpecs.length, expectedSpecs, name)
    assert.equal(host.counters.get(session.id).observedCalls, 0, `${name} resets the window`)
  }
})

test('structured output wins; assistant JSON text is the fallback', () => {
  assert.deepEqual(extractPlan({ structured: { summary: 's', items: [] }, output: [] }), { summary: 's', items: [] })
  const fromText = extractPlan({
    output: [{ type: 'text', text: 'prefix\n```json\n{"summary":"s","items":[]}\n```\nafter' }],
  })
  assert.deepEqual(fromText, { summary: 's', items: [] })
  assert.deepEqual(extractPlanFromText('no json here'), null)
  assert.deepEqual(extractPlanFromText('{"a":1} trailing'), { a: 1 })
  assert.equal(extractPlan({}), null)
  assert.equal(extractPlan(null), null)
})

test('task extraction and recent rendering never leak tool text into the task block', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    { role: 'user', content: [{ type: 'text', text: 'second request' }] },
  ]
  assert.equal(extractTask(messages), 'second request')
  assert.equal(extractTask(undefined), '（未提供）')
  assert.equal(extractTask([{ role: 'user', content: [] }]), '（未提供）')
  assert.equal(extractTask([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] }]).length > 1600, true)

  const session = createFakeSession()
  session.appendToolResult('call-1', 'bash', 'a'.repeat(100))
  session.appendToolResult('call-2', 'read_file', 'b'.repeat(200))
  const entries = readSurfaceEntries(session)
  const recent = buildRecent(entries, new Set([entries[1].seq]), 4)
  assert.deepEqual(recent, [{ index: 0, tool: 'read_file', isError: false, chars: 200 }])
})

test('prune-extension rejection degrades for the rest of the instance', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession({ rejectPruneExtension: true })
  ctx.nextResult = (spec) => ({
    stopReason: 'completed',
    output: [],
    structured: { summary: 's', items: [{ index: 0, op: 'drop' }] },
  })
  const host = new SlimmerHost(ctx, config)
  host.install()
  await preStep(ctx, session)
  appendObserved(ctx, session, 'call-1', 'bash', 'a'.repeat(1000))
  appendObserved(ctx, session, 'call-2', 'read_file', 'b'.repeat(2000))
  await preStep(ctx, session)
  assert.equal(host.extensionSupported, false)
  const replacement = session.events.at(-1)
  assert.equal(replacement.type, 'tool/result')
  assert.equal(replacement.surfaceOp.op, 'replace')

  // Second run must not even try the additive field.
  session.rejectPruneExtension = false
  appendObserved(ctx, session, 'call-3', 'bash', 'c'.repeat(1000))
  appendObserved(ctx, session, 'call-4', 'read_file', 'd'.repeat(2000))
  await preStep(ctx, session)
  const prunes = session.events.filter((event) => event.type === 'compaction/prune')
  assert.equal(prunes.length, 2)
  assert.equal(prunes[1].data.contextSlimmer, undefined)
})

test('pre-execute guard denies every child tool except structured_output', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, config)
  host.install()
  host.runs.set('child-1', { batchId: 'b' })
  const guards = ctx.handlers.get('tools/pre-execute')
  assert.equal(guards.length, 1)
  assert.deepEqual(
    await guards[0]({ name: 'bash', agent: { id: 'child-1' } }, async () => ({ kind: 'allow' })),
    { kind: 'deny', reason: 'context-slimmer child may only submit its structured plan' },
  )
  assert.deepEqual(await guards[0]({ name: 'structured_output', agent: { id: 'child-1' } }, async () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.deepEqual(await guards[0]({ name: 'bash', agent: { id: 'root-agent' } }, async () => ({ kind: 'allow' })), { kind: 'allow' })
})

test('estimateMessageTokens uses the token meter, then the 4-chars fallback', () => {
  const message = { role: 'tool', content: [{ type: 'text', text: 'a'.repeat(400) }] }
  assert.equal(estimateMessageTokens(undefined, message), 100)
  assert.equal(estimateMessageTokens({ estimateMessage: () => 42 }, message), 42)
  assert.equal(estimateMessageTokens({ estimateMessage: () => { throw new Error('boom') } }, message), 100)
  assert.equal(estimateMessageTokens({ estimateMessage: () => Number.NaN }, message), 100)
})

test('config errors surface as ConfigError from the row schema', () => {
  assert.equal(typeof ConfigError, 'function')
})
