/**
 * Surface-replacement primitive for tool results.
 *
 * A replacement is appended exactly like the official
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` does it:
 *
 *   1. `session.append('compaction/prune', { shadowedRange, shadowedSeqs,
 *      shadowedTokenCount })` — the log-only shadow price that lets the native
 *      token meter/compaction accounting subtract the replaced node;
 *   2. `session.append('tool/result', { ...originalEvent.data, message },
 *      { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })`
 *      — the replacement node, identical to the original event except
 *      `message.content` (the session log itself rejects any other change).
 *
 * Target selection is here too: it only considers tool results that are paired
 * with an assistant `tool-call` on the current surface, skips the protected
 * recent tail, and never touches this plugin's own tool output.
 *
 * This module is pure: it only calls methods on a borrowed session object and
 * never imports dsh runtime packages. The replacement message is built as a
 * plain JSON object; `Session.append` validates and deep-freezes it exactly as
 * it does for the native pruner (which receives an already-frozen value only
 * because `freezeMessage` happens to be its dependency, not because the log
 * requires one).
 *
 * @module @ds-hu/dsh-context-slimmer-core/replace
 */

import { META_KEY, buildItemMeta, buildSummaryMeta, contentTextChars, hasSlimMeta, textChars } from './events.js'
import { normalizeComparableText } from './plan.js'
import { buildDropText } from './templates.js'

/** Default number of most-recent tool results that are never touched. */
export const DEFAULT_PROTECT_RECENT = 2

/** Default number of targets per run. */
export const DEFAULT_MAX_TARGETS = 12

/**
 * Minimum size of a slimmable result. Replacing a tiny result is pure risk
 * without savings, so candidates below this size stay untouched.
 */
export const DEFAULT_MIN_TARGET_CHARS = 256

/**
 * Project the current surface into the small, serializable entry list target
 * selection needs. Message projection is read through the session's own
 * `deriveEventMessage` (the replacement value must match it exactly).
 *
 * @param {object} session Borrowed Session instance (live or fake).
 * @returns {object[]} Surface entries in model-visible order.
 */
export function readSurfaceEntries(session) {
  const entries = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'assistant/message') {
      const message = session.deriveEventMessage(event)
      if (message === null || !Array.isArray(message.content)) continue
      const calls = []
      for (const block of message.content) {
        if (block?.type === 'tool-call') calls.push({ callId: block.id, name: block.name })
      }
      if (calls.length > 0) entries.push({ seq, type: 'assistant/message', calls })
    } else if (event.type === 'tool/result') {
      const message = session.deriveEventMessage(event)
      if (message === null || !Array.isArray(message.content)) continue
      const content = message.content
      entries.push({
        seq,
        type: 'tool/result',
        event,
        message,
        turn: event.data.turn,
        callId: message.toolCallId,
        isError: message.isError === true,
        chars: contentTextChars(content),
        text: content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n'),
        nonText: content.filter((block) => block?.type !== 'text'),
      })
    }
  }
  return entries
}

/**
 * Pick the tool results a slim run may rewrite.
 *
 * Rules (docs/architecture.md §3.3):
 * - only results paired with an assistant `tool-call` on the current surface;
 * - the `protectRecent` newest results are a hard safety valve;
 * - this plugin's own tool output is always excluded;
 * - results below `minTargetChars` are skipped (no meaningful saving);
 * - at most `maxTargets` newest eligible results are taken, then returned in
 *   model-visible order with a fresh 0-based `index` (the only id the model
 *   sees — never the seq, never the callId).
 *
 * @param {readonly object[]} entries Entries from {@link readSurfaceEntries}.
 * @param {object} [options] Selection options.
 * @param {number} [options.protectRecent] Newest tool results to protect.
 * @param {number} [options.maxTargets] Maximum targets to return.
 * @param {number} [options.minTargetChars] Minimum original size of a target.
 * @param {readonly string[]} [options.excludeToolNames] Tool names to exclude.
 * @returns {object[]} Targets `{ index, seq, callId, toolName, isError, chars, text, nonText, event, message, turn }`.
 */
export function selectTargets(entries, options = {}) {
  const protectRecent = options.protectRecent ?? DEFAULT_PROTECT_RECENT
  const maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS
  const minTargetChars = options.minTargetChars ?? DEFAULT_MIN_TARGET_CHARS
  const excludeToolNames = options.excludeToolNames ?? ['slim_tool_results']
  const callNames = new Map()
  for (const entry of entries) {
    if (entry.type !== 'assistant/message') continue
    for (const call of entry.calls) callNames.set(call.callId, call.name)
  }
  const results = []
  for (const entry of entries) {
    if (entry.type !== 'tool/result') continue
    const toolName = callNames.get(entry.callId)
    // Unpaired results (e.g. a fork seed cut) are never rewritten: the model
    // history must keep every call/result pair intact.
    if (toolName === undefined) continue
    if (excludeToolNames.includes(toolName)) continue
    // Idempotence: never re-slim a node that is already a replacement (ours or
    // the native pruner's) or that carries a slim batch marker. The surface
    // normally hides replaced nodes, but a restored/healed log may still expose
    // the replacement event itself.
    const surfaceOp = entry.event?.surfaceOp
    if (surfaceOp !== undefined && surfaceOp !== 'append') continue
    if (hasSlimMeta(entry.event?.data)) continue
    results.push({ ...entry, toolName })
  }
  if (results.length === 0) return []
  // Candidate scan window (Lead ruling §9.2): look back far enough to see
  // adjacent duplicate/superseded pairs that a narrow window would hide, then
  // filter. protectRecent still protects the newest N results.
  const windowSize = Math.max(protectRecent + maxTargets * 3, 12)
  const windowed = results.slice(-windowSize)
  const protectedSeqs = new Set()
  if (protectRecent > 0) {
    for (const entry of windowed.slice(-protectRecent)) protectedSeqs.add(entry.seq)
  }
  const eligible = windowed.filter((entry) => !protectedSeqs.has(entry.seq) && entry.chars >= minTargetChars)
  if (eligible.length === 0) return []
  const chosen = maxTargets > 0 ? eligible.slice(-maxTargets) : []
  return chosen.map((entry, index) => ({
    index,
    seq: entry.seq,
    callId: entry.callId,
    toolName: entry.toolName,
    isError: entry.isError,
    chars: entry.chars,
    text: entry.text,
    nonText: entry.nonText,
    event: entry.event,
    message: entry.message,
    turn: entry.turn,
  }))
}

/**
 * Tool name per callId from the assistant messages of one surface.
 *
 * @param {readonly object[]} entries Entries from {@link readSurfaceEntries}.
 * @returns {Map<string, string>} callId -> tool name.
 */
function callNamesOf(entries) {
  const callNames = new Map()
  for (const entry of entries) {
    if (entry.type !== 'assistant/message') continue
    for (const call of entry.calls) callNames.set(call.callId, call.name)
  }
  return callNames
}

/**
 * Current-surface tool results shaped as evidence references, including results
 * that are not CANDIDATES (e.g. the RECENT-protected copy of a duplicate pair).
 *
 * @param {readonly object[]} entries Entries from {@link readSurfaceEntries}.
 * @returns {object[]} `{ callId, seq, toolName, isError, chars, text }` records.
 */
export function collectEvidenceResults(entries) {
  const callNames = callNamesOf(entries)
  const results = []
  for (const entry of entries) {
    if (entry.type !== 'tool/result') continue
    const toolName = callNames.get(entry.callId)
    if (typeof entry.callId !== 'string' || entry.callId.length === 0 || toolName === undefined) continue
    results.push({ callId: entry.callId, seq: entry.seq, toolName, isError: entry.isError === true, chars: entry.chars, text: entry.text })
  }
  return results
}

/**
 * Deterministic duplicate groups over one surface: same tool, byte-equal after
 * trim/newline normalization, both sides >= `minTargetChars`, both successful.
 *
 * @param {readonly object[]} entries Entries from {@link readSurfaceEntries}.
 * @param {{ minTargetChars?: number }} [options] Scan options.
 * @returns {Map<string, object[]>} key -> results ascending by seq.
 */
function duplicateGroups(entries, options = {}) {
  const minTargetChars = options.minTargetChars ?? 0
  const groups = new Map()
  for (const result of collectEvidenceResults(entries)) {
    if (result.isError || result.chars < minTargetChars) continue
    const key = `${result.toolName}\u0000${normalizeComparableText(result.text)}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [result])
    else group.push(result)
  }
  for (const [key, group] of groups) {
    if (group.length < 2) groups.delete(key)
    else group.sort((left, right) => left.seq - right.seq)
  }
  return groups
}

/**
 * Host-side duplicate hints for the CANDIDATES payload (Lead ruling §9.5):
 * "provably safe" byte-equality is a program check, so each candidate whose
 * later byte-equal copy exists gets a `duplicateOf` hint the model can copy.
 *
 * @param {readonly object[]} entries Entries from {@link readSurfaceEntries}.
 * @param {readonly object[]} targets Selected targets (dense 0-based index).
 * @param {{ minTargetChars?: number }} [options] Scan options.
 * @returns {Map<number, string>} target index -> callId of the later kept copy.
 */
export function findDuplicateHints(entries, targets, options = {}) {
  const minTargetChars = options.minTargetChars ?? 0
  const groups = duplicateGroups(entries, options)
  const hints = new Map()
  for (const target of targets) {
    if (target.isError || target.chars < minTargetChars) continue
    const group = groups.get(`${target.toolName}\u0000${normalizeComparableText(target.text)}`)
    if (group === undefined) continue
    for (let position = group.length - 1; position >= 0; position -= 1) {
      const kept = group[position]
      if (kept.seq > target.seq && kept.callId !== target.callId) {
        hints.set(target.index, kept.callId)
        break
      }
    }
  }
  return hints
}

/**
 * Conservative host fallback: when the planner returns an EMPTY plan, drop the
 * earlier copies of deterministic duplicate groups. Never drops the kept copy
 * (the latest byte-equal result, even when it lives in RECENT) and never drops
 * both sides of one pair.
 *
 * @param {readonly object[]} entries Entries from {@link readSurfaceEntries}.
 * @param {readonly object[]} targets Selected targets (dense 0-based index).
 * @param {{ minTargetChars?: number }} [options] Scan options.
 * @returns {object[]} Plan items with duplicate evidence, ascending by target index.
 */
export function buildDuplicateDropItems(entries, targets, options = {}) {
  const groups = duplicateGroups(entries, options)
  const targetByCallId = new Map()
  for (const target of targets) {
    if (typeof target.callId === 'string' && target.callId.length > 0) targetByCallId.set(target.callId, target)
  }
  const items = []
  for (const group of groups.values()) {
    const kept = group[group.length - 1]
    for (const earlier of group.slice(0, -1)) {
      const target = targetByCallId.get(earlier.callId)
      if (target === undefined) continue
      items.push({
        index: target.index,
        op: 'drop',
        evidence: { kind: 'duplicate' },
        duplicateOf: kept.callId,
        reason: '重复读取（宿主判定）',
      })
    }
  }
  items.sort((left, right) => left.index - right.index)
  return items
}

/**
 * Build the replacement content for one target: one text block plus every
 * original non-text block (images/files are never invented and never dropped).
 *
 * @param {object} target Target from {@link selectTargets}.
 * @param {'drop' | 'trim'} op Operation.
 * @param {string} [text] Trim replacement; ignored for `drop`.
 * @param {string} [reason] One-line reason for the drop stub.
 * @param {{ kind?: string, duplicateOf?: string, supersededBy?: string }} [evidence] Verifiable drop evidence.
 * @returns {object[]} New content blocks.
 */
export function buildReplacementContent(target, op, text, reason, evidence) {
  const replacement = op === 'drop'
    ? buildDropText({ toolName: target.toolName, callId: target.callId, chars: target.chars, reason, evidence })
    : text
  return [{ type: 'text', text: replacement }, ...target.nonText]
}

/**
 * Whether a target is still a current surface node. Between plan validation and
 * the append, a broadcast/compaction or a retried tool call may have shadowed
 * it; appending a replacement then would fail the session contract, so the host
 * re-checks before each append.
 *
 * @param {object} session Borrowed Session instance.
 * @param {object} target Target from {@link selectTargets}.
 * @returns {boolean} True when the original seq is still a tool/result node.
 */
export function isTargetCurrent(session, target) {
  const surface = session.surface.nodes
  if (!Array.from(surface).includes(target.seq)) return false
  return session.eventAt(target.seq)?.type === 'tool/result'
}

/**
 * Append one tool-result replacement the official way: shadow price first, then
 * the replacement node citing the shadowed seq.
 *
 * The caller must have validated the complete plan and must pass the token
 * estimate of the ORIGINAL message (the host computes it through
 * `ctx.tokenMeter.estimateMessage`, exactly like the native pruner).
 *
 * The optional `batchMeta` rides as an additive field on the official log-only
 * `compaction/prune` event (see `lib/events.js` for why it cannot live on
 * `tool/result.data.meta`). If appending the extended prune is rejected by the
 * running harness, the replacement still lands: the host retries the prune
 * without the extension and reports `metaLanded: false` (UI loses one row, the
 * main agent is unaffected).
 *
 * @param {object} input Replacement inputs.
 * @param {object} input.session Borrowed parent Session instance.
 * @param {object} input.target Target from {@link selectTargets}.
 * @param {object[]} input.content Replacement content blocks.
 * @param {number} input.shadowedTokenCount Estimated token price of the original message.
 * @param {object} [input.batchMeta] Batch payload to attach to the prune event.
 * @returns {{ shadowSeq: number, replacementSeq: number, charsAfter: number, metaLanded: boolean }} Appended seqs and new size.
 */
export function applyToolResultReplacement({ session, target, content, shadowedTokenCount, batchMeta }) {
  const originalChars = target.chars
  const charsAfter = contentTextChars(content)
  if (charsAfter >= originalChars) {
    throw new Error(`replacement for seq ${String(target.seq)} is not smaller (${charsAfter} >= ${originalChars})`)
  }
  if (!Number.isFinite(shadowedTokenCount) || shadowedTokenCount < 0) {
    throw new Error(`shadowedTokenCount for seq ${String(target.seq)} must be a non-negative number`)
  }
  // 1. Official shadow price of the replaced surface node (log-only event).
  const pruneData = {
    shadowedRange: { start: target.seq, end: target.seq },
    shadowedSeqs: [target.seq],
    shadowedTokenCount,
  }
  let prune
  let metaLanded = false
  if (batchMeta !== undefined) {
    try {
      prune = session.append('compaction/prune', { ...pruneData, [META_KEY]: batchMeta })
      metaLanded = true
    } catch {
      // Capability degradation: an old/new harness rejected the additive field.
      // The replacement is what matters; re-append the plain official event.
      prune = session.append('compaction/prune', pruneData)
    }
  } else {
    prune = session.append('compaction/prune', pruneData)
  }
  // 2. Replacement node: full original event data, only message.content changes.
  const message = { ...target.message, content }
  const replacement = session.append(
    'tool/result',
    { ...target.event.data, message },
    {
      surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
      sourceEventSeqs: [target.seq],
    },
  )
  return { shadowSeq: prune.seq, replacementSeq: replacement.seq, charsAfter, metaLanded }
}

/**
 * Apply an already-validated plan to the parent session.
 *
 * Atomicity contract (docs/architecture.md §3.3): the complete plan is checked
 * first — including a fresh "target is still current" check for EVERY target —
 * and only then are the replacements appended one by one. Any append failure
 * aborts the remaining items; already-landed replacements stay durable (same
 * semantics as the official pruner). A batch that never appends its final
 * summary bounce gets no UI row, by design.
 *
 * The first N-1 prune events carry a `role: 'item'` payload; the last carries
 * the `role: 'summary'` payload with the whole batch. The summary includes the
 * final item's `replacementSeq`, which is deterministic: the log is append-only
 * and this run is the only writer, so the replacement right after the last
 * prune has seq `session.seq + 1`.
 *
 * @param {object} input Apply inputs.
 * @param {object} input.session Borrowed parent Session instance.
 * @param {readonly object[]} input.targets Targets of this run (dense 0-based index).
 * @param {{ summary: string, items: readonly object[] }} input.plan Validated plan.
 * @param {(message: object) => number} input.estimateTokens Token estimate of one message.
 * @param {object} input.batch Batch bookkeeping `{ batchId, startedAt, trigger, model, now? }`.
 * @returns {{ items: object[], totals: object, batchId: string, metaLanded: boolean, degraded: boolean }} Landed items and derived totals.
 */
export function applyPlan({ session, targets, plan, estimateTokens, batch }) {
  const { batchId, startedAt, trigger, model } = batch
  const now = typeof batch.now === 'function' ? batch.now : Date.now
  // Full pre-flight before the first append: a stale target must reject the
  // whole batch instead of landing half of it.
  const resolved = plan.items.map((item) => {
    const target = targets[item.index]
    if (target === undefined) {
      throw new Error(`plan item index ${String(item.index)} has no target in this run`)
    }
    if (!isTargetCurrent(session, target)) {
      throw new Error(`target seq ${String(target.seq)} is no longer a current tool result`)
    }
    return {
      item,
      target,
      content: buildReplacementContent(target, item.op, item.text, item.reason, {
        ...(item.evidence === undefined ? {} : { kind: item.evidence.kind }),
        ...(item.duplicateOf === undefined ? {} : { duplicateOf: item.duplicateOf }),
        ...(item.supersededBy === undefined ? {} : { supersededBy: item.supersededBy }),
      }),
    }
  })
  const landed = []
  let metaLanded = false
  let degraded = false
  for (const [position, entry] of resolved.entries()) {
    const { item, target, content } = entry
    const charsAfter = contentTextChars(content)
    const isLast = position === resolved.length - 1
    const attachMeta = batch.attachMeta !== false && batch.degraded !== true
    let batchMeta
    if (!attachMeta) {
      batchMeta = undefined
    } else if (isLast) {
      const predictedReplacementSeq = session.seq + 1
      const summaryItems = [
        ...landed.map((landedItem) => ({
          index: landedItem.index,
          callId: landedItem.callId,
          toolName: landedItem.toolName,
          op: landedItem.op,
          ...(landedItem.reason === undefined ? {} : { reason: landedItem.reason }),
          charsBefore: landedItem.charsBefore,
          charsAfter: landedItem.charsAfter,
          replacementSeq: landedItem.replacementSeq,
        })),
        {
          index: item.index,
          callId: target.callId,
          toolName: target.toolName,
          op: item.op,
          ...(item.reason === undefined || item.reason === '' ? {} : { reason: item.reason }),
          charsBefore: target.chars,
          charsAfter,
          replacementSeq: predictedReplacementSeq,
        },
      ]
      batchMeta = buildSummaryMeta({
        batchId,
        status: 'applied',
        startedAt,
        finishedAt: now(),
        trigger,
        model,
        items: summaryItems,
      })
    } else {
      batchMeta = buildItemMeta({
        batchId,
        index: item.index,
        op: item.op,
        charsBefore: target.chars,
        charsAfter,
        toolName: target.toolName,
        callId: target.callId,
        ...(item.reason === undefined || item.reason === '' ? {} : { reason: item.reason }),
      })
    }
    const { shadowSeq, replacementSeq, charsAfter: landedChars, metaLanded: itemMetaLanded } = applyToolResultReplacement({
      session,
      target,
      content,
      shadowedTokenCount: estimateTokens(target.message),
      batchMeta,
    })
    if (itemMetaLanded) metaLanded = true
    else {
      // The current harness refused the additive prune field: stop trying for
      // the rest of this run (and, through `batch.degraded`, for later runs).
      batch.degraded = true
      degraded = true
    }
    landed.push(
      Object.freeze({
        index: item.index,
        callId: target.callId,
        toolName: target.toolName,
        op: item.op,
        ...(item.reason === undefined || item.reason === '' ? {} : { reason: item.reason }),
        charsBefore: target.chars,
        charsAfter: landedChars,
        replacementSeq,
        shadowSeq,
        metaLanded: itemMetaLanded,
      }),
    )
  }
  let charsBefore = 0
  let charsAfter = 0
  for (const item of landed) {
    charsBefore += item.charsBefore
    charsAfter += item.charsAfter
  }
  return {
    items: landed,
    totals: Object.freeze({
      items: landed.length,
      charsBefore,
      charsAfter,
      charsSaved: charsBefore - charsAfter,
    }),
    batchId,
    metaLanded,
    degraded,
  }
}

/**
 * Character count of a plain text string (re-exported for host convenience).
 *
 * @param {string} text Text to measure.
 * @returns {number} Unicode code-point count.
 */
export { textChars }
