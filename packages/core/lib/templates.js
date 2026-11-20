/**
 * Replacement-text templates and text hygiene shared by the plan validator, the
 * background prompt and the surface-replacement primitive.
 *
 * Source of truth: docs/research/prompt-adaptation.md §6. Every replacement
 * text is single-line and starts with {@link ELIDED_PREFIX}; `drop` stubs are
 * generated here by the host (the model never writes them), `trim` text comes
 * from the model verbatim once validation passed.
 *
 * This module is pure: no dsh runtime imports, no I/O.
 *
 * @module @ds-hu/dsh-context-slimmer-core/templates
 */

/** Mandatory prefix of every replacement text (verbatim, case-sensitive). */
export const ELIDED_PREFIX = '[elided by context-slimmer]'

/** Fallback `reason` in a host-generated drop stub. */
export const DEFAULT_DROP_REASON = 'irrelevant'

/**
 * Replace every run of whitespace (including newlines) with one space, drop
 * control characters, and trim both ends. Replacement texts, `reason` and
 * `summary` are single-line by contract, and they are rendered into a chat row
 * and a plugin record, so folding happens once here.
 *
 * @param {unknown} value Candidate text; non-strings become an empty string.
 * @returns {string} Single-line, whitespace-normalized text.
 */
export function foldSingleLine(value) {
  if (typeof value !== 'string') return ''
  let text = ''
  for (const char of value) {
    const code = char.codePointAt(0)
    if (code === 0x0a || code === 0x0d || code === 0x09) text += ' '
    else if (code !== undefined && (code < 0x20 || code === 0x7f)) text += ' '
    else text += char
  }
  return text.replace(/ {2,}/g, ' ').trim()
}

/**
 * Fold a string to a single line and truncate it to `maxChars` code points.
 *
 * @param {unknown} value Candidate text.
 * @param {number} maxChars Maximum retained code points.
 * @returns {string} Sanitized text.
 */
export function foldAndTruncate(value, maxChars) {
  const folded = foldSingleLine(value)
  if (maxChars <= 0) return ''
  const points = Array.from(folded)
  return points.length <= maxChars ? folded : points.slice(0, maxChars).join('')
}

/**
 * Build the host-generated `drop` stub, template T1 of the adaptation spec:
 *
 * `[elided by context-slimmer] tool=<toolName> call=<callId>; original=<chars>
 * chars; reason=<reason>; re-fetch: repeat the same call (original content not
 * retained)`
 *
 * The stub is deliberately explicit: the main agent must never mistake it for
 * real tool output (docs/research/context-irrelevance-2026.md §9.7).
 *
 * @param {object} input Stub fields.
 * @param {string} input.toolName Tool that produced the result.
 * @param {string} input.callId Provider call id of the paired call.
 * @param {number} input.chars Original character count.
 * @param {string} [input.reason] One-line reason; defaults to "irrelevant".
 * @returns {string} Single-line drop stub.
 */
export function buildDropText({ toolName, callId, chars, reason }) {
  const label = typeof toolName === 'string' && toolName.length > 0 ? toolName : 'unknown'
  const call = typeof callId === 'string' && callId.length > 0 ? callId : 'unknown'
  const why = foldAndTruncate(reason, 40) || DEFAULT_DROP_REASON
  return (
    `${ELIDED_PREFIX} tool=${label} call=${call}; original=${String(chars)} chars; ` +
    `reason=${why}; re-fetch: repeat the same call (original content not retained)`
  )
}

/** T2 — trim to the matched block (model generates; shown for prompt parity). */
export const TRIM_BLOCK_TEMPLATE =
  '[elided by context-slimmer] path=<path> lines=<start>-<end>; kept: <命中内容摘要，含符号/关键行>; original=<chars> chars; re-fetch: read <path>:<start>-<end>'

/** T3 — trim to a superseded pointer (model generates). */
export const SUPERSEDED_TEMPLATE =
  '[elided by context-slimmer] superseded: old result <index> (turn <t1>) -> newer result <index2> (turn <t2>); latest state is in the newer result; do not rely on this entry'

/** T4 — trim a failure to its evidence line (model generates). */
export const FAILURE_TEMPLATE =
  '[elided by context-slimmer] failure: cmd=<cmd>; exit=<code>; error="<首个精确错误行>"; <关键栈帧/位置>; retried <n>x; do not repeat without changing parameters; original=<chars> chars'

/**
 * The four replacement templates keyed as in the adaptation spec §6.
 * `drop` is the only host-generated one; the strings document the model-side
 * shape and are exported for tests/parity.
 */
export const REPLACEMENT_TEMPLATES = Object.freeze({
  drop: buildDropText,
  trimHint: TRIM_BLOCK_TEMPLATE,
  superseded: SUPERSEDED_TEMPLATE,
  failure: FAILURE_TEMPLATE,
})
