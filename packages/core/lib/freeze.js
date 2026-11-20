/**
 * Small deep-freeze helpers shared by the pure modules of this package.
 *
 * The modern JS engines installed with DeepSeek Harness all ship
 * `Object.freeze`, so the only thing worth centralizing is the recursion and
 * the "plain JSON value only" contract every public core helper follows.
 *
 * @module @ds-hu/dsh-context-slimmer-core/freeze
 */

/**
 * Whether a value is a plain (JSON-style) object rather than an array or an
 * exotic class instance.
 *
 * @param {unknown} value Candidate value of any type.
 * @returns {boolean} True for `{}`-style objects created in any realm.
 */
export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Recursively freeze a JSON-style value in place.
 *
 * @template T
 * @param {T} value Value to freeze; only objects and arrays are traversed.
 * @returns {T} The same value, deeply frozen.
 */
export function deepFreeze(value) {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
  } else {
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

/**
 * Recursively clone a JSON-style value into a detached, deeply frozen copy.
 * Non-JSON values (functions, class instances) are rejected, mirroring the
 * Session log's own serializability contract.
 *
 * @template T
 * @param {T} value Value to snapshot.
 * @returns {T} A detached, deeply frozen copy.
 * @throws {TypeError} When the value is not lossless JSON.
 */
export function freezeSnapshot(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`value ${String(value)} is not lossless JSON`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return deepFreeze(value.map((item) => freezeSnapshot(item)))
  }
  if (isPlainObject(value)) {
    const copy = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      copy[key] = freezeSnapshot(item)
    }
    return deepFreeze(copy)
  }
  throw new TypeError(`value of type ${typeof value} / ${value?.constructor?.name ?? 'unknown'} is not lossless JSON`)
}
