#!/usr/bin/env node
/**
 * assert-slimming.mjs — offline assertions over one real DSH session log.
 *
 * Proves, without any model call, that the plugin actually slimmed tool results
 * through the harness-native replacement protocol and that the user-visible
 * transcript was not rewritten:
 *
 *   1. slimmer prune      a `compaction/prune` event carrying the plugin's
 *                         `data.contextSlimmer` extension (role=summary is the row data)
 *   2. replacement        a later `tool/result` surface event with
 *                         `surfaceOp: {op:'replace', startSeq, endSeq}` whose
 *                         `sourceEventSeqs` cite the original tool results
 *   3. shadow price       every replacement is immediately preceded by a
 *                         `compaction/prune` event carrying `data.contextSlimmer`
 *                         (the harness shadow-price protocol + UI row data)
 *   4. transcript intact  append-origin surface events are unique and unchanged,
 *                         replacements only cite append-origin events, and the
 *                         headless NDJSON stream saw the same tool results
 *   5. context shrank     foldSurface()/deriveMessages over the log shows the
 *                         replaced tool-result text is materially shorter
 *
 * The fold uses the installed `@deepseek-ai/dsh-session` surface module when
 * available (authoritative); a built-in minimal fold is used only with
 * --allow-builtin-fold or in --self-test.
 *
 * Usage:
 *   node scripts/ci/assert-slimming.mjs --session-log "$RUNNER_TEMP/ci-artifacts/verify-session.jsonl"
 *   node scripts/ci/assert-slimming.mjs --self-test
 *   node scripts/ci/assert-slimming.mjs --dry-run
 *
 * Exit codes: 0 all checks passed, 1 a required check failed, 2 usage/setup error.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Legacy protocol marker kept only for very old logs; the current protocol
// attaches the plugin extension to `compaction/prune` events instead.
const LEGACY_EVENT_TYPE = 'plugin:context-slimmer/tool-result-pruned';
const SURFACE_RELATIVE = 'node_modules/@deepseek-ai/dsh-session/lib/types/surface.js';

function parseArgs(argv) {
  const args = {
    sessionLog: process.env.VERIFY_SESSION_JSONL ?? process.env.SESSION_LOG ?? '',
    jsonStream: process.env.SCENARIO_JSON ?? '',
    artifactsDir: process.env.CI_ARTIFACTS_DIR ?? join(process.env.RUNNER_TEMP ?? '/tmp', 'ci-artifacts'),
    reportJson: '',
    reportTxt: '',
    minReplacements: 1,
    minSavingsChars: 256,
    minReductionRatio: 0.2,
    diagnostics: process.env.SLIMMER_DIAGNOSTICS_FILE ?? '',
    requireShadowPrice: true,
    requireNoSubagents: process.env.SLIMMER_ALLOW_SUBAGENTS !== '1',
    maxUserMessages: 1,
    dshInstallRoot: process.env.DSH_INSTALL_ROOT ?? '',
    dshSessionSurface: process.env.DSH_SESSION_SURFACE ?? '',
    allowBuiltinFold: false,
    strictStream: false,
    selfTest: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--session-log': args.sessionLog = next(); break;
      case '--json-stream': args.jsonStream = next(); break;
      case '--artifacts-dir': args.artifactsDir = next(); break;
      case '--report-json': args.reportJson = next(); break;
      case '--report-txt': args.reportTxt = next(); break;
      case '--min-replacements': args.minReplacements = Number(next()); break;
      case '--min-savings-chars': args.minSavingsChars = Number(next()); break;
      case '--min-reduction-ratio': args.minReductionRatio = Number(next()); break;
      case '--event-type': args.legacyEventType = next(); break;
      case '--max-user-messages': args.maxUserMessages = Number(next()); break;
      case '--diagnostics': args.diagnostics = next(); break;
      case '--allow-subagents': args.requireNoSubagents = false; break;
      case '--require-no-subagents': args.requireNoSubagents = true; break;
      case '--require-shadow-price': args.requireShadowPrice = true; break;
      case '--no-require-shadow-price': args.requireShadowPrice = false; break;
      case '--dsh-install-root': args.dshInstallRoot = next(); break;
      case '--dsh-session-surface': args.dshSessionSurface = next(); break;
      case '--allow-builtin-fold': args.allowBuiltinFold = true; break;
      case '--strict-stream': args.strictStream = true; break;
      case '--self-test': args.selfTest = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '-h': case '--help':
        process.stdout.write('see the header of scripts/ci/assert-slimming.mjs for usage\n');
        process.exit(0);
        break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.reportJson = args.reportJson || join(args.artifactsDir, 'assert-report.json');
  args.reportTxt = args.reportTxt || join(args.artifactsDir, 'assert-report.txt');
  return args;
}

const log = (message) => process.stdout.write(`assert-slimming: ${message}\n`);

function fail(message) {
  process.stderr.write(`assert-slimming: ERROR: ${message}\n`);
  process.exit(2);
}

/** Decode a plain or zstd-frame-concatenated session log. */
function readSessionLog(file) {
  if (!existsSync(file)) fail(`session log does not exist: ${file}`);
  if (file.endsWith('.zstd')) {
    const result = spawnSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      fail(`cannot decompress ${file}; install the zstd CLI or set SESSION_COMPRESSION=none in the profile (${result.error ?? result.stderr})`);
    }
    return result.stdout.toString('utf8');
  }
  return readFileSync(file, 'utf8');
}

/** Resolve the installed dsh-session surface module, if any. */
function resolveSurfaceModule(args) {
  const candidates = [];
  if (args.dshSessionSurface) candidates.push(args.dshSessionSurface);
  if (args.dshInstallRoot) candidates.push(join(args.dshInstallRoot, SURFACE_RELATIVE));
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
    candidates.push(join(npmRoot.stdout.trim(), '@deepseek-ai/dsh', SURFACE_RELATIVE));
  }
  candidates.push(join('/usr/local/lib/node_modules/@deepseek-ai/dsh', SURFACE_RELATIVE));
  candidates.push(join('/usr/lib/node_modules/@deepseek-ai/dsh', SURFACE_RELATIVE));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

let surfaceModule;
let surfaceModulePath;
async function loadSurfaceModule(args) {
  surfaceModulePath = resolveSurfaceModule(args);
  if (!surfaceModulePath) return undefined;
  surfaceModule = await import(pathToFileURL(surfaceModulePath).href);
  return surfaceModule;
}

/** Minimal, dependency-free surface fold used only as an explicit fallback. */
function builtinFold(events) {
  const nodes = [];
  const replacements = [];
  // Map every surface event seq to the node currently holding its content.
  for (const event of events) {
    const op = event.surfaceOp;
    if (op === 'append') {
      nodes.push(event.seq);
      continue;
    }
    if (op !== undefined && op !== null && typeof op === 'object' && op.op === 'replace') {
      const startIdx = nodes.indexOf(op.startSeq);
      const endIdx = nodes.indexOf(op.endSeq);
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        throw new Error(`replacement at seq ${event.seq} has an invalid range ${op.startSeq}..${op.endSeq}`);
      }
      const shadowedSeqs = nodes.splice(startIdx, endIdx - startIdx + 1);
      nodes.splice(startIdx, 0, event.seq);
      replacements.push({ seq: event.seq, start: op.startSeq, end: op.endSeq, shadowedSeqs });
    }
  }
  return { nodes, replacements, projectedMessages: new Map() };
}

const isSurfaceEvent = (event) => event.surfaceOp !== undefined && event.surfaceOp !== null;
const isAppendEvent = (event) => event.surfaceOp === 'append';
const isReplaceEvent = (event) => typeof event.surfaceOp === 'object' && event.surfaceOp !== null && event.surfaceOp.op === 'replace';

/** The message a surface event contributes to the model-visible history. */
function surfaceMessage(event) {
  if (!event) return undefined;
  if (event.type === 'user/message') return event.data;
  if (event.type === 'system/message' || event.type === 'developer/message') return event.data?.message;
  return event.data?.message;
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

function messageChars(message) {
  if (!message) return 0;
  const text = messageText(message);
  if (text.length > 0) return text.length;
  try { return JSON.stringify(message.content ?? message).length; } catch { return 0; }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeStatus(record) {
  const raw = record?.data?.status ?? record?.data?.state ?? record?.data?.result;
  if (typeof raw !== 'string') {
    if (record?.data?.applied === true) return 'applied';
    return undefined;
  }
  return raw.toLowerCase();
}

function diagnosticsKind(record) {
  const value = record?.kind ?? record?.type ?? record?.event ?? record?.phase ?? record?.stage ?? '';
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function diagnosticsUsage(record) {
  const candidates = [record?.usage, record?.data?.usage, record?.planner?.usage, record?.metrics?.usage];
  for (const usage of candidates) {
    if (usage === null || typeof usage !== 'object') continue;
    const promptTokens = usage.promptTokens ?? usage.inputTokens;
    const completionTokens = usage.completionTokens ?? usage.outputTokens;
    if (typeof promptTokens === 'number' || typeof completionTokens === 'number') {
      return { promptTokens: Number(promptTokens ?? 0), completionTokens: Number(completionTokens ?? 0) };
    }
  }
  return undefined;
}

function diagnosticsDuration(record) {
  const value = record?.durationMs ?? record?.duration ?? record?.elapsedMs ?? record?.data?.durationMs ?? record?.planner?.durationMs;
  return typeof value === 'number' ? value : undefined;
}

function diagnosticsFinishReason(record) {
  const value = record?.finishReason ?? record?.finish_reason ?? record?.finish ?? record?.stopReason
    ?? record?.data?.finishReason ?? record?.planner?.finishReason;
  if (typeof value === 'string') return value;
  return undefined;
}

function diagnosticsIsTruncation(record) {
  const kind = diagnosticsKind(record);
  if (kind.includes('planner-truncated') || kind.includes('truncated')) return true;
  const finish = diagnosticsFinishReason(record);
  if (typeof finish === 'string' && /^(max[-_]?tokens|length|token[-_]?limit)$/i.test(finish) && /plan|apply|result|activation/.test(kind)) return true;
  const serialized = JSON.stringify(record);
  return serialized.includes('planner-truncated') || serialized.includes('planner_truncated');
}

function parseDiagnostics(path) {
  if (!existsSync(path)) {
    fail(`diagnostics file does not exist: ${path} (the v0.2 planner must write plan/apply diagnostics)`);
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* ignore a torn final line */ }
  }
  return { records };
}

function parseStreamToolResultIds(streamPath) {
  if (!streamPath || !existsSync(streamPath)) return undefined;
  const ids = [];
  const parsed = readFileSync(streamPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter(Boolean);
  for (const event of parsed) {
    if (event.type !== 'tool_result') continue;
    const id = event.callId ?? event.toolCallId ?? event.id ?? event?.data?.callId ?? event?.data?.toolCallId;
    if (typeof id === 'string' && id !== '') ids.push(id);
  }
  return { ids, eventCount: parsed.length };
}

/**
 * Evaluate every check over a parsed session.
 * @returns a report object (never throws for check failures).
 */
async function evaluate(events, header, args, options) {
  const checks = [];
  const add = (id, ok, detail, required = true) => checks.push({ id, ok, required, detail });
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const ordered = [...events].sort((a, b) => a.seq - b.seq);

  // ---- check 0: session lifecycle and log integrity ------------------------
  let contiguous = true;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].seq !== index) { contiguous = false; break; }
  }
  const toolResults = events.filter((event) => event.type === 'tool/result');
  const toolCalls = events.filter((event) => event.type === 'tool/call');
  add('session-log-contiguous', contiguous,
    contiguous ? `${events.length} events, seq 0..${events.length - 1}` : 'event seqs are not contiguous from 0');
  add('session-lifecycle', Boolean(header && typeof header.id === 'string'),
    header ? `session ${header.id}` : 'missing session header event');
  add('tool-activity', toolCalls.length >= 1 && toolResults.length >= 2,
    `${toolCalls.length} tool/call, ${toolResults.length} tool/result events (includes replacement results)`);

  // ---- check 0b: the v0.2 planner must not reappear as a hidden subagent -----
  const subagentEvents = events.filter((event) => typeof event.type === 'string' && event.type.startsWith('subagent/'));
  add('no-subagent-events', !args.requireNoSubagents || subagentEvents.length === 0,
    subagentEvents.length === 0
      ? 'no subagent/* events in the main session log (v0.2 planner is a direct LLM call)'
      : `${subagentEvents.length} subagent/* event(s): ${JSON.stringify(subagentEvents.slice(0, 5).map((event) => event.type))} — the planner regression returned`,
    args.requireNoSubagents);

  // ---- check 1: the plugin's prune extension (UI row source) ---------------
  // Protocol: the plugin records each slimming round as a `compaction/prune`
  // event whose `data.contextSlimmer` extension describes the round. The
  // `role=summary` extension is the data rendered by the Web UI row.
  const slimmerPrunes = events.filter((event) => event.type === 'compaction/prune'
    && event.data !== null && typeof event.data === 'object'
    && event.data.contextSlimmer !== null && typeof event.data.contextSlimmer === 'object');
  const slimmerSummaries = slimmerPrunes.filter((event) => event.data.contextSlimmer.role === 'summary');
  const legacyRecords = events.filter((event) => event.type === args.legacyEventType);
  add('slimmer-prune-record', slimmerPrunes.length >= 1 && slimmerSummaries.length >= 1,
    `compaction/prune events with contextSlimmer: ${slimmerPrunes.length} (role=summary: ${slimmerSummaries.length})`
    + (legacyRecords.length > 0 ? `; legacy plugin records: ${legacyRecords.length}` : '')
    + (slimmerPrunes.length > 0
      ? `; sample contextSlimmer=${JSON.stringify(slimmerPrunes[0].data.contextSlimmer).slice(0, 500)}`
      : ' — the plugin did not attach data.contextSlimmer to any compaction/prune event'));

  // The summary payload is what the Web UI renders as one row: every summary
  // must be applied, list at least one landed item, and point at the replacement
  // events it produced.
  const summaryProblems = [];
  const summaryItems = [];
  for (const summary of slimmerSummaries) {
    const meta = summary.data.contextSlimmer;
    if (meta.status !== 'applied') summaryProblems.push(`seq ${summary.seq}: status=${String(meta.status)}`);
    const items = Array.isArray(meta.items) ? meta.items : [];
    if (items.length === 0) summaryProblems.push(`seq ${summary.seq}: items[] is empty`);
    for (const item of items) {
      summaryItems.push({ summarySeq: summary.seq, ...item });
      const replacementEvent = bySeq.get(item.replacementSeq);
      if (!replacementEvent || !isReplaceEvent(replacementEvent) || replacementEvent.type !== 'tool/result') {
        summaryProblems.push(`seq ${summary.seq}: items[${item.index}].replacementSeq=${item.replacementSeq} is not a tool/result replacement event`);
      }
      if (!(item.charsAfter < item.charsBefore)) summaryProblems.push(`seq ${summary.seq}: items[${item.index}] did not shrink (${item.charsBefore} -> ${item.charsAfter})`);
      const originSeq = Array.isArray(replacementEvent?.sourceEventSeqs) ? replacementEvent.sourceEventSeqs[0] : undefined;
      if (typeof originSeq === 'number') {
        const originChars = messageChars(bySeq.get(originSeq)?.data?.message);
        const landedChars = messageChars(replacementEvent?.data?.message);
        if (!(landedChars < originChars)) summaryProblems.push(`seq ${summary.seq}: items[${item.index}] replacement is not smaller than the cited original (${originChars} -> ${landedChars})`);
      }
    }
    const totals = meta.totals ?? {};
    if (!(totals.charsSaved > 0)) summaryProblems.push(`seq ${summary.seq}: totals.charsSaved=${String(totals.charsSaved)} is not positive`);
  }
  add('slimmer-summary-consistent', summaryProblems.length === 0,
    summaryProblems.length === 0
      ? `${slimmerSummaries.length} applied summary payload(s); ${summaryItems.length} landed item(s): ${JSON.stringify(summaryItems.map((item) => ({ callId: item.callId, toolName: item.toolName, op: item.op, before: item.charsBefore, after: item.charsAfter }))).slice(0, 700)}`
      : summaryProblems.join('; ').slice(0, 900));

  // ---- check 2: replacement surface events --------------------------------
  // A replacement may cite an append-origin event directly, or cite an earlier
  // replacement of the same node (a second slimming round); resolve both back
  // to the append-origin event so the plugin's rewrites are identified.
  const replacements = events.filter((event) => isReplaceEvent(event));
  const appendSurface = events.filter((event) => isAppendEvent(event));
  const replacementBySeq = new Map(replacements.map((event) => [event.seq, event]));
  const resolveOrigin = (seq, depth = 0) => {
    if (depth > 32) return undefined;
    const citedEvent = bySeq.get(seq);
    if (!citedEvent) return undefined;
    if (isAppendEvent(citedEvent)) return { seq, event: citedEvent };
    const chained = replacementBySeq.get(seq);
    if (!chained) return undefined;
    for (const chainedSeq of chained.sourceEventSeqs ?? []) {
      const resolved = resolveOrigin(chainedSeq, depth + 1);
      if (resolved) return resolved;
    }
    return undefined;
  };
  const citedByReplacement = [];
  const pluginReplacements = [];
  let replacementError;
  for (const replacement of replacements) {
    // The plugin's rewrites are tool/result surface replacements; other types
    // (e.g. a compaction summary) are reported separately below.
    if (replacement.type !== 'tool/result') continue;
    const cited = Array.isArray(replacement.sourceEventSeqs) ? replacement.sourceEventSeqs : [];
    if (cited.length === 0) { replacementError = `replacement at seq ${replacement.seq} has no sourceEventSeqs`; break; }
    const resolved = [];
    const unresolved = [];
    for (const seq of cited) {
      const origin = resolveOrigin(seq);
      if (!origin) { unresolved.push(seq); continue; }
      resolved.push(origin);
      citedByReplacement.push({ replacementSeq: replacement.seq, citedSeq: seq, originalSeq: origin.seq, type: origin.event.type });
    }
    const citedToolResults = resolved.filter((origin) => origin.event.type === 'tool/result');
    if (citedToolResults.length === 0) continue;
    if (unresolved.length > 0) {
      replacementError = `tool-result replacement at seq ${replacement.seq} cites seq ${unresolved.join(',')} which does not resolve to an append-origin surface event`;
      break;
    }
    pluginReplacements.push({ replacement, citedToolResults });
    if (replacement.seq <= Math.max(...cited)) { replacementError = `replacement at seq ${replacement.seq} does not come after its cited events`; break; }
  }
  const otherReplacements = replacements.filter((replacement) => !pluginReplacements.some((entry) => entry.replacement === replacement) && replacement.type !== 'tool/result');
  add('surface-replacement', pluginReplacements.length >= args.minReplacements && replacementError === undefined,
    replacementError ?? `${pluginReplacements.length} tool/result replacement(s) of ${replacements.length} replace event(s), ${citedByReplacement.length} cited event(s): ${pluginReplacements.map(({ replacement }) => `seq ${replacement.seq} <- [${(replacement.sourceEventSeqs ?? []).join(',')}]`).join('; ').slice(0, 600)}`);
  add('other-replacements', otherReplacements.length === 0,
    otherReplacements.length === 0
      ? 'no non-tool-result surface replacements (built-in compaction/pruning appears disabled)'
      : `${otherReplacements.length} non-tool-result replacement(s) at seq ${otherReplacements.map((event) => event.seq).join(', ')} — built-in compaction may not be fully disabled`,
    false);

  // ---- check 3: shadow-price protocol -------------------------------------
  const missingShadow = [];
  const shadowPrices = [];
  for (const { replacement, citedToolResults } of pluginReplacements) {
    const originalSeqs = new Set(citedToolResults.map((origin) => origin.seq));
    const predecessor = bySeq.get(replacement.seq - 1);
    const shadowedSeqs = Array.isArray(predecessor?.data?.shadowedSeqs) ? predecessor.data.shadowedSeqs : [];
    const range = predecessor?.data?.shadowedRange;
    const coversRange = range && typeof range.start === 'number' && typeof range.end === 'number'
      && [...originalSeqs].some((seq) => seq >= range.start && seq <= range.end);
    const intersects = shadowedSeqs.some((seq) => originalSeqs.has(seq));
    const hasSlimmerExtension = predecessor?.data?.contextSlimmer !== null && typeof predecessor?.data?.contextSlimmer === 'object';
    if (predecessor?.type === 'compaction/prune' && (intersects || coversRange) && hasSlimmerExtension) shadowPrices.push(predecessor);
    else missingShadow.push(replacement.seq);
  }
  add('shadow-price-precedes-replace', missingShadow.length === 0,
    missingShadow.length === 0
      ? `${shadowPrices.length} compaction/prune event(s) with data.contextSlimmer directly precede tool-result replacements`
      : `replacement(s) at seq ${missingShadow.join(', ')} lack an immediately preceding compaction/prune event with data.contextSlimmer`,
    args.requireShadowPrice);

  // ---- check 4: user-visible transcript not rewritten ---------------------
  const appendToolResults = appendSurface.filter((event) => event.type === 'tool/result');
  const appendTranscriptHash = sha256(appendSurface.map((event) => `${event.seq}:${event.type}:${hashEvent(event)}`).join('\n'));
  const uniqueAppendSeqs = new Set(appendSurface.map((event) => event.seq)).size === appendSurface.length;
  const userMessages = appendSurface.filter((event) => event.type === 'user/message');
  const extraUserMessages = Math.max(0, userMessages.length - args.maxUserMessages);
  add('transcript-append-only', contiguous && uniqueAppendSeqs,
    `append-origin surface nodes: ${appendSurface.length} (${appendToolResults.length} tool/results); append transcript hash=${appendTranscriptHash.slice(0, 16)}…; duplicate seqs=${uniqueAppendSeqs ? 'none' : 'FOUND'}`);
  add('transcript-not-rewritten', pluginReplacements.every(({ replacement }) => replacement.seq > Math.max(0, ...(replacement.sourceEventSeqs ?? [0]), ...(replacement.sourceEventSeqs ?? []).map((seq) => resolveOrigin(seq)?.seq ?? 0))),
    'every replacement is appended after the events it shadows; originals remain in the append-origin transcript');
  add('no-user-visible-rewrite', extraUserMessages === 0,
    `user/message surface events: ${userMessages.length} (max allowed ${args.maxUserMessages}; extra user messages are legitimate policy notices, so this is advisory)`,
    false);

  // The session log is append-only by construction; cross-check the headless
  // NDJSON stream to prove the run itself emitted those same tool results.
  const stream = parseStreamToolResultIds(args.jsonStream);
  let streamOk = true;
  let streamDetail = 'json stream not provided (cross-check skipped)';
  if (stream !== undefined) {
    const logCallIds = appendToolResults
      .map((event) => event.data?.message?.toolCallId ?? event.data?.message?.source?.callId)
      .filter((id) => typeof id === 'string');
    const streamIds = stream.ids;
    const missingFromLog = streamIds.filter((id) => !logCallIds.includes(id));
    const missingFromStream = logCallIds.filter((id) => !streamIds.includes(id));
    streamOk = missingFromLog.length === 0 && (!args.strictStream || missingFromStream.length === 0);
    streamDetail = `stream tool_results=${streamIds.length}, log append tool/results=${logCallIds.length}; missing from log=[${missingFromLog.join(',')}]; missing from stream=[${missingFromStream.join(',')}]${args.strictStream ? ' (strict)' : ''}`;
  }
  add('stream-cross-check', streamOk, streamDetail);

  // ---- check 5: derived context actually shrank ---------------------------
  let fold;
  let foldMode;
  if (options.useInstalledFold) {
    fold = surfaceModule.foldSurface(ordered);
    foldMode = 'dsh-session/surface';
  } else {
    fold = builtinFold(ordered);
    foldMode = 'builtin';
  }
  const derive = (seq) => {
    const event = bySeq.get(seq);
    if (!event) return undefined;
    if (options.useInstalledFold) return surfaceModule.deriveEventMessage(event, fold.projectedMessages);
    return surfaceMessage(event);
  };
  const finalMessages = fold.nodes.map((seq) => derive(seq)).filter(Boolean);
  const finalToolByCallId = new Map();
  for (const message of finalMessages) {
    if (message.role !== 'tool') continue;
    const callId = message.toolCallId ?? message.source?.callId;
    if (typeof callId === 'string') finalToolByCallId.set(callId, message);
  }

  let totalSavings = 0;
  let bestRatio = 0;
  const reductions = [];
  for (const { replacement, citedToolResults: citedOrigins } of pluginReplacements) {
    const cited = citedOrigins.map((origin) => origin.event);
    for (const original of cited) {
      const callId = original.data?.message?.toolCallId;
      const originalChars = messageChars(original.data?.message);
      const finalMessage = (callId ? finalToolByCallId.get(callId) : undefined) ?? surfaceMessage(replacement);
      const finalChars = messageChars(finalMessage);
      const savings = originalChars - finalChars;
      if (savings > 0) {
        totalSavings += savings;
        bestRatio = Math.max(bestRatio, originalChars === 0 ? 0 : savings / originalChars);
      }
      reductions.push({ replacementSeq: replacement.seq, originalSeq: original.seq, callId: callId ?? null, originalChars, finalChars, savings });
    }
  }
  const ratioOk = bestRatio >= args.minReductionRatio;
  const savingsOk = totalSavings >= args.minSavingsChars;
  add('derived-context-shrank', ratioOk && savingsOk,
    `fold=${foldMode}; reductions=${JSON.stringify(reductions).slice(0, 700)}; total savings=${totalSavings} chars (>= ${args.minSavingsChars}), best reduction=${(bestRatio * 100).toFixed(1)}% (>= ${(args.minReductionRatio * 100).toFixed(1)}%)`);

  // Aggregate raw vs projected tool-result text across the whole session.
  const rawToolChars = appendToolResults.reduce((sum, event) => sum + messageChars(event.data?.message), 0);
  const projectedToolChars = finalMessages
    .filter((message) => message.role === 'tool')
    .reduce((sum, message) => sum + messageChars(message), 0);
  add('projected-tool-context-smaller', projectedToolChars < rawToolChars,
    `raw append tool-result text=${rawToolChars} chars, folded model-visible tool text=${projectedToolChars} chars`);

  // ---- check 6: planner observability (v0.2 diagnostics) -------------------
  // The v0.2 direct-LLM planner writes `plan`/`apply` diagnostics with usage,
  // durationMs, finishReason, and records `planner-truncated` when the output
  // budget ran out. A truncated planner is the v0.1.0 production regression.
  const diagnostics = args.diagnostics ? parseDiagnostics(args.diagnostics) : undefined;
  let plannerSummary = null;
  if (diagnostics !== undefined) {
    const records = diagnostics.records;
    const kinds = records.map((record) => diagnosticsKind(record));
    const truncations = records.filter((record) => diagnosticsIsTruncation(record));
    const planRecords = records.filter((record) => /plan|apply|result|activation/.test(diagnosticsKind(record)));
    // plan/validate/apply repeat the same planner usage; prefer the dedicated
    // llm-result record so the aggregate counts one usage per planner call.
    const llmResultRecords = records.filter((record) => /llm-result|llm_result/.test(diagnosticsKind(record)) && diagnosticsUsage(record) !== undefined);
    const usageRecords = llmResultRecords.length > 0
      ? llmResultRecords
      : records.filter((record) => diagnosticsUsage(record) !== undefined);
    const durations = records.map((record) => diagnosticsDuration(record)).filter((value) => typeof value === 'number');
    const finishReasons = records.map((record) => diagnosticsFinishReason(record)).filter((value) => typeof value === 'string');
    plannerSummary = {
      file: args.diagnostics,
      recordCount: records.length,
      kinds: [...new Set(kinds)],
      planRecords: planRecords.length,
      usageRecords: usageRecords.length,
      truncations: truncations.length,
      truncationSamples: truncations.slice(0, 3).map((record) => JSON.stringify(record).slice(0, 300)),
      usageSource: llmResultRecords.length > 0 ? 'llm-result' : 'plan/apply fallback',
      promptTokens: usageRecords.reduce((sum, record) => sum + (diagnosticsUsage(record).promptTokens ?? 0), 0),
      completionTokens: usageRecords.reduce((sum, record) => sum + (diagnosticsUsage(record).completionTokens ?? 0), 0),
      durationMs: durations.reduce((sum, value) => sum + value, 0) || undefined,
      finishReasons: [...new Set(finishReasons)],
    };
    add('planner-diagnostics-present', records.length > 0 && planRecords.length > 0,
      records.length === 0
        ? `diagnostics file is empty: ${args.diagnostics} (the v0.2 planner must write plan/apply records)`
        : `${planRecords.length} plan/apply/result record(s) in ${records.length} diagnostics event(s): kinds=[${plannerSummary.kinds.join(', ')}]`);
    add('no-planner-truncated', truncations.length === 0,
      truncations.length === 0
        ? `no planner-truncated record in ${records.length} diagnostics event(s); finishReasons=[${plannerSummary.finishReasons.join(', ')}]`
        : `${truncations.length} planner truncation record(s): ${truncations.slice(0, 3).map((record) => JSON.stringify(record).slice(0, 240)).join(' | ')}`);
    add('planner-observability', usageRecords.length > 0,
      usageRecords.length > 0
        ? `usageSources=${usageRecords.length} (${plannerSummary.usageSource}), planRecords=${planRecords.length}; promptTokens=${plannerSummary.promptTokens}, completionTokens=${plannerSummary.completionTokens}, durationMs=${plannerSummary.durationMs ?? '<missing>'}`
        : 'no plan/apply diagnostics record carried planner usage (tokens/durationMs/finishReason); the v0.2 planner should log them',
      false);
  }

  const requiredFailed = checks.filter((check) => check.required && !check.ok);
  const report = {
    ok: requiredFailed.length === 0,
    generatedAt: new Date().toISOString(),
    sessionId: header?.id ?? null,
    sessionLog: options.sessionLog ?? null,
    foldMode,
    surfaceModule: surfaceModulePath ?? null,
    eventCount: events.length,
    metrics: {
      replacementCount: replacements.length,
      pluginReplacementCount: pluginReplacements.length,
      otherReplacementCount: otherReplacements.length,
      shadowPriceCount: shadowPrices.length,
      slimmerPruneCount: slimmerPrunes.length,
      slimmerSummaryCount: slimmerSummaries.length,
      summaryCharsSaved: slimmerSummaries.reduce((sum, event) => sum + (event.data.contextSlimmer?.totals?.charsSaved ?? 0), 0),
      legacyRecordCount: legacyRecords.length,
      structuredOutputToolCalls: events.filter((event) => (event.type === 'tool/call' || event.type === 'tool/result') && (event.data?.name === 'structured_output' || event.data?.toolName === 'structured_output')).length,
      appendToolResultCount: appendToolResults.length,
      userMessageCount: userMessages.length,
      rawToolTextChars: rawToolChars,
      projectedToolTextChars: projectedToolChars,
      savingsChars: totalSavings,
      estimatedTokensSaved: Math.ceil(totalSavings / 4),
      bestReductionRatio: Number(bestRatio.toFixed(3)),
      appendTranscriptHash,
      subagentEventCount: subagentEvents.length,
      planner: plannerSummary,
    },
    checks,
    failures: requiredFailed.map((check) => `${check.id}: ${check.detail}`),
  };
  return report;
}

function hashEvent(event) {
  const { type, data, surfaceOp, sourceEventSeqs } = event;
  return sha256(JSON.stringify({ type, data, surfaceOp, sourceEventSeqs }));
}

function renderReport(report) {
  const lines = [];
  lines.push(`assert-slimming report — ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`session: ${report.sessionId ?? '<unknown>'}`);
  lines.push(`log: ${report.sessionLog ?? '<unknown>'} (${report.eventCount} events, fold=${report.foldMode})`);
  lines.push('');
  for (const check of report.checks) {
    const marker = check.ok ? 'PASS' : check.required ? 'FAIL' : 'WARN';
    lines.push(`[${marker}] ${check.id}: ${check.detail}`);
  }
  lines.push('');
  lines.push(`metrics: ${JSON.stringify(report.metrics)}`);
  if (report.failures.length > 0) {
    lines.push('', 'failures:');
    for (const failure of report.failures) lines.push(`  - ${failure}`);
  }
  return lines.join('\n') + '\n';
}

function selfTestFixture() {
  let seq = 0;
  const event = (extra) => ({ time: 1, seq: seq++, ...extra });
  const longText = 'long tool output '.repeat(120); // ~1920 chars
  const shortText = 'long tool output '.repeat(10); // ~160 chars
  return {
    header: { type: 'session', version: 4, id: 'session-selftest', cwd: '/tmp/selftest', createdAt: 1, isSeeded: false },
    events: [
      event({ type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] } } }),
      event({ type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'Run the fixed CI scenario' }], source: { kind: 'user' }, id: 'u1' } }),
      event({ type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{}' }] } } }),
      event({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_1', name: 'read', arguments: '{}' } }),
      event({ type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', content: [{ type: 'text', text: longText }], isError: false, id: 'm1' } } }),
      event({
        type: 'compaction/prune',
        data: {
          shadowedRange: { start: 4, end: 4 },
          shadowedSeqs: [4],
          shadowedTokenCount: 480,
          contextSlimmer: {
            v: 1,
            batchId: 'batch-selftest',
            role: 'summary',
            status: 'applied',
            startedAt: 1,
            finishedAt: 2,
            trigger: { everyNToolCalls: 2, minChars: 0, observedCalls: 2, observedChars: longText.length },
            model: { provider: 'deepseek-official', model: 'deepseek-flash', inherited: true },
            items: [{ index: 0, callId: 'call_1', toolName: 'read', op: 'drop', charsBefore: longText.length, charsAfter: shortText.length, replacementSeq: 6 }],
            totals: { items: 1, charsBefore: longText.length, charsAfter: shortText.length, charsSaved: longText.length - shortText.length },
          },
        },
      }),
      event({ type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 }, sourceEventSeqs: [4], data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call_1' }, toolCallId: 'call_1', content: [{ type: 'text', text: shortText }], isError: false, id: 'm1' } } }),

      event({ type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'CI_SCENARIO_DONE' }] } } }),
    ],
  };
}

function assertSelfTestReport(label, report, expectOk) {
  const ok = report.ok === expectOk;
  log(`${ok ? 'PASS' : 'FAIL'} self-test ${label}: expected ok=${expectOk}, got ok=${report.ok}${report.failures.length > 0 ? ` (failures: ${report.failures.join(' | ')})` : ''}`);
  return ok;
}

async function runSelfTest(args) {
  await loadSurfaceModule(args);
  const useInstalledFold = Boolean(surfaceModule && typeof surfaceModule.foldSurface === 'function');
  const base = selfTestFixture();
  const options = { useInstalledFold, sessionLog: '<self-test>' };
  const positive = await evaluate(base.events, base.header, args, options);
  const noReplacement = {
    header: base.header,
    events: base.events.filter((event) => !isReplaceEvent(event) && event.type !== 'compaction/prune').map((event, index) => ({ ...event, seq: index })),
  };
  const negative = await evaluate(noReplacement.events, noReplacement.header, args, options);
  const subagentFixture = {
    header: base.header,
    events: [...base.events, { time: 1, seq: base.events.length, type: 'subagent/catalog', data: { reason: 'selftest' } }],
  };
  const withSubagent = await evaluate(subagentFixture.events, subagentFixture.header, args, options);
  let ok = true;
  ok = assertSelfTestReport('positive fixture', positive, true) && ok;
  ok = assertSelfTestReport('negative fixture', negative, false) && ok;
  if (args.requireNoSubagents) ok = assertSelfTestReport('subagent negative fixture', withSubagent, false) && ok;
  // Diagnostics checks: healthy plan/apply records pass, a truncated planner
  // record fails the required gate, and an empty diagnostics file fails too
  // (a missing/empty file must not count as "no truncation").
  const diagnosticsFile = join(tmpdir(), `assert-slimming-selftest-${process.pid}.jsonl`);
  const diagnosticsRun = async (label, records) => {
    writeFileSync(diagnosticsFile, records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : ''));
    return evaluate(base.events, base.header, { ...args, diagnostics: diagnosticsFile }, options);
  };
  const healthy = await diagnosticsRun('healthy', [
    { kind: 'trigger', observedCalls: 13 },
    { kind: 'llm-result', finishReason: 'stop', durationMs: 4321, usage: { inputTokens: 100, outputTokens: 20 } },
    { kind: 'plan', plan: { items: [] } },
    { kind: 'apply', items: 1, charsSaved: 300 },
  ]);
  ok = assertSelfTestReport('diagnostics healthy fixture', healthy, true) && ok;
  if (!(healthy.metrics?.planner?.promptTokens === 100 && healthy.metrics?.planner?.completionTokens === 20)) {
    log('FAIL self-test diagnostics healthy fixture: planner usage metrics missing');
    ok = false;
  }
  const truncated = await diagnosticsRun('truncated', [
    { kind: 'planner-truncated', finishReason: 'max-tokens', durationMs: 120000, usage: { inputTokens: 100, outputTokens: 4096 } },
  ]);
  ok = assertSelfTestReport('diagnostics planner-truncated fixture', truncated, false) && ok;
  if (!(truncated.failures ?? []).some((failure) => failure.startsWith('no-planner-truncated'))) {
    log('FAIL self-test diagnostics planner-truncated fixture: no-planner-truncated did not fail');
    ok = false;
  }
  const empty = await diagnosticsRun('empty', []);
  ok = assertSelfTestReport('diagnostics empty fixture', empty, false) && ok;
  if (!(empty.failures ?? []).some((failure) => failure.startsWith('planner-diagnostics-present'))) {
    log('FAIL self-test diagnostics empty fixture: planner-diagnostics-present did not fail');
    ok = false;
  }
  await loadSurfaceModule(args);
  const fallback = await evaluate(base.events, base.header, args, { useInstalledFold: false, sessionLog: '<self-test>' });
  ok = assertSelfTestReport('builtin-fold fixture', fallback, true) && ok;
  if (surfaceModule) log(`self-test used installed fold: ${surfaceModulePath}`);
  log(ok ? 'SELF-TEST PASS' : 'SELF-TEST FAIL');
  process.exit(ok ? 0 : 1);
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { fail(error.message); }

  if (args.selfTest) {
    await runSelfTest(args);
    return;
  }

  if (args.dryRun) {
    log('dry-run plan:');
    log(`  session log: ${args.sessionLog || '<missing>'}`);
    log(`  json stream: ${args.jsonStream || '<missing>'}`);
    log('  protocol:    compaction/prune data.contextSlimmer (role=summary) + tool/result surface replace');
    log(`  artifacts:   ${args.artifactsDir}`);
    log(`  diagnostics: ${args.diagnostics || '<not provided: planner truncation check skipped>'}`);
    log(`  thresholds:  replacements>=${args.minReplacements}, savings>=${args.minSavingsChars} chars, best reduction>=${args.minReductionRatio}`);
    const modulePath = resolveSurfaceModule(args);
    log(`  fold: ${modulePath ? `dsh-session/surface at ${modulePath}` : 'builtin fallback (installed dsh not found)'}`);
    if (!args.sessionLog) fail('--session-log (or VERIFY_SESSION_JSONL) is required for a real run');
    if (!existsSync(args.sessionLog)) fail(`session log does not exist: ${args.sessionLog}`);
    log('dry-run OK (no assertion executed)');
    return;
  }

  if (!args.sessionLog) fail('--session-log (or VERIFY_SESSION_JSONL) is required');
  if (Number.isNaN(args.minReplacements) || Number.isNaN(args.minSavingsChars) || Number.isNaN(args.minReductionRatio)) {
    fail('numeric thresholds must be numbers');
  }

  const raw = readSessionLog(args.sessionLog);
  const parsed = raw.split('\n').filter((line) => line.trim() !== '').map((line, index) => {
    try { return JSON.parse(line); } catch { fail(`session log line ${index + 1} is not JSON`); }
  });
  const header = parsed.find((event) => event.type === 'session');
  const events = parsed.filter((event) => typeof event.seq === 'number');
  if (events.length === 0) fail('session log has no seq-bearing events');

  await loadSurfaceModule(args);
  const useInstalledFold = Boolean(surfaceModule && typeof surfaceModule.foldSurface === 'function');
  if (!useInstalledFold) {
    if (args.allowBuiltinFold) {
      log('warning: installed @deepseek-ai/dsh-session/surface not found; using the built-in fold (--allow-builtin-fold)');
    } else {
      fail(`cannot find @deepseek-ai/dsh-session/lib/types/surface.js (looked from "${args.dshInstallRoot || process.env.DSH_INSTALL_ROOT || 'npm root -g'}"); install dsh or pass --allow-builtin-fold`);
    }
  }

  let report;
  try {
    report = await evaluate(events, header, args, { useInstalledFold, sessionLog: args.sessionLog });
  } catch (error) {
    fail(`fold/validation failed: ${error.message}`);
  }

  mkdirSync(dirname(args.reportJson), { recursive: true });
  mkdirSync(dirname(args.reportTxt), { recursive: true });
  writeFileSync(args.reportJson, JSON.stringify(report, undefined, 2) + '\n');
  const rendered = renderReport(report);
  writeFileSync(args.reportTxt, rendered);
  process.stdout.write(rendered);
  log(`report: ${args.reportJson}`);
  log(`report: ${args.reportTxt}`);
  process.exit(report.ok ? 0 : 1);
}

await main();
