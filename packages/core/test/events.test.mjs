import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BATCH_STATUSES,
  META_KEY,
  META_VERSION,
  MetaProtocolError,
  ROLE_ITEM,
  ROLE_SUMMARY,
  STATUS_APPLIED,
  buildItemMeta,
  buildSummaryMeta,
  contentTextChars,
  hasSlimMeta,
  normalizeMeta,
  readSlimMeta,
  readSlimMetaFromEvent,
  summarizeItems,
  summarizeMeta,
  textChars,
} from '../lib/events.js'

const trigger = { everyNToolCalls: 8, minChars: 24000, observedCalls: 9, observedChars: 30000 }
const model = { provider: 'deepseek', model: 'deepseek-chat', inherited: true }

function validSummary(overrides = {}) {
  return {
    batchId: 'batch-1',
    status: STATUS_APPLIED,
    startedAt: 1000,
    finishedAt: 1200,
    trigger,
    model,
    items: [
      { index: 0, callId: 'call-1', toolName: 'bash', op: 'drop', charsBefore: 500, charsAfter: 48, replacementSeq: 41 },
      { index: 1, callId: 'call-2', toolName: 'read_file', op: 'trim', reason: 'bulk', charsBefore: 900, charsAfter: 200, replacementSeq: 43 },
    ],
    ...overrides,
  }
}

test('buildItemMeta normalizes and freezes the per-replacement payload', () => {
  const meta = buildItemMeta({
    batchId: 'batch-1',
    index: 2,
    op: 'trim',
    charsBefore: 1200,
    charsAfter: 300,
    toolName: 'bash',
    callId: 'call-9',
    reason: 'bulk',
  })
  assert.equal(meta.v, META_VERSION)
  assert.equal(meta.role, ROLE_ITEM)
  assert.equal(meta.index, 2)
  assert.equal(meta.op, 'trim')
  assert.equal(meta.reason, 'bulk')
  assert.ok(Object.isFrozen(meta))
  assert.equal(normalizeMeta(meta).index, 2)
})

test('buildItemMeta rejects invalid ops/sizes and oversized reasons', () => {
  const base = { batchId: 'b', index: 0, op: 'drop', charsBefore: 100, charsAfter: 10, toolName: 'bash' }
  assert.throws(() => buildItemMeta({ ...base, op: 'keep' }), MetaProtocolError)
  assert.throws(() => buildItemMeta({ ...base, charsAfter: 200 }), MetaProtocolError)
  assert.throws(() => buildItemMeta({ ...base, reason: 'x'.repeat(41) }), MetaProtocolError)
  assert.throws(() => buildItemMeta({ ...base, toolName: '' }), MetaProtocolError)
})

test('buildSummaryMeta derives totals and round-trips through the reader', () => {
  const meta = buildSummaryMeta(validSummary())
  assert.equal(meta.role, ROLE_SUMMARY)
  assert.deepEqual(meta.totals, { items: 2, charsBefore: 1400, charsAfter: 248, charsSaved: 1152 })
  assert.deepEqual(readSlimMeta(meta), meta)
  assert.ok(Object.isFrozen(meta))
  assert.ok(Object.isFrozen(meta.items[0]))
})

test('summary validation is strict', () => {
  assert.throws(() => buildSummaryMeta(validSummary({ status: 'partial' })), MetaProtocolError)
  assert.throws(() => buildSummaryMeta(validSummary({ finishedAt: 999 })), MetaProtocolError)
  assert.throws(() => buildSummaryMeta(validSummary({ batchId: '' })), MetaProtocolError)
  assert.throws(
    () => buildSummaryMeta(validSummary({ items: [{ index: 0, callId: 'c', toolName: 'bash', op: 'drop', charsBefore: 10, charsAfter: 2, replacementSeq: 1, reason: 'x'.repeat(41) }] })),
    MetaProtocolError,
  )
  const badTotals = buildSummaryMeta(validSummary())
  assert.throws(
    () => normalizeMeta({ ...badTotals, totals: { ...badTotals.totals, items: 3 } }),
    MetaProtocolError,
  )
})

test('readSlimMeta is total: unknown versions/shapes return null instead of throwing', () => {
  assert.equal(readSlimMeta(undefined), null)
  assert.equal(readSlimMeta({ role: 'item' }), null)
  assert.equal(readSlimMeta({ v: 2, batchId: 'b', role: 'summary' }), null)
  assert.equal(readSlimMeta({ v: 1, batchId: '', role: 'item' }), null)
  const item = buildItemMeta({ batchId: 'b', index: 0, op: 'drop', charsBefore: 9, charsAfter: 1, toolName: 'bash' })
  assert.deepEqual(readSlimMeta(item), item)
})

test('readSlimMetaFromEvent only reads slim compaction/prune events', () => {
  const summary = buildSummaryMeta(validSummary())
  const event = { seq: 42, type: 'compaction/prune', data: { shadowedRange: { start: 7, end: 7 }, shadowedSeqs: [7], shadowedTokenCount: 10, [META_KEY]: summary } }
  assert.equal(readSlimMetaFromEvent(event).batchId, 'batch-1')
  assert.equal(readSlimMetaFromEvent({ seq: 1, type: 'tool/result', data: { [META_KEY]: summary } }), null)
  assert.equal(readSlimMetaFromEvent({ seq: 1, type: 'compaction/prune', data: { shadowedSeqs: [] } }), null)
  assert.equal(readSlimMetaFromEvent(null), null)
})

test('hasSlimMeta detects both the prune field and a tool-result meta marker', () => {
  assert.equal(hasSlimMeta({ [META_KEY]: { v: 1 } }), true)
  assert.equal(hasSlimMeta({ meta: { [META_KEY]: { v: 1 } } }), true)
  assert.equal(hasSlimMeta({ meta: { other: true } }), false)
  assert.equal(hasSlimMeta(undefined), false)
})

test('textChars counts code points, contentTextChars only text blocks', () => {
  assert.equal(textChars('a😀b'), 3)
  assert.equal(textChars(''), 0)
  assert.equal(contentTextChars([{ type: 'text', text: 'ab' }, { type: 'image', data: 'x' }, { type: 'text', text: '😀' }]), 3)
})

test('summarizeItems and summarizeMeta are pure and tool-text-free', () => {
  const items = [
    { charsBefore: 100, charsAfter: 40 },
    { charsBefore: 300, charsAfter: 200 },
  ]
  assert.deepEqual(summarizeItems(items), { items: 2, charsBefore: 400, charsAfter: 240, charsSaved: 160 })
  const summary = buildSummaryMeta(validSummary())
  const line = summarizeMeta(summary)
  assert.match(line, /^applied: 2 items, saved 1152 chars \(batch batch-1\)$/)
  assert.equal(BATCH_STATUSES.length, 4)
})
