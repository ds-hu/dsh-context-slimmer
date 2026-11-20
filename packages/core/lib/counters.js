/**
 * Per-session incremental counters and threshold decisions.
 *
 * A counter accumulates `tool/result` growth since the last slim run: how many
 * results, how many text characters, how many of them failed. The host updates
 * it from the live `session/event` feed of root agents, and `agent/pre-step`
 * reads it to decide whether to fire a slim run. After a run the counter resets
 * so the next window starts empty. Nothing is persisted: after a plugin reload
 * the first pre-step of each session establishes a fresh baseline without
 * firing, and candidate selection skips already-replaced nodes, so a reload can
 * never re-slim history.
 *
 * Everything here is a pure function over plain objects (no session, no dsh
 * runtime), so every rule is unit-testable offline.
 *
 * @module @ds-hu/dsh-context-slimmer-core/counters
 */

import { contentTextChars } from './events.js'

/** A fresh counter with an empty observation window. */
export const EMPTY_COUNTER = Object.freeze({
  observedCalls: 0,
  observedChars: 0,
  observedErrorCalls: 0,
  lastSeq: -1,
})

/**
 * Build one counter state.
 *
 * @param {object} [initial] Initial values; missing fields default to zero.
 * @returns {object} Frozen counter.
 */
export function createCounter(initial = {}) {
  return Object.freeze({
    observedCalls: initial.observedCalls ?? 0,
    observedChars: initial.observedChars ?? 0,
    observedErrorCalls: initial.observedErrorCalls ?? 0,
    lastSeq: initial.lastSeq ?? -1,
  })
}

/**
 * Record one newly observed tool result.
 *
 * @param {object} counter Counter state from {@link createCounter}.
 * @param {object} sample Observation `{ seq?, chars?, content?, isError? }`.
 * @returns {object} New frozen counter with the observation applied.
 */
export function noteToolResult(counter, sample = {}) {
  const chars = typeof sample.chars === 'number' ? sample.chars : contentTextChars(sample.content ?? [])
  return Object.freeze({
    observedCalls: counter.observedCalls + 1,
    observedChars: counter.observedChars + chars,
    observedErrorCalls: counter.observedErrorCalls + (sample.isError === true ? 1 : 0),
    lastSeq: typeof sample.seq === 'number' ? sample.seq : counter.lastSeq,
  })
}

/**
 * Whether the configured trigger condition is met.
 *
 * v0.2.0 (docs/plan-v0.2.md §3): the two thresholds are AND-conditions — a run
 * fires only when BOTH the result count AND the character count reached their
 * configured limits, so calm sessions never fire on one dimension alone. A
 * threshold of 0 disables that condition (vacuously true), and
 * `triggerOnErrorOnly` additionally requires at least one failed result in the
 * window.
 *
 * @param {object} counter Counter state.
 * @param {object} config Trigger configuration.
 * @param {number} config.everyNToolCalls Result-count threshold (`0` disables this condition).
 * @param {number} config.minChars Character threshold (`0` disables this condition).
 * @param {boolean} [config.triggerOnErrorOnly] Require a failed result.
 * @returns {{ triggered: boolean, reason: 'both' | 'calls' | 'chars' | null }} Decision.
 */
export function shouldTrigger(counter, config) {
  const errorGate = config.triggerOnErrorOnly === true && counter.observedErrorCalls === 0
  const callsConfigured = config.everyNToolCalls > 0
  const charsConfigured = config.minChars > 0
  const callsOk = !callsConfigured || counter.observedCalls >= config.everyNToolCalls
  const charsOk = !charsConfigured || counter.observedChars >= config.minChars
  if (errorGate || !callsOk || !charsOk) return { triggered: false, reason: null }
  return { triggered: true, reason: callsConfigured && charsConfigured ? 'both' : callsConfigured ? 'calls' : 'chars' }
}

/**
 * Freeze the trigger receipt stored in the plugin record.
 *
 * @param {object} counter Counter state at trigger time.
 * @param {object} config Trigger configuration.
 * @returns {object} Frozen trigger receipt.
 */
export function triggerSnapshot(counter, config) {
  return Object.freeze({
    everyNToolCalls: config.everyNToolCalls,
    minChars: config.minChars,
    observedCalls: counter.observedCalls,
    observedChars: counter.observedChars,
  })
}

/**
 * Reset a counter to an empty observation window for the next run.
 *
 * @param {object} counter Counter state.
 * @returns {object} New frozen counter.
 */
export function resetCounter(counter) {
  return Object.freeze({
    observedCalls: 0,
    observedChars: 0,
    observedErrorCalls: 0,
    lastSeq: counter.lastSeq,
  })
}

/**
 * Count the surface entries after a boundary. Used when the host meets a
 * session for the first time (plugin loaded mid-session / restored log): the
 * counter window is rebuilt from the current surface instead of from a live
 * feed it never saw. That first pre-step establishes a baseline and never
 * triggers.
 *
 * @param {readonly object[]} entries Surface entries from `replace.readSurfaceEntries`.
 * @param {number} [afterSeq] Anchor seq; entries at or before it are ignored.
 * @returns {{ observedCalls: number, observedChars: number, observedErrorCalls: number, lastSeq: number }} Window aggregate.
 */
export function countEntriesSince(entries, afterSeq = -1) {
  let observedCalls = 0
  let observedChars = 0
  let observedErrorCalls = 0
  let lastSeq = afterSeq
  for (const entry of entries) {
    if (entry.type !== 'tool/result') continue
    if (entry.seq <= afterSeq) continue
    observedCalls += 1
    observedChars += entry.chars
    if (entry.isError === true) observedErrorCalls += 1
    lastSeq = entry.seq
  }
  return { observedCalls, observedChars, observedErrorCalls, lastSeq }
}

/**
 * Tiny keyed store for per-session counters, kept as a class so the host can
 * swap implementations in tests. Keys are session ids.
 */
export class CounterStore {
  #counters = new Map()

  /**
   * Read one counter.
   *
   * @param {string} key Session id.
   * @returns {object | undefined} Counter or undefined.
   */
  get(key) {
    return this.#counters.get(key)
  }

  /**
   * Store one counter.
   *
   * @param {string} key Session id.
   * @param {object} counter Counter state.
   * @returns {object} The stored counter.
   */
  set(key, counter) {
    this.#counters.set(key, counter)
    return counter
  }

  /**
   * Read a counter, creating one through `factory` when absent.
   *
   * @param {string} key Session id.
   * @param {() => object} factory Counter factory.
   * @returns {object} The existing or created counter.
   */
  ensure(key, factory) {
    const existing = this.#counters.get(key)
    if (existing !== undefined) return existing
    return this.set(key, factory())
  }

  /**
   * Delete one counter.
   *
   * @param {string} key Session id.
   * @returns {boolean} Whether a counter was removed.
   */
  delete(key) {
    return this.#counters.delete(key)
  }

  /** Drop every counter (plugin unload / profile switch). */
  clear() {
    this.#counters.clear()
  }

  /** Number of tracked sessions. */
  get size() {
    return this.#counters.size
  }
}
