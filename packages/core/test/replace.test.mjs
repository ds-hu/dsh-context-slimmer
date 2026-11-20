import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPlan,
  applyToolResultReplacement,
  buildDuplicateDropItems,
  collectEvidenceResults,
  findDuplicateHints,
  readSurfaceEntries,
  selectTargets,
} from '../lib/replace.js'
import { META_KEY, readSlimMetaFromEvent, STATUS_APPLIED } from '../lib/events.js'
import { createFakeSession } from './helpers/fake-session.mjs'

const trigger = { everyNToolCalls: 8, minChars: 24000, observedCalls: 9, observedChars: 30000 }
const model = { provider: 'test', model: 'test', inherited: true }
const batch = { batchId: 'batch-1', startedAt: 1000, trigger, model }

function entryStats(entries) {
  return entries.map((entry) => ({ type: entry.type, seq: entry.seq }))
}

test('selectTargets pairs calls, skips unpaired/protected/short/replaced results', () => {
  const session = createFakeSession()
  const first = session.appendToolResult('call-1', 'bash', 'a'.repeat(1000))
  session.appendToolResult('call-2', 'read_file', 'b'.repeat(2000))
  const third = session.appendToolResult('call-3', 'bash', 'c'.repeat(3000))
  const entries = readSurfaceEntries(session)
  assert.deepEqual(entryStats(entries), [
    { type: 'assistant/message', seq: 0 },
    { type: 'tool/result', seq: 1 },
    { type: 'assistant/message', seq: 2 },
    { type: 'tool/result', seq: 3 },
    { type: 'assistant/message', seq: 4 },
    { type: 'tool/result', seq: 5 },
  ])
  const all = selectTargets(entries, { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  assert.deepEqual(all.map((target) => [target.index, target.seq, target.toolName]), [
    [0, first.seq, 'bash'],
    [1, 3, 'read_file'],
    [2, third.seq, 'bash'],
  ])
  // Newest-first selection but ascending index for the payload.
  const limited = selectTargets(entries, { maxTargets: 2, protectRecent: 1, minTargetChars: 1 })
  assert.deepEqual(limited.map((target) => target.seq), [1, 3])
  assert.equal(selectTargets(entries, { maxTargets: 12, protectRecent: 0, minTargetChars: 3001 }).length, 0)
  assert.equal(selectTargets(entries, { maxTargets: 12, protectRecent: 0, minTargetChars: 1, excludeToolNames: ['bash'] }).length, 1)

  // A replacement node never becomes a candidate again.
  applyToolResultReplacement({
    session,
    target: all[0],
    content: [{ type: 'text', text: '[elided by context-slimmer] stub' }],
    shadowedTokenCount: 3,
  })
  const after = selectTargets(readSurfaceEntries(session), { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  assert.equal(after.some((target) => target.seq === first.seq), false)
})

test('applyPlan appends prune -> replace pairs with item/summary batch metadata', () => {
  const session = createFakeSession()
  session.appendToolResult('call-1', 'bash', 'a'.repeat(2000))
  session.appendToolResult('call-2', 'read_file', 'b'.repeat(4000))
  const targets = selectTargets(readSurfaceEntries(session), { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  const result = applyPlan({
    session,
    targets,
    plan: {
      summary: '清理',
      items: [
        { index: 0, op: 'drop', reason: '无关' },
        { index: 1, op: 'trim', text: '[elided by context-slimmer] read_file; original 4000 chars; re-run to restore', reason: 'bulk' },
      ],
    },
    estimateTokens: () => 7,
    batch: { ...batch },
  })
  assert.equal(result.totals.items, 2)
  assert.equal(result.totals.charsSaved > 0, true)
  assert.equal(result.metaLanded, true)
  assert.equal(result.degraded, false)

  // Exactly four appended events: prune, replace, prune, replace.
  assert.deepEqual(session.events.slice(4).map((event) => event.type), ['compaction/prune', 'tool/result', 'compaction/prune', 'tool/result'])
  const firstPrune = readSlimMetaFromEvent(session.events[4])
  const lastPrune = readSlimMetaFromEvent(session.events[6])
  assert.equal(firstPrune.role, 'item')
  assert.equal(firstPrune.index, 0)
  assert.equal(firstPrune.op, 'drop')
  assert.equal(firstPrune.batchId, 'batch-1')
  assert.equal(lastPrune.role, 'summary')
  assert.equal(lastPrune.status, STATUS_APPLIED)
  assert.equal(lastPrune.items.length, 2)
  assert.equal(lastPrune.totals.items, 2)
  // Summary carries each landed replacement and the real seq of the last one.
  assert.equal(lastPrune.items[0].replacementSeq, session.events[5].seq)
  assert.equal(lastPrune.items[1].replacementSeq, session.events[7].seq)
  // Prune and replacement are adjacent and the prune keeps the official fields.
  for (const pruneSeq of [4, 6]) {
    assert.equal(session.events[pruneSeq].data.shadowedSeqs.length, 1)
    assert.equal(session.events[pruneSeq + 1].surfaceOp.startSeq, session.events[pruneSeq + 1].sourceEventSeqs[0])
  }
  assert.equal(result.items[1].metaLanded, true)
})

test('applyPlan degrades to plain prune events when the extension is rejected', () => {
  const session = createFakeSession({ rejectPruneExtension: true })
  session.appendToolResult('call-1', 'bash', 'a'.repeat(2000))
  const targets = selectTargets(readSurfaceEntries(session), { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  const result = applyPlan({
    session,
    targets,
    plan: { summary: '清理', items: [{ index: 0, op: 'drop' }] },
    estimateTokens: () => 3,
    batch: { ...batch },
  })
  assert.equal(result.degraded, true)
  assert.equal(result.metaLanded, false)
  const prunes = session.events.filter((event) => event.type === 'compaction/prune')
  assert.equal(prunes.length, 1)
  assert.equal(prunes[0].data[META_KEY], undefined)
  assert.deepEqual(Object.keys(prunes[0].data).sort(), ['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount'])
  assert.equal(session.events.at(-1).type, 'tool/result')
})

test('attachMeta=false skips the extension entirely', () => {
  const session = createFakeSession()
  session.appendToolResult('call-1', 'bash', 'a'.repeat(2000))
  const targets = selectTargets(readSurfaceEntries(session), { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  const result = applyPlan({
    session,
    targets,
    plan: { summary: 's', items: [{ index: 0, op: 'drop' }] },
    estimateTokens: () => 1,
    batch: { ...batch, attachMeta: false },
  })
  assert.equal(result.metaLanded, false)
  assert.equal(session.events.filter((event) => event.type === 'compaction/prune')[0].data[META_KEY], undefined)
})

test('applyPlan pre-flight rejects stale targets before the first append', () => {
  const session = createFakeSession()
  session.appendToolResult('call-1', 'bash', 'a'.repeat(2000))
  const targets = selectTargets(readSurfaceEntries(session), { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  applyToolResultReplacement({ session, target: targets[0], content: [{ type: 'text', text: 'x' }], shadowedTokenCount: 1 })
  const before = session.events.length
  assert.throws(
    () => applyPlan({ session, targets, plan: { summary: 's', items: [{ index: 0, op: 'drop' }] }, estimateTokens: () => 1, batch: { ...batch } }),
    /no longer a current tool result/,
  )
  assert.equal(session.events.length, before)
})

test('replacements must be a byte-for-byte original event except content', () => {
  const session = createFakeSession()
  session.appendToolResult('call-1', 'bash', 'a'.repeat(500))
  const target = selectTargets(readSurfaceEntries(session), { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })[0]
  assert.throws(
    () => applyToolResultReplacement({
      session,
      target: { ...target, event: { ...target.event, data: { ...target.event.data, meta: { sneaky: true } } } },
      content: [{ type: 'text', text: 'x' }],
      shadowedTokenCount: 1,
    }),
    /may change only content/,
  )
  assert.throws(
    () => applyToolResultReplacement({ session, target, content: [{ type: 'text', text: 'a'.repeat(600) }], shadowedTokenCount: 1 }),
    /not smaller/,
  )
})


test('duplicate scan: same tool, byte-equal, size filter, keep later, recent copy allowed', () => {
  const session = createFakeSession()
  session.appendToolResult('call-a', 'read_file', 'large duplicate body')
  session.appendToolResult('call-b', 'read_file', 'large duplicate body')
  session.appendToolResult('call-c', 'bash', 'large duplicate body') // different tool: never paired
  session.appendToolResult('call-d', 'read_file', 'short')
  session.appendToolResult('call-e', 'read_file', 'short') // below minTargetChars: not a duplicate pair
  const entries = readSurfaceEntries(session)
  const targets = selectTargets(entries, { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  const evidence = collectEvidenceResults(entries)
  assert.deepEqual(evidence.map((item) => item.callId), ['call-a', 'call-b', 'call-c', 'call-d', 'call-e'])

  const hints = findDuplicateHints(entries, targets, { minTargetChars: 10 })
  assert.deepEqual([...hints.entries()], [[0, 'call-b']])

  const items = buildDuplicateDropItems(entries, targets, { minTargetChars: 10 })
  assert.equal(items.length, 1)
  assert.equal(items[0].index, 0)
  assert.equal(items[0].evidence.kind, 'duplicate')
  assert.equal(items[0].duplicateOf, 'call-b')
  assert.equal(items[0].reason, '重复读取（宿主判定）')

  // The kept copy may live in the RECENT-protected area: still a valid kept copy.
  const pairSession = createFakeSession()
  pairSession.appendToolResult('call-1', 'read_file', 'pair body')
  pairSession.appendToolResult('call-2', 'bash', 'unrelated tail')
  pairSession.appendToolResult('call-3', 'read_file', 'pair body')
  const pairEntries = readSurfaceEntries(pairSession)
  const pairTargets = selectTargets(pairEntries, { maxTargets: 12, protectRecent: 1, minTargetChars: 4 })
  assert.deepEqual(pairTargets.map((target) => target.callId), ['call-1', 'call-2'])
  const pairHints = findDuplicateHints(pairEntries, pairTargets, { minTargetChars: 4 })
  assert.deepEqual([...pairHints.entries()], [[0, 'call-3']], 'kept copy protected by RECENT is still usable')
  const pairItems = buildDuplicateDropItems(pairEntries, pairTargets, { minTargetChars: 4 })
  assert.equal(pairItems.length, 1)
  assert.equal(pairItems[0].duplicateOf, 'call-3')

  // Both copies being candidates must not produce items dropping both sides.
  const bothSession = createFakeSession()
  bothSession.appendToolResult('call-x', 'read_file', 'twin body')
  bothSession.appendToolResult('call-y', 'read_file', 'twin body')
  const bothEntries = readSurfaceEntries(bothSession)
  const bothTargets = selectTargets(bothEntries, { maxTargets: 12, protectRecent: 0, minTargetChars: 4 })
  const bothItems = buildDuplicateDropItems(bothEntries, bothTargets, { minTargetChars: 4 })
  assert.deepEqual(bothItems.map((item) => item.index), [0])
  assert.equal(bothItems[0].duplicateOf, 'call-y')
})

test('duplicate scan excludes failed results and never drops both sides', () => {
  const session = createFakeSession()
  session.appendToolResult('call-1', 'read_file', 'same body', { isError: true })
  session.appendToolResult('call-2', 'read_file', 'same body')
  const entries = readSurfaceEntries(session)
  const targets = selectTargets(entries, { maxTargets: 12, protectRecent: 0, minTargetChars: 1 })
  assert.deepEqual([...findDuplicateHints(entries, targets, { minTargetChars: 1 }).entries()], [])
  assert.deepEqual(buildDuplicateDropItems(entries, targets, { minTargetChars: 1 }), [])
})
