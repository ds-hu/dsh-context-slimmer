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
} from '../../lib/counters.js'
import { createFakeSession } from '../helpers/fake-session.mjs'
import { readSurfaceEntries } from '../../lib/replace.js'

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

test('OR-thresholds trigger independently and respect the error gate', () => {
  const config = { everyNToolCalls: 8, minChars: 24000, triggerOnErrorOnly: false }
  assert.equal(shouldTrigger(createCounter({ observedCalls: 8 }), config).reason, 'calls')
  assert.equal(shouldTrigger(createCounter({ observedChars: 24000 }), config).reason, 'chars')
  assert.equal(shouldTrigger(createCounter({ observedCalls: 7, observedChars: 23999 }), config).triggered, false)

  const callsDisabled = { everyNToolCalls: 0, minChars: 24000, triggerOnErrorOnly: false }
  assert.equal(shouldTrigger(createCounter({ observedCalls: 100 }), callsDisabled).triggered, false)
  assert.equal(shouldTrigger(createCounter({ observedChars: 24000 }), callsDisabled).reason, 'chars')

  const errorOnly = { ...config, triggerOnErrorOnly: true }
  assert.equal(shouldTrigger(createCounter({ observedCalls: 99 }), errorOnly).triggered, false)
  assert.equal(shouldTrigger(createCounter({ observedCalls: 99, observedErrorCalls: 1 }), errorOnly).reason, 'calls')
})

test('reset keeps lastSeq but clears the window; triggerSnapshot is frozen', () => {
  const counter = createCounter({ observedCalls: 9, observedChars: 100, observedErrorCalls: 2, lastSeq: 42 })
  const reset = resetCounter(counter)
  assert.deepEqual(reset, { observedCalls: 0, observedChars: 0, observedErrorCalls: 0, lastSeq: 42 })
  const snapshot = triggerSnapshot(counter, { everyNToolCalls: 8, minChars: 24000 })
  assert.deepEqual(snapshot, { everyNToolCalls: 8, minChars: 24000, observedCalls: 9, observedChars: 100 })
  assert.ok(Object.isFrozen(snapshot))
})

test('countEntriesSince rebuilds a window from the current surface', () => {
  const session = createFakeSession()
  session.appendToolResult('call-1', 'bash', 'a'.repeat(300))
  session.appendToolResult('call-2', 'read_file', 'b'.repeat(500), { isError: true })
  const entries = readSurfaceEntries(session)
  assert.deepEqual(countEntriesSince(entries, -1), { observedCalls: 2, observedChars: 800, observedErrorCalls: 1, lastSeq: 3 })
  assert.deepEqual(countEntriesSince(entries, 1), { observedCalls: 1, observedChars: 500, observedErrorCalls: 1, lastSeq: 3 })
  assert.deepEqual(countEntriesSince(entries, 99), { observedCalls: 0, observedChars: 0, observedErrorCalls: 0, lastSeq: 99 })
})

test('CounterStore is a simple keyed map', () => {
  const store = new CounterStore()
  assert.equal(store.size, 0)
  const counter = store.ensure('s1', () => createCounter({ observedCalls: 2 }))
  assert.equal(store.get('s1'), counter)
  assert.equal(store.ensure('s1', () => createCounter({ observedCalls: 99 })), counter)
  store.set('s2', createCounter())
  assert.equal(store.size, 2)
  assert.equal(store.delete('s1'), true)
  assert.equal(store.get('s1'), undefined)
  store.clear()
  assert.equal(store.size, 0)
})
