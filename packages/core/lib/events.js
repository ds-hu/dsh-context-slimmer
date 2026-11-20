/**
 * Batch-metadata protocol of the dsh-context-slimmer bundle.
 *
 * Why not `tool/result.data.meta`? The Session log validates every surface
 * replacement with `assertToolResultRewrite`, which requires the replacement's
 * entire event data to equal the original except `message.content` — a changed
 * `meta` is rejected at append time ("tool/result surface replacement may change
 * only content"). The UI data channel therefore rides on the log-only event the
 * host must append before each replacement anyway:
 *
 *   session.append('compaction/prune', {
 *     shadowedRange: { start, end }, shadowedSeqs: [seq], shadowedTokenCount,
 *     contextSlimmer: { v: 1, batchId, role: 'item' | 'summary', ... },
 *   })
 *
 * `contextSlimmer` is an additive JSON field on a KNOWN, log-only event type:
 * the core session accepts it, snapshot/restore keep it, and native consumers
 * (token meter, compaction rows) read only the three documented fields. The
 * client half renders one chat row per batch from the last `role: 'summary'`
 * prune event. If a future harness rejects the extra field, the host degrades to
 * a plain prune + replacement (no row) instead of failing the run.
 *
 * This module is pure: no dsh runtime imports, no I/O, deep-frozen outputs.
 *
 * @module @ds-hu/dsh-context-slimmer-core/events
 */

import { deepFreeze, isPlainObject } from './freeze.js'

/** Namespace key of the batch payload inside `compaction/prune` event data. */
export const META_KEY = 'contextSlimmer'

/** Schema version of the batch payload; bump on incompatible change. */
export const META_VERSION = 1

/** A per-replacement marker (one tool result rewritten). */
export const ROLE_ITEM = 'item'

/** The last replacement of a batch: carries the full batch summary. */
export const ROLE_SUMMARY = 'summary'

/** Every role a payload may declare. */
export const META_ROLES = Object.freeze([ROLE_ITEM, ROLE_SUMMARY])

/** An applied batch landed at least one surface replacement. */
export const STATUS_APPLIED = 'applied'
/** The background model finished without asking for a change (memory/log only). */
export const STATUS_NO_OP = 'no-op'
/** The plan was refused by validation, nothing was replaced (memory/log only). */
export const STATUS_REJECTED = 'rejected'
/** Infrastructure failure: timeout, child error, cancelled turn, append error (memory/log only). */
export const STATUS_FAILED = 'failed'

/** Every status a batch may carry. Only `applied` reaches durable batch data. */
export const BATCH_STATUSES = Object.freeze([
  STATUS_APPLIED,
  STATUS_NO_OP,
  STATUS_REJECTED,
  STATUS_FAILED,
])

/** Every per-item operation the slim tool accepts. */
export const ITEM_OPS = Object.freeze(['drop', 'trim'])

/** The only model-facing tool a slim run may call. */
export const SLIM_TOOL_NAME = 'slim_tool_results'

/** Maximum characters of the plan summary (prompt contract). */
export const MAX_SUMMARY_CHARS = 80

/** Maximum characters of one per-item reason (prompt contract). */
export const MAX_REASON_CHARS = 40

/** Maximum characters of `batchId` / `runId`. */
export const MAX_BATCH_ID_CHARS = 64

/** Maximum characters of `error.code` on diagnostic, in-memory batches. */
export const MAX_ERROR_CODE_CHARS = 64

/** Maximum characters of `error.message`; never contains tool-result text. */
export const MAX_ERROR_MESSAGE_CHARS = 200

/**
 * One malformed or unsupported batch payload.
 *
 * The host and the client must survive a record from an older/newer build, so
 * the public readers are total: they map this error to `null` instead of
 * throwing at a replay or render boundary.
 */
export class MetaProtocolError extends Error {
  /**
   * @param {string} code Stable machine-readable failure code.
   * @param {string} message Human-readable diagnostic (never tool-result text).
   */
  constructor(code, message) {
    super(message)
    this.name = 'MetaProtocolError'
    this.code = code
  }
}

/**
 * Whether a value is a non-negative safe integer (no negative zero).
 *
 * @param {unknown} value Candidate number.
 * @returns {boolean} True when the value is a valid JSON count.
 */
export function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

/**
 * Count Unicode code points of a string without splitting surrogate pairs.
 * Character counts in every batch field are code-point counts, matching the
 * official tool-result pruner's measurement.
 *
 * @param {string} text Text to measure.
 * @returns {number} Unicode code-point count.
 */
export function textChars(text) {
  return Array.from(text).length
}

/**
 * Read the character count of a message content block array.
 *
 * @param {readonly object[]} content Message content blocks.
 * @returns {number} Total Unicode code points across text blocks.
 */
export function contentTextChars(content) {
  let chars = 0
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') chars += textChars(block.text)
  }
  return chars
}

/**
 * Validate a non-empty string bounded by `maxChars`.
 *
 * @param {unknown} value Candidate value.
 * @param {number} maxChars Maximum code points.
 * @param {string} code Failure code.
 * @param {string} subject Diagnostic subject.
 * @returns {string} The validated string.
 */
function boundedString(value, maxChars, code, subject) {
  if (typeof value !== 'string' || value.length === 0 || textChars(value) > maxChars) {
    throw new MetaProtocolError(code, `${subject} must be a non-empty string of at most ${maxChars} characters`)
  }
  return value
}

/**
 * Normalize one trigger receipt.
 *
 * @param {unknown} value Raw trigger object.
 * @returns {object} Deep-frozen trigger.
 * @throws {MetaProtocolError} On malformed data.
 */
function normalizeTrigger(value) {
  if (!isPlainObject(value)) throw new MetaProtocolError('bad-trigger', 'trigger must be an object')
  for (const key of ['everyNToolCalls', 'minChars', 'observedCalls', 'observedChars']) {
    if (!isCount(value[key])) {
      throw new MetaProtocolError('bad-trigger', `trigger.${key} must be a non-negative integer`)
    }
  }
  return deepFreeze({
    everyNToolCalls: value.everyNToolCalls,
    minChars: value.minChars,
    observedCalls: value.observedCalls,
    observedChars: value.observedChars,
  })
}

/**
 * Normalize the model receipt of the background slim agent.
 *
 * @param {unknown} value Raw model object.
 * @returns {object} Deep-frozen model receipt.
 * @throws {MetaProtocolError} On malformed data.
 */
function normalizeModel(value) {
  if (!isPlainObject(value)) throw new MetaProtocolError('bad-model', 'model must be an object')
  if (typeof value.provider !== 'string' || value.provider.length === 0) {
    throw new MetaProtocolError('bad-model', 'model.provider must be a non-empty string')
  }
  if (typeof value.model !== 'string' || value.model.length === 0) {
    throw new MetaProtocolError('bad-model', 'model.model must be a non-empty string')
  }
  if (typeof value.inherited !== 'boolean') {
    throw new MetaProtocolError('bad-model', 'model.inherited must be a boolean')
  }
  return deepFreeze({ provider: value.provider, model: value.model, inherited: value.inherited })
}

/**
 * Normalize one landed-item entry of a batch summary.
 *
 * @param {unknown} value Raw item.
 * @param {number} position Array position, for diagnostics.
 * @returns {object} Deep-frozen item.
 * @throws {MetaProtocolError} On malformed data.
 */
function normalizeSummaryItem(value, position) {
  const subject = `items[${position}]`
  if (!isPlainObject(value)) throw new MetaProtocolError('bad-summary-item', `${subject} must be an object`)
  if (!isCount(value.index)) throw new MetaProtocolError('bad-summary-item', `${subject}.index must be a non-negative integer`)
  if (typeof value.callId !== 'string' || value.callId.length === 0) {
    throw new MetaProtocolError('bad-summary-item', `${subject}.callId must be a non-empty string`)
  }
  if (typeof value.toolName !== 'string' || value.toolName.length === 0) {
    throw new MetaProtocolError('bad-summary-item', `${subject}.toolName must be a non-empty string`)
  }
  if (!ITEM_OPS.includes(value.op)) {
    throw new MetaProtocolError('bad-summary-item', `${subject}.op must be one of ${ITEM_OPS.join(', ')}`)
  }
  if (value.reason !== undefined && (typeof value.reason !== 'string' || textChars(value.reason) > MAX_REASON_CHARS)) {
    throw new MetaProtocolError('bad-summary-item', `${subject}.reason must be a string of at most ${MAX_REASON_CHARS} characters`)
  }
  if (!isCount(value.charsBefore) || !isCount(value.charsAfter)) {
    throw new MetaProtocolError('bad-summary-item', `${subject}.charsBefore/charsAfter must be non-negative integers`)
  }
  if (value.charsAfter > value.charsBefore) {
    throw new MetaProtocolError('bad-summary-item', `${subject}.charsAfter must not exceed charsBefore`)
  }
  if (!isCount(value.replacementSeq)) {
    throw new MetaProtocolError('bad-summary-item', `${subject}.replacementSeq must be a non-negative integer`)
  }
  return deepFreeze({
    index: value.index,
    callId: value.callId,
    toolName: value.toolName,
    op: value.op,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    charsBefore: value.charsBefore,
    charsAfter: value.charsAfter,
    replacementSeq: value.replacementSeq,
  })
}

/**
 * Normalize one `role: 'item'` payload (the per-replacement marker).
 *
 * @param {unknown} value Raw payload.
 * @returns {object} Deep-frozen item payload.
 * @throws {MetaProtocolError} On malformed data.
 */
function normalizeItemMeta(value) {
  if (!isPlainObject(value)) throw new MetaProtocolError('meta-not-object', 'batch payload must be an object')
  if (!isCount(value.index)) throw new MetaProtocolError('bad-item-meta', 'index must be a non-negative integer')
  if (!ITEM_OPS.includes(value.op)) {
    throw new MetaProtocolError('bad-item-meta', `op must be one of ${ITEM_OPS.join(', ')}`)
  }
  if (!isCount(value.charsBefore) || !isCount(value.charsAfter)) {
    throw new MetaProtocolError('bad-item-meta', 'charsBefore/charsAfter must be non-negative integers')
  }
  if (value.charsAfter > value.charsBefore) {
    throw new MetaProtocolError('bad-item-meta', 'charsAfter must not exceed charsBefore')
  }
  if (typeof value.toolName !== 'string' || value.toolName.length === 0) {
    throw new MetaProtocolError('bad-item-meta', 'toolName must be a non-empty string')
  }
  if (value.callId !== undefined && (typeof value.callId !== 'string' || value.callId.length === 0)) {
    throw new MetaProtocolError('bad-item-meta', 'callId must be a non-empty string when present')
  }
  if (value.reason !== undefined && (typeof value.reason !== 'string' || textChars(value.reason) > MAX_REASON_CHARS)) {
    throw new MetaProtocolError('bad-item-meta', `reason must be a string of at most ${MAX_REASON_CHARS} characters`)
  }
  return deepFreeze({
    v: META_VERSION,
    batchId: value.batchId,
    role: ROLE_ITEM,
    index: value.index,
    op: value.op,
    charsBefore: value.charsBefore,
    charsAfter: value.charsAfter,
    toolName: value.toolName,
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  })
}

/**
 * Normalize one `role: 'summary'` payload (the last prune event of a batch).
 *
 * @param {unknown} value Raw payload.
 * @returns {object} Deep-frozen summary payload.
 * @throws {MetaProtocolError} On malformed data.
 */
function normalizeSummaryMeta(value) {
  if (!isPlainObject(value)) throw new MetaProtocolError('meta-not-object', 'batch payload must be an object')
  if (!BATCH_STATUSES.includes(value.status)) {
    throw new MetaProtocolError('bad-summary-meta', `status must be one of ${BATCH_STATUSES.join(', ')}`)
  }
  if (!isCount(value.startedAt) || !isCount(value.finishedAt) || value.finishedAt < value.startedAt) {
    throw new MetaProtocolError('bad-summary-meta', 'startedAt/finishedAt must be epoch-millisecond timestamps with finishedAt >= startedAt')
  }
  if (!Array.isArray(value.items)) throw new MetaProtocolError('bad-summary-meta', 'items must be an array')
  if (!isCount(value.totals?.items) || !isCount(value.totals?.charsBefore) || !isCount(value.totals?.charsAfter) || !isCount(value.totals?.charsSaved)) {
    throw new MetaProtocolError('bad-summary-meta', 'totals must expose non-negative integer items/charsBefore/charsAfter/charsSaved')
  }
  const items = value.items.map((item, position) => normalizeSummaryItem(item, position))
  if (items.length !== value.totals.items) {
    throw new MetaProtocolError('bad-summary-meta', 'totals.items must equal items.length')
  }
  if (value.error !== undefined) {
    if (!isPlainObject(value.error)) throw new MetaProtocolError('bad-summary-meta', 'error must be an object when present')
    boundedString(value.error.code, MAX_ERROR_CODE_CHARS, 'bad-summary-meta', 'error.code')
    if (value.error.message !== undefined) {
      boundedString(value.error.message, MAX_ERROR_MESSAGE_CHARS, 'bad-summary-meta', 'error.message')
    }
  }
  return deepFreeze({
    v: META_VERSION,
    batchId: value.batchId,
    role: ROLE_SUMMARY,
    status: value.status,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    trigger: normalizeTrigger(value.trigger),
    model: normalizeModel(value.model),
    items,
    totals: {
      items: value.totals.items,
      charsBefore: value.totals.charsBefore,
      charsAfter: value.totals.charsAfter,
      charsSaved: value.totals.charsSaved,
    },
    ...(value.error === undefined ? {} : { error: deepFreeze({ code: value.error.code, ...(value.error.message === undefined ? {} : { message: value.error.message }) }) }),
  })
}

/**
 * Validate and normalize one batch payload (item or summary).
 *
 * @param {unknown} value Raw payload.
 * @returns {object} Deep-frozen payload.
 * @throws {MetaProtocolError} On malformed or unsupported data.
 */
export function normalizeMeta(value) {
  if (!isPlainObject(value)) throw new MetaProtocolError('meta-not-object', 'batch payload must be an object')
  if (value.v !== META_VERSION) {
    throw new MetaProtocolError('meta-version', `batch payload version ${String(value.v)} is not supported (expected ${META_VERSION})`)
  }
  boundedString(value.batchId, MAX_BATCH_ID_CHARS, 'bad-batch-id', 'batchId')
  if (!META_ROLES.includes(value.role)) {
    throw new MetaProtocolError('bad-role', `role must be one of ${META_ROLES.join(', ')}`)
  }
  return value.role === ROLE_SUMMARY ? normalizeSummaryMeta(value) : normalizeItemMeta(value)
}

/**
 * Build one `role: 'item'` payload for the prune event that precedes a
 * replacement.
 *
 * @param {object} input Item fields.
 * @param {string} input.batchId Stable id of the batch.
 * @param {number} input.index 0-based candidate index.
 * @param {string} input.op `drop` or `trim`.
 * @param {number} input.charsBefore Original character count.
 * @param {number} input.charsAfter Replacement character count.
 * @param {string} input.toolName Tool that produced the result.
 * @param {string} [input.callId] Provider call id (audit only; never prompt-facing).
 * @param {string} [input.reason] One-line reason.
 * @returns {object} Deep-frozen item payload.
 * @throws {MetaProtocolError} On malformed data.
 */
export function buildItemMeta(input) {
  return normalizeMeta({ v: META_VERSION, role: ROLE_ITEM, ...input })
}

/**
 * Build the `role: 'summary'` payload carried by the last prune event of a
 * batch. `totals` is derived from `items` when omitted.
 *
 * @param {object} input Summary fields.
 * @param {string} input.batchId Stable id of the batch.
 * @param {string} input.status One of {@link BATCH_STATUSES}.
 * @param {number} input.startedAt Epoch-ms start of the batch.
 * @param {number} input.finishedAt Epoch-ms end of the batch.
 * @param {object} input.trigger Trigger receipt from the counter.
 * @param {object} input.model Model receipt of the background agent.
 * @param {object[]} input.items Landed item entries (with replacementSeq).
 * @returns {object} Deep-frozen summary payload.
 * @throws {MetaProtocolError} On malformed data.
 */
export function buildSummaryMeta(input) {
  const items = Array.isArray(input.items) ? input.items : []
  let charsBefore = 0
  let charsAfter = 0
  for (const item of items) {
    charsBefore += isCount(item?.charsBefore) ? item.charsBefore : 0
    charsAfter += isCount(item?.charsAfter) ? item.charsAfter : 0
  }
  return normalizeMeta({
    v: META_VERSION,
    role: ROLE_SUMMARY,
    batchId: input.batchId,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    trigger: input.trigger,
    model: input.model,
    items,
    totals: input.totals ?? { items: items.length, charsBefore, charsAfter, charsSaved: charsBefore - charsAfter },
    ...(input.error === undefined ? {} : { error: input.error }),
  })
}

/**
 * Total reader for one batch payload: returns the normalized payload, or
 * `null` when an older/newer build wrote an unsupported shape. Never throws.
 *
 * @param {unknown} value Raw payload (e.g. `event.data[META_KEY]`).
 * @returns {object | null} Deep-frozen payload, or null when unsupported.
 */
export function readSlimMeta(value) {
  try {
    return normalizeMeta(value)
  } catch {
    return null
  }
}

/**
 * Total reader for one `compaction/prune` event: returns the normalized batch
 * payload, or `null` when the event is not a slim prune or is malformed.
 *
 * @param {object} event A session event candidate.
 * @returns {object | null} Deep-frozen payload, or null.
 */
export function readSlimMetaFromEvent(event) {
  if (!isPlainObject(event) || event.type !== 'compaction/prune') return null
  return readSlimMeta(event.data?.[META_KEY])
}

/**
 * Whether one event data payload already carries a slim batch payload. Used as
 * a defensive idempotence check by candidate selection (a replaced node is
 * normally detected by its non-append surfaceOp, but a restored/healed log may
 * surface both signals).
 *
 * @param {unknown} data Raw `tool/result` event data.
 * @returns {boolean} True when the payload carries {@link META_KEY}.
 */
export function hasSlimMeta(data) {
  return isPlainObject(data) && (isPlainObject(data[META_KEY]) || isPlainObject(data.meta?.[META_KEY]))
}

/**
 * Recompute aggregate totals from landed items (pure, no trust in input).
 *
 * @param {readonly object[]} items Landed item entries.
 * @returns {object} Deep-frozen totals.
 */
export function summarizeItems(items) {
  let charsBefore = 0
  let charsAfter = 0
  for (const item of items) {
    charsBefore += item.charsBefore
    charsAfter += item.charsAfter
  }
  return deepFreeze({
    items: items.length,
    charsBefore,
    charsAfter,
    charsSaved: charsBefore - charsAfter,
  })
}

/**
 * One-line, tool-text-free summary used by tests and host debug logs.
 *
 * @param {object} meta Normalized batch payload.
 * @returns {string} Summary such as `applied: 3 items, saved 8123 chars`.
 */
export function summarizeMeta(meta) {
  if (meta.role === ROLE_SUMMARY) {
    return `${meta.status}: ${meta.totals.items} items, saved ${meta.totals.charsSaved} chars (batch ${meta.batchId})`
  }
  return `item #${meta.index} ${meta.op}: ${meta.charsBefore} -> ${meta.charsAfter} chars (batch ${meta.batchId})`
}
