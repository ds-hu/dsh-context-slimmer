import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BALANCED_MAX_TRIM_CHARS,
  CHARS_PER_TOKEN,
  CONSERVATIVE_EVIDENCE_KINDS,
  EMPTY_OUTPUT_PATTERNS,
  MAX_PLAN_ITEMS,
  MAX_TRIM_TOKENS,
  buildPlanJsonSchema,
  estimateTokens,
  isEmptyOutput,
  trimCharLimit,
  validatePlan,
} from '../lib/plan.js'

const prefix = '[elided by context-slimmer]'

/** One candidate target; `text` defaults to a unique body large enough to trim. */
function target(index, overrides = {}) {
  const chars = overrides.chars ?? 2000
  return {
    index,
    seq: overrides.seq ?? 10 + index,
    callId: overrides.callId ?? `call-${index}`,
    toolName: overrides.toolName ?? 'bash',
    isError: overrides.isError === true,
    chars,
    text: overrides.text ?? `original text ${index} ${'x'.repeat(Math.min(chars, 100))}`,
  }
}

function targets(count = 3, overrides = {}) {
  return Array.from({ length: count }, (_, index) => target(index, overrides))
}

test('conservative accepts only verifiable evidence; trim is rejected', () => {
  // Duplicate: index 1 is byte-equal to the kept index 0.
  const duplicateTargets = [
    target(0, { chars: 5000, text: 'same body\nline two' }),
    target(1, { chars: 5000, text: 'same body\nline two' }),
    target(2, { chars: 6000, text: 'different body' }),
  ]
  const duplicate = validatePlan(
    {
      summary: '去重',
      items: [{ index: 1, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-0', reason: '重复' }],
    },
    duplicateTargets,
    { policy: 'conservative', minTargetChars: 4096 },
  )
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.plan.items[0].duplicateOf, 'call-0')

  // Empty: whitespace / (no output) / exit-code-only.
  for (const text of ['   \n  ', '(no output)', '[no output]', 'exit code 0', 'Process exited with code 0']) {
    const empty = validatePlan(
      { summary: '空输出', items: [{ index: 0, op: 'drop', evidence: { kind: 'empty' }, reason: '空' }] },
      [target(0, { text, chars: 4096 })],
      { policy: 'conservative' },
    )
    assert.equal(empty.ok, true, `empty pattern should match: ${JSON.stringify(text)}`)
  }

  // Superseded: failed target (index 0) covered by later successful result (index 1).
  const superseded = validatePlan(
    {
      summary: '覆盖',
      items: [{ index: 0, op: 'drop', evidence: { kind: 'superseded' }, supersededBy: 'call-1', reason: '已被覆盖' }],
    },
    [target(0, { isError: true }), target(1, { seq: 20 })],
    { policy: 'conservative' },
  )
  assert.equal(superseded.ok, true)

  const trim = validatePlan(
    { summary: 't', items: [{ index: 0, op: 'trim', text: `${prefix} kept`, reason: 'bulk' }] },
    targets(),
    { policy: 'conservative' },
  )
  assert.equal(trim.ok, false)
  assert.equal(trim.code, 'policy-op-trim')

  // Missing / non-verifiable evidence is rejected, not trusted.
  const missing = validatePlan({ summary: 's', items: [{ index: 0, op: 'drop' }] }, targets())
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'item-missing-evidence')

  const irrelevant = validatePlan(
    { summary: 's', items: [{ index: 0, op: 'drop', evidence: { kind: 'irrelevant' } }] },
    targets(),
    { policy: 'conservative' },
  )
  assert.equal(irrelevant.ok, false)
  assert.equal(irrelevant.code, 'item-evidence-kind')
})

test('conservative duplicate evidence must be true and kept', () => {
  const pair = [target(0, { chars: 5000, text: 'A\nB' }), target(1, { chars: 5000, text: 'A\nB' })]
  const base = (index, duplicateOf) => ({
    summary: 's',
    items: [{ index, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf }],
  })

  const different = validatePlan(base(1, 'call-0'), [target(0, { chars: 5000, text: 'A\nB' }), target(1, { chars: 5000, text: 'A\nC' })], { policy: 'conservative' })
  assert.equal(different.ok, false)
  assert.equal(different.code, 'item-not-duplicate')

  // Pointing at a result that this same plan also drops is rejected.
  const droppedRef = validatePlan(
    {
      summary: 's',
      items: [
        { index: 0, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-1' },
        { index: 1, op: 'drop', evidence: { kind: 'duplicate' }, duplicateOf: 'call-0' },
      ],
    },
    pair,
    { policy: 'conservative' },
  )
  assert.equal(droppedRef.ok, false)
  assert.equal(droppedRef.code, 'item-duplicate-ref')

  const unknownRef = validatePlan(base(1, 'call-404'), pair, { policy: 'conservative' })
  assert.equal(unknownRef.ok, false)
  assert.equal(unknownRef.code, 'item-duplicate-ref')

  const tooSmall = validatePlan(base(1, 'call-0'), [target(0, { chars: 100, text: 'same' }), target(1, { chars: 100, text: 'same' })], {
    policy: 'conservative',
    minTargetChars: 4096,
  })
  assert.equal(tooSmall.ok, false)
  assert.equal(tooSmall.code, 'item-duplicate-ref')
})

test('conservative superseded evidence is checked for direction/tool/status', () => {
  const superseded = (index, supersededBy) => ({ summary: 's', items: [{ index, op: 'drop', evidence: { kind: 'superseded' }, supersededBy }] })
  assert.equal(validatePlan(superseded(0, 'call-1'), [target(0, { isError: true }), target(1)], { policy: 'conservative' }).ok, true)

  const notFailed = validatePlan(superseded(0, 'call-1'), [target(0), target(1)], { policy: 'conservative' })
  assert.equal(notFailed.ok, false)
  assert.equal(notFailed.code, 'item-not-superseded')

  // The referenced result is earlier, not later.
  const earlier = validatePlan(superseded(1, 'call-0'), [target(0, { isError: true }), target(1, { isError: true })], { policy: 'conservative' })
  assert.equal(earlier.ok, false)
  assert.equal(earlier.code, 'item-not-superseded')

  const failedRef = validatePlan(superseded(0, 'call-1'), [target(0, { isError: true }), target(1, { isError: true, seq: 20 })], { policy: 'conservative' })
  assert.equal(failedRef.ok, false)
  assert.equal(failedRef.code, 'item-not-superseded')

  const otherTool = validatePlan(superseded(0, 'call-1'), [target(0, { isError: true, toolName: 'bash' }), target(1, { toolName: 'read_file' })], { policy: 'conservative' })
  assert.equal(otherTool.ok, false)
  assert.equal(otherTool.code, 'item-not-superseded')

  const unknownRef = validatePlan(superseded(0, 'call-404'), [target(0, { isError: true }), target(1)], { policy: 'conservative' })
  assert.equal(unknownRef.ok, false)
  assert.equal(unknownRef.code, 'item-superseded-ref')
})

test('empty evidence must actually be information-free', () => {
  for (const text of ['important output', 'error: boom', 'line1\nline2']) {
    const result = validatePlan(
      { summary: 's', items: [{ index: 0, op: 'drop', evidence: { kind: 'empty' } }] },
      [target(0, { text, chars: 4096 })],
      { policy: 'conservative' },
    )
    assert.equal(result.ok, false, `must not be "empty": ${JSON.stringify(text)}`)
    assert.equal(result.code, 'item-not-empty')
  }
})

test('balanced allows trim up to min(50%, 4000 chars) and relaxed drop evidence', () => {
  const balanced = (items, candidates = targets()) => validatePlan({ summary: 's', items }, candidates, { policy: 'balanced' })
  const tiny = balanced([{ index: 0, op: 'trim', text: `${prefix} kept`, reason: 'bulk' }])
  assert.equal(tiny.ok, true)
  // 50% of 2000 = 1000 chars max under balanced.
  const tooLong = balanced([{ index: 0, op: 'trim', text: `${prefix}${'y'.repeat(1001)}`, reason: 'bulk' }])
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.code, 'item-text-too-long')
  // Irrelevant is allowed under balanced.
  assert.equal(balanced([{ index: 0, op: 'drop', evidence: { kind: 'irrelevant' } }]).ok, true)
  assert.equal(trimCharLimit('balanced', 100000), BALANCED_MAX_TRIM_CHARS)
  // Trim text still cannot fabricate URLs.
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix} see https://nope.invalid/x`, reason: 'b' }] }, targets(), { policy: 'balanced' }).code, 'item-text-fabricated')
})

test('aggressive keeps the legacy trim caps and drop rules', () => {
  const trim = validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix} kept`, reason: 'b' }] }, targets(), { policy: 'aggressive' })
  assert.equal(trim.ok, true)
  assert.equal(trimCharLimit('aggressive', 100000), MAX_TRIM_TOKENS * CHARS_PER_TOKEN)
  // Drop without evidence is accepted under aggressive.
  const drop = validatePlan({ summary: 's', items: [{ index: 0, op: 'drop', reason: 'noise' }] }, targets(), { policy: 'aggressive' })
  assert.equal(drop.ok, true)
  const tooLong = validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix}${'y'.repeat(1210)}`, reason: 'b' }] }, targets(), { policy: 'aggressive' })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.code, 'item-text-too-long')
})

test('structural rules stay strict and the schema carries the evidence fields', () => {
  const empty = validatePlan({ summary: '本次无改动', items: [] }, targets())
  assert.equal(empty.ok, true)
  assert.equal(empty.plan.items.length, 0)
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'trim', text: `${prefix} x`, extra: 1 }] }, targets()).code, 'item-unknown-key')
  assert.equal(validatePlan({ summary: 's', items: [{ index: 9, op: 'drop' }] }, targets()).code, 'item-index-out-of-range')
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'drop', evidence: { kind: 'bogus' } }] }, targets()).code, 'item-evidence-kind')
  assert.equal(validatePlan({ summary: 's', items: [{ index: 0, op: 'drop', evidence: { kind: 'duplicate' } }] }, targets()).code, 'item-missing-evidence')
  assert.equal(validatePlan({ summary: 's', items: [] }, []).code, 'no-candidates')
  assert.equal(validatePlan({ summary: 's', items: [] }, [], { policy: 'nope' }).code, 'plan-invalid')
  assert.equal(MAX_PLAN_ITEMS >= 12, true)

  const schema = buildPlanJsonSchema()
  assert.equal(schema.properties.items.items.properties.evidence.properties.kind.enum.includes('duplicate'), true)
  assert.equal(schema.properties.items.items.properties.duplicateOf.type, 'string')
  assert.equal(schema.properties.items.items.properties.supersededBy.type, 'string')
  assert.equal('maxItems' in schema.properties.items, false)

  assert.equal(isEmptyOutput('   '), true)
  assert.equal(isEmptyOutput('real output'), false)
  assert.equal(EMPTY_OUTPUT_PATTERNS.length > 0, true)
  assert.equal(CONSERVATIVE_EVIDENCE_KINDS.includes('duplicate'), true)
  assert.equal(estimateTokens(8), 2)
})
