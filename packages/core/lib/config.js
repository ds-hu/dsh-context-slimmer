/**
 * Schemastery configuration of the tool-result slimmer module.
 *
 * Every field carries a default and a description, so the native Plugins panel
 * renders a complete, editable form and an empty `config: {}` row yields the
 * documented behaviour. `Config` is re-exported by the module package as
 * `Config` for the Loader; `resolveConfig` adds the cross-field checks the JSON
 * Schema form cannot express (invalid combinations are rejected at mount time
 * rather than half-working at trigger time).
 *
 * v0.2.0 (docs/plan-v0.2.md, binding): the default policy is `conservative`
 * (only provably-safe drops), both trigger thresholds must be met (AND), and the
 * background planner is a direct `ctx.llm.stream()` call whose model is resolved
 * with a three-level fallback (section 1 of the plan). `forkProvider` is gone.
 *
 * @module @ds-hu/dsh-context-slimmer-core/config
 */

import z from '@deepseek-ai/schemastery'
import { deepFreeze } from './freeze.js'

/**
 * Legacy sentinel meaning "inherit the main agent's route". Kept for backward
 * compatibility with 0.1.0 configuration files; `''` and `'inherit'` are both
 * treated as "not configured" by {@link resolveModelTarget}.
 */
export const INHERIT = 'inherit'

/** Supported slimming policies (docs/plan-v0.2.md §3). */
export const POLICIES = Object.freeze(['conservative', 'balanced', 'aggressive'])

/** Default policy: provably safe drops only. */
export const DEFAULT_POLICY = 'conservative'

/**
 * One configuration refusal. The module entry lets it escape `apply()` so the
 * native Plugins panel shows a red row instead of silently running defaults.
 */
export class ConfigError extends Error {
  /**
   * @param {string} code Stable machine-readable failure code.
   * @param {string} message Human-readable diagnostic.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
  }
}

/**
 * Unwrap one `schemastery` volatile field value.
 *
 * `.volatile()` marks a field as live-editable for the native Plugins panel;
 * schemastery then returns a cosmokit volatile wrapper (`{ get(), [write] }`)
 * instead of the plain value. We cannot import `@deepseek-ai/cosmokit`
 * (dependency rule R4), so detect the documented `get()` shape structurally.
 *
 * @param {unknown} value Raw resolved field value.
 * @returns {unknown} Plain value.
 */
export function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * Deep-unwrap volatile references produced by the Loader.
 *
 * The Loader validates the row schema BEFORE calling `apply`, so the config the
 * plugin receives already contains cosmokit volatile wrappers
 * (`{ get(), [write] }`) for every `.volatile()` field. Re-validating that raw
 * value with `Config(input)` would fail (`$.enabled expected boolean but got
 * [object Object]`), so the input is unwrapped recursively first (arrays and
 * plain objects only; dates/null/other values are preserved).
 *
 * @param {unknown} value Raw config value (possibly containing volatile refs).
 * @returns {unknown} Plain JSON-like value.
 */
export function unwrapVolatileDeep(value) {
  const unwrapped = unwrapVolatile(value)
  if (unwrapped !== value) return unwrapVolatileDeep(unwrapped)
  if (Array.isArray(unwrapped)) return unwrapped.map((entry) => unwrapVolatileDeep(entry))
  if (unwrapped !== null && typeof unwrapped === 'object') {
    const prototype = Object.getPrototypeOf(unwrapped)
    if (prototype === Object.prototype || prototype === null) {
      const plain = {}
      for (const [key, entry] of Object.entries(unwrapped)) plain[key] = unwrapVolatileDeep(entry)
      return plain
    }
  }
  return unwrapped
}

/** Top-level configuration keys accepted by the row. */
export const CONFIG_KEYS = Object.freeze([
  'enabled',
  'everyNToolCalls',
  'minChars',
  'protectRecent',
  'maxTargets',
  'triggerOnErrorOnly',
  'minTargetChars',
  'timeoutMs',
  'policy',
  'includeSubagents',
  'promptLocale',
  'model',
  'diagnosticsFile',
])

/** Keys accepted inside `model`. */
export const MODEL_KEYS = Object.freeze(['provider', 'model', 'reasoningEffort', 'maxOutputTokens'])

/** The documented default configuration (kept in sync with the schema). */
export const DEFAULT_CONFIG = deepFreeze({
  enabled: true,
  everyNToolCalls: 12,
  minChars: 24000,
  protectRecent: 3,
  maxTargets: 4,
  triggerOnErrorOnly: false,
  minTargetChars: 4096,
  timeoutMs: 120000,
  policy: DEFAULT_POLICY,
  includeSubagents: true,
  promptLocale: 'auto',
  diagnosticsFile: '',
  model: {
    provider: '',
    model: '',
    reasoningEffort: 'inherit',
    maxOutputTokens: 0,
  },
})

/** The Loader/panel schema. Defaults are complete: an empty object is valid. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description(
    'Master switch. When false the row mounts, logs one line and installs nothing (no listener, no counters).',
  ).volatile(),
  everyNToolCalls: z.natural().default(DEFAULT_CONFIG.everyNToolCalls).description(
    'AND-trigger: fire a slim run once this many new tool results accumulated since the last run. 0 disables this condition.',
  ).volatile(),
  minChars: z.natural().default(DEFAULT_CONFIG.minChars).description(
    'AND-trigger: fire a slim run once this many new tool-result characters accumulated since the last run. 0 disables this condition.',
  ).volatile(),
  protectRecent: z.natural().default(DEFAULT_CONFIG.protectRecent).description(
    'The newest N tool results are never picked as targets (safety valve for the step the agent is working on).',
  ).volatile(),
  maxTargets: z.natural().default(DEFAULT_CONFIG.maxTargets).description(
    'Maximum number of tool results one run may rewrite (the planner sees at most this many candidates).',
  ).volatile(),
  triggerOnErrorOnly: z.boolean().default(DEFAULT_CONFIG.triggerOnErrorOnly).description(
    'Only fire when the observation window contains at least one failed tool result (useful for noisy long builds).',
  ).volatile(),
  minTargetChars: z.natural().default(DEFAULT_CONFIG.minTargetChars).description(
    'Results shorter than this many characters are never rewritten: replacing them costs a rewrite without saving context.',
  ).volatile(),
  timeoutMs: z.natural().default(DEFAULT_CONFIG.timeoutMs).description(
    'Hard budget for one background planner call, in milliseconds. On timeout nothing is replaced and a failed record is written.',
  ).volatile(),
  policy: z.union(POLICIES.map((policy) => z.const(policy))).default(DEFAULT_CONFIG.policy).description(
    'Slimming policy. conservative (default): drops only, each with verifiable evidence (duplicate/superseded/empty); trim rejected. balanced: drops + trims (<=50% and <=4000 chars). aggressive: legacy lossy rules (may drop relevant content).',
  ).volatile(),
  includeSubagents: z.boolean().default(DEFAULT_CONFIG.includeSubagents).description(
    'Also slim subagent sessions (sessions whose header origin is "subagent"). When false only the root conversation is processed.',
  ).volatile(),
  promptLocale: z.union([z.const('auto'), z.const('zh'), z.const('en')]).default(DEFAULT_CONFIG.promptLocale).description(
    'Language of the planner prompt: "zh" (default behaviour), "en", or "auto" (currently resolves to Chinese).',
  ).volatile(),
  diagnosticsFile: z.string().default(DEFAULT_CONFIG.diagnosticsFile).description(
    'Optional absolute path of a JSONL diagnostics file for this module (empty = disabled, default). Each line is one sanitized event (trigger, llm, plan, validate, apply, no-op); tool-result text is truncated and never stored in full. Intended for CI debugging.',
  ).volatile(),
  model: z.object({
    provider: z.string().default(DEFAULT_CONFIG.model.provider).description(
      'Provider for the background planner. Empty = inherit the main agent route (request header, then agent options).',
    ).volatile(),
    model: z.string().default(DEFAULT_CONFIG.model.model).description(
      'Model id for the background planner. Empty = inherit; set together with `provider`.',
    ).volatile(),
    reasoningEffort: z.string().default(DEFAULT_CONFIG.model.reasoningEffort).description(
      'Reasoning effort for the planner: inherit (default, follow the main model route of this step and keep its thinking budget), off/low/medium/high/max, empty (same as inherit), or a provider-specific effort id.',
    ).volatile(),
    maxOutputTokens: z.natural().default(DEFAULT_CONFIG.model.maxOutputTokens).description(
      'Output-token budget for each planner request. 0 (default) = follow the model default (no maxTokens override); a positive value caps the WHOLE completion, including reasoning tokens, so too small a value can truncate before any text is emitted.',
    ).volatile(),
  }).default({}).description('Model override for the background planner.'),
})

/**
 * Treat the legacy `'inherit'` sentinel as "not configured".
 *
 * @param {unknown} value Configured provider/model/effort value.
 * @returns {string} Trimmed concrete value, or '' when inherited.
 */
function concrete(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed === INHERIT ? '' : trimmed
}

/**
 * Validate one already-schema-checked configuration and add cross-field rules.
 *
 * @param {object} raw Row configuration (already parsed by the Loader in production).
 * @returns {object} Deep-frozen normalized configuration.
 * @throws {ConfigError} When a field or a combination is refused.
 */
export function resolveConfig(raw = {}) {
  const input = raw === null || raw === undefined ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError('config-not-object', 'row configuration must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.includes(key)) {
      throw new ConfigError('unknown-config-key', `unknown configuration key "${key}" (allowed: ${CONFIG_KEYS.join(', ')})`)
    }
  }
  const modelInput = input.model ?? {}
  if (typeof modelInput !== 'object' || Array.isArray(modelInput)) {
    throw new ConfigError('bad-model-config', 'model must be an object')
  }
  for (const key of Object.keys(modelInput)) {
    if (!MODEL_KEYS.includes(key)) {
      throw new ConfigError('unknown-model-key', `unknown configuration key "model.${key}" (allowed: ${MODEL_KEYS.join(', ')})`)
    }
  }
  let validated
  try {
    validated = Config(unwrapVolatileDeep(input))
  } catch (error) {
    throw new ConfigError('bad-config', error instanceof Error ? error.message : String(error))
  }
  const read = (key) => unwrapVolatile(validated[key])
  if (read('everyNToolCalls') === 0 && read('minChars') === 0) {
    throw new ConfigError(
      'no-trigger',
      'everyNToolCalls and minChars are both 0: the module would never fire. Set at least one trigger.',
    )
  }
  if (read('everyNToolCalls') > 200) {
    throw new ConfigError('bad-every-n-tool-calls', 'everyNToolCalls must be at most 200')
  }
  if (read('minChars') > 10_000_000) {
    throw new ConfigError('bad-min-chars', 'minChars must be at most 10000000')
  }
  if (read('maxTargets') < 1 || read('maxTargets') > 20) {
    throw new ConfigError('bad-max-targets', 'maxTargets must be between 1 and 20')
  }
  if (read('protectRecent') > 50) {
    throw new ConfigError('bad-protect-recent', 'protectRecent must be at most 50')
  }
  if (read('minTargetChars') > 1_000_000) {
    throw new ConfigError('bad-min-target-chars', 'minTargetChars must be at most 1000000')
  }
  if (read('timeoutMs') < 1000 || read('timeoutMs') > 600_000) {
    throw new ConfigError('bad-timeout', 'timeoutMs must be between 1000 and 600000')
  }
  const modelInputResolved = validated.model
  const modelRead = (key) => unwrapVolatile(modelInputResolved[key])
  if (modelRead('maxOutputTokens') > 1_000_000) {
    throw new ConfigError('bad-max-output-tokens', 'model.maxOutputTokens must be at most 1000000')
  }
  const provider = concrete(modelRead('provider'))
  const model = concrete(modelRead('model'))
  const rawEffort = modelRead('reasoningEffort')
  // '' and the legacy 'inherit' sentinel both mean "follow the main route".
  const reasoningEffort = typeof rawEffort === 'string' && rawEffort.trim().length > 0 && rawEffort.trim() !== INHERIT
    ? rawEffort.trim()
    : INHERIT
  if ((provider.length === 0) !== (model.length === 0)) {
    throw new ConfigError(
      'partial-model-override',
      'model.provider and model.model must both be empty (inherit) or both name a concrete route',
    )
  }
  return deepFreeze({
    enabled: read('enabled'),
    everyNToolCalls: read('everyNToolCalls'),
    minChars: read('minChars'),
    protectRecent: read('protectRecent'),
    maxTargets: read('maxTargets'),
    triggerOnErrorOnly: read('triggerOnErrorOnly'),
    minTargetChars: read('minTargetChars'),
    timeoutMs: read('timeoutMs'),
    policy: read('policy'),
    includeSubagents: read('includeSubagents'),
    promptLocale: read('promptLocale'),
    diagnosticsFile: read('diagnosticsFile'),
    model: {
      provider,
      model,
      reasoningEffort,
      maxOutputTokens: modelRead('maxOutputTokens'),
    },
  })
}

/**
 * Resolve the planner route with the documented three-level fallback
 * (docs/plan-v0.2.md §1): configured route -> latest request header config ->
 * agent options. A level is only used when BOTH provider and model are named.
 *
 * @param {object} config Resolved configuration.
 * @param {object | undefined} requestHeaderConfig `session.requestHeader()?.config`.
 * @param {object | undefined} agentOptions `agent.options` (route fields).
 * @returns {{ provider: string, model: string, reasoningEffort?: string, inherited: boolean } | null} Route, or null.
 */
export function resolveModelTarget(config, requestHeaderConfig, agentOptions) {
  // 'inherit' (default) follows the MAIN model route's effort for this step:
  // thinking is important, so a planner call must not silently downgrade it.
  const configuredEffort = config.model.reasoningEffort
  const inheritEffort = configuredEffort === '' || configuredEffort === INHERIT
  const header = requestHeaderConfig ?? {}
  const options = agentOptions ?? {}
  const headerHasRoute = typeof header.provider === 'string' && header.provider.length > 0 && typeof header.model === 'string' && header.model.length > 0
  const optionsHasRoute = typeof options.provider === 'string' && options.provider.length > 0 && typeof options.model === 'string' && options.model.length > 0
  const mainEffort = headerHasRoute
    ? (typeof header.reasoningEffort === 'string' && header.reasoningEffort.length > 0 ? header.reasoningEffort : undefined)
    : (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0 ? options.reasoningEffort : undefined)
  const effort = inheritEffort ? mainEffort : configuredEffort
  const withEffort = (target) => Object.freeze({ ...target, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
  if (config.model.provider.length > 0 && config.model.model.length > 0) {
    return withEffort({ provider: config.model.provider, model: config.model.model, inherited: false })
  }
  if (headerHasRoute) return withEffort({ provider: header.provider, model: header.model, inherited: true })
  if (optionsHasRoute) return withEffort({ provider: options.provider, model: options.model, inherited: true })
  return null
}

/**
 * Resolve the prompt locale setting to a `zh`/`en` value.
 *
 * @param {object} config Resolved configuration.
 * @returns {'zh' | 'en'} Effective prompt language.
 */
export function promptLocaleOf(config) {
  if (config.promptLocale === 'en') return 'en'
  if (config.promptLocale === 'zh') return 'zh'
  return 'zh'
}

/**
 * Build the model receipt written into the batch metadata.
 *
 * @param {object} config Resolved configuration (unused fields kept for signature stability).
 * @param {{ provider: string, model: string, inherited: boolean }} target Resolved route.
 * @returns {{ provider: string, model: string, inherited: boolean }} Frozen receipt.
 */
export function recordModel(config, target) {
  return Object.freeze({ provider: target.provider, model: target.model, inherited: target.inherited === true })
}
