import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CHARS_PER_TOKEN,
  MAX_PLAN_ITEMS,
  MAX_TRIM_TOKENS,
  buildPlanJsonSchema,
  estimateTokens,
  validatePlan,
} from '../lib/plan.js'

const prefix = '[elided by context-slimmer]'

function targets(sizes = [2000, 4000, 8000]) {
  return sizes.map((chars, index) => ({
    index,
    seq: 10 + index,
    callId: `call-${index}`,
    toolName: 'bash',
    chars,
    text: `original text ${index} ${'x'.repeat(Math.min(chars, 100))}`,
  }))
}

test('accepts a drop-only plan, a trim plan and an empty no-op plan', () => {
  const drop = validatePlan({ summary: '清理', items: [{ index: 0, op: 'drop', reason: '无关' }] }, targets())
  assert.equal(drop.ok, true)
  assert.equal(drop.plan.items[0].op, 'drop')
  assert.equal(drop.plan.summary, '清理')

  const trim = validatePlan({ summary: '收窄', items: [{ index: 2, op: 'trim', text: `${prefix} bash; original 8000 chars; re-run`, reason: 'bulk' }] }, targets())
  assert.equal(trim.ok, true)
  assert.equal(trim.plan.items[0].index, 2)

  const empty = validatePlan({ summary: '本次无改动', items: [] }, targets())
  assert.equal(empty.ok, true)
  assert.equal(empty.plan.items.length, 0)
})

test('rejects out-of-range, duplicate and non-dense candidate indexes', () => {
  const outOfRange = validatePlan({ summary: 's', items: [{ index: 9, op: 'drop' }] }, targets())
  assert.equal(outOfRange.ok, false)
  assert.equal(outOfRange.code, 'item-index-out-of-range')

  const duplicate = validatePlan({ summary: 's', items: [{ index: 1, op: 'drop' }, { index: 1, op: 'drop' }] }, targets())
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.code, 'item-duplicate-index')

  const sparse = [{ index: 1, seq: 3, callId: 'c', toolName: 'bash', chars: 1000, text: 'x' }]
  const nonDense = validatePlan({ summary: 's', items: [] }, sparse)
  assert.equal(nonDense.ok, false)
  assert.equal(nonDense.code, 'plan-invalid')
})

test('rejects unknown keys, missing/duplicate text and malformed items atomically', () => {
  const unknownPlanKey = validatePlan({ summary: 's', items: [], extra: true }, targets())
  assert.equal(unknownPlanKey.code, 'plan-unknown-key')

  const unknownItemKey = validatePlan({ summary: 's', items: [{ index: 0, op: 'drop', stub: 'x' }] }, targets())
  assert.equal(unknownItemKey.code, 'item-unknown-key')

  const missingText = validatePlan({ summary: 's', items: [{ index: 0, op: 'trim' }] }, targets())
  assert.equal(missingText.code, 'item-missing-text')

  const dropWithText = validatePlan({ summary: 's', items: [{ index: 0, op: 'drop', text: 'x' }] }, targets())
  assert.equal(dropWithText.code, 'item-drop-with-text')

  const noPrefix = validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: 'short summary' }] }, targets())
  assert.equal(noPrefix.code, 'item-text-prefix')

  const badIndex = validatePlan({ summary: 's', items: [{ index: 1.5, op: 'drop' }] }, targets())
  assert.equal(badIndex.ok, false)
})

test('DEV-3: trim text must be <= min(50% of original, 300 tokens)', () => {
  // 50% ratio bites on a small candidate: 1000 chars -> 500 max.
  const small = [{ index: 0, seq: 1, callId: 'c', toolName: 'bash', chars: 1000, text: 'x' }]
  const atLimit = `${prefix}${'a'.repeat(500 - prefix.length)}`
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: atLimit }] }, small).ok, true)
  const overLimit = `${prefix}${'a'.repeat(501 - prefix.length)}`
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: overLimit }] }, small).code, 'item-text-too-long')

  // Token cap bites on a large candidate: 300 tokens = 1200 chars.
  const large = [{ index: 0, seq: 1, callId: 'c', toolName: 'bash', chars: 100000, text: 'x' }]
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix}${'a'.repeat(MAX_TRIM_TOKENS * CHARS_PER_TOKEN - prefix.length)}` }] }, large).ok, true)
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix}${'a'.repeat(MAX_TRIM_TOKENS * CHARS_PER_TOKEN - prefix.length + 1)}` }] }, large).code, 'item-text-too-long')

  assert.equal(estimateTokens(1200), 300)
  assert.equal(estimateTokens(1201), 301)
})

test('rejects fabricated URL and file:line evidence, but allows rewritten path labels', () => {
  const candidate = [{ index: 0, seq: 1, callId: 'c', toolName: 'read_file', chars: 5000, text: 'opened /src/app.js:42 successfully' }]
  const fabricatedLine = { summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix} read /src/other.js:99` }] }
  assert.equal(validatePlan(fabricatedLine, candidate).code, 'item-text-fabricated')
  const realLine = { summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix} read /src/app.js:42` }] }
  assert.equal(validatePlan(realLine, candidate).ok, true)

  const fabricatedUrl = { summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix} see https://example.invalid/nope` }] }
  assert.equal(validatePlan(fabricatedUrl, candidate).code, 'item-text-fabricated')
  const realUrl = { summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix} see https://example.com/real` }] }
  const urlCandidate = [{ index: 0, seq: 1, callId: 'c', toolName: 'web_search', chars: 5000, text: 'result https://example.com/real is relevant' }]
  assert.equal(validatePlan(realUrl, urlCandidate).ok, true)

  // Regression (CI e2e): `path=` is a rewrite annotation, not a verbatim quote.
  // A plan that labels the rewritten path must not be rejected as fabricated.
  const pathCandidate = [{ index: 0, seq: 1, callId: 'c', toolName: 'read_file', chars: 5000, text: 'file contents without any absolute path annotation' }]
  const pathLabelled = {
    summary: 's',
    items: [{ index: 0, op: 'trim', text: `${prefix} read result, path=/abs/fixture-large.txt, original 5000 chars, re-run read_file to restore`, reason: 'bulk' }],
  }
  const labelled = validatePlan(pathLabelled, pathCandidate)
  assert.equal(labelled.ok, true, labelled.ok ? '' : labelled.message)
  const pathWithLine = {
    summary: 's',
    items: [{ index: 0, op: 'trim', text: `${prefix} read /abs/fixture-large.txt:12`, reason: 'bulk' }],
  }
  // A path WITH a line number is still the high-risk file:line class.
  assert.equal(validatePlan(pathWithLine, pathCandidate).code, 'item-text-fabricated')
})

test('maxItems follows the configured maxTargets, summary is folded and truncated', () => {
  const many = targets([2000, 2000, 2000])
  const items = [0, 1, 2].map((index) => ({ index, op: 'drop' }))
  assert.equal(validatePlan({ summary: 's', items }, many, { maxItems: 3 }).ok, true)
  assert.equal(validatePlan({ summary: 's', items }, many, { maxItems: 2 }).code, 'plan-too-many-items')

  const folded = validatePlan({ summary: `line one\nline two ${'z'.repeat(200)}`, items: [] }, many)
  assert.equal(folded.plan.summary.includes('\n'), false)
  assert.ok(folded.plan.summary.length <= 80)
})

test('buildPlanJsonSchema stays inside the enforced output-schema subset', () => {
  const schema = buildPlanJsonSchema()
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['summary', 'items'])
  assert.deepEqual(Object.keys(schema.properties).sort(), ['items', 'summary'])
  const item = schema.properties.items.items
  assert.deepEqual(item.required, ['index', 'op'])
  assert.deepEqual(item.properties.op.enum, ['drop', 'trim'])
  const serialized = JSON.stringify(schema)
  for (const forbidden of ['maxItems', 'minItems', 'minimum', 'maximum', 'maxLength', 'minLength']) {
    assert.equal(serialized.includes(forbidden), false, `schema must not contain ${forbidden}`)
  }
  assert.ok(Object.isFrozen(schema))
  assert.equal(MAX_PLAN_ITEMS, 12)
})
