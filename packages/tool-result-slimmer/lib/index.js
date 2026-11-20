/**
 * Host half of the tool-result slimmer (Cordis row
 * `context-slimmer-tool-result`).
 *
 * Behaviour per root `agent/pre-step`:
 *   1. read the per-session counter built from the live `session/event` feed;
 *   2. when a threshold is met, select target results from the current surface
 *      (newest first, protected recent tail skipped, already-replaced nodes
 *      skipped) and start ONE managed fork activation (`delivery: 'caller'`)
 *      with an inherited model route and an `outputSchema` for the plan; the
 *      fork provider mounts its native `structured_output` tool in the child
 *      scope, so no custom tool is registered by this plugin;
 *   3. in the awaited `agent/created` window restrict the child to that single
 *      tool (`agent.ctx.tools.restrict({ deny: <all global tool names> })`) and
 *      keep a root `tools/pre-execute` deny backstop;
 *   4. validate the returned plan with the core `validatePlan` (authoritative)
 *      and apply it atomically: for every target append the official
 *      `compaction/prune` shadow price immediately followed by the replacement
 *      `tool/result`, with the batch payload riding on the prune event;
 *   5. reset the counter in every outcome (applied / no-op / rejected / failed).
 *      Nothing is ever thrown into the main agent loop: a failed run is a
 *      no-op plus a warning log.
 *
 * Dependency policy (Lead ruling R4): this file imports ONLY node builtins and
 * the workspace core package. No `@deepseek-ai/*` import: external plugins
 * cannot rely on the profile's private copies. Session mutation goes through
 * the borrowed `session.append` API with plain JSON (the log validates and
 * freezes it); token estimation uses the optional `tokenMeter` service when the
 * profile mounts it, with the project-wide `ceil(chars/4)` fallback.
 *
 * Budget: this module only reacts after the awaited `next()` of
 * `agent/pre-step`; the main agent is blocked for the duration of the run
 * (timeout `config.timeoutMs`, default 120s).
 *
 * @module @ds-hu/dsh-context-slimmer-tool-result
 */

import { randomUUID } from 'node:crypto'

import { Config, ConfigError, agentOptionsOverride, recordModel, resolveConfig } from '@ds-hu/dsh-context-slimmer-core/config'
import { CounterStore, createCounter, noteToolResult, resetCounter, shouldTrigger, triggerSnapshot } from '@ds-hu/dsh-context-slimmer-core/counters'
import { STRUCTURED_OUTPUT_TOOL, buildSlimTaskMessage } from '@ds-hu/dsh-context-slimmer-core/prompt'
import { applyPlan, readSurfaceEntries, selectTargets } from '@ds-hu/dsh-context-slimmer-core/replace'
import { buildPlanJsonSchema, validatePlan } from '@ds-hu/dsh-context-slimmer-core/plan'
import { STATUS_APPLIED, STATUS_FAILED, STATUS_NO_OP, STATUS_REJECTED } from '@ds-hu/dsh-context-slimmer-core/events'

/** Cordis row name; must equal the `id` in cordis.patch.yml. */
export const name = 'context-slimmer-tool-result'

/** Required services: tool registry (restrict/definitions) and subagent activations. */
export const inject = ['tools', 'subagents']

/** Re-export the schema so the Loader/native panel can project the form. */
export { Config, ConfigError }

/** Characters per token of the fallback estimate, matching dsh-token-meter. */
const FALLBACK_CHARS_PER_TOKEN = 4

/** Maximum characters of the extracted task description in the payload. */
const MAX_TASK_CHARS = 1600

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
 * Remove one optional Markdown code fence and parse the first balanced JSON
 * object of a text blob. Used only as a fallback when the provider did not
 * return `result.structured`.
 *
 * @param {string} text Raw assistant text.
 * @returns {object | null} Parsed object, or null.
 */
export function extractPlanFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = fenced === null ? [text] : [fenced[1], text]
  for (const candidate of candidates) {
    const parsed = parseFirstJsonObject(candidate)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  }
  return null
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
 * Extract a plan object from a settled subagent result:
 * `result.structured` first (the enforced output schema), then the first JSON
 * object found in the assistant text output.
 *
 * @param {{ structured?: unknown, output?: readonly object[] }} result SubagentResult.
 * @returns {object | null} Candidate plan, or null.
 */
export function extractPlan(result) {
  if (result === null || typeof result !== 'object') return null
  if (result.structured !== undefined && result.structured !== null) {
    if (typeof result.structured === 'object' && !Array.isArray(result.structured)) return result.structured
    if (typeof result.structured === 'string') return extractPlanFromText(result.structured)
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
    /** @type {Map<string, object>} childId -> run bookkeeping */
    this.runs = new Map()
    /** Global tool names to hide from the child (captured before any child). */
    this.globalToolNames = []
    this.disposed = false
    this.disposers = []
    /** Batch payload capability cache (Lead ruling R1 degradation). */
    this.extensionSupported = true
  }

  /** Mount every listener; safe to call once. */
  install() {
    const { ctx } = this
    this.globalToolNames = this.#globalToolNames()
    this.disposers.push(
      ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)),
      ctx.on('agent/created', (payload) => this.onAgentCreated(payload)),
      ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next)),
      ctx.on('tools/pre-execute', (exec, next) => this.onToolsPreExecute(exec, next)),
    )
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => this.dispose())
    }
    ctx.logger?.info?.(
      `context-slimmer: mounted (everyNToolCalls=${String(this.config.everyNToolCalls)}, minChars=${String(this.config.minChars)}, maxTargets=${String(this.config.maxTargets)})`,
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
    this.runs.clear()
  }

  /**
   * Read the global tool names the child must not see.
   *
   * @returns {string[]} Global tool names (excluding the native structured-output tool).
   */
  #globalToolNames() {
    try {
      const definitions = this.ctx.tools?.definitions?.() ?? []
      return definitions.map((definition) => definition.name).filter((toolName) => toolName !== STRUCTURED_OUTPUT_TOOL)
    } catch {
      return []
    }
  }

  /**
   * Live-observation handler: count new settled results of root sessions.
   *
   * @param {object} session Session that emitted the event.
   * @param {object} event Appended session event.
   */
  onSessionEvent(session, event) {
    if (this.disposed || event?.type !== 'tool/result') return
    if (isSubagentSession(session)) return
    // Replacement nodes must not feed the counter, or a finished run would
    // immediately look like fresh growth.
    if (event.surfaceOp !== 'append') return
    const counter = this.counters.get(session.id)
    if (counter === undefined) return
    this.counters.set(session.id, noteToolResult(counter, { seq: event.seq, content: event.data?.message?.content ?? [], isError: event.data?.message?.isError === true }))
  }

  /**
   * Awaited creation window: restrict the child to the native structured-output
   * tool before its first request is assembled.
   *
   * @param {{ agent: object }} payload `agent/created` payload.
   */
  onAgentCreated(payload) {
    if (this.disposed) return
    const agent = payload?.agent
    const run = agent === undefined ? undefined : this.runs.get(agent.id)
    if (run === undefined) return
    try {
      if (this.globalToolNames.length > 0) {
        agent.ctx?.tools?.restrict?.({ deny: [...this.globalToolNames] })
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`context-slimmer: could not restrict child tools: ${errorMessage(error)}`)
    }
  }

  /**
   * Root waterfall: block every child tool call except the native structured
   * output tool (defence in depth if `restrict` was not effective).
   *
   * @param {object} exec Tool execution.
   * @param {() => Promise<object>} next Continuation.
   * @returns {Promise<object>} Decision.
   */
  onToolsPreExecute(exec, next) {
    if (this.disposed) return next()
    const isChild = exec?.agent?.id !== undefined && this.runs.has(exec.agent.id)
    if (isChild && exec.name !== STRUCTURED_OUTPUT_TOOL) {
      return Promise.resolve({ kind: 'deny', reason: 'context-slimmer child may only submit its structured plan' })
    }
    return next()
  }

  /**
   * Root waterfall around one step: run the slimmer after the native decision,
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
    if (agent === undefined || session === undefined || isSubagentSession(session)) return
    if (this.runs.has(agent.id)) return
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
    if (targets.length === 0) {
      this.counters.set(session.id, resetCounter(counter))
      return
    }
    const batch = {
      batchId: randomUUID(),
      startedAt: Date.now(),
      trigger: triggerSnapshot(counter, this.config),
      model: recordModel(this.config, payload.modelSelection),
      attachMeta: this.extensionSupported,
    }
    const status = await this.runBatch({
      agent,
      session,
      entries,
      targets,
      batch,
      task: extractTask(payload.messages),
      parentSignal: payload.signal,
    })
    this.ctx.logger?.debug?.(
      `context-slimmer: run ${status} (targets=${String(targets.length)}, calls=${String(counter.observedCalls)}, chars=${String(counter.observedChars)})`,
    )
    this.counters.set(session.id, resetCounter(this.counters.get(session.id) ?? counter))
  }

  /**
   * Start, await and apply one managed fork activation.
   *
   * @param {object} input Run inputs.
   * @param {object} input.agent Root agent of the current step.
   * @param {object} input.session Its session.
   * @param {readonly object[]} input.entries Current surface entries.
   * @param {readonly object[]} input.targets Selected targets.
   * @param {object} input.batch Batch bookkeeping.
   * @param {string} input.task Extracted task description for the payload.
   * @param {AbortSignal} [input.parentSignal] Parent turn signal.
   * @returns {Promise<string>} Status constant of the run.
   */
  async runBatch({ agent, session, entries, targets, batch, task, parentSignal }) {
    const childId = `context-slimmer-${randomUUID()}`
    const targetSeqs = new Set(targets.map((target) => target.seq))
    const prompt = buildSlimTaskMessage({
      locale: this.config.promptLocale,
      task,
      constraints: [],
      recent: buildRecent(entries, targetSeqs),
      candidates: targets.map((target) => ({
        index: target.index,
        tool: target.toolName,
        isError: target.isError,
        chars: target.chars,
        text: target.text,
      })),
    })
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signal = parentSignal === undefined || parentSignal === null ? timeout : AbortSignal.any([parentSignal, timeout])
    const agentOptions = agentOptionsOverride(this.config)
    this.runs.set(childId, batch)
    let activation
    try {
      activation = await this.ctx.subagents.startActivation({
        provider: this.config.forkProvider,
        label: 'context-slimmer',
        childId,
        delivery: 'caller',
        signal,
        request: {
          prompt,
          parent: agent,
          outputSchema: buildPlanJsonSchema(),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        },
      })
    } catch (error) {
      this.runs.delete(childId)
      this.ctx.logger?.warn?.(`context-slimmer: subagent start failed: ${errorMessage(error)}`)
      return STATUS_FAILED
    }
    let result
    try {
      result = await activation.result
    } catch (error) {
      this.ctx.logger?.warn?.(`context-slimmer: subagent failed: ${errorMessage(error)}`)
      return STATUS_FAILED
    } finally {
      try {
        await activation.dispose()
      } catch {
        // teardown is best-effort
      }
      this.runs.delete(childId)
    }
    if (result?.stopReason !== undefined && result.stopReason !== 'completed') {
      this.ctx.logger?.warn?.(`context-slimmer: subagent stopped with ${String(result.stopReason)}`)
      return STATUS_FAILED
    }
    const plan = extractPlan(result)
    if (plan === null) {
      this.ctx.logger?.debug?.('context-slimmer: subagent returned no plan; treating as no-op')
      return STATUS_NO_OP
    }
    const validation = validatePlan(plan, targets, { maxItems: this.config.maxTargets })
    if (!validation.ok) {
      this.ctx.logger?.warn?.(`context-slimmer: plan rejected (${validation.code}); nothing replaced`)
      return STATUS_REJECTED
    }
    if (validation.plan.items.length === 0) return STATUS_NO_OP
    const tokenMeter = this.ctx.get?.('tokenMeter')
    try {
      const applied = applyPlan({
        session,
        targets,
        plan: validation.plan,
        estimateTokens: (message) => estimateMessageTokens(tokenMeter, message),
        batch,
      })
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
      this.ctx.logger?.warn?.(`context-slimmer: replacement failed: ${errorMessage(error)}`)
      return STATUS_FAILED
    }
  }
}


/**
 * Whether a session belongs to a subagent (never slimmed, never counted).
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
 * Cordis plugin entry: validate the row configuration, mount the host.
 *
 * @param {object} ctx Cordis context of the row.
 * @param {object} [rawConfig] Row configuration from the Loader.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})
  if (!config.enabled) {
    ctx.logger?.info?.('context-slimmer: disabled by configuration')
    return
  }
  new SlimmerHost(ctx, config).install()
}
