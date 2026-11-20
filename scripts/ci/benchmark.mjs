#!/usr/bin/env node
/**
 * benchmark.mjs — v0.2.0 conservative-policy benchmark (issue #2 evidence).
 *
 * Runs one deterministic composite session per mode and compares quality /
 * context size / planner overhead:
 *
 *   baseline      plugin row disabled
 *   conservative  the v0.2.0 default policy (only drop provable duplicates /
 *                 superseded / empty results)
 *   aggressive    the v0.1 lossy policy (report-only control)
 *
 * The scenario (scripts/ci/benchmark-scenario.md) reads a unique large file
 * (C1/C2 checkpoints in its middle), a duplicate large file twice (C4 in the
 * kept copy), a deterministic failing command (C3 = error code + exit code) and
 * a deterministic high-repetition log twice (C5 in its unique block). The
 * final answer must contain all five literals as JSON.
 *
 * Hard gates (docs/plan-v0.2.md §5/§9):
 *   * every baseline AND conservative run passes 5/5 checkpoints;
 *   * conservative folded tool text < baseline for the same repetition;
 *   * conservative planner truncations (`planner-truncated`) == 0;
 *   * conservative actually triggered at least one drop (otherwise the run is
 *     invalid, not "safe": rerun the whole round once, then fail);
 *   * aggressive is report-only.
 *
 * Planner overhead comes from `slimmer-diagnostics.jsonl` plan/apply records
 * (prompt/completion tokens, durationMs, finishReason, retried).
 *
 * Usage:
 *   node scripts/ci/benchmark.mjs --dry-run
 *   node scripts/ci/benchmark.mjs --repetitions 1 --write-doc
 *   node scripts/ci/benchmark.mjs --model deepseek-flash --repetitions 3
 *
 * Exit codes: 0 gates passed, 1 gate failed, 2 usage/setup error, 3 skipped
 * (no DEEPSEEK_API_KEY).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const MODES = ['baseline', 'conservative', 'aggressive'];
const CHECKPOINTS = [
  { id: 'C1', label: 'unique_code', test: (answer) => answer.unique_code === '7F3A-Q9' },
  { id: 'C2', label: 'atlas_port', test: (answer) => Number(answer.atlas_port) === 7042 },
  { id: 'C3', label: 'failure', test: (answer) => { const text = String(answer.failure ?? ''); return /ERR_BENCH_42/.test(text) && /exit\s*42/i.test(text); } },
  { id: 'C4', label: 'maint_token', test: (answer) => answer.maint_token === 'ZR-88' },
  { id: 'C5', label: 'backup_slot', test: (answer) => answer.backup_slot === 'blue-17' },
];
const FIXTURE_DIR = join(REPO_ROOT, 'scripts/ci/bench/fixture');
const SCENARIO_FILE = join(REPO_ROOT, 'scripts/ci/benchmark-scenario.md');
const PLANNER_TRUNCATION_RE = /planner[-_]truncated/;

function parseArgs(argv) {
  const args = {
    repetitions: Number(process.env.BENCHMARK_REPETITIONS ?? 1),
    model: process.env.DSH_TEST_MODEL ?? '',
    artifactsDir: process.env.CI_ARTIFACTS_DIR ?? join(process.env.RUNNER_TEMP ?? '/tmp', 'ci-artifacts'),
    timeoutSeconds: Number(process.env.BENCHMARK_TIMEOUT_SECONDS ?? 600),
    writeDoc: false,
    retryInvalidRounds: Number(process.env.BENCHMARK_RETRY_INVALID ?? 1),
    dshHomeRoot: process.env.BENCHMARK_DSH_HOME_ROOT ?? '',
    dryRun: false,
    selfTest: false,
    keepArtifacts: process.env.BENCHMARK_KEEP_ARTIFACTS === '1',
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
      case '--repetitions': args.repetitions = Number(next()); break;
      case '--model': args.model = next(); break;
      case '--artifacts-dir': args.artifactsDir = next(); break;
      case '--timeout-seconds': args.timeoutSeconds = Number(next()); break;
      case '--write-doc': args.writeDoc = true; break;
      case '--no-retry-invalid': args.retryInvalidRounds = 0; break;
      case '--dry-run': args.dryRun = true; break;
      case '--self-test': args.selfTest = true; break;
      case '--keep-artifacts': args.keepArtifacts = true; break;
      case '-h': case '--help':
        process.stdout.write('see the header of scripts/ci/benchmark.mjs for usage\n');
        process.exit(0);
        break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.repetitions) || args.repetitions < 1 || args.repetitions > 5) {
    throw new Error('--repetitions must be an integer between 1 and 5');
  }
  return args;
}

const log = (message) => process.stdout.write(`benchmark: ${message}\n`);
const warn = (message) => process.stderr.write(`benchmark: WARNING: ${message}\n`);
const die = (message) => { process.stderr.write(`benchmark: ERROR: ${message}\n`); process.exit(2); };

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fixtureInfo() {
  const files = ['unique.txt', 'duplicate.txt', 'verify.mjs', 'log.mjs'];
  const info = {};
  for (const name of files) {
    const file = join(FIXTURE_DIR, name);
    if (!existsSync(file)) die(`benchmark fixture missing: ${file}`);
    info[name] = { bytes: statSync(file).size, sha256: sha256File(file) };
  }
  if (info['unique.txt'].sha256 === info['duplicate.txt'].sha256) die('fixture sanity failure: unique.txt and duplicate.txt are identical');
  return info;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 0,
  });
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (options.check !== false && result.status !== 0) {
    const stderrTail = String(result.stderr ?? '').split('\n').slice(-12).join('\n');
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${stderrTail}`);
  }
  return result;
}

function parseEnvFile(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function configFor(mode, artifactsDir) {
  const diagnosticsFile = join(artifactsDir, 'slimmer-diagnostics.jsonl');
  if (mode === 'baseline') {
    return JSON.stringify({ enabled: false, diagnosticsFile });
  }
  if (mode === 'conservative') {
    // The v0.2 production defaults; deliberately inherit the planner model
    // settings (reasoningEffort / maxOutputTokens are host defaults).
    return JSON.stringify({
      enabled: true,
      policy: 'conservative',
      everyNToolCalls: 12,
      minChars: 24000,
      protectRecent: 3,
      minTargetChars: 4096,
      maxTargets: 4,
      timeoutMs: 180000,
      includeSubagents: true,
      triggerOnErrorOnly: false,
      promptLocale: 'zh',
      // Empty object = inherit provider/model/reasoning effort, no maxTokens cap
      // (production defaults; avoids partial-model-override copies of 'inherit').
      model: {},
      diagnosticsFile,
    });
  }
  return JSON.stringify({
    enabled: true,
    policy: 'aggressive',
    everyNToolCalls: 3,
    minChars: 0,
    protectRecent: 1,
    minTargetChars: 2048,
    maxTargets: 6,
    timeoutMs: 180000,
    includeSubagents: true,
    promptLocale: 'zh',
    model: { provider: 'inherit' },
    diagnosticsFile,
  });
}

function probeModel(args, artifactsDir) {
  if (args.model) return args.model;
  const envFile = join(artifactsDir, 'probe-env.sh');
  log('probing /models once (free) to resolve the default model');
  run('bash', ['scripts/ci/prepare-profile.sh', '--profile', 'bench-probe', '--template', 'headless', '--probe-model'], {
    env: {
      DSH_HOME: join(args.artifactsDir, 'dsh-home-probe'),
      CI_ENV_FILE: envFile,
      CI_ARTIFACTS_DIR: join(args.artifactsDir, 'probe'),
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
    },
  });
  const env = parseEnvFile(envFile);
  if (!env.DSH_TEST_MODEL) die('model probe did not record DSH_TEST_MODEL');
  args.model = env.DSH_TEST_MODEL;
  log(`model: ${args.model}`);
  return args.model;
}

function runOneMode(args, mode, repeat, round) {
  const label = `${mode}-r${repeat}`;
  const runDir = join(args.artifactsDir, `round-${round}`, label);
  mkdirSync(runDir, { recursive: true });
  const home = join(args.dshHomeRoot || artifactsHomeRoot(args), `${label}`);
  mkdirSync(home, { recursive: true });
  const profile = `bench-${label}`;
  // Keep the prepare-profile env file separate from the run-scenario env file:
  // run-scenario sources CI_ENV_FILE, whose DSH_TEST_PROFILE_HEADLESS would
  // otherwise override the --profile argument we pass explicitly.
  const prepareEnvFile = join(runDir, 'prepare-env.sh');
  const envFile = join(runDir, 'run-env.sh');
  const config = configFor(mode, runDir);
  const startedAt = Date.now();
  log(`[${label}] preparing profile (policy=${JSON.parse(config).policy ?? 'disabled'})`);
  run('bash', ['scripts/ci/prepare-profile.sh', '--profile', profile, '--template', 'headless', '--no-probe-model'], {
    env: {
      DSH_HOME: home,
      CI_ENV_FILE: prepareEnvFile,
      CI_ARTIFACTS_DIR: runDir,
      SLIMMER_CONFIG_JSON: config,
      DSH_TEST_MODEL: args.model,
    },
  });
  log(`[${label}] running the composite benchmark session (timeout ${args.timeoutSeconds}s)`);
  const scenario = run('bash', ['scripts/ci/run-scenario.sh', '--profile', profile, '--home', home, '--prompt-file', SCENARIO_FILE, '--timeout', String(args.timeoutSeconds), '--no-include-web-search'], {
    env: {
      DSH_HOME: home,
      CI_ENV_FILE: envFile,
      CI_ARTIFACTS_DIR: runDir,
      DSH_TEST_MODEL: args.model,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
    },
    check: false,
  });
  const wallMs = Date.now() - startedAt;
  const runEnv = parseEnvFile(envFile);
  const sessionLog = runEnv.VERIFY_SESSION_JSONL ?? '';
  const streamJson = runEnv.SCENARIO_JSON ?? '';
  const diagnosticsFile = join(runDir, 'slimmer-diagnostics.jsonl');
  const analysis = analyzeRun({
    mode,
    repeat,
    round,
    label,
    exitCode: scenario.status,
    wallMs,
    sessionLog,
    streamJson,
    diagnosticsFile,
    runDir,
    stderr: scenario.stderr,
  });
  analysis.wallMs = wallMs;
  writeFileSync(join(runDir, `run-${mode}-r${repeat}.json`), JSON.stringify(analysis, undefined, 2) + '\n');
  log(`[${label}] score=${analysis.score}/5 foldedToolChars=${analysis.metrics.foldedToolChars} drops=${analysis.metrics.pluginDrops} truncations=${analysis.planner.truncations} valid=${analysis.valid}${analysis.invalidReason ? ` (${analysis.invalidReason})` : ''}`);
  return analysis;
}

function artifactsHomeRoot(args) {
  return join(args.artifactsDir, 'dsh-homes');
}

function readJsonl(file) {
  if (!file || !existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line)); } catch { /* ignore a torn final line */ }
  }
  return events;
}

function messageChars(message) {
  if (!message || !Array.isArray(message.content)) return 0;
  const text = message.content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('');
  return text.length > 0 ? text.length : JSON.stringify(message.content ?? message).length;
}

/** Minimal surface fold: final node list after append/replace operations. */
function foldSurface(events) {
  const nodes = [];
  const ordered = [...events].filter((event) => typeof event.seq === 'number').sort((a, b) => a.seq - b.seq);
  const bySeq = new Map(ordered.map((event) => [event.seq, event]));
  for (const event of ordered) {
    if (event.surfaceOp === 'append') { nodes.push(event.seq); continue; }
    if (event.surfaceOp !== null && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace') {
      const startIndex = nodes.indexOf(event.surfaceOp.startSeq);
      const endIndex = nodes.indexOf(event.surfaceOp.endSeq);
      if (startIndex === -1 || endIndex === -1) continue;
      nodes.splice(startIndex, endIndex - startIndex + 1, event.seq);
    }
  }
  return nodes.map((seq) => bySeq.get(seq)).filter(Boolean);
}

function finalAssistantText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'assistant/message') continue;
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n').trim();
    if (text !== '') return text;
  }
  return '';
}

function parseAnswer(text) {
  if (!text) return undefined;
  const attempts = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* next */ }
  }
  return undefined;
}

function normalizeCall(event) {
  const name = event?.data?.name ?? event?.data?.toolName ?? '';
  const raw = event?.data?.arguments ?? event?.data?.input ?? '{}';
  let args = raw;
  try { args = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* keep raw */ }
  let canonical;
  try { canonical = JSON.stringify(args, Object.keys(args ?? {}).sort()); } catch { canonical = String(raw); }
  return { name, canonical, raw: String(raw) };
}

function analyzeDiagnostics(file) {
  const records = readJsonl(file);
  const plannerRecords = records.filter((record) => {
    const kind = String(record?.kind ?? record?.type ?? record?.event ?? record?.phase ?? '').toLowerCase();
    return kind === '' || /plan|apply|result|activation|planner|no-op|validate|trigger/.test(kind);
  });
  const usageOf = (record) => {
    const candidates = [record?.usage, record?.data?.usage, record?.planner?.usage];
    for (const usage of candidates) {
      if (usage === null || typeof usage !== 'object') continue;
      const promptTokens = usage.promptTokens ?? usage.inputTokens;
      const completionTokens = usage.completionTokens ?? usage.outputTokens;
      if (typeof promptTokens === 'number' || typeof completionTokens === 'number') {
        return { promptTokens: Number(promptTokens ?? 0), completionTokens: Number(completionTokens ?? 0) };
      }
    }
    return undefined;
  };
  const durationOf = (record) => {
    const value = record?.durationMs ?? record?.duration ?? record?.elapsedMs ?? record?.data?.durationMs ?? record?.planner?.durationMs;
    return typeof value === 'number' ? value : undefined;
  };
  const finishOf = (record) => {
    const value = record?.finishReason ?? record?.finish_reason ?? record?.finish ?? record?.stopReason ?? record?.data?.finishReason ?? record?.planner?.finishReason;
    return typeof value === 'string' ? value : undefined;
  };
  const isTruncation = (record) => {
    const serialized = JSON.stringify(record);
    if (PLANNER_TRUNCATION_RE.test(serialized)) return true;
    const kind = String(record?.kind ?? record?.type ?? record?.event ?? '').toLowerCase();
    const finish = finishOf(record);
    return typeof finish === 'string' && /^(max[-_]?tokens|length|token[-_]?limit)$/i.test(finish) && /plan|apply|planner|result|activation/.test(kind);
  };
  // plan/validate/apply repeat the same planner usage; the llm-result record is
  // the canonical once-per-call source when present.
  const llmResultRecords = records.filter((record) => /llm-result|llm_result/.test(String(record?.kind ?? record?.type ?? '').toLowerCase()) && usageOf(record) !== undefined);
  const usageRecords = llmResultRecords.length > 0 ? llmResultRecords : plannerRecords;
  const usages = usageRecords.map(usageOf).filter(Boolean);
  const durations = usageRecords.map(durationOf).filter((value) => typeof value === 'number');
  const finishReasons = [...new Set(usageRecords.map(finishOf).filter(Boolean))];
  const truncations = records.filter((record) => isTruncation(record));
  // Only the explicit boolean flags count: every plan/apply record carries
  // `"retried":false`, so matching the JSON text would count clean runs as
  // retried (observed in run 44747543865: conservative retried=3, real 0).
  const retried = records.filter((record) => record?.retried === true || record?.data?.retried === true);
  const appliedRecords = records.filter((record) => {
    const kind = String(record?.kind ?? record?.type ?? record?.event ?? '').toLowerCase();
    if (/apply/.test(kind)) return true;
    return record?.status === 'applied' || record?.data?.status === 'applied' || record?.applied === true;
  });
  return {
    file,
    recordCount: records.length,
    kinds: [...new Set(records.map((record) => String(record?.kind ?? record?.type ?? '')).filter(Boolean))],
    planCalls: plannerRecords.filter((record) => /plan/.test(String(record?.kind ?? record?.type ?? '').toLowerCase())).length,
    applyCalls: appliedRecords.length,
    promptTokens: usages.reduce((sum, usage) => sum + usage.promptTokens, 0),
    completionTokens: usages.reduce((sum, usage) => sum + usage.completionTokens, 0),
    durationMs: durations.reduce((sum, value) => sum + value, 0) || undefined,
    durations,
    finishReasons,
    retried: retried.length,
    usageSource: llmResultRecords.length > 0 ? 'llm-result' : 'plan/apply fallback',
    truncations: truncations.length,
    truncationSamples: truncations.slice(0, 3).map((record) => JSON.stringify(record).slice(0, 300)),
  };
}

function analyzeRun(input) {
  const events = readJsonl(input.sessionLog);
  const answerText = finalAssistantText(events);
  const answer = parseAnswer(answerText);
  const checks = {};
  for (const checkpoint of CHECKPOINTS) checks[checkpoint.id] = Boolean(answer && checkpoint.test(answer));
  const score = Object.values(checks).filter(Boolean).length;

  const callEvents = events.filter((event) => event.type === 'tool/call');
  const calls = callEvents.map(normalizeCall);
  const readPaths = calls.filter((call) => call.name === 'read').map((call) => `${call.raw} ${call.canonical}`);
  const bashCommands = calls.filter((call) => call.name === 'bash').map((call) => `${call.raw} ${call.canonical}`);
  const setupOk = {
    uniqueRead: readPaths.some((value) => value.includes('bench/fixture/unique.txt')),
    duplicateReads: readPaths.filter((value) => value.includes('bench/fixture/duplicate.txt')).length >= 2,
    failedCommand: bashCommands.some((value) => value.includes('bench/fixture/verify.mjs')),
    logRuns: bashCommands.filter((value) => value.includes('bench/fixture/log.mjs')).length >= 2,
    totalCalls: calls.length >= 12,
  };
  const setupComplete = Object.values(setupOk).every(Boolean);

  // Repeated calls (same tool name + canonical arguments).
  const seen = new Map();
  let duplicateReads = 0;
  for (const call of calls) {
    const key = `${call.name}:${call.canonical}`;
    if (seen.has(key) && call.name === 'read') duplicateReads += 1;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const appendToolResults = events.filter((event) => event.type === 'tool/result' && event.surfaceOp === 'append');
  const finalNodes = foldSurface(events);
  const finalToolMessages = finalNodes.filter((event) => event.type === 'tool/result' && event.data?.message);
  const foldedToolChars = finalToolMessages.reduce((sum, event) => sum + messageChars(event.data.message), 0);
  const rawToolChars = appendToolResults.reduce((sum, event) => sum + messageChars(event.data?.message), 0);

  const pruneEvents = events.filter((event) => event.type === 'compaction/prune' && event.data?.contextSlimmer);
  const summaries = pruneEvents.filter((event) => event.data.contextSlimmer.role === 'summary');
  const items = summaries.flatMap((event) => Array.isArray(event.data.contextSlimmer.items) ? event.data.contextSlimmer.items : []);
  const replacements = events.filter((event) => event.type === 'tool/result' && event.surfaceOp !== null && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace');
  const pluginDrops = items.filter((item) => item.op === 'drop').length;
  const pluginTrims = items.filter((item) => item.op === 'trim').length;
  const dropLegality = items.filter((item) => item.op === 'drop').map((item) => ({
    callId: item.callId,
    toolName: item.toolName,
    kind: item.evidence?.kind ?? item.kind ?? (item.duplicateOf !== undefined || item.replaces !== undefined ? 'has-reference' : undefined),
    duplicateOf: item.duplicateOf ?? item.replaces ?? item.evidence?.duplicateOf,
    charsBefore: item.charsBefore,
    charsAfter: item.charsAfter,
  }));
  const subagentEvents = events.filter((event) => typeof event.type === 'string' && event.type.startsWith('subagent/'));

  // Billed usage: assistant/message events carry `usage`.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let modelSteps = 0;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    modelSteps += 1;
    const usage = event.data?.usage ?? event.usage;
    if (!usage) continue;
    inputTokens += Number(usage.inputTokens ?? 0);
    outputTokens += Number(usage.outputTokens ?? 0);
    cacheReadTokens += Number(usage.cacheReadTokens ?? 0);
    cacheWriteTokens += Number(usage.cacheWriteTokens ?? 0);
  }
  const planner = analyzeDiagnostics(input.diagnosticsFile);
  const estimatedContextTokens = Math.ceil(finalNodes.reduce((sum, event) => sum + messageChars(event.data?.message ?? event.data), 0) / 4);
  const costCny = Number((((Math.max(0, inputTokens) * 0.15 + cacheReadTokens * 0.003 + outputTokens * 0.6) / 1_000_000) * 7.2).toFixed(4));

  const invalidReasons = [];
  if (input.exitCode !== 0) invalidReasons.push(`session exited ${input.exitCode}; stderr=${String(input.stderr ?? '').split('\n').slice(-4).join(' | ').slice(0, 400)}`);
  if (!setupComplete) invalidReasons.push(`scenario setup incomplete: ${JSON.stringify(setupOk)}`);
  if (!answer) invalidReasons.push('final answer is not a parseable JSON object');
  if (input.mode === 'conservative') {
    if (pluginDrops < 1 && replacements.length < 1) invalidReasons.push('conservative performed no drop/replacement (invalid run: not "safe")');
    if (planner.truncations > 0) invalidReasons.push(`planner truncation(s): ${planner.truncations}`);
  }
  const valid = invalidReasons.length === 0;

  return {
    mode: input.mode,
    repeat: input.repeat,
    round: input.round,
    label: input.label,
    startedAt: new Date().toISOString(),
    exitCode: input.exitCode,
    valid,
    invalidReason: invalidReasons.length > 0 ? invalidReasons.join('; ') : undefined,
    answerRaw: answerText.slice(0, 2_000),
    answer,
    checks,
    score,
    setup: setupOk,
    setupComplete,
    metrics: {
      rawToolChars,
      foldedToolChars,
      foldedReduction: rawToolChars === 0 ? 0 : Number((1 - foldedToolChars / rawToolChars).toFixed(3)),
      estimatedContextTokens,
      toolCallsTotal: calls.length,
      modelSteps,
      subagentEvents: subagentEvents.length,
      duplicateReads,
      pruneEvents: pruneEvents.length,
      summaryEvents: summaries.length,
      pluginReplacements: replacements.length,
      pluginDrops,
      pluginTrims,
      dropLegality,
      billedTokens: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, total: inputTokens + outputTokens },
      costCny,
    },
    planner: {
      file: input.diagnosticsFile,
      recordCount: planner.recordCount,
      kinds: planner.kinds,
      planCalls: planner.planCalls,
      applyCalls: planner.applyCalls,
      promptTokens: planner.promptTokens,
      completionTokens: planner.completionTokens,
      durationMs: planner.durationMs,
      finishReasons: planner.finishReasons,
      retried: planner.retried,
      truncations: planner.truncations,
      truncationSamples: planner.truncationSamples,
    },
    wallMs: input.wallMs,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(runs) {
  const modes = {};
  for (const mode of MODES) {
    const modeRuns = runs.filter((run) => run.mode === mode);
    if (modeRuns.length === 0) continue;
    modes[mode] = {
      runs: modeRuns.map((run) => run.label),
      validRuns: modeRuns.filter((run) => run.valid).length,
      minScore: Math.min(...modeRuns.map((run) => run.score)),
      scores: modeRuns.map((run) => run.score),
      medianFoldedToolChars: median(modeRuns.map((run) => run.metrics.foldedToolChars)),
      medianRawToolChars: median(modeRuns.map((run) => run.metrics.rawToolChars)),
      medianDuplicateReads: median(modeRuns.map((run) => run.metrics.duplicateReads)),
      medianEstimatedContextTokens: median(modeRuns.map((run) => run.metrics.estimatedContextTokens)),
      medianBilledTokens: median(modeRuns.map((run) => run.metrics.billedTokens.total)),
      medianWallMs: median(modeRuns.map((run) => run.wallMs)),
      pluginDrops: modeRuns.reduce((sum, run) => sum + run.metrics.pluginDrops, 0),
      pluginTrims: modeRuns.reduce((sum, run) => sum + run.metrics.pluginTrims, 0),
      plannerPromptTokens: modeRuns.reduce((sum, run) => sum + run.planner.promptTokens, 0),
      plannerCompletionTokens: modeRuns.reduce((sum, run) => sum + run.planner.completionTokens, 0),
      plannerDurationMs: modeRuns.reduce((sum, run) => sum + (run.planner.durationMs ?? 0), 0),
      plannerRecords: modeRuns.reduce((sum, run) => sum + run.planner.planCalls, 0),
      plannerFinishReasons: [...new Set(modeRuns.flatMap((run) => run.planner.finishReasons))],
      plannerTruncations: modeRuns.reduce((sum, run) => sum + run.planner.truncations, 0),
      medianCostCny: median(modeRuns.map((run) => run.metrics.costCny)),
    };
  }
  return modes;
}

function evaluateGates(runs, summary, repetitions) {
  const failures = [];
  const baselines = runs.filter((run) => run.mode === 'baseline');
  const conservatives = runs.filter((run) => run.mode === 'conservative');
  for (const run of baselines) {
    if (!run.valid) failures.push(`${run.label}: invalid run (${run.invalidReason})`);
    if (run.score !== 5) failures.push(`${run.label}: baseline scored ${run.score}/5 (must be 5/5)`);
  }
  for (const run of conservatives) {
    if (!run.valid) failures.push(`${run.label}: invalid run (${run.invalidReason})`);
    if (run.score !== 5) failures.push(`${run.label}: conservative scored ${run.score}/5 (must be 5/5)`);
    if (run.planner.truncations !== 0) failures.push(`${run.label}: conservative planner truncations=${run.planner.truncations} (must be 0)`);
    if (run.metrics.pluginDrops + run.metrics.pluginTrims < 1) failures.push(`${run.label}: conservative never slimmed (0 prune/replace events)`);
    if (run.planner.recordCount === 0 || run.planner.planCalls === 0) failures.push(`${run.label}: no planner diagnostics (plan/apply records) — cannot prove the truncation gate`);
    const baseline = baselines.find((candidate) => candidate.repeat === run.repeat);
    if (baseline && run.metrics.foldedToolChars >= baseline.metrics.foldedToolChars) {
      failures.push(`${run.label}: folded tool text ${run.metrics.foldedToolChars} >= baseline ${baseline.metrics.foldedToolChars}`);
    }
  }
  const gate = {
    repetitions,
    baselineAll5: baselines.length > 0 && baselines.every((run) => run.valid && run.score === 5),
    conservativeAll5: conservatives.length > 0 && conservatives.every((run) => run.valid && run.score === 5),
    conservativeFoldedLessThanBaseline: conservatives.every((run) => {
      const baseline = baselines.find((candidate) => candidate.repeat === run.repeat);
      return baseline !== undefined && run.metrics.foldedToolChars < baseline.metrics.foldedToolChars;
    }),
    conservativeNoPlannerTruncation: conservatives.every((run) => run.planner.truncations === 0),
    conservativeSlimmed: conservatives.every((run) => run.metrics.pluginDrops + run.metrics.pluginTrims >= 1),
    aggressiveReportOnly: true,
    failures,
    pass: failures.length === 0,
  };
  return gate;
}

function renderMarkdown(report) {
  const { summary, gate, runs, fixture, model, repetitions } = report;
  const lines = [];
  lines.push('# Benchmark — conservative 默认策略的非劣演示（v0.2.0 / issue #2）');
  lines.push('');
  lines.push(`- 模型：\`${model ?? '<probed>'}\`；重复次数：R=${repetitions}（模式交错 B/C/A）；场景：\`scripts/ci/benchmark-scenario.md\``);
  lines.push(`- fixture：${Object.entries(fixture).map(([name, info]) => `\`${name}\` (${info.bytes} B, sha256:${info.sha256.slice(0, 12)}…)`).join('，')}`);
  lines.push(`- 结论：**非劣演示（${repetitions === 1 ? 'single-run' : `R=${repetitions}`}）**——baseline 与 conservative 每次运行 5/5、conservative 折叠后工具文本更少；这不是统计显著性结论。`);
  lines.push('');
  lines.push('## 1. 质量与 token');
  lines.push('');
  lines.push('| 模式 | 运行 | 校验点 | folded 工具文本（中位） | raw 工具文本（中位） | 重复 read（中位） | billed tokens（中位） | cost ¥（中位） | drops/trims | planner 截断 |');
  lines.push('| :-- | --: | :-- | --: | --: | --: | --: | --: | :-- | --: |');
  for (const mode of MODES) {
    const info = summary[mode];
    if (!info) continue;
    lines.push(`| ${mode} | ${info.runs.join(', ')} | ${info.scores.join(', ')} | ${info.medianFoldedToolChars} | ${info.medianRawToolChars} | ${info.medianDuplicateReads} | ${info.medianBilledTokens} | ${info.medianCostCny} | ${info.pluginDrops}/${info.pluginTrims} | ${info.plannerTruncations} |`);
  }
  lines.push('');
  lines.push('## 2. planner 开销（diagnostics plan/apply）');
  lines.push('');
  lines.push('| 模式 | plan 调用 | prompt tokens | completion tokens | durationMs | finishReason | 截断 |');
  lines.push('| :-- | --: | --: | --: | --: | :-- | --: |');
  for (const mode of MODES) {
    const info = summary[mode];
    if (!info) continue;
    lines.push(`| ${mode} | ${info.plannerRecords ?? '-'} | ${info.plannerPromptTokens} | ${info.plannerCompletionTokens} | ${info.plannerDurationMs} | ${info.plannerFinishReasons.join(', ') || '-'} | ${info.plannerTruncations} |`);
  }
  lines.push('');
  lines.push('## 3. 每次运行明细');
  lines.push('');
  lines.push('| run | valid | C1 | C2 | C3 | C4 | C5 | score | folded | raw | drops | truncations | finishReason |');
  lines.push('| :-- | :-- | :-- | :-- | :-- | :-- | :-- | --: | --: | --: | --: | --: | :-- |');
  for (const run of runs) {
    lines.push(`| ${run.label} | ${run.valid ? 'yes' : 'NO'}${run.invalidReason ? ` (${run.invalidReason})` : ''} | ${run.checks.C1 ? '✅' : '❌'} | ${run.checks.C2 ? '✅' : '❌'} | ${run.checks.C3 ? '✅' : '❌'} | ${run.checks.C4 ? '✅' : '❌'} | ${run.checks.C5 ? '✅' : '❌'} | ${run.score}/5 | ${run.metrics.foldedToolChars} | ${run.metrics.rawToolChars} | ${run.metrics.pluginDrops} | ${run.planner.truncations} | ${run.planner.finishReasons.join(', ') || '-'} |`);
  }
  lines.push('');
  lines.push('## 4. 门禁');
  lines.push('');
  lines.push(`- baseline 与 conservative 每次 5/5：${gate.baselineAll5 && gate.conservativeAll5 ? 'PASS' : 'FAIL'}`);
  lines.push(`- conservative 折叠后工具文本 < baseline：${gate.conservativeFoldedLessThanBaseline ? 'PASS' : 'FAIL'}`);
  lines.push(`- conservative planner 截断 = 0：${gate.conservativeNoPlannerTruncation ? 'PASS' : 'FAIL'}`);
  lines.push(`- conservative 至少发生一次精简：${gate.conservativeSlimmed ? 'PASS' : 'FAIL'}`);
  lines.push(`- aggressive 仅报告（不设门禁）：${summary.aggressive ? summary.aggressive.scores.join(', ') : 'n/a'}`);
  lines.push(`- 总门禁：${gate.pass ? '**PASS**' : '**FAIL**'}`);
  if (gate.failures.length > 0) {
    lines.push('', '失败项：');
    for (const failure of gate.failures) lines.push(`  - ${failure}`);
  }
  lines.push('');
  lines.push('> 说明：本表由 `scripts/ci/benchmark.mjs` 自动生成；单次/少量重复只能作为非劣演示，不能宣称统计显著（见 `docs/research/benchmark-design.md` §5）。');
  lines.push('');
  return lines.join('\n');
}

function renderSummaryTable(report) {
  const lines = ['### Context Slimmer benchmark', ''];
  lines.push(`model \`${report.model ?? '<probed>'}\`, R=${report.repetitions}, gate=${report.gate.pass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('| mode | scores | folded tool chars (median) | drops/trims | planner truncations |');
  lines.push('| :-- | :-- | --: | :-- | --: |');
  for (const mode of MODES) {
    const info = report.summary[mode];
    if (!info) continue;
    lines.push(`| ${mode} | ${info.scores.join(', ')} | ${info.medianFoldedToolChars} | ${info.pluginDrops}/${info.pluginTrims} | ${info.plannerTruncations} |`);
  }
  if (report.gate.failures.length > 0) {
    lines.push('', 'Failures:');
    for (const failure of report.gate.failures.slice(0, 8)) lines.push(`- ${failure}`);
  }
  lines.push('');
  return lines.join('\n');
}


/**
 * Offline self-test for the analyzer path: builds a synthetic baseline run and a
 * synthetic conservative run (prune + replacement + diagnostics) and checks the
 * checkpoint grading, fold-based tool text metrics, planner aggregation and the
 * gate evaluation. No model call, no network.
 */
function runSelfTest(args) {
  const root = join(args.artifactsDir, 'benchmark-self-test');
  mkdirSync(root, { recursive: true });
  let failures = 0;
  const check = (label, condition, detail) => {
    if (!condition) failures += 1;
    process.stdout.write(`${condition ? 'PASS' : 'FAIL'} self-test ${label}${detail ? `: ${detail}` : ''}\n`);
  };

  const answer = { unique_code: '7F3A-Q9', atlas_port: 7042, failure: 'ERR_BENCH_42/exit 42', maint_token: 'ZR-88', backup_slot: 'blue-17' };
  const toolCall = (seq, name, argsJson) => ({ type: 'tool/call', seq, data: { callId: `call-${seq}`, name, arguments: argsJson } });
  const toolResult = (seq, callId, text) => ({ type: 'tool/result', seq, surfaceOp: 'append', sourceEventSeqs: [], data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } } });
  const calls = [
    ['read', '{"file_path":"scripts/ci/bench/fixture/unique.txt"}'],
    ['read', '{"file_path":"scripts/ci/bench/fixture/duplicate.txt"}'],
    ['bash', '{"command":"node scripts/ci/bench/fixture/verify.mjs"}'],
    ['bash', '{"command":"node scripts/ci/bench/fixture/log.mjs"}'],
    ['bash', '{"command":"node scripts/ci/bench/fixture/log.mjs"}'],
    ['read', '{"file_path":"scripts/ci/bench/fixture/duplicate.txt"}'],
    ['bash', '{"command":"wc -l scripts/ci/bench/fixture/unique.txt"}'],
    ['bash', '{"command":"wc -l scripts/ci/bench/fixture/duplicate.txt"}'],
    ['bash', '{"command":"ls scripts/ci/bench/fixture"}'],
    ['bash', '{"command":"git status --short"}'],
    ['bash', '{"command":"pwd"}'],
    ['bash', '{"command":"tail -1 scripts/ci/bench/fixture/unique.txt"}'],
  ];
  const events = [{ type: 'session', id: 'session-selftest' }];
  let seq = 0;
  for (const [name, callArgs] of calls) {
    events.push(toolCall(seq, name, callArgs));
    events.push(toolResult(seq + 1, `call-${seq}`, `RESULT-${seq} ` + 'x'.repeat(name === 'read' ? 400 : 60)));
    seq += 2;
  }
  const finalSeq = seq;
  events.push({ type: 'assistant/message', seq: finalSeq, data: { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(answer) }] }, usage: { inputTokens: 1000, outputTokens: 30 } } });
  const baselineLog = join(root, 'baseline.jsonl');
  writeFileSync(baselineLog, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const diagnostics = join(root, 'diagnostics.jsonl');
  writeFileSync(diagnostics, [
    { kind: 'trigger', observedCalls: 12 },
    { kind: 'plan', usage: { promptTokens: 500, completionTokens: 120 }, durationMs: 4000, finishReason: 'stop' },
    { kind: 'apply', items: 1, charsSaved: 350 },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');

  const baseline = analyzeRun({
    mode: 'baseline', repeat: 1, round: 1, label: 'selftest-baseline', exitCode: 0,
    wallMs: 1000, sessionLog: baselineLog, streamJson: '', diagnosticsFile: diagnostics, runDir: root, stderr: '',
  });
  check('baseline 5/5', baseline.score === 5, `score=${baseline.score}`);
  check('baseline valid', baseline.valid, baseline.invalidReason);
  check('baseline setup complete', baseline.setupComplete, JSON.stringify(baseline.setup));
  check('baseline duplicate reads (duplicate.txt twice)', baseline.metrics.duplicateReads === 1, `duplicateReads=${baseline.metrics.duplicateReads}`);
  check('baseline planner usage', baseline.planner.promptTokens === 500 && baseline.planner.completionTokens === 120, JSON.stringify({ prompt: baseline.planner.promptTokens, completion: baseline.planner.completionTokens }));

  // Conservative variant: drop the first duplicate read (append-origin seq 3) and
  // replace it with a short stub; planner diagnostics stay clean.
  const conservativeEvents = events.map((event) => ({ ...event }));
  const pruneSeq = finalSeq + 1;
  const replaceSeq = finalSeq + 2;
  conservativeEvents.push({
    type: 'compaction/prune', seq: pruneSeq,
    data: { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 100, contextSlimmer: {
      v: 1, batchId: 'selftest', role: 'summary', status: 'applied',
      items: [{ index: 0, callId: 'call-2', toolName: 'read', op: 'drop', charsBefore: 407, charsAfter: 120, replacementSeq: replaceSeq, evidence: { kind: 'duplicate', duplicateOf: 'call-6' } }],
      totals: { items: 1, charsBefore: 407, charsAfter: 120, charsSaved: 287 },
    } },
  });
  conservativeEvents.push({ type: 'tool/result', seq: replaceSeq, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3], data: { message: { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: 'x'.repeat(120) }] } } });
  const conservativeLog = join(root, 'conservative.jsonl');
  writeFileSync(conservativeLog, conservativeEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const conservative = analyzeRun({
    mode: 'conservative', repeat: 1, round: 1, label: 'selftest-conservative', exitCode: 0,
    wallMs: 1000, sessionLog: conservativeLog, streamJson: '', diagnosticsFile: diagnostics, runDir: root, stderr: '',
  });
  check('conservative 5/5', conservative.score === 5, `score=${conservative.score}`);
  check('conservative valid', conservative.valid, conservative.invalidReason);
  check('conservative dropped', conservative.metrics.pluginDrops === 1, `drops=${conservative.metrics.pluginDrops}`);
  check('conservative folded < baseline', conservative.metrics.foldedToolChars < baseline.metrics.foldedToolChars, `${conservative.metrics.foldedToolChars} < ${baseline.metrics.foldedToolChars}`);

  // Truncated planner must invalidate a conservative run.
  const truncatedDiagnostics = join(root, 'diagnostics-truncated.jsonl');
  writeFileSync(truncatedDiagnostics, JSON.stringify({ kind: 'plan', finishReason: 'max-tokens', usage: { promptTokens: 500, completionTokens: 4096 } }) + '\n');
  const truncated = analyzeRun({
    mode: 'conservative', repeat: 1, round: 1, label: 'selftest-truncated', exitCode: 0,
    wallMs: 1000, sessionLog: conservativeLog, streamJson: '', diagnosticsFile: truncatedDiagnostics, runDir: root, stderr: '',
  });
  check('planner truncation invalidates conservative', !truncated.valid && truncated.planner.truncations > 0, truncated.invalidReason);

  const gate = evaluateGates([baseline, conservative], summarize([baseline, conservative]), 1);
  check('gate passes for baseline+conservative', gate.pass, gate.failures.join(' | '));
  process.stdout.write(failures === 0 ? 'SELF-TEST PASS\n' : `SELF-TEST FAIL (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { die(error.message); }
  const fixture = fixtureInfo();
  if (args.selfTest) {
    runSelfTest(args);
    return;
  }
  if (args.dryRun) {
    log('dry-run plan:');
    log(`  repo: ${REPO_ROOT}`);
    log(`  scenario: ${SCENARIO_FILE}`);
    log(`  fixtures: ${Object.entries(fixture).map(([name, info]) => `${name}=${info.bytes}B`).join(', ')}`);
    log(`  modes: ${MODES.join(', ')} (interleaved B/C/A; baseline = plugin disabled, conservative = v0.2 default, aggressive = report-only)`);
    log(`  repetitions: ${args.repetitions}; artifacts: ${args.artifactsDir}`);
    log(`  per-run timeout: ${args.timeoutSeconds}s; retry invalid rounds: ${args.retryInvalidRounds}`);
    log(`  model: ${args.model || '<probe /models once>'}`);
    log(`  write docs/benchmark.md: ${args.writeDoc}`);
    log('dry-run OK (no profile, no network, no model call)');
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    warn('DEEPSEEK_API_KEY is not set: skipping the paid benchmark.');
    process.exit(3);
  }
  mkdirSync(args.artifactsDir, { recursive: true });
  probeModel(args, args.artifactsDir);
  log(`starting ${args.repetitions} repetition(s) × ${MODES.length} modes, interleaved B/C/A`);

  let runs = [];
  let gate;
  let attempt = 0;
  const maxAttempts = 1 + Math.max(0, args.retryInvalidRounds);
  while (attempt < maxAttempts) {
    attempt += 1;
    runs = [];
    for (let repeat = 1; repeat <= args.repetitions; repeat += 1) {
      for (const mode of MODES) {
        runs.push(runOneMode(args, mode, repeat, attempt));
      }
    }
    const summary = summarize(runs);
    gate = evaluateGates(runs, summary, args.repetitions);
    const invalidRequired = runs.filter((run) => run.mode !== 'aggressive' && !run.valid);
    if (gate.pass || invalidRequired.length === 0 || attempt >= maxAttempts) break;
    warn(`round ${attempt} had ${invalidRequired.length} invalid required run(s); rerunning the whole round once (${attempt + 1}/${maxAttempts})`);
  }

  const summary = summarize(runs);
  const report = {
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    model: args.model,
    repetitions: args.repetitions,
    attempts: attempt,
    fixture,
    runs,
    summary,
    gate,
    pass: gate.pass,
  };
  const markdown = renderMarkdown(report);
  writeFileSync(join(args.artifactsDir, 'benchmark-report.json'), JSON.stringify(report, undefined, 2) + '\n');
  writeFileSync(join(args.artifactsDir, 'benchmark.md'), markdown);
  writeFileSync(join(args.artifactsDir, 'benchmark-summary.md'), renderSummaryTable(report));
  if (args.writeDoc) {
    const docPath = join(REPO_ROOT, 'docs/benchmark.md');
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, markdown);
    log(`wrote ${docPath}`);
  }
  process.stdout.write(markdown);
  log(`report: ${join(args.artifactsDir, 'benchmark-report.json')}`);
  log(gate.pass ? 'BENCHMARK PASS' : `BENCHMARK FAIL (${gate.failures.length} failure(s))`);
  process.exit(gate.pass ? 0 : 1);
}

main();
