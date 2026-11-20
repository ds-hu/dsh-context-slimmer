import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CounterStore,
  EMPTY_COUNTER,
  countEntriesSince,
  createCounter,
  noteToolResult,
  resetCounter,
  shouldTrigger,
  triggerSnapshot,
} from '../lib/counters.js'
import { createFakeSession } from './helpers/fake-session.mjs'
import { readSurfaceEntries } from '../lib/replace.js'

test('counter accumulates calls/chars/errors and freezes each state', () => {
  let counter = createCounter()
  assert.deepEqual(counter, EMPTY_COUNTER)
  counter = noteToolResult(counter, { seq: 3, content: [{ type: 'text', text: 'abc😀' }], isError: true })
  counter = noteToolResult(counter, { seq: 5, chars: 10 })
  assert.equal(counter.observedCalls, 2)
  assert.equal(counter.observedChars, 14)
  assert.equal(counter.observedErrorCalls, 1)
  assert.equal(counter.lastSeq, 5)
  assert.ok(Object.isFrozen(counter))
})

test('AND-trigger: both thresholds must be met, 0 disables one condition', () => {
  const config = { everyNToolCalls: 12, minChars: 24000, triggerOnErrorOnly: false }
  assert.equal(shouldTrigger(createCounter({ observedCalls: 12, observedChars: 24000 }), config).reason, 'both')
  // One dimension alone is NOT enough (v0.2.0 AND trigger).
  assert.equal(shouldTrigger(createCounter({ observedCalls: 99, observedChars: 100 }), config).triggered, false)
  assert.equal(shouldTrigger(createCounter({ observedCalls: 1, observedChars: 999999 }), config).triggered, false)

  const callsDisabled = { everyNToolCalls: 0, minChars: 24000, triggerOnErrorOnly: false }
  assert.equal(shouldTrigger(createCounter({ observedChars: 24000 }), callsDisabled).reason, 'chars')
  assert.equal(shouldTrigger(createCounter({ observedChars: 23999 }), callsDisabled).triggered, false)

  const charsDisabled = { everyNToolCalls: 12, minChars: 0, triggerOnErrorOnly: false }
  assert.equal(shouldTrigger(createCounter({ observedCalls: 12 }), charsDisabled).reason, 'calls')

  const errorOnly = { ...config, triggerOnErrorOnly: true }
  assert.equal(shouldTrigger(createCounter({ observedCalls: 12, observedChars: 24000 }), errorOnly).triggered, false)
  assert.equal(shouldTrigger(createCounter({ observedCalls: 12, observedChars: 24000, observedErrorCalls: 1 }), errorOnly).triggered, true)
})

test('trigger snapshot and reset preserve the configured thresholds', () => {
  const counter = createCounter({ observedCalls: 12, observedChars: 30000, observedErrorCalls: 2, lastSeq: 7 })
  assert.deepEqual(triggerSnapshot(counter, { everyNToolCalls: 12, minChars: 24000 }), {
    everyNToolCalls: 12,
    minChars: 24000,
    observedCalls: 12,
    observedChars: 30000,
  })
  const reset = resetCounter(counter)
  assert.equal(reset.observedCalls, 0)
  assert.equal(reset.observedChars, 0)
  assert.equal(reset.observedErrorCalls, 0)
  assert.equal(reset.lastSeq, 7)
})

test('countEntriesSince rebuilds a window from the current surface', () => {
  const session = createFakeSession()
  session.appendToolResult('call-a', 'bash', 'hello')
  session.appendToolResult('call-b', 'read_file', 'world', { isError: true })
  const entries = readSurfaceEntries(session)
  const window = countEntriesSince(entries, -1)
  assert.equal(window.observedCalls, 2)
  assert.equal(window.observedChars, 10)
  assert.equal(window.observedErrorCalls, 1)
})

test('CounterStore isolates sessions and clears', () => {
  const store = new CounterStore()
  assert.equal(store.get('a'), undefined)
  const ensured = store.ensure('a', () => createCounter())
  assert.deepEqual(ensured, EMPTY_COUNTER)
  store.set('a', createCounter({ observedCalls: 3 }))
  assert.equal(store.get('a').observedCalls, 3)
  assert.equal(store.size, 1)
  store.delete('a')
  assert.equal(store.size, 0)
  store.set('b', EMPTY_COUNTER)
  store.clear()
  assert.equal(store.size, 0)
})
