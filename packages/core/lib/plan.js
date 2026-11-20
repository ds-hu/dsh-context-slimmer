/**
 * Strict validation and normalization of one slimmer plan.
 *
 * The plan is the ONLY model-authored input of a slim run, so it is validated
 * completely before any surface event is appended: a single invalid item
 * rejects the whole plan (atomicity, docs/architecture.md §3.3).
 *
 * v0.2.0 (docs/plan-v0.2.md §3 + Lead tightening): validation is policy-aware.
 * `conservative` (default) accepts ONLY `drop` items whose evidence is
 * DETERMINISTICALLY verifiable against the candidate set:
 *
 *   - `duplicate`  -> `duplicateOf: <callId>`; the two results are byte-equal
 *     after trimming surrounding whitespace and normalizing newlines; the
 *     referenced result is kept (not dropped in the same plan);
 *   - `superseded` -> `supersededBy: <callId>`; the target is a failed result
 *     (`isError`) and the referenced, later result is a successful result of the
 *     same tool that is kept;
 *   - `empty`      -> the target text matches {@link EMPTY_OUTPUT_PATTERNS}
 *     (blank / `(no output)` / `[no output]` / exit-code-only noise).
 *
 * `trim` is rejected under conservative; `balanced` allows trim up to
 * min(50%, 4000 chars) and relaxed drop evidence; `aggressive` keeps the v0.1
 * lossy rules (trim up to min(50%, 300 tokens, 8000 chars), `irrelevant` drops
 * allowed). The "max 20% dropped chars per batch" line of the plan is a
 * benchmark OBSERVATION metric only, not a validation rule (Lead ruling).
 *
 * This module is pure: no dsh runtime imports, no I/O, no mutation of inputs.
 *
 * @module @ds-hu/dsh-context-slimmer-core/plan
 */

import { textChars } from './events.js'
import { ELIDED_PREFIX, foldAndTruncate, foldSingleLine } from './templates.js'

/** Maximum items accepted in one plan; `maxTargets` caps the payload itself. */
export const MAX_PLAN_ITEMS = 12

/** Target replacement size as a fraction of the original text. */
export const MAX_TRIM_RATIO = 0.5

/** Absolute cap of an aggressive trim replacement, in tokens (DEV-3, 4 chars/token). */
export const MAX_TRIM_TOKENS = 300

/** Project-wide character-per-token convention (same as dsh-token-meter's heuristic). */
export const CHARS_PER_TOKEN = 4

/** Defensive absolute character cap of an aggressive trim replacement. */
export const MAX_TRIM_CHARS = 8000

/** Character cap of a balanced trim replacement (plan §3). */
export const BALANCED_MAX_TRIM_CHARS = 4000

/** Policies accepted by {@link validatePlan} (docs/plan-v0.2.md §3). */
export const POLICIES = Object.freeze(['conservative', 'balanced', 'aggressive'])

/** Default policy: only provably-safe drops. */
export const DEFAULT_POLICY = 'conservative'

/** Evidence categories accepted by the plan schema. */
export const EVIDENCE_KINDS = Object.freeze(['duplicate', 'superseded', 'empty', 'irrelevant', 'redundant-blocks'])

/** Evidence categories a conservative plan may use. */
export const CONSERVATIVE_EVIDENCE_KINDS = Object.freeze(['duplicate', 'superseded', 'empty'])

/** Evidence categories a balanced plan may use for a drop. */
export const BALANCED_DROP_EVIDENCE_KINDS = Object.freeze(['duplicate', 'superseded', 'empty', 'irrelevant'])

/**
 * Text patterns that carry no information and are therefore safely droppable
 * under the `empty` evidence category.
 */
export const EMPTY_OUTPUT_PATTERNS = Object.freeze([
  /^\s*$/u,
  /^\(\s*no output\s*\)$/iu,
  /^\[\s*no output\s*\]$/iu,
  /^\(\s*no result\s*\)$/iu,
  /^\[\s*no result\s*\]$/iu,
  /^\(\s*empty\s*\)$/iu,
  /^\[\s*empty\s*\]$/iu,
  /^exit(?:ed)?(?: with)?(?: code| status)?\s*[:=]?\s*0\.?$/iu,
  /^process exited with code 0$/iu,
  /^command completed(?: successfully)?(?: with no output)?\.?$/iu,
  /^（无输出）$/u,
  /^（退出码\s*0）$/u,
  /^done\.?$/iu,
])

/**
 * Whether one tool-result text carries no information at all.
 *
 * @param {string} text Tool-result text.
 * @returns {boolean} True when the text matches an {@link EMPTY_OUTPUT_PATTERNS} entry.
 */
export function isEmptyOutput(text) {
  if (typeof text !== 'string') return false
  return EMPTY_OUTPUT_PATTERNS.some((pattern) => pattern.test(text))
}

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
export const ITEM_KEYS = Object.freeze(['index', 'op', 'text', 'reason', 'evidence', 'duplicateOf', 'supersededBy'])

/** Evidence object keys. */
export const EVIDENCE_KEYS = Object.freeze(['kind'])

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
  'no-candidates',
  'plan-invalid',
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
  'policy-op-trim',
  'policy-op-drop',
  'item-missing-evidence',
  'item-bad-evidence',
  'item-evidence-kind',
  'item-duplicate-ref',
  'item-not-duplicate',
  'item-superseded-ref',
  'item-not-superseded',
  'item-not-empty',
])

/**
 * One rejected plan. The host catches this and turns it into a silent
 * `rejected` no-op (diagnostics record the stable code).
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
 * guard, adaptation spec §8.3). Paths are deliberately NOT exact-matched: the
 * old `path=`/`file=` label rule was removed in R6 because it rejected legal
 * plans (CI e2e root cause). Paths inside `file:line` citations are still
 * validated through the line rule.
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
 * Limit of a trim replacement for one policy and one original size.
 *
 * @param {string} policy Effective policy.
 * @param {number} originalChars Code-point length of the original result.
 * @returns {number} Maximum replacement characters.
 */
export function trimCharLimit(policy, originalChars) {
  const byRatio = Math.floor(originalChars * MAX_TRIM_RATIO)
  if (policy === 'balanced') return Math.min(byRatio, BALANCED_MAX_TRIM_CHARS)
  return Math.min(byRatio, MAX_TRIM_TOKENS * CHARS_PER_TOKEN, MAX_TRIM_CHARS)
}

/**
 * Normalize tool-result text for the duplicate comparison: trim surrounding
 * whitespace, unify CRLF/CR to LF. The comparison stays byte-exact otherwise.
 *
 * @param {string} text Original tool-result text.
 * @returns {string} Comparable text.
 */
export function normalizeComparableText(text) {
  return typeof text === 'string' ? text.replace(/^\s+|\s+$/gu, '').replace(/\r\n?/gu, '\n') : ''
}

/**
 * Normalize one plan item and check every structural / trim constraint.
 *
 * @param {unknown} raw Raw item from the model.
 * @param {number} position Item array position, for diagnostics.
 * @param {readonly object[]} targets Candidate targets of this run, indexed 0..n-1.
 * @param {string} policy Effective policy.
 * @returns {object} Normalized item.
 * @throws {PlanValidationError} On any violation.
 */
function normalizePlanItem(raw, position, targets, policy) {
  const subject = `items[${position}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanValidationError('item-not-object', `${subject} must be an object`)
  }
  for (const key of Object.keys(raw)) {
    if (!ITEM_KEYS.includes(key)) {
      throw new PlanValidationError('item-unknown-key', `${subject} carries unsupported field "${key}" (allowed: ${ITEM_KEYS.join(', ')})`)
    }
  }
  const { index, op, text, reason, evidence, duplicateOf, supersededBy } = raw
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
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new PlanValidationError('item-bad-reason', `${subject}.reason must be a string`)
  }
  if (evidence !== undefined && evidence !== null) {
    if (typeof evidence !== 'object' || Array.isArray(evidence)) {
      throw new PlanValidationError('item-bad-evidence', `${subject}.evidence must be an object such as {"kind":"duplicate"}`)
    }
    for (const key of Object.keys(evidence)) {
      if (!EVIDENCE_KEYS.includes(key)) {
        throw new PlanValidationError('item-bad-evidence', `${subject}.evidence carries unsupported field "${key}" (allowed: kind)`)
      }
    }
    if (typeof evidence.kind !== 'string' || !EVIDENCE_KINDS.includes(evidence.kind)) {
      throw new PlanValidationError(
        'item-evidence-kind',
        `${subject}.evidence.kind must be one of ${EVIDENCE_KINDS.join(', ')}`,
      )
    }
  }
  if (duplicateOf !== undefined && (typeof duplicateOf !== 'string' || duplicateOf.length === 0)) {
    throw new PlanValidationError('item-duplicate-ref', `${subject}.duplicateOf must be a non-empty callId string`)
  }
  if (supersededBy !== undefined && (typeof supersededBy !== 'string' || supersededBy.length === 0)) {
    throw new PlanValidationError('item-superseded-ref', `${subject}.supersededBy must be a non-empty callId string`)
  }
  const normalized = {
    index,
    op,
    reason: foldAndTruncate(reason, 40),
  }
  if (op === 'drop') {
    if (text !== undefined) {
      throw new PlanValidationError('item-drop-with-text', `${subject} is op=drop and must not carry text (the host writes the stub)`)
    }
    if (policy === 'conservative' || policy === 'balanced') {
      if (evidence === undefined) {
        throw new PlanValidationError(
          'item-missing-evidence',
          `${subject} is op=drop and the ${policy} policy requires evidence {kind, ...} (duplicate/superseded/empty or irrelevant)`,
        )
      }
    }
    if (evidence !== undefined) normalized.evidence = Object.freeze({ kind: evidence.kind })
    if (duplicateOf !== undefined) normalized.duplicateOf = duplicateOf
    if (supersededBy !== undefined) normalized.supersededBy = supersededBy
    return normalized
  }
  // trim
  if (policy === 'conservative') {
    throw new PlanValidationError(
      'policy-op-trim',
      `${subject} is op=trim but the conservative policy only allows verifiable drops; return an empty plan instead of rewriting content`,
    )
  }
  if (evidence !== undefined || duplicateOf !== undefined || supersededBy !== undefined) {
    throw new PlanValidationError('item-bad-evidence', `${subject} is op=trim and must not carry drop evidence`)
  }
  if (typeof text !== 'string' || foldSingleLine(text).length === 0) {
    throw new PlanValidationError('item-missing-text', `${subject} is op=trim and requires a non-empty text`)
  }
  const replacement = foldSingleLine(text)
  if (!replacement.startsWith(ELIDED_PREFIX)) {
    throw new PlanValidationError('item-text-prefix', `${subject}.text must start with "${ELIDED_PREFIX}"`)
  }
  const originalChars = target.chars
  const maxChars = trimCharLimit(policy, originalChars)
  const chars = textChars(replacement)
  if (chars > maxChars) {
    throw new PlanValidationError(
      'item-text-too-long',
      `${subject}.text is ${chars} chars; the ${policy} limit for this candidate is ${maxChars} chars`,
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
  return normalized
}

/**
 * Deterministic verification of the drop evidence of one plan (Lead tightening,
 * issue #2: "provably safe" means checkable, not a self-declared string).
 *
 * @param {readonly object[]} items Normalized items.
 * @param {readonly object[]} targets Candidate targets.
 * @param {string} policy Effective policy.
 * @param {{ minTargetChars?: number }} options Verification options.
 * @throws {PlanValidationError} When one evidence relation does not hold.
 */
function verifyDropEvidence(items, targets, policy, options) {
  const minTargetChars = options.minTargetChars ?? 0
  const droppedIndexes = new Set(items.filter((item) => item.op === 'drop').map((item) => item.index))
  const byCallId = new Map()
  for (const target of targets) {
    if (typeof target.callId === 'string' && target.callId.length > 0) byCallId.set(target.callId, target)
  }
  const allowed = policy === 'conservative'
    ? CONSERVATIVE_EVIDENCE_KINDS
    : policy === 'balanced'
      ? BALANCED_DROP_EVIDENCE_KINDS
      : EVIDENCE_KINDS
  for (const item of items) {
    if (item.op !== 'drop') continue
    const subject = `items[${items.indexOf(item)}]`
    const evidence = item.evidence
    if (evidence === undefined) {
      if (policy === 'aggressive') continue
      throw new PlanValidationError('item-missing-evidence', `${subject} is op=drop and requires evidence`)
    }
    if (!allowed.includes(evidence.kind)) {
      throw new PlanValidationError(
        'item-evidence-kind',
        `${subject}.evidence.kind "${evidence.kind}" is not allowed under the ${policy} policy (allowed: ${allowed.join(', ')})`,
      )
    }
    const target = targets[item.index]
    if (evidence.kind === 'duplicate') {
      if (typeof item.duplicateOf !== 'string') {
        throw new PlanValidationError(
          'item-missing-evidence',
          `${subject} has evidence.kind="duplicate" and must name duplicateOf: <callId of the kept duplicate>`,
        )
      }
      const other = byCallId.get(item.duplicateOf)
      if (other === undefined) {
        throw new PlanValidationError('item-duplicate-ref', `${subject}.duplicateOf "${item.duplicateOf}" is not one of this payload's candidates`)
      }
      if (droppedIndexes.has(other.index)) {
        throw new PlanValidationError('item-duplicate-ref', `${subject}.duplicateOf "${item.duplicateOf}" is itself dropped by this plan; keep exactly one copy`)
      }
      if (other.toolName !== target.toolName) {
        throw new PlanValidationError('item-not-duplicate', `${subject} and duplicateOf "${item.duplicateOf}" are results of different tools`)
      }
      if (normalizeComparableText(other.text) !== normalizeComparableText(target.text)) {
        throw new PlanValidationError('item-not-duplicate', `${subject} is not byte-equal to duplicateOf "${item.duplicateOf}" (after trims/newline normalization)`)
      }
      if (minTargetChars > 0 && (target.chars < minTargetChars || other.chars < minTargetChars)) {
        throw new PlanValidationError('item-duplicate-ref', `${subject} duplicate pair is below minTargetChars (${minTargetChars}); not worth a rewrite`)
      }
      continue
    }
    if (evidence.kind === 'superseded') {
      if (typeof item.supersededBy !== 'string') {
        throw new PlanValidationError(
          'item-missing-evidence',
          `${subject} has evidence.kind="superseded" and must name supersededBy: <callId of the later successful result>`,
        )
      }
      if (target.isError !== true) {
        throw new PlanValidationError('item-not-superseded', `${subject} has evidence.kind="superseded" but the target is not a failed result`)
      }
      const other = byCallId.get(item.supersededBy)
      if (other === undefined) {
        throw new PlanValidationError('item-superseded-ref', `${subject}.supersededBy "${item.supersededBy}" is not one of this payload's candidates`)
      }
      if (droppedIndexes.has(other.index)) {
        throw new PlanValidationError('item-superseded-ref', `${subject}.supersededBy "${item.supersededBy}" is itself dropped by this plan`)
      }
      if (other.toolName !== target.toolName) {
        throw new PlanValidationError('item-not-superseded', `${subject} and supersededBy "${item.supersededBy}" are results of different tools`)
      }
      if (other.isError === true) {
        throw new PlanValidationError('item-not-superseded', `${subject}.supersededBy "${item.supersededBy}" is itself a failed result, not a success`)
      }
      if (!(other.seq > target.seq)) {
        throw new PlanValidationError('item-not-superseded', `${subject}.supersededBy "${item.supersededBy}" is not later than the target result`)
      }
      continue
    }
    if (evidence.kind === 'empty') {
      if (!isEmptyOutput(target.text)) {
        throw new PlanValidationError('item-not-empty', `${subject} claims evidence.kind="empty" but the target text is not a recognized information-free output`)
      }
    }
  }
}

/**
 * Validate and normalize one complete plan against the candidate set.
 *
 * Returns a result object instead of throwing so the caller can either record a
 * `rejected` run without inspecting caught exception types. The `ok:false`
 * branch always carries a stable `code` and a model-readable `message`; never
 * tool-result text.
 *
 * @param {unknown} raw Parsed plan exactly as the model produced it.
 * @param {readonly object[]} targets Candidate targets (index 0-based, ascending).
 * @param {object} [options] Validation overrides.
 * @param {number} [options.maxItems] Maximum items (default {@link MAX_PLAN_ITEMS}).
 * @param {string} [options.policy] Effective policy (default {@link DEFAULT_POLICY}).
 * @param {number} [options.minTargetChars] Minimum target size for duplicate evidence.
 * @returns {{ ok: true, plan: object } | { ok: false, code: string, message: string }} Validation result.
 */
export function validatePlan(raw, targets, options = {}) {
  const maxItems = options.maxItems ?? MAX_PLAN_ITEMS
  const policy = options.policy ?? DEFAULT_POLICY
  if (!POLICIES.includes(policy)) {
    return { ok: false, code: 'plan-invalid', message: `unknown policy "${String(policy)}" (allowed: ${POLICIES.join(', ')})` }
  }
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
      const normalized = normalizePlanItem(item, position, targets, policy)
      if (seen.has(normalized.index)) {
        throw new PlanValidationError('item-duplicate-index', `index ${normalized.index} appears more than once`)
      }
      seen.add(normalized.index)
      return normalized
    })
    verifyDropEvidence(items, targets, policy, options)
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
 * Throwing form of {@link validatePlan}.
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
 * Build the enforced JSON schema of a plan.
 *
 * Kept for offline schema tests and for compatibility with harness versions that
 * still expose structured output. v0.2.0 no longer requests an outputSchema: the
 * planner is a plain JSON text call, and {@link validatePlan} is the
 * authoritative gate. Only the keyword subset supported by the harness schema
 * validator is used.
 *
 * @param {{ description?: string }} [options] Optional summary description override.
 * @returns {object} Deep-frozen plan schema.
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
      description: 'drop replaces the whole result with a short host-generated stub; trim replaces it with the complete text you provide (balanced/aggressive only).',
    },
    text: {
      type: 'string',
      description:
        'Required for trim. Complete single-line replacement text starting with "[elided by context-slimmer]"; self-describing and re-fetchable; no invented facts.',
    },
    reason: {
      type: 'string',
      description: 'Optional single line, <=40 chars, shown in the UI detail row.',
    },
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      description: 'Verifiable reason for a drop (required by conservative/balanced).',
      properties: {
        kind: {
          type: 'string',
          enum: [...EVIDENCE_KINDS],
          description: 'duplicate = byte-equal copy of a kept result; superseded = failed attempt covered by a later success; empty = information-free output; irrelevant/redundant-blocks = lossy policies only.',
        },
      },
    },
    duplicateOf: {
      type: 'string',
      description: 'Required when evidence.kind="duplicate": callId of the kept, byte-equal result.',
    },
    supersededBy: {
      type: 'string',
      description: 'Required when evidence.kind="superseded": callId of the later successful result of the same tool.',
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
