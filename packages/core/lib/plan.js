/**
 * Strict validation and normalization of one `slim_tool_results` plan.
 *
 * The plan is the ONLY model-authored input of a slim run, so it is validated
 * completely before any surface event is appended: a single invalid item
 * rejects the whole plan (atomicity, docs/architecture.md §3.3). Schema source:
 * docs/research/prompt-adaptation.md §1/§6 and docs/research/prompt-regression.md
 * §3 (negative cases 1–5).
 *
 * This module is pure: no dsh runtime imports, no I/O, no mutation of inputs.
 *
 * @module @ds-hu/dsh-context-slimmer-core/plan
 */

import { textChars } from './events.js'
import { ELIDED_PREFIX, foldAndTruncate, foldSingleLine } from './templates.js'

/** Maximum items accepted in one plan (matches the tool schema/`maxTargets`). */
export const MAX_PLAN_ITEMS = 12

/** Target replacement size as a fraction of the original text. */
export const MAX_TRIM_RATIO = 0.5

/** Absolute cap of a trim replacement, in tokens (DEV-3, 4 chars/token convention). */
export const MAX_TRIM_TOKENS = 300

/** Project-wide character-per-token convention (same as dsh-token-meter's heuristic). */
export const CHARS_PER_TOKEN = 4

/** Defensive absolute character cap of a trim replacement; the 300-token cap bites first. */
export const MAX_TRIM_CHARS = 8000

/**
 * Estimate tokens for one replacement text with the project's fixed heuristic
 * (4 characters per token, rounded up). The plan validator deliberately does
 * not depend on the live token-meter service so it stays a pure function; the
 * bound is a conservative approximation, not billing-grade accounting.
 *
 * @param {string | number} textOrChars Text, or an already measured code-point count.
 * @returns {number} Estimated token count.
 */
export function estimateTokens(textOrChars) {
  const chars = typeof textOrChars === 'number' ? textOrChars : textChars(textOrChars)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Tool parameter names accepted at the plan root. */
export const PLAN_KEYS = Object.freeze(['summary', 'items'])

/** Item parameter names accepted inside one plan item. */
export const ITEM_KEYS = Object.freeze(['index', 'op', 'text', 'reason'])

/** Summary used when the model returns an empty one. */
export const DEFAULT_SUMMARY = '本次无改动'

/** Occupations the plan validator may report, for host logging/tests. */
export const PLAN_ERROR_CODES = Object.freeze([
  'plan-not-object',
  'plan-unknown-key',
  'plan-missing-summary',
  'plan-too-many-items',
  'plan-missing-items',
  'items-not-array',
  'item-not-object',
  'item-unknown-key',
  'item-bad-index',
  'item-duplicate-index',
  'item-index-out-of-range',
  'item-bad-op',
  'item-missing-text',
  'item-drop-with-text',
  'item-bad-reason',
  'item-text-prefix',
  'item-text-too-long',
  'item-text-fabricated',
])

/**
 * One rejected plan. The host catches this from the tool body and returns an
 * `isError` tool result; no surface event is appended.
 */
export class PlanValidationError extends Error {
  /**
   * @param {string} code Stable machine-readable failure code.
   * @param {string} message Model-readable diagnostic.
   */
  constructor(code, message) {
    super(message)
    this.name = 'PlanValidationError'
    this.code = code
  }
}

/**
 * Collect URL and `file:line` tokens that a trim replacement claims.
 *
 * The host cannot check semantics, but it can reject a replacement that names a
 * URL or a line number absent from the original text (conservative fabrication
 * guard, adaptation spec §8.3). Both classes are high-risk: a plausible but
 * wrong URL/line silently poisons later reasoning.
 *
 * Plain paths are deliberately NOT exact-matched, and the old `path=`/`file=`
 * label rule is gone (R6, CI e2e root cause): `path=/abs/file` is how the model
 * ANNOTATES a rewritten path, not a verbatim quote of the original text. The
 * old rule rejected every such legal plan as `item-text-fabricated`, silently
 * turning the whole feature into a no-op. Paths inside a `file:line` citation
 * are still validated through the line rule below.
 *
 * @param {string} text Replacement text.
 * @returns {string[]} Substrings that must appear in the original text.
 */
function claimedEvidenceTokens(text) {
  const tokens = new Set()
  for (const match of text.matchAll(/https?:\/\/[^\s"'`<>）)】]+/gu)) {
    tokens.add(match[0].replace(/[.,;:!?]+$/u, ''))
  }
  for (const match of text.matchAll(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?/gu)) {
    tokens.add(match[0])
  }
  return [...tokens]
}

/**
 * Normalize one plan item and check every per-item constraint.
 *
 * @param {unknown} raw Raw item from the model.
 * @param {number} position Item array position, for diagnostics.
 * @param {readonly object[]} targets Candidate targets of this run, indexed 0..n-1.
 * @returns {object} Normalized item.
 * @throws {PlanValidationError} On any violation.
 */
function normalizePlanItem(raw, position, targets) {
  const subject = `items[${position}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanValidationError('item-not-object', `${subject} must be an object`)
  }
  for (const key of Object.keys(raw)) {
    if (!ITEM_KEYS.includes(key)) {
      throw new PlanValidationError('item-unknown-key', `${subject} carries unsupported field "${key}" (allowed: ${ITEM_KEYS.join(', ')})`)
    }
  }
  const { index, op, text, reason } = raw
  if (!Number.isInteger(index) || index < 0) {
    throw new PlanValidationError('item-bad-index', `${subject}.index must be a non-negative integer`)
  }
  const target = targets[index]
  if (target === undefined) {
    throw new PlanValidationError('item-index-out-of-range', `${subject}.index ${index} is outside the ${targets.length} CANDIDATES of this payload`)
  }
  if (op !== 'drop' && op !== 'trim') {
    throw new PlanValidationError('item-bad-op', `${subject}.op must be "drop" or "trim"`)
  }
  if (op === 'drop' && text !== undefined) {
    throw new PlanValidationError('item-drop-with-text', `${subject} is op=drop and must not carry text (the host writes the stub)`)
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new PlanValidationError('item-bad-reason', `${subject}.reason must be a string`)
  }
  const normalized = {
    index,
    op,
    reason: foldAndTruncate(reason, 40),
  }
  if (op === 'trim') {
    if (typeof text !== 'string' || foldSingleLine(text).length === 0) {
      throw new PlanValidationError('item-missing-text', `${subject} is op=trim and requires a non-empty text`)
    }
    const replacement = foldSingleLine(text)
    if (!replacement.startsWith(ELIDED_PREFIX)) {
      throw new PlanValidationError('item-text-prefix', `${subject}.text must start with "${ELIDED_PREFIX}"`)
    }
    const originalChars = target.chars
    const byRatio = Math.floor(originalChars * MAX_TRIM_RATIO)
    const byTokens = MAX_TRIM_TOKENS * CHARS_PER_TOKEN
    const maxChars = Math.min(byRatio, byTokens, MAX_TRIM_CHARS)
    const chars = textChars(replacement)
    if (chars > maxChars) {
      const tokens = estimateTokens(chars)
      throw new PlanValidationError(
        'item-text-too-long',
        `${subject}.text is ${chars} chars (~${tokens} tokens); the limit for this candidate is ` +
          `min(50% of ${originalChars} = ${byRatio}, ${MAX_TRIM_TOKENS} tokens = ${byTokens} chars) = ${maxChars} chars`,
      )
    }
    for (const token of claimedEvidenceTokens(replacement)) {
      if (!target.text.includes(token)) {
        throw new PlanValidationError(
          'item-text-fabricated',
          `${subject}.text mentions "${token}" which does not occur in the original candidate text`,
        )
      }
    }
    normalized.text = replacement
  }
  return normalized
}

/**
 * Validate and normalize one complete plan against the candidate set.
 *
 * Returns a result object instead of throwing so the caller can either raise a
 * tool error or record a `rejected` plugin record without inspecting caught
 * exception types. The `ok:false` branch always carries a stable `code` and a
 * model-readable `message`; never tool-result text.
 *
 * @param {unknown} raw Parsed tool arguments exactly as the model produced them.
 * @param {readonly object[]} targets Candidate targets (index 0-based, ascending).
 * @param {object} [options] Validation overrides.
 * @param {number} [options.maxItems] Maximum items (default {@link MAX_PLAN_ITEMS}).
 * @returns {{ ok: true, plan: object } | { ok: false, code: string, message: string }} Validation result.
 */
export function validatePlan(raw, targets, options = {}) {
  const maxItems = options.maxItems ?? MAX_PLAN_ITEMS
  if (!Array.isArray(targets) || targets.length === 0) {
    return { ok: false, code: 'no-candidates', message: 'this run has no candidate targets' }
  }
  // The payload index IS the array position: the host builds targets with that
  // exact invariant. A mismatch would silently rewrite the wrong seq.
  if (!targets.every((target, position) => target?.index === position)) {
    return { ok: false, code: 'plan-invalid', message: 'targets do not expose a dense 0-based index mapping' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'plan-not-object', message: 'the plan must be a JSON object' }
  }
  try {
    for (const key of Object.keys(raw)) {
      if (!PLAN_KEYS.includes(key)) {
        throw new PlanValidationError('plan-unknown-key', `the plan carries unsupported field "${key}" (allowed: ${PLAN_KEYS.join(', ')})`)
      }
    }
    if (typeof raw.summary !== 'string') {
      throw new PlanValidationError('plan-missing-summary', 'summary is required and must be a string')
    }
    if (!Array.isArray(raw.items)) {
      throw new PlanValidationError('plan-missing-items', 'items is required and must be an array (empty means nothing to change)')
    }
    if (raw.items.length > maxItems) {
      throw new PlanValidationError('plan-too-many-items', `items must contain at most ${maxItems} entries`)
    }
    const seen = new Set()
    const items = raw.items.map((item, position) => {
      const normalized = normalizePlanItem(item, position, targets)
      if (seen.has(normalized.index)) {
        throw new PlanValidationError('item-duplicate-index', `index ${normalized.index} appears more than once`)
      }
      seen.add(normalized.index)
      return normalized
    })
    const summary = foldAndTruncate(raw.summary, 80) || DEFAULT_SUMMARY
    return {
      ok: true,
      plan: Object.freeze({
        summary,
        items: Object.freeze(items.map((item) => Object.freeze(item))),
      }),
    }
  } catch (error) {
    if (error instanceof PlanValidationError) {
      return { ok: false, code: error.code, message: error.message }
    }
    return { ok: false, code: 'plan-invalid', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Throwing form of {@link validatePlan}, for tool bodies that want an exception
 * to become an `isError` tool result.
 *
 * @param {unknown} raw Raw plan.
 * @param {readonly object[]} targets Candidate targets.
 * @param {object} [options] Validation overrides.
 * @returns {object} Normalized plan.
 * @throws {PlanValidationError} When the plan is refused (atomic rejection).
 */
export function assertValidPlan(raw, targets, options) {
  const result = validatePlan(raw, targets, options)
  if (!result.ok) throw new PlanValidationError(result.code, result.message)
  return result.plan
}

/**
 * Build the `outputSchema` handed to the managed fork activation (R5).
 *
 * The harness validates this against its enforced ObjectJsonSchema subset, which
 * allows only type / oneOf / properties / required / additionalProperties /
 * items / enum / const / description / title / default / examples. Numeric or
 * length keywords (`maxItems`, `minimum`, `maxLength`, ...) are NOT part of the
 * subset, so they are deliberately absent: the authoritative bounds are
 * enforced by {@link validatePlan} with actionable errors.
 *
 * @param {{ description?: string }} [options] Optional extra property descriptions.
 * @returns {object} Deep-frozen output schema for the plan object.
 */
export function buildPlanJsonSchema(options = {}) {
  const itemProperties = {
    index: {
      type: 'integer',
      description:
        '0-based index of the target as shown in the CANDIDATES payload marker "[#N]". Candidate position, not the session event sequence number.',
    },
    op: {
      type: 'string',
      enum: ['drop', 'trim'],
      description: 'drop replaces the whole result with a short host-generated stub; trim replaces it with the complete text you provide.',
    },
    text: {
      type: 'string',
      description:
        'Required for trim. Complete single-line replacement text starting with "[elided by context-slimmer]"; self-describing and re-fetchable; no invented facts; <=300 tokens and <=50% of the original.',
    },
    reason: {
      type: 'string',
      description: 'Optional single line, <=40 chars, shown in the UI detail row.',
    },
  }
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'items'],
    properties: {
      summary: {
        type: 'string',
        description: options.summaryDescription ?? 'One short sentence (Chinese preferred, <=80 chars) describing this slimming pass.',
      },
      items: {
        type: 'array',
        description:
          'Only the candidates that need changing; unlisted candidates are kept unchanged. Empty array means "nothing to change".',
        items: Object.freeze({
          type: 'object',
          additionalProperties: false,
          required: ['index', 'op'],
          properties: Object.freeze(itemProperties),
        }),
      },
    },
  })
}
