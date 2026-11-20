/**
 * Host half of the tool-result slimmer (Cordis row
 * `context-slimmer-tool-result`).
 *
 * Behaviour per `agent/pre-step` (root AND subagent sessions):
 *   1. read the per-session counter built from the live `session/event` feed;
 *   2. when BOTH threshold conditions are met (v0.2.0 AND trigger), select
 *      target results from the current surface (newest first, protected recent
 *      tail skipped, already-replaced nodes skipped);
 *   3. resolve the planner route (configured route -> latest request header ->
 *      agent options) and call `ctx.llm.stream()` ONCE with the derived
 *      conversation plus a policy-aware planner instruction. No subagent is
 *      started, so the main conversation never shows `subagent/*` events or the
 *      WebUI "N subagents" counter;
 *   4. validate the plan with the core `validatePlan` (authoritative, policy-
 *      aware, deterministic evidence checks) and apply it atomically: for every
 *      target append the official `compaction/prune` shadow price immediately
 *      followed by the replacement `tool/result`, with the batch payload riding
 *      on the prune event;
 *   5. reset the counter in every outcome (applied / no-op / rejected / failed).
 *      Nothing is ever thrown into the main agent loop: a failed run is a
 *      no-op plus a warning log.
 *
 * Dependency policy (Lead ruling R4): this file imports ONLY node builtins and
 * the workspace core package. No `@deepseek-ai/*` import. Session mutation goes
 * through the borrowed `session.append` API with plain JSON; token estimation
 * uses the optional `tokenMeter` service when mounted, with the project-wide
 * `ceil(chars/4)` fallback.
 *
 * Budget: this module only reacts after the awaited `next()` of
 * `agent/pre-step`; the main agent is blocked for the duration of the run
 * (hard timeout `config.timeoutMs`, default 120s).
 *
 * @module @ds-hu/dsh-context-slimmer-tool-result
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { Config, ConfigError, promptLocaleOf, recordModel, resolveConfig, resolveModelTarget } from '@ds-hu/dsh-context-slimmer-core/config'
import { CounterStore, createCounter, noteToolResult, resetCounter, shouldTrigger, triggerSnapshot } from '@ds-hu/dsh-context-slimmer-core/counters'
import { STRUCTURED_OUTPUT_TOOL, buildPlannerInstruction } from '@ds-hu/dsh-context-slimmer-core/prompt'
import { applyPlan, readSurfaceEntries, selectTargets } from '@ds-hu/dsh-context-slimmer-core/replace'
import { validatePlan } from '@ds-hu/dsh-context-slimmer-core/plan'
import { STATUS_APPLIED, STATUS_FAILED, STATUS_NO_OP, STATUS_REJECTED } from '@ds-hu/dsh-context-slimmer-core/events'

/** Cordis row name; must equal the `id` in cordis.patch.yml. */
export const name = 'context-slimmer-tool-result'

/** Required services: tool registry (own-output exclusion) and the LLM service. */
export const inject = ['llm']

/** Re-export the schema so the Loader/native panel can project the form. */
export { Config, ConfigError }

/** Characters per token of the fallback estimate, matching dsh-token-meter. */
const FALLBACK_CHARS_PER_TOKEN = 4

/** Maximum characters of the extracted task description in the payload. */
const MAX_TASK_CHARS = 1600

/** Sentinel resolved by the hard-timeout race (identity compared by `kind`). */
const TIMEOUT_OUTCOME = Object.freeze({ kind: 'timeout' })

/**
 * Estimate the token price of one message without importing dsh packages.
 *
 * @param {object | undefined} tokenMeter Optional `ctx.tokenMeter` service.
 * @param {object} message Message to price.
 * @returns {number} Non-negative token estimate.
 */
export function estimateMessageTokens(tokenMeter, message) {
  if (tokenMeter !== undefined && typeof tokenMeter.estimateMessage === 'function') {
    try {
      const value = tokenMeter.estimateMessage(message)
      if (Number.isFinite(value) && value >= 0) return value
    } catch {
      // fall through to the heuristic
    }
  }
  let chars = 0
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') chars += Array.from(block.text).length
    }
  }
  return Math.ceil(chars / FALLBACK_CHARS_PER_TOKEN)
}

/**
 * Parse a planner answer tolerantly: direct JSON.parse first, then the first
 * Markdown code fence, then the first `{` to the last `}`, then the first
 * balanced object. Used by the host after collecting every text block.
 *
 * @param {string} text Raw assistant text.
 * @returns {object | null} Parsed object, or null.
 */
export function parsePlannerText(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const accept = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null)
  try {
    const direct = accept(JSON.parse(trimmed))
    if (direct !== null) return direct
  } catch {
    // fall through to extraction
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced !== null) {
    try {
      const fencedValue = accept(JSON.parse(fenced[1].trim()))
      if (fencedValue !== null) return fencedValue
    } catch {
      // fall through
    }
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      const sliced = accept(JSON.parse(text.slice(first, last + 1)))
      if (sliced !== null) return sliced
    } catch {
      // fall through
    }
  }
  return parseFirstJsonObject(text)
}

/**
 * Scan a string for the first balanced `{...}` JSON object and parse it.
 *
 * @param {string} text Text to scan.
 * @returns {unknown} Parsed value, or null when no balanced object parses.
 */
function parseFirstJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let position = start; position < text.length; position += 1) {
    const char = text[position]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, position + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Backward-compatible alias of {@link parsePlannerText}.
 *
 * @param {string} text Raw assistant text.
 * @returns {object | null} Parsed object, or null.
 */
export function extractPlanFromText(text) {
  return parsePlannerText(text)
}

/**
 * Extract a plan object from one settled structured shape (compatibility helper
 * for tests and for a model that still emits a structured_output tool call):
 * `structured` object first, then the first JSON object of the text output.
 *
 * @param {{ structured?: unknown, output?: readonly object[] }} result Result-like object.
 * @returns {object | null} Candidate plan, or null.
 */
export function extractPlan(result) {
  if (result === null || typeof result !== 'object') return null
  if (result.structured !== undefined && result.structured !== null) {
    if (typeof result.structured === 'object' && !Array.isArray(result.structured)) return result.structured
    if (typeof result.structured === 'string') return parsePlannerText(result.structured)
  }
  const blocks = Array.isArray(result.output) ? result.output : []
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return extractPlanFromText(text)
}

/**
 * Extract a compact task description from the projected messages of the step.
 *
 * @param {readonly object[] | undefined} messages Projected `PreStepPayload.messages`.
 * @returns {string} Task text (possibly trimmed), or an empty placeholder.
 */
export function extractTask(messages) {
  if (!Array.isArray(messages)) return '（未提供）'
  for (let position = messages.length - 1; position >= 0; position -= 1) {
    const message = messages[position]
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text.length === 0) continue
    return Array.from(text).length > MAX_TASK_CHARS ? `${Array.from(text).slice(0, MAX_TASK_CHARS).join('')}…` : text
  }
  return '（未提供）'
}

/**
 * Build the protected RECENT block for the prompt from the current surface.
 *
 * @param {readonly object[]} entries Surface entries.
 * @param {ReadonlySet<number>} targetSeqs Seqs already used as candidates.
 * @param {number} limit Maximum recent entries to include.
 * @returns {object[]} Recent entries for `renderRecent`.
 */
export function buildRecent(entries, targetSeqs, limit = 4) {
  const callNames = new Map()
  for (const entry of entries) {
    if (entry.type !== 'assistant/message') continue
    for (const call of entry.calls) callNames.set(call.callId, call.name)
  }
  const recent = []
  for (const entry of entries) {
    if (entry.type !== 'tool/result' || targetSeqs.has(entry.seq)) continue
    recent.push({
      index: recent.length,
      tool: callNames.get(entry.callId) ?? 'unknown',
      isError: entry.isError === true,
      chars: entry.chars,
    })
  }
  return recent.slice(-Math.max(limit, 0))
}

/**
 * One running host instance. Created per mounted row; all mutable state is
 * per-instance and dropped on disposal.
 */
export class SlimmerHost {
  /**
   * @param {object} ctx Cordis context of the row.
   * @param {object} config Resolved configuration.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {CounterStore} */
    this.counters = new CounterStore()
    /** Agents with a planner call in flight (never start two for one agent). */
    this.runningAgents = new Set()
    this.disposed = false
    this.disposers = []
    /** Batch payload capability cache (Lead ruling R1 degradation). */
    this.extensionSupported = true
    /** Diagnostics directory created once per host instance. */
    this.diagnosticsDirReady = false
  }

  /** Mount every listener; safe to call once. */
  install() {
    const { ctx } = this
    this.disposers.push(
      ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)),
      ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next)),
    )
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => this.dispose())
    }
    ctx.logger?.info?.(
      `context-slimmer: mounted (policy=${this.config.policy}, everyNToolCalls=${String(this.config.everyNToolCalls)}, minChars=${String(this.config.minChars)}, maxTargets=${String(this.config.maxTargets)}, includeSubagents=${String(this.config.includeSubagents)})`,
    )
  }

  /** Drop every listener and pending run bookkeeping. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // disposers are best-effort during unload
      }
    }
    this.counters.clear()
    this.runningAgents.clear()
  }

  /**
   * Append one sanitized JSONL diagnostics line when `config.diagnosticsFile`
   * is configured (opt-in, default off). Never throws and never stores
   * tool-result text in full: callers pass bounded, derived fields only.
   *
   * @param {string} kind Fixed event kind (trigger/llm/plan/validate/apply/no-op).
   * @param {object} [details] Sanitized details.
   * @param {string} [sessionId] Session the event belongs to.
   */
  diag(kind, details = {}, sessionId) {
    const file = this.config?.diagnosticsFile
    if (typeof file !== 'string' || file.length === 0) return
    try {
      if (this.diagnosticsDirReady !== true) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        this.diagnosticsDirReady = true
      }
      fs.appendFileSync(
        file,
        `${JSON.stringify({ ts: Date.now(), kind, ...(sessionId === undefined ? {} : { sessionId }), ...details })}\n`,
        'utf8',
      )
    } catch {
      // Diagnostics must never disturb the main loop.
    }
  }

  /**
   * Live-observation handler: count new settled results of the observed
   * sessions (root, and subagents when `includeSubagents` is true).
   *
   * @param {object} session Session that emitted the event.
   * @param {object} event Appended session event.
   */
  onSessionEvent(session, event) {
    if (this.disposed || event?.type !== 'tool/result') return
    if (!this.config.includeSubagents && isSubagentSession(session)) return
    // Replacement nodes must not feed the counter, or a finished run would
    // immediately look like fresh growth.
    if (event.surfaceOp !== 'append') return
    const counter = this.counters.get(session.id)
    if (counter === undefined) return
    this.counters.set(
      session.id,
      noteToolResult(counter, {
        seq: event.seq,
        content: event.data?.message?.content ?? [],
        isError: event.data?.message?.isError === true,
      }),
    )
  }

  /**
   * Waterfall around one step: run the slimmer after the native decision,
   * never throwing into the loop.
   *
   * @param {object} payload `agent/pre-step` payload.
   * @param {() => Promise<object>} next Continuation returning the step decision.
   * @returns {Promise<object>} The original step decision.
   */
  async onPreStep(payload, next) {
    const decision = await next()
    if (this.disposed || decision?.kind === 'reject') return decision
    try {
      await this.maybeSlim(payload)
    } catch (error) {
      this.ctx.logger?.warn?.(`context-slimmer: run skipped: ${errorMessage(error)}`)
    }
    return decision
  }

  /**
   * Decide and perform at most one slim run for this step.
   *
   * @param {object} payload `agent/pre-step` payload.
   * @returns {Promise<void>} Resolves when the run (if any) finished.
   */
  async maybeSlim(payload) {
    const agent = payload?.agent
    const session = agent?.session
    if (agent === undefined || session === undefined) return
    if (!this.config.includeSubagents && isSubagentSession(session)) return
    if (this.runningAgents.has(agent.id)) return
    const counter = this.counters.get(session.id)
    if (counter === undefined) {
      // First pre-step after mount: establish a baseline window only.
      this.counters.set(session.id, createCounter({ lastSeq: session.seq ?? -1 }))
      return
    }
    const trigger = shouldTrigger(counter, this.config)
    if (!trigger.triggered) return
    const entries = readSurfaceEntries(session)
    const targets = selectTargets(entries, {
      maxTargets: this.config.maxTargets,
      protectRecent: this.config.protectRecent,
      minTargetChars: this.config.minTargetChars,
      excludeToolNames: [STRUCTURED_OUTPUT_TOOL],
    })
    this.diag(
      'trigger',
      {
        policy: this.config.policy,
        observedCalls: counter.observedCalls,
        observedChars: counter.observedChars,
        observedErrorCalls: counter.observedErrorCalls,
        targets: targets.map((target) => ({
          seq: target.seq,
          tool: target.toolName,
          isError: target.isError === true,
          chars: target.chars,
        })),
      },
      session.id,
    )
    if (targets.length === 0) {
      this.counters.set(session.id, resetCounter(counter))
      return
    }
    const modelTarget = resolveModelTarget(
      this.config,
      session.requestHeader?.()?.config,
      agent.options,
    )
    if (modelTarget === null) {
      this.diag('no-op', { reason: 'no-model' }, session.id)
      this.ctx.logger?.warn?.('context-slimmer: no provider/model available for the planner; skipping this run')
      this.counters.set(session.id, resetCounter(counter))
      return
    }
    const batch = {
      batchId: randomUUID(),
      startedAt: Date.now(),
      trigger: triggerSnapshot(counter, this.config),
      model: recordModel(this.config, modelTarget),
      attachMeta: this.extensionSupported,
    }
    this.runningAgents.add(agent.id)
    let status
    try {
      status = await this.runBatch({
        agent,
        session,
        entries,
        targets,
        batch,
        task: extractTask(payload.messages),
        parentSignal: payload.signal,
        modelTarget,
      })
    } finally {
      this.runningAgents.delete(agent.id)
    }
    this.ctx.logger?.debug?.(
      `context-slimmer: run ${status} (targets=${String(targets.length)}, calls=${String(counter.observedCalls)}, chars=${String(counter.observedChars)})`,
    )
    this.counters.set(session.id, resetCounter(this.counters.get(session.id) ?? counter))
  }

  /**
   * Perform one direct-LLM planner call and apply its plan.
   *
   * @param {object} input Run inputs.
   * @param {object} input.agent Agent of the current step.
   * @param {object} input.session Its session.
   * @param {readonly object[]} input.entries Current surface entries.
   * @param {readonly object[]} input.targets Selected targets.
   * @param {object} input.batch Batch bookkeeping.
   * @param {string} input.task Extracted task description for the payload.
   * @param {AbortSignal} [input.parentSignal] Parent turn signal.
   * @param {{ provider: string, model: string, reasoningEffort?: string, inherited: boolean }} input.modelTarget Resolved route.
   * @returns {Promise<string>} Status constant of the run.
   */
  async runBatch({ agent, session, entries, targets, batch, task, parentSignal, modelTarget }) {
    const targetSeqs = new Set(targets.map((target) => target.seq))
    const instruction = buildPlannerInstruction({
      locale: promptLocaleOf(this.config),
      policy: this.config.policy,
      task,
      constraints: [],
      recent: buildRecent(entries, targetSeqs),
      candidates: targets.map((target) => ({
        index: target.index,
        tool: target.toolName,
        isError: target.isError,
        chars: target.chars,
        callId: target.callId,
        text: target.text,
      })),
    })
    let derivedMessages
    try {
      derivedMessages = session.deriveMessages()
    } catch {
      derivedMessages = []
    }
    const messages = [
      ...derivedMessages,
      { role: 'user', content: [{ type: 'text', text: instruction }] },
    ]
    const maxTokens = this.config.model.maxOutputTokens
    const options = {
      provider: modelTarget.provider,
      model: modelTarget.model,
      messages,
      ...(typeof session.toolHistory === 'function' ? { toolHistory: session.toolHistory() } : {}),
      ...(maxTokens > 0 ? { maxTokens } : {}),
      ...(modelTarget.reasoningEffort === undefined ? {} : { reasoningEffort: modelTarget.reasoningEffort }),
      sessionId: session.id,
    }
    const timeoutMs = this.config.timeoutMs
    const aborter = new AbortController()
    let timeoutTimer
    const timeoutPromise = new Promise((resolve) => {
      timeoutTimer = setTimeout(() => {
        try {
          aborter.abort()
        } catch {
          // already aborted
        }
        resolve(TIMEOUT_OUTCOME)
      }, timeoutMs)
    })
    const signal = parentSignal === undefined || parentSignal === null ? aborter.signal : AbortSignal.any([parentSignal, aborter.signal])
    this.diag(
      'llm-start',
      {
        provider: modelTarget.provider,
        model: modelTarget.model,
        inherited: modelTarget.inherited,
        messageCount: messages.length,
        maxTokens,
      },
      session.id,
    )
    // Output-budget trap (Lead root-cause ruling §8-revised): a configured
    // maxTokens caps reasoning + visible output TOGETHER, so a small explicit
    // budget can be consumed by reasoning before any text/tool call exists.
    // When an explicit cap truncates the answer, retry ONCE without it.
    const maxTokensExplicit = typeof options.maxTokens === 'number' && options.maxTokens > 0
    const startedAt = Date.now()
    let retried = false
    let collected
    try {
      const attempt = (attemptOptions) => Promise.race([
        this.#collectStream(attemptOptions).then(
          (value) => ({ kind: 'ok', value }),
          (error) => ({ kind: 'reject', error }),
        ),
        timeoutPromise,
      ])
      let outcome = await attempt({ ...options, signal })
      if (
        outcome.kind === 'ok' &&
        outcome.value.finish?.kind === 'max-tokens' &&
        maxTokensExplicit
      ) {
        retried = true
        this.diag(
          'llm-truncation-retry',
          {
            finishReason: 'max-tokens',
            maxTokens: options.maxTokens,
            usage: summarizeUsage(outcome.value.usage),
          },
          session.id,
        )
        this.ctx.logger?.debug?.(
          `context-slimmer: planner hit maxTokens=${String(options.maxTokens)} before emitting output; retrying without the cap`,
        )
        const { maxTokens: _droppedBudget, ...retryOptions } = options
        outcome = await attempt({ ...retryOptions, signal })
      }
      if (outcome.kind === TIMEOUT_OUTCOME.kind) {
        this.diag('llm-error', { stage: 'timeout', timeoutMs }, session.id)
        this.ctx.logger?.warn?.(`context-slimmer: planner call timed out after ${timeoutMs}ms`)
        return STATUS_FAILED
      }
      if (outcome.kind === 'reject') {
        this.diag('llm-error', { stage: 'stream', error: bounded(errorMessage(outcome.error), 500) }, session.id)
        this.ctx.logger?.warn?.(`context-slimmer: planner call failed: ${errorMessage(outcome.error)}`)
        return STATUS_FAILED
      }
      collected = outcome.value
    } finally {
      clearTimeout(timeoutTimer)
    }
    const durationMs = Date.now() - startedAt
    const finishKind = collected.finish?.kind ?? 'none'
    const usageSummary = summarizeUsage(collected.usage)
    /** Planner accounting attached to the later plan/apply diagnostics. */
    const plannerInfo = {
      finishReason: finishKind,
      durationMs,
      retried,
      ...(usageSummary === undefined ? {} : { usage: usageSummary }),
    }
    this.diag(
      'llm-result',
      {
        finish: finishKind,
        textLength: Array.from(collected.text).length,
        toolCallCount: collected.toolCalls.length,
        durationMs,
        retried,
        ...(usageSummary === undefined ? {} : { usage: usageSummary }),
      },
      session.id,
    )
    if (finishKind === 'aborted' || finishKind === 'error') {
      this.diag('llm-error', { stage: 'finish', finish: finishKind, retried }, session.id)
      this.ctx.logger?.warn?.(`context-slimmer: planner call stopped with ${finishKind}`)
      return STATUS_FAILED
    }
    if (finishKind === 'max-tokens') {
      // Truncated after the retry (or with no explicit cap): never apply a
      // partial plan.
      this.diag(
        'planner-truncated',
        {
          finishReason: 'max-tokens',
          textLength: Array.from(collected.text).length,
          textHead: bounded(collected.text, 200),
          durationMs,
          retried,
          ...(usageSummary === undefined ? {} : { usage: usageSummary }),
        },
        session.id,
      )
      this.ctx.logger?.warn?.('context-slimmer: planner answer truncated at the token cap; nothing replaced')
      return STATUS_FAILED
    }
    if (finishKind !== 'stop' && finishKind !== 'tool-calls' && finishKind !== 'none') {
      // Unknown/merge-extended finish reasons are treated as failures: never
      // apply a plan from a call we do not understand.
      this.diag('llm-error', { stage: 'finish', finish: finishKind, retried }, session.id)
      this.ctx.logger?.warn?.(`context-slimmer: planner call ended with unsupported finish ${finishKind}`)
      return STATUS_FAILED
    }
    const plan = planFromCollected(collected)
    this.diag('plan', { plan: sanitizePlanForLog(plan), ...plannerInfo }, session.id)
    if (plan === null) {
      this.diag(
        'planner-invalid-json',
        {
          finish: finishKind,
          textLength: Array.from(collected.text).length,
          textHead: bounded(collected.text, 200),
        },
        session.id,
      )
      this.diag('no-op', { reason: 'text-plan-parse-failed' }, session.id)
      this.ctx.logger?.debug?.('context-slimmer: planner returned no parseable plan; treating as no-op')
      return STATUS_NO_OP
    }
    const validation = validatePlan(plan, targets, {
      maxItems: this.config.maxTargets,
      policy: this.config.policy,
      minTargetChars: this.config.minTargetChars,
    })
    this.diag(
      'validate',
      {
        ok: validation.ok,
        policy: this.config.policy,
        ...plannerInfo,
        ...(validation.ok ? {} : { code: validation.code, message: bounded(validation.message, 500) }),
      },
      session.id,
    )
    if (!validation.ok) {
      this.ctx.logger?.warn?.(`context-slimmer: plan rejected by ${this.config.policy} policy (${validation.code}); nothing replaced`)
      return STATUS_REJECTED
    }
    if (validation.plan.items.length === 0) {
      this.diag('no-op', { reason: 'empty-items' }, session.id)
      return STATUS_NO_OP
    }
    const tokenMeter = this.ctx.get?.('tokenMeter')
    try {
      const applied = applyPlan({
        session,
        targets,
        plan: validation.plan,
        estimateTokens: (message) => estimateMessageTokens(tokenMeter, message),
        batch,
      })
      this.diag(
        'apply',
        {
          items: applied.totals.items,
          charsSaved: applied.totals.charsSaved,
          degraded: applied.degraded === true,
          metaLanded: applied.metaLanded === true,
          ...plannerInfo,
        },
        session.id,
      )
      this.ctx.logger?.info?.(
        `context-slimmer: applied ${String(applied.totals.items)} items, saved ${String(applied.totals.charsSaved)} chars` +
          (applied.metaLanded ? '' : ' (UI metadata degraded: prune extension rejected)'),
      )
      if (applied.degraded) {
        this.extensionSupported = false
        this.ctx.logger?.warn?.('context-slimmer: prune metadata extension rejected by the session runtime; continuing without UI rows')
      }
      return STATUS_APPLIED
    } catch (error) {
      this.diag('apply', { error: bounded(errorMessage(error), 500), ...plannerInfo }, session.id)
      this.ctx.logger?.warn?.(`context-slimmer: replacement failed: ${errorMessage(error)}`)
      return STATUS_FAILED
    }
  }

  /**
   * Consume one `ctx.llm.stream()` call: accumulate text by block index, keep
   * every tool call, and read the terminal finish/usage chunks. Adapters may
   * emit either deltas or complete block-end chunks, so both are merged (a
   * block-end text block is authoritative for its index).
   *
   * @param {object} options GenerateOptions for `ctx.llm.stream`.
   * @returns {Promise<{ text: string, toolCalls: object[], finish: object | undefined, usage: object | undefined }>} Collected output.
   */
  async #collectStream(options) {
    const textParts = new Map()
    const toolCallDeltas = new Map()
    const toolCalls = []
    let finish
    let usage
    for await (const chunk of this.ctx.llm.stream(options)) {
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        const index = typeof chunk.index === 'number' ? chunk.index : textParts.size
        textParts.set(index, `${textParts.get(index) ?? ''}${chunk.text}`)
      } else if (chunk.type === 'tool-call-delta') {
        const index = typeof chunk.index === 'number' ? chunk.index : toolCallDeltas.size
        const part = toolCallDeltas.get(index) ?? { id: chunk.id, name: undefined, arguments: '' }
        if (typeof chunk.id === 'string') part.id = chunk.id
        if (typeof chunk.name === 'string' && chunk.name.length > 0) part.name = chunk.name
        part.arguments += typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        toolCallDeltas.set(index, part)
      } else if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object') {
        if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
          textParts.set(typeof chunk.index === 'number' ? chunk.index : textParts.size, chunk.block.text)
        } else if (chunk.block.type === 'tool-call') {
          toolCalls.push(chunk.block)
        }
      } else if (chunk.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
        usage = chunk.usage
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
    for (const part of toolCallDeltas.values()) {
      if (!toolCalls.some((call) => call.id === part.id)) {
        toolCalls.push({ type: 'tool-call', id: part.id, name: part.name, arguments: part.arguments })
      }
    }
    const text = [...textParts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .join('')
    return { text, toolCalls, finish, usage }
  }
}

/**
 * Sanitize a `TokenUsage` object for diagnostics: prompt (input) and completion
 * (output) token counts only, so no tool text reaches the file.
 *
 * @param {object | undefined} usage Raw usage chunk value.
 * @returns {{ promptTokens: number, completionTokens: number, totalTokens?: number } | undefined} Summary.
 */
function summarizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const promptTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0
  const completionTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0
  return {
    promptTokens,
    completionTokens,
    ...(typeof usage.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {}),
  }
}

/**
 * Derive the plan from one collected stream: a native `structured_output` tool
 * call wins (compatibility), then the first JSON object of the text output.
 *
 * @param {{ text: string, toolCalls: readonly object[] }} collected Collected stream.
 * @returns {object | null} Candidate plan, or null.
 */
function planFromCollected(collected) {
  for (const call of collected.toolCalls) {
    if (call?.name !== STRUCTURED_OUTPUT_TOOL) continue
    if (typeof call.arguments === 'string') {
      const parsed = parsePlannerText(call.arguments)
      if (parsed !== null) return parsed
    } else if (call.arguments !== null && typeof call.arguments === 'object') {
      return call.arguments
    }
  }
  return parsePlannerText(collected.text)
}

/**
 * Whether a session belongs to a subagent.
 *
 * @param {object | undefined} session Session.
 * @returns {boolean} True for child sessions.
 */
function isSubagentSession(session) {
  return session?.header?.origin === 'subagent'
}

/**
 * Bounded, tool-text-free error message for logs.
 *
 * @param {unknown} error Thrown value.
 * @returns {string} Short message.
 */
function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return Array.from(text).slice(0, 200).join('')
}

/**
 * Bound one string to `limit` code points (diagnostics only).
 *
 * @param {string} text Source text.
 * @param {number} limit Maximum code points.
 * @returns {string} Bounded text.
 */
function bounded(text, limit) {
  return Array.from(text).slice(0, limit).join('')
}

/**
 * Sanitized plan snapshot for the diagnostics file: per-item `text` is cut to
 * 120 code points first, then the JSON is cut to 4000 chars, so a diagnostics
 * line can never contain a full tool result.
 *
 * @param {object | null} plan Extracted plan.
 * @returns {string | null} Bounded JSON, or null.
 */
function sanitizePlanForLog(plan) {
  if (plan === null || typeof plan !== 'object') return plan === null ? null : bounded(String(plan), 4000)
  try {
    const sanitized = {
      ...plan,
      ...(Array.isArray(plan.items)
        ? {
            items: plan.items.map((item) =>
              item !== null && typeof item === 'object'
                ? { ...item, ...(typeof item.text === 'string' ? { text: bounded(item.text, 120) } : {}) }
                : item,
            ),
          }
        : {}),
    }
    return bounded(JSON.stringify(sanitized), 4000)
  } catch {
    return bounded(String(plan), 4000)
  }
}

/**
 * Cordis plugin entry: validate the row configuration, mount the host.
 *
 * @param {object} ctx Cordis context of the row.
 * @param {object} [rawConfig] Row configuration from the Loader.
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = resolveConfig(rawConfig ?? {})
  } catch (error) {
    // The Loader validates the schema before apply; a refusal here is a
    // programming/config error that must not crash the whole profile row.
    ctx.logger?.warn?.(`context-slimmer: invalid configuration, row not mounted: ${errorMessage(error)}`)
    return
  }
  if (!config.enabled) {
    ctx.logger?.info?.('context-slimmer: disabled by configuration')
    return
  }
  new SlimmerHost(ctx, config).install()
}
