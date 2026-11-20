/**
 * Minimal in-memory Session double for offline tests.
 *
 * Mirrors only the borrowed surface the slimmer uses: `id`, `header`, `seq`
 * (next append seq), `append(type, data, meta)`, `eventAt(seq)`,
 * `deriveEventMessage(event)` and `surface.nodes`. It also enforces the two
 * real-runtime contracts the host relies on:
 *
 *   - a log-only `compaction/prune` accepts arbitrary additive JSON fields;
 *   - a surface `tool/result` replacement may change ONLY `message.content`
 *     (like `assertToolResultRewrite` in dsh-session), so a host bug that edits
 *     `meta`/`error`/`turn` fails the test exactly as it would fail at runtime.
 *
 * @param {{ id?: string, origin?: string, rejectPruneExtension?: boolean }} [options] Session options.
 * @returns {object} Fake session.
 */
export function createFakeSession(options = {}) {
  const events = []
  const session = {
    id: options.id ?? 'fake-session',
    header: { origin: options.origin ?? 'user' },
    surface: { nodes: new Set() },
    events,
    /** When true every prune carrying `contextSlimmer` is rejected (degradation path). */
    rejectPruneExtension: options.rejectPruneExtension === true,
    rejectPruneExtensionOnce: false,
    get seq() {
      return events.length
    },
    append(type, data, meta = {}) {
      if (type === 'compaction/prune' && data?.contextSlimmer !== undefined) {
        if (session.rejectPruneExtension) {
          const error = new Error('unknown field "contextSlimmer" on compaction/prune')
          error.code = 'unknown-event-field'
          throw error
        }
        if (session.rejectPruneExtensionOnce) {
          session.rejectPruneExtensionOnce = false
          const error = new Error('unknown field "contextSlimmer" on compaction/prune')
          error.code = 'unknown-event-field'
          throw error
        }
      }
      const seq = events.length
      const surfaceOp = meta.surfaceOp
      if (type === 'tool/result' && surfaceOp !== undefined && typeof surfaceOp === 'object') {
        const original = events[surfaceOp.startSeq]
        if (original === undefined) throw new Error(`replacement source seq ${surfaceOp.startSeq} does not exist`)
        if (original.data.meta !== undefined || data.meta !== undefined) {
          if (JSON.stringify(original.data.meta) !== JSON.stringify(data.meta)) {
            throw new Error('tool/result surface replacement may change only content')
          }
        }
        const originalRest = { ...original.data, message: undefined }
        const replacementRest = { ...data, message: undefined }
        if (JSON.stringify(originalRest) !== JSON.stringify(replacementRest)) {
          throw new Error('tool/result surface replacement may change only content')
        }
      }
      const event = { seq, type, data, ...(Object.keys(meta).length === 0 ? {} : meta) }
      events.push(event)
      if (meta.surfaceOp === 'append') session.surface.nodes.add(seq)
      if (surfaceOp !== undefined && typeof surfaceOp === 'object') {
        session.surface.nodes.delete(surfaceOp.startSeq)
        session.surface.nodes.add(seq)
      }
      return event
    },
    eventAt(seq) {
      return events[seq]
    },
    deriveEventMessage(event) {
      return event.data.message ?? null
    },
    /** Append a paired assistant tool call + tool result and return the result event. */
    appendToolResult(callId, toolName, text, { isError = false, turn = 1, step = 1 } = {}) {
      session.append(
        'assistant/message',
        {
          turn,
          step,
          message: {
            id: `assistant-${callId}`,
            role: 'assistant',
            source: { kind: 'model', provider: 'test', model: 'test' },
            content: [{ type: 'tool-call', id: callId, name: toolName, arguments: '{}' }],
          },
          stream: [],
        },
        { surfaceOp: 'append' },
      )
      return session.append(
        'tool/result',
        {
          turn,
          step,
          message: {
            id: `tool-${callId}`,
            role: 'tool',
            content: [{ type: 'text', text }],
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError,
          },
        },
        { surfaceOp: 'append' },
      )
    },
  }
  return session
}
