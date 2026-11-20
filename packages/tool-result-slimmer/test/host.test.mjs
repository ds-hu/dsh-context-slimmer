import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createFakeSession } from '../../core/test/helpers/fake-session.mjs'
import { buildPlannerInstruction } from '../../core/lib/prompt.js'
import { readSlimMetaFromEvent } from '../../core/lib/events.js'
import { SlimmerHost, estimateMessageTokens, extractPlanFromText, parsePlannerText } from '../lib/index.js'

/** Resolved-config double; tests override individual fields. */
function hostConfig(overrides = {}) {
  return {
    enabled: true,
    everyNToolCalls: 1,
    minChars: 1,
    protectRecent: 0,
    maxTargets: 4,
    triggerOnErrorOnly: false,
    minTargetChars: 0,
    timeoutMs: 500,
    policy: 'conservative',
    includeSubagents: true,
    promptLocale: 'zh',
    diagnosticsFile: '',
    model: { provider: 'p', model: 'm', reasoningEffort: '', maxOutputTokens: 0 },
    ...overrides,
  }
}

/** Minimal Cordis ctx double with one LLM stream factory. */
function createFakeCtx() {
  const handlers = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {
        const list = handlers.get(event) ?? []
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect() {
      return () => {}
    },
    get() {
      return undefined
    },
    llm: {
      calls: [],
      /** @type {((options: object, callIndex: number) => AsyncGenerator) | null} */
      streamFactory: null,
      stream(options) {
        ctx.llm.calls.push(options)
        if (ctx.llm.streamFactory === null) throw new Error('no stream factory configured')
        return ctx.llm.streamFactory(options, ctx.llm.calls.length - 1)
      },
    },
    emitSessionEvent(session, event) {
      for (const handler of handlers.get('session/event') ?? []) handler(session, event)
    },
    emitAgentCreated(payload) {
      for (const handler of handlers.get('agent/created') ?? []) handler(payload)
    },
    async preStep(payload) {
      const handler = (handlers.get('agent/pre-step') ?? [])[0]
      assert.equal(typeof handler, 'function', 'agent/pre-step listener must be installed')
      return handler(payload, async () => ({ kind: 'accept' }))
    },
  }
  return ctx
}

function preStepPayload(session, options = {}) {
  return {
    agent: { id: options.agentId ?? 'agent-1', session, options: options.agentOptions ?? { provider: 'p', model: 'm' } },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'fix the failing test' }] }],
    signal: options.signal,
  }
}

function liveResult(ctx, session, callId, toolName, text, options = {}) {
  const event = session.appendToolResult(callId, toolName, text, { isError: options.isError === true })
  ctx.emitSessionEvent(session, event)
  return event
}

/** One-shot generator yielding complete text and a finish reason. */
function textPlanStream(plan, options = {}) {
  return async function* () {
    if (options.throwError !== undefined) throw options.throwError
    yield { type: 'text-delta', index: 0, text: typeof plan === 'string' ? plan : JSON.stringify(plan) }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Generator that emits only reasoning and truncates at the token cap. */
function truncatedStream() {
  return async function* () {
    yield { type: 'reasoning-delta', index: 0, text: 'thinking...' }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 2048 } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  }
}

/** Generator that never settles (hard-timeout test). */
function hungStream() {
  return async function* () {
    await new Promise(() => {})
  }
}

function duplicateSetup(ctx, session, options = {}) {
  const body = `large duplicate body ${'x'.repeat(300)}`
  liveResult(ctx, session, 'call-0', 'read_file', body)
  liveResult(ctx, session, 'call-1', 'read_file', body)
  return body
}

test('baseline pre-step installs a counter without calling the planner', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig())
  host.install()
  await ctx.preStep(preStepPayload(session))
  assert.equal(ctx.llm.calls.length, 0)
  assert.equal(host.counters.get(session.id).observedCalls, 0)
})

test('AND trigger: calls-only or chars-only does not fire; both fire and apply a duplicate drop', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ everyNToolCalls: 2, minChars: 200 }))
  host.install()
  await ctx.preStep(preStepPayload(session))

  // One result, far above minChars: the count condition still fails.
  liveResult(ctx, session, 'call-0', 'read_file', 'x'.repeat(400))
  await ctx.preStep(preStepPayload(session))
  assert.equal(ctx.llm.calls.length, 0)

  // Second small result: now both conditions are met.
  ctx.llm.streamFactory = textPlanStream({
    summary: '去重',
    items: [{ index: 1, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-0', reason: '重复' }],
  })
  liveResult(ctx, session, 'call-1', 'read_file', 'x'.repeat(400))
  await ctx.preStep(preStepPayload(session))
  assert.equal(ctx.llm.calls.length, 1)

  const appended = session.events.slice(-2)
  assert.deepEqual(appended.map((event) => event.type), ['compaction/prune', 'tool/result'])
  const stub = appended[1].data.message.content[0].text
  assert.equal(stub.includes('duplicate of call-0 (kept above)'), true)
  assert.equal(stub.includes('do not re-read'), true)
  assert.equal(stub.includes('re-fetch'), false)
  assert.equal(readSlimMetaFromEvent(appended[0]).role, 'summary')
})

test('planner request: derived messages + instruction, inherit route, no maxTokens/reasoningEffort by default', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession({ requestHeader: { config: { provider: 'h-p', model: 'h-m', reasoningEffort: 'max' } } })
  session.appendToolResult('call-0', 'bash', 'old result')
  const host = new SlimmerHost(ctx, hostConfig({ model: { provider: '', model: '', reasoningEffort: '', maxOutputTokens: 0 } }))
  host.install()
  await ctx.preStep(preStepPayload(session))
  liveResult(ctx, session, 'call-1', 'bash', 'the chosen result text')
  ctx.llm.streamFactory = textPlanStream({ summary: '无改动', items: [] })
  await ctx.preStep(preStepPayload(session))

  assert.equal(ctx.llm.calls.length, 1)
  const options = ctx.llm.calls[0]
  assert.equal(options.provider, 'h-p')
  assert.equal(options.model, 'h-m')
  assert.equal(options.reasoningEffort, 'max', 'inherit copies the main route effort (thinking stays on)')
  assert.equal('maxTokens' in options, false, 'maxOutputTokens=0 must omit maxTokens')
  assert.equal('purpose' in options, false, 'planner must not claim the compaction purpose')
  assert.equal('tools' in options, false, 'planner request stays tool-less')
  assert.equal(options.sessionId, session.id)
  assert.equal(typeof options.signal?.aborted, 'boolean')
  assert.equal(options.messages.length >= 1, true)
  const last = options.messages.at(-1)
  assert.equal(last.role, 'user')
  const instruction = last.content[0].text
  assert.equal(instruction.includes('[CANDIDATES]'), true)
  assert.equal(instruction.includes('callId=call-1'), true)
  assert.equal(instruction.includes('唯一的长文本读取结果'), true)
  // An explicit effort value is forwarded verbatim.
  const ctxExpl = createFakeCtx()
  const sessionExpl = createFakeSession()
  const hostExpl = new SlimmerHost(ctxExpl, hostConfig({ model: { provider: 'p', model: 'm', reasoningEffort: 'max', maxOutputTokens: 0 } }))
  hostExpl.install()
  await ctxExpl.preStep(preStepPayload(sessionExpl))
  liveResult(ctxExpl, sessionExpl, 'call-0', 'bash', 'explicit effort output')
  ctxExpl.llm.streamFactory = textPlanStream({ summary: '无改动', items: [] })
  await ctxExpl.preStep(preStepPayload(sessionExpl))
  assert.equal(ctxExpl.llm.calls[0].reasoningEffort, 'max')
})

test('maxOutputTokens > 0 is forwarded, and an unchanged plan is a no-op', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ model: { provider: 'p', model: 'm', reasoningEffort: '', maxOutputTokens: 2048 } }))
  host.install()
  await ctx.preStep(preStepPayload(session))
  liveResult(ctx, session, 'call-0', 'bash', 'big output')
  ctx.llm.streamFactory = textPlanStream({ summary: '无改动', items: [] })
  await ctx.preStep(preStepPayload(session))
  assert.equal(ctx.llm.calls[0].maxTokens, 2048)
  assert.equal(session.events.filter((event) => event.type === 'compaction/prune').length, 0)
})

test('structured_output tool-call compatibility still applies a plan', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig())
  host.install()
  await ctx.preStep(preStepPayload(session))
  liveResult(ctx, session, 'call-0', 'read_file', 'A'.repeat(500))
  liveResult(ctx, session, 'call-1', 'read_file', 'A'.repeat(500))
  const plan = {
    summary: '去重',
    items: [{ index: 1, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-0', reason: '重复' }],
  }
  ctx.llm.streamFactory = async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 't1', name: 'structured_output', arguments: JSON.stringify(plan) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
  await ctx.preStep(preStepPayload(session))
  assert.equal(session.events.filter((event) => event.type === 'compaction/prune').length, 1)
})

test('conservative policy rejects trim plans and never touches the surface', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig())
  host.install()
  await ctx.preStep(preStepPayload(session))
  liveResult(ctx, session, 'call-0', 'bash', 'bulk output '.repeat(100))
  ctx.llm.streamFactory = textPlanStream({
    summary: '修剪',
    items: [{ index: 0, op: 'trim', text: '[elided by context-slimmer] kept', reason: 'bulk' }],
  })
  const before = session.events.length
  await ctx.preStep(preStepPayload(session))
  assert.equal(session.events.length, before, 'a rejected plan must not append events')
})

test('includeSubagents controls whether subagent sessions are processed', async () => {
  for (const includeSubagents of [true, false]) {
    const ctx = createFakeCtx()
    const session = createFakeSession({ origin: 'subagent' })
    const host = new SlimmerHost(ctx, hostConfig({ includeSubagents }))
    host.install()
    await ctx.preStep(preStepPayload(session))
    liveResult(ctx, session, 'call-0', 'read_file', 'B'.repeat(500))
    liveResult(ctx, session, 'call-1', 'read_file', 'B'.repeat(500))
    ctx.llm.streamFactory = textPlanStream({
      summary: '去重',
      items: [{ index: 1, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-0', reason: '重复' }],
    })
    await ctx.preStep(preStepPayload(session))
    assert.equal(ctx.llm.calls.length, includeSubagents ? 1 : 0)
    assert.equal(session.events.filter((event) => event.type === 'compaction/prune').length, includeSubagents ? 1 : 0)
  }
})

test('no resolvable model is a silent no-op', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ model: { provider: '', model: '', reasoningEffort: '', maxOutputTokens: 0 } }))
  host.install()
  await ctx.preStep(preStepPayload(session, { agentOptions: {} }))
  liveResult(ctx, session, 'call-0', 'bash', 'output '.repeat(50))
  const before = session.events.length
  await ctx.preStep(preStepPayload(session, { agentOptions: {} }))
  assert.equal(ctx.llm.calls.length, 0)
  assert.equal(session.events.length, before)
})

test('transient first truncation retries without maxTokens and applies the plan', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ model: { provider: 'p', model: 'm', reasoningEffort: '', maxOutputTokens: 2048 } }))
  host.install()
  await ctx.preStep(preStepPayload(session))
  liveResult(ctx, session, 'call-0', 'read_file', 'C'.repeat(500))
  liveResult(ctx, session, 'call-1', 'read_file', 'C'.repeat(500))
  ctx.llm.streamFactory = (options, callIndex) => {
    if (callIndex === 0) return truncatedStream()()
    return textPlanStream({
      summary: '去重',
      items: [{ index: 1, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-0', reason: '重复' }],
    })()
  }
  await ctx.preStep(preStepPayload(session))
  assert.equal(ctx.llm.calls.length, 2)
  assert.equal(ctx.llm.calls[0].maxTokens, 2048)
  assert.equal('maxTokens' in ctx.llm.calls[1], false, 'retry must omit the cap')
  assert.equal(session.events.filter((event) => event.type === 'compaction/prune').length, 1)
})

test('persistent truncation fails the run without touching the surface and records diagnostics', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slimmer-trunc-'))
  const diagnosticsFile = path.join(directory, 'diagnostics.jsonl')
  try {
    const ctx = createFakeCtx()
    const session = createFakeSession()
    const host = new SlimmerHost(ctx, hostConfig({ diagnosticsFile, model: { provider: 'p', model: 'm', reasoningEffort: '', maxOutputTokens: 2048 } }))
    host.install()
    await ctx.preStep(preStepPayload(session))
    liveResult(ctx, session, 'call-0', 'bash', 'D'.repeat(500))
    ctx.llm.streamFactory = () => truncatedStream()()
    const before = session.events.length
    await ctx.preStep(preStepPayload(session))
    assert.equal(ctx.llm.calls.length, 2)
    assert.equal(session.events.length, before)
    const records = fs.readFileSync(diagnosticsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const truncated = records.find((record) => record.kind === 'planner-truncated')
    assert.equal(truncated.finishReason, 'max-tokens')
    assert.equal(truncated.retried, true)
    assert.equal(truncated.usage.completionTokens, 2048)
    assert.equal(typeof truncated.durationMs, 'number')
    const retry = records.find((record) => record.kind === 'llm-truncation-retry')
    assert.equal(retry.maxTokens, 2048)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('hard timeout and stream errors are silent no-ops', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ timeoutMs: 25 }))
  host.install()
  await ctx.preStep(preStepPayload(session))
  liveResult(ctx, session, 'call-0', 'bash', 'E'.repeat(200))
  ctx.llm.streamFactory = () => hungStream()()
  const before = session.events.length
  const startedAt = Date.now()
  await ctx.preStep(preStepPayload(session))
  assert.equal(Date.now() - startedAt < 2000, true)
  assert.equal(session.events.length, before)

  const ctx2 = createFakeCtx()
  const session2 = createFakeSession()
  const host2 = new SlimmerHost(ctx2, hostConfig())
  host2.install()
  await ctx2.preStep(preStepPayload(session2))
  liveResult(ctx2, session2, 'call-0', 'bash', 'F'.repeat(200))
  ctx2.llm.streamFactory = () => textPlanStream('', { throwError: new Error('provider down') })()
  const before2 = session2.events.length
  await ctx2.preStep(preStepPayload(session2))
  assert.equal(session2.events.length, before2)
})

test('diagnostics file records trigger/llm/plan/validate/apply on a successful run', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slimmer-diag-'))
  const diagnosticsFile = path.join(directory, 'diagnostics.jsonl')
  try {
    const ctx = createFakeCtx()
    const session = createFakeSession()
    const host = new SlimmerHost(ctx, hostConfig({ diagnosticsFile }))
    host.install()
    await ctx.preStep(preStepPayload(session))
    liveResult(ctx, session, 'call-0', 'read_file', 'G'.repeat(500))
    liveResult(ctx, session, 'call-1', 'read_file', 'G'.repeat(500))
    ctx.llm.streamFactory = textPlanStream({
      summary: '去重',
      items: [{ index: 1, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-0', reason: '重复' }],
    })
    await ctx.preStep(preStepPayload(session))
    const records = fs.readFileSync(diagnosticsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const kinds = records.map((record) => record.kind)
    for (const kind of ['trigger', 'llm-start', 'llm-result', 'plan', 'validate', 'apply']) {
      assert.equal(kinds.includes(kind), true, `missing diagnostics kind ${kind}`)
    }
    const apply = records.find((record) => record.kind === 'apply')
    assert.equal(apply.finishReason, 'stop')
    assert.equal(apply.retried, false)
    assert.deepEqual(apply.usage, { promptTokens: 100, completionTokens: 20 })
    assert.equal(typeof apply.durationMs, 'number')
    assert.equal(records.every((record) => typeof record.ts === 'number' && record.ts > 0), true)
    assert.equal(records.every((record) => record.sessionId === session.id), true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('helper functions keep their documented contracts', () => {
  assert.equal(extractPlanFromText('```json\n{"a":1}\n```').a, 1)
  assert.equal(parsePlannerText('prefix {"a":1} suffix').a, 1)
  assert.equal(parsePlannerText('{"a":1}').a, 1)
  assert.equal(parsePlannerText('no json here'), null)
  assert.equal(estimateMessageTokens(undefined, { content: [{ type: 'text', text: 'abcd' }] }), 1)
  assert.equal(typeof buildPlannerInstruction({ locale: 'zh', policy: 'conservative' }), 'string')
})

test('duplicate hints reach the prompt and a hint-copy plan applies once (source planner)', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ minTargetChars: 8 }))
  host.install()
  await ctx.preStep(preStepPayload(session))
  duplicateSetup(ctx, session)
  ctx.llm.streamFactory = textPlanStream({
    summary: '去重',
    items: [{ index: 0, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-1', reason: '重复' }],
  })
  await ctx.preStep(preStepPayload(session))

  const instruction = ctx.llm.calls[0].messages.at(-1).content[0].text
  assert.equal(instruction.includes('duplicateOf=call-1（逐字相同，可直接 drop 本条）'), true)
  const appended = session.events.slice(-2)
  assert.deepEqual(appended.map((event) => event.type), ['compaction/prune', 'tool/result'])
  const stub = appended[1].data.message.content[0].text
  assert.equal(stub.includes('duplicate of call-1 (kept above)'), true)
  // Exactly one side of the pair was replaced (2 originals + 1 replacement).
  assert.equal(session.events.filter((event) => event.type === 'tool/result').length, 3)
  assert.equal(session.events.filter((event) => event.type === 'compaction/prune').length, 1)
})

test('empty conservative plan + provable duplicates → deterministic host fallback applies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slimmer-fallback-'))
  const diagnosticsFile = path.join(dir, 'diagnostics.jsonl')
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ minTargetChars: 8, diagnosticsFile }))
  host.install()
  await ctx.preStep(preStepPayload(session))
  duplicateSetup(ctx, session)
  ctx.llm.streamFactory = textPlanStream({ summary: '本次无改动', items: [] })
  await ctx.preStep(preStepPayload(session))

  const appended = session.events.slice(-2)
  assert.deepEqual(appended.map((event) => event.type), ['compaction/prune', 'tool/result'])
  const stub = appended[1].data.message.content[0].text
  assert.equal(stub.includes('duplicate of call-1 (kept above)'), true)
  const replacement = appended[1].data.message.content[0].text
  assert.equal(replacement.includes('重复读取（宿主判定）'), false, 'host reason stays in plan metadata, not the stub')

  const records = fs.readFileSync(diagnosticsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const fallbackValidate = records.filter((record) => record.kind === 'validate' && record.source === 'host-fallback')
  const fallbackApply = records.filter((record) => record.kind === 'apply' && record.source === 'host-fallback')
  assert.equal(fallbackValidate.length, 1)
  assert.equal(fallbackValidate[0].ok, true)
  assert.equal(fallbackApply.length, 1)
  assert.equal(fallbackApply[0].items, 1)
  assert.equal(fallbackApply[0].finishReason, 'stop')
  assert.deepEqual(fallbackApply[0].usage, { promptTokens: 100, completionTokens: 20 })
  assert.equal(host.counters.get(session.id).observedCalls, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('empty conservative plan without provable duplicates stays a no-op (no fallback)', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig())
  host.install()
  await ctx.preStep(preStepPayload(session))
  liveResult(ctx, session, 'call-0', 'bash', 'unique long output')
  liveResult(ctx, session, 'call-1', 'read_file', 'another unique output')
  ctx.llm.streamFactory = textPlanStream({ summary: '本次无改动', items: [] })
  await ctx.preStep(preStepPayload(session))
  assert.equal(session.events.filter((event) => event.type === 'compaction/prune').length, 0)
  assert.equal(session.events.filter((event) => event.type === 'tool/result').length, 2)
})

test('host fallback is conservative-only: balanced empty plan does not force a drop', async () => {
  const ctx = createFakeCtx()
  const session = createFakeSession()
  const host = new SlimmerHost(ctx, hostConfig({ policy: 'balanced', minTargetChars: 8 }))
  host.install()
  await ctx.preStep(preStepPayload(session))
  duplicateSetup(ctx, session)
  ctx.llm.streamFactory = textPlanStream({ summary: 'no changes', items: [] })
  await ctx.preStep(preStepPayload(session))
  assert.equal(session.events.filter((event) => event.type === 'compaction/prune').length, 0)
})
