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
 * @module @ds-hu/dsh-context-slimmer-core/config
 */

import z from '@deepseek-ai/schemastery'
import { deepFreeze } from './freeze.js'

/** Sentinel meaning "use the parent agent's current route". */
export const INHERIT = 'inherit'

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
  'forkProvider',
  'promptLocale',
  'model',
  'diagnosticsFile',
])

/** Keys accepted inside `model`. */
export const MODEL_KEYS = Object.freeze(['provider', 'model', 'reasoningEffort', 'maxOutputTokens'])

/** The documented default configuration (kept in sync with the schema). */
export const DEFAULT_CONFIG = deepFreeze({
  enabled: true,
  everyNToolCalls: 8,
  minChars: 24000,
  protectRecent: 2,
  maxTargets: 12,
  triggerOnErrorOnly: false,
  minTargetChars: 256,
  timeoutMs: 120000,
  forkProvider: 'fork',
  promptLocale: 'auto',
  diagnosticsFile: '',
  model: {
    provider: INHERIT,
    model: INHERIT,
    reasoningEffort: INHERIT,
    maxOutputTokens: 2048,
  },
})

/** The Loader/panel schema. Defaults are complete: an empty object is valid. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description(
    'Master switch. When false the row mounts, logs one line and installs nothing (no listener, no tool, no counters).',
  ),
  everyNToolCalls: z.natural().default(DEFAULT_CONFIG.everyNToolCalls).description(
    'Fire a slim run once this many new tool results accumulated in a root session since the last run. 0 disables the count-based trigger.',
  ),
  minChars: z.natural().default(DEFAULT_CONFIG.minChars).description(
    'Fire a slim run once this many new tool-result characters accumulated in a root session. 0 disables the size-based trigger.',
  ),
  protectRecent: z.natural().default(DEFAULT_CONFIG.protectRecent).description(
    'The newest N tool results are never picked as targets (safety valve for the step the agent is working on).',
  ),
  maxTargets: z.natural().default(DEFAULT_CONFIG.maxTargets).description(
    'Maximum number of tool results one run may rewrite (the background model sees at most this many candidates).',
  ),
  triggerOnErrorOnly: z.boolean().default(DEFAULT_CONFIG.triggerOnErrorOnly).description(
    'Only fire when the observation window contains at least one failed tool result (useful for noisy long builds).',
  ),
  minTargetChars: z.natural().default(DEFAULT_CONFIG.minTargetChars).description(
    'Results shorter than this many characters are never rewritten: replacing them costs a rewrite without saving context.',
  ),
  timeoutMs: z.natural().default(DEFAULT_CONFIG.timeoutMs).description(
    'Hard budget for one background slim run, in milliseconds. On timeout nothing is replaced and a failed record is written.',
  ),
  forkProvider: z.string().default(DEFAULT_CONFIG.forkProvider).description(
    'Registered subagent provider used to start the background slimmer (must be an in-process provider that inherits parent context, e.g. "fork").',
  ),
  promptLocale: z.union([z.const('auto'), z.const('zh'), z.const('en')]).default(DEFAULT_CONFIG.promptLocale).description(
    'Language of the background prompt: "zh" (default behaviour), "en", or "auto" (currently resolves to Chinese; kept as a forward-compatible hint).',
  ),
  diagnosticsFile: z.string().default(DEFAULT_CONFIG.diagnosticsFile).description(
    'Optional absolute path of a JSONL diagnostics file for this module (empty = disabled, default). Each line is one sanitized event (trigger, activation, plan, validate, apply, no-op); tool-result text is truncated and never stored in full. Intended for CI debugging; leave empty in normal use.',
  ),
  model: z.object({
    provider: z.string().default(INHERIT).description(
      'Provider for the background slim agent. Keep "inherit" (default) to use the main agent route.',
    ),
    model: z.string().default(INHERIT).description(
      'Model id for the background slim agent. Keep "inherit" (default) or set together with `provider`.',
    ),
    reasoningEffort: z.string().default(INHERIT).description(
      'Reasoning effort for the background slim agent: "inherit" (default) or a provider/model-specific effort id.',
    ),
    maxOutputTokens: z.natural().default(DEFAULT_CONFIG.model.maxOutputTokens).description(
      'Output-token cap for each background request. 0 omits the override and lets the route decide.',
    ),
  }).default({}).description('Model override for the background slim agent.'),
})

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
    validated = Config(input)
  } catch (error) {
    throw new ConfigError('bad-config', error instanceof Error ? error.message : String(error))
  }
  if (validated.everyNToolCalls === 0 && validated.minChars === 0) {
    throw new ConfigError(
      'no-trigger',
      'everyNToolCalls and minChars are both 0: the module would never fire. Set at least one trigger.',
    )
  }
  if (validated.maxTargets < 1) {
    throw new ConfigError('bad-max-targets', 'maxTargets must be at least 1')
  }
  if (validated.maxTargets > 64) {
    throw new ConfigError('bad-max-targets', 'maxTargets must be at most 64 (one background call must stay small)')
  }
  if (validated.protectRecent > 1000) {
    throw new ConfigError('bad-protect-recent', 'protectRecent must be at most 1000')
  }
  if (validated.minTargetChars > 1_000_000) {
    throw new ConfigError('bad-min-target-chars', 'minTargetChars must be at most 1000000')
  }
  if (validated.timeoutMs < 1000 || validated.timeoutMs > 600_000) {
    throw new ConfigError('bad-timeout', 'timeoutMs must be between 1000 and 600000')
  }
  if (validated.maxOutputTokens !== undefined && validated.maxOutputTokens > 1_000_000) {
    throw new ConfigError('bad-max-output-tokens', 'model.maxOutputTokens must be at most 1000000')
  }
  if (typeof validated.forkProvider !== 'string' || validated.forkProvider.length === 0) {
    throw new ConfigError('bad-fork-provider', 'forkProvider must be a non-empty provider name')
  }
  const provider = validated.model.provider
  const model = validated.model.model
  const providerInherited = provider === INHERIT
  const modelInherited = model === INHERIT
  if (providerInherited !== modelInherited) {
    throw new ConfigError(
      'partial-model-override',
      'model.provider and model.model must either both stay "inherit" or both name a concrete route',
    )
  }
  return deepFreeze({
    enabled: validated.enabled,
    everyNToolCalls: validated.everyNToolCalls,
    minChars: validated.minChars,
    protectRecent: validated.protectRecent,
    maxTargets: validated.maxTargets,
    triggerOnErrorOnly: validated.triggerOnErrorOnly,
    minTargetChars: validated.minTargetChars,
    timeoutMs: validated.timeoutMs,
    forkProvider: validated.forkProvider,
    promptLocale: validated.promptLocale,
    diagnosticsFile: validated.diagnosticsFile,
    model: {
      provider,
      model,
      reasoningEffort: validated.model.reasoningEffort,
      maxOutputTokens: validated.model.maxOutputTokens,
    },
  })
}

/**
 * Build the `agentOptions` override for `startActivation`, or `undefined` when
 * the background agent should inherit the parent route completely.
 *
 * @param {object} config Resolved configuration.
 * @returns {object | undefined} AgentOptions override.
 */
export function agentOptionsOverride(config) {
  const override = {}
  if (config.model.provider !== INHERIT && config.model.model !== INHERIT) {
    override.provider = config.model.provider
    override.model = config.model.model
    if (config.model.reasoningEffort !== INHERIT && config.model.reasoningEffort !== '') {
      override.reasoningEffort = config.model.reasoningEffort
    }
  }
  if (config.model.maxOutputTokens > 0) override.maxTokens = config.model.maxOutputTokens
  return Object.keys(override).length === 0 ? undefined : Object.freeze(override)
}

/**
 * Resolve the model receipt written into the plugin record.
 *
 * @param {object} config Resolved configuration.
 * @param {{ provider?: string, model?: string } | undefined} parentSelection Model selection of the
 *   step that triggered the run (`payload.modelSelection`).
 * @returns {{ provider: string, model: string, inherited: boolean }} Frozen receipt.
 */
export function recordModel(config, parentSelection) {
  if (config.model.provider !== INHERIT && config.model.model !== INHERIT) {
    return Object.freeze({ provider: config.model.provider, model: config.model.model, inherited: false })
  }
  return Object.freeze({
    provider: typeof parentSelection?.provider === 'string' && parentSelection.provider.length > 0
      ? parentSelection.provider
      : 'inherit',
    model: typeof parentSelection?.model === 'string' && parentSelection.model.length > 0
      ? parentSelection.model
      : 'inherit',
    inherited: true,
  })
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
