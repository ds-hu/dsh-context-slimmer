#!/usr/bin/env bash
# run-scenario.sh — run ONE real, cost-capped DSH headless session and collect
# the evidence the assertion/screenshot steps need.
#
# The scenario is a fixed, short task that produces exactly the inputs the
# plugin prunes: a large file read, a failing bash command, and one web search.
# It is intentionally boring: small output cap, cheapest reasoning effort, one
# turn, no exploration. The model must not be asked to retry or explain.
#
# Side effects (all inside the CI workspace / temp DSH_HOME):
#   * writes and removes a large fixture file in the workspace,
#   * runs a real model session (DEEPSEEK_API_KEY required),
#   * copies a plain-JSONL session log to $CI_ARTIFACTS_DIR/verify-session.jsonl,
#   * registers the session in $DSH_HOME/storages/workspace.json so the Web GUI
#     lists it for the screenshot step.
#
# Usage:
#   scripts/ci/run-scenario.sh                 # real run
#   scripts/ci/run-scenario.sh --dry-run       # validate wiring, no API call
#   scripts/ci/run-scenario.sh --no-include-web-search
#   scripts/ci/run-scenario.sh --timeout 600
#
# Exit codes: 0 session completed, 1 failure, 3 skipped (no API key).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
DSH_HOME="${DSH_HOME:-$RUNNER_TEMP/dsh-home}"
CI_ENV_FILE="${CI_ENV_FILE:-$RUNNER_TEMP/ci-env.sh}"
CI_ARTIFACTS_DIR="${CI_ARTIFACTS_DIR:-$RUNNER_TEMP/ci-artifacts}"
DSH_WORKSPACE_ROOT="${DSH_WORKSPACE_ROOT:-$REPO_ROOT}"

PROFILE="${DSH_TEST_PROFILE:-${DSH_TEST_PROFILE_HEADLESS:-ci-headless}}"
DRY_RUN=0
SCENARIO_TIMEOUT_SECONDS="${SCENARIO_TIMEOUT_SECONDS:-900}"
INCLUDE_WEB_SEARCH="${INCLUDE_WEB_SEARCH:-1}"
SLIMMER_FIXTURE_LINES="${SLIMMER_FIXTURE_LINES:-200}"
KEEP_FIXTURE="${KEEP_FIXTURE:-0}"
FIXTURE_FILE="$DSH_WORKSPACE_ROOT/.ci-fixture-large.txt"
PROMPT=""

log()  { printf 'run-scenario: %s\n' "$*"; }
warn() { printf 'run-scenario: WARNING: %s\n' "$*" >&2; }
die()  { printf 'run-scenario: ERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --home) DSH_HOME="${2:?--home needs a value}"; shift 2 ;;
    --timeout) SCENARIO_TIMEOUT_SECONDS="${2:?--timeout needs a value}"; shift 2 ;;
    --include-web-search) INCLUDE_WEB_SEARCH=1; shift ;;
    --no-include-web-search) INCLUDE_WEB_SEARCH=0; shift ;;
    --prompt-file) PROMPT="$(cat "${2:?--prompt-file needs a value}")"; shift 2 ;;
    --keep-fixture) KEEP_FIXTURE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

mkdir -p "$(dirname "$CI_ENV_FILE")" "$CI_ARTIFACTS_DIR"

set_env() {
  local key="$1" value="$2"
  touch "$CI_ENV_FILE"
  if grep -q "^${key}=" "$CI_ENV_FILE" 2>/dev/null; then
    grep -v "^${key}=" "$CI_ENV_FILE" > "$CI_ENV_FILE.tmp" || true
    mv "$CI_ENV_FILE.tmp" "$CI_ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$CI_ENV_FILE"
  if [[ -n "${GITHUB_ENV:-}" ]]; then printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"; fi
}

if [[ -f "$CI_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CI_ENV_FILE"
  PROFILE="${DSH_TEST_PROFILE:-${DSH_TEST_PROFILE_HEADLESS:-$PROFILE}}"
fi

if (( DRY_RUN )); then
  command -v dsh >/dev/null 2>&1 || warn "dsh is not on PATH (a real run would fail until the workflow installs it)"
  [[ -f "$DSH_HOME/profiles/$PROFILE/package.json" ]] || warn "profile $PROFILE is not prepared under $DSH_HOME (a real run needs prepare-profile.sh first)"
  log "dsh: $( (dsh --version 2>/dev/null || echo '<not installed>') | head -1 )"
else
  command -v node >/dev/null || die "node is required"
  command -v dsh  >/dev/null || die "dsh is not on PATH (the workflow installs it before this step)"
  if [[ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]]; then
    die "profile $PROFILE is not prepared under $DSH_HOME; run scripts/ci/prepare-profile.sh first"
  fi
  log "dsh: $( (dsh --version 2>/dev/null || echo unknown) | head -1 )"
fi
if [[ ! -d "$DSH_WORKSPACE_ROOT" ]]; then die "workspace root does not exist: $DSH_WORKSPACE_ROOT"; fi
log "profile: $PROFILE (home: $DSH_HOME)"
log "workspace: $DSH_WORKSPACE_ROOT"
log "model: ${DSH_TEST_MODEL:-<profile default>}, max output tokens: ${DSH_TEST_MAX_OUTPUT_TOKENS:-2048}, effort: ${DSH_TEST_REASONING_EFFORT:-off}"
log "web_search in scenario: $([[ "$INCLUDE_WEB_SEARCH" == "1" ]] && echo yes || echo no)"
log "session timeout: ${SCENARIO_TIMEOUT_SECONDS}s"

build_prompt() {
  if [[ -n "$PROMPT" ]]; then return 0; fi
  local step=3 web_step="" wait_step=""
  if [[ "$INCLUDE_WEB_SEARCH" == "1" ]]; then
    web_step="${step}. Use the web_search tool exactly once with the query \"DeepSeek V4.1 Flash\"."
    step=$((step + 1))
  fi
  wait_step="${step}. Use the bash tool to run exactly this command once: \`sleep 25\`. Do not pass any other command and do not retry it. This wait keeps the session alive while the plugin's background batch lands."
  PROMPT="$(cat <<EOF
You are running a fixed CI verification scenario. Complete these steps exactly, in order, then stop.

1. Use the read tool to read the file ".ci-fixture-large.txt" in the current working directory. It is a test fixture; read it once.
2. Use the bash tool to run the command \`false\` exactly once. That command is expected to fail; do not retry it.
${web_step}
${wait_step}

The bash tool is used exactly twice (steps 2 and ${step}). After all tool results above are available, reply with exactly this text and nothing else: CI_SCENARIO_DONE

Do not use any other tools. Do not read other files. Do not explore the repository. Do not retry failing commands.
EOF
)"
}

write_fixture() {
  node -e '
    const fs = require("fs");
    const lines = Number(process.argv[1]);
    const out = [];
    out.push("CI FIXTURE FILE - intentionally repetitive content used to create a large tool result.");
    for (let i = 0; i < lines; i += 1) {
      out.push(`row ${String(i).padStart(4, "0")} | context-slimmer-ci | ` + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(2) + ` | marker=${i}`);
    }
    fs.writeFileSync(process.argv[2], out.join("\n") + "\n");
  ' "$SLIMMER_FIXTURE_LINES" "$FIXTURE_FILE"
}

cleanup() {
  if [[ "$KEEP_FIXTURE" != "1" ]]; then rm -f "$FIXTURE_FILE"; fi
}
trap cleanup EXIT

build_prompt
if [[ "$INCLUDE_WEB_SEARCH" == "1" && -z "${DEEPSEEK_API_KEY:-}" ]]; then
  warn "web_search in the scenario needs a DeepSeek credential; the search tool may be withheld without DEEPSEEK_API_KEY"
fi

SCENARIO_JSON="$CI_ARTIFACTS_DIR/scenario.jsonl"
SCENARIO_STDERR="$CI_ARTIFACTS_DIR/scenario.stderr.log"
SCENARIO_SUMMARY="$CI_ARTIFACTS_DIR/scenario-summary.json"

# Launcher flags first; the first token it does not own starts the headless app's args.
CMD=(dsh --profile "$PROFILE" --json --permission-mode workspace-write --approval-policy never "$PROMPT")

if (( DRY_RUN )); then
  log "dry-run plan:"
  log "  would write fixture: $FIXTURE_FILE ($SLIMMER_FIXTURE_LINES lines)"
  log "  would set DSH_HOME=$DSH_HOME DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL:-<unset: official endpoint>} DSH_TELEMETRY_DISABLED=1"
  log "  would run (timeout ${SCENARIO_TIMEOUT_SECONDS}s):"
  log "    ${CMD[0]} --profile ${CMD[2]} --json --permission-mode workspace-write --approval-policy never '<fixed CI scenario prompt>'"
  log "  captured to: $SCENARIO_JSON , $SCENARIO_STDERR"
  if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    log "  NOTE: no DEEPSEEK_API_KEY in this shell; a real run would exit 3 (skipped) here."
  fi
  log "dry-run OK (no fixture written, no model call)"
  exit 0
fi

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  warn "DEEPSEEK_API_KEY is not set: skipping the real model session."
  warn "In GitHub Actions this is expected for fork pull requests (secrets are not available there)."
  warn "To run locally: DEEPSEEK_API_KEY=... scripts/ci/run-scenario.sh --dry-run first, then without --dry-run."
  set_env SCENARIO_STATUS "skipped_no_key"
  set_env SCENARIO_EXIT_CODE "3"
  exit 3
fi

if [[ -n "${DSH_TEST_MAX_OUTPUT_TOKENS:-}" && "${DSH_TEST_MAX_OUTPUT_TOKENS:-0}" -gt 4096 ]]; then
  warn "DSH_TEST_MAX_OUTPUT_TOKENS=${DSH_TEST_MAX_OUTPUT_TOKENS} makes a CI run more expensive than the default 2048"
fi

write_fixture
log "fixture: $FIXTURE_FILE ($(wc -c < "$FIXTURE_FILE") bytes, $SLIMMER_FIXTURE_LINES lines)"
log "starting real headless session (timeout ${SCENARIO_TIMEOUT_SECONDS}s); model output is capped by the profile"

set +e
(
  cd "$DSH_WORKSPACE_ROOT"
  DSH_HOME="$DSH_HOME" \
  DSH_TELEMETRY_DISABLED=1 \
  DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" \
  ${DEEPSEEK_BASE_URL:+DEEPSEEK_BASE_URL="$DEEPSEEK_BASE_URL"} \
  timeout --signal=TERM --kill-after=30s "$SCENARIO_TIMEOUT_SECONDS" "${CMD[@]}" \
    >"$SCENARIO_JSON" 2>"$SCENARIO_STDERR"
)
SCENARIO_EXIT_CODE=$?
set -e
set_env SCENARIO_EXIT_CODE "$SCENARIO_EXIT_CODE"

if (( SCENARIO_EXIT_CODE == 124 || SCENARIO_EXIT_CODE == 137 )); then
  warn "session timed out after ${SCENARIO_TIMEOUT_SECONDS}s; stderr tail:"
  tail -20 "$SCENARIO_STDERR" >&2 || true
  die "headless session exceeded its timeout budget"
fi
if (( SCENARIO_EXIT_CODE != 0 )); then
  warn "headless session exited with code $SCENARIO_EXIT_CODE; stderr tail:"
  tail -40 "$SCENARIO_STDERR" >&2 || true
  die "real headless session failed"
fi
log "headless session completed (exit 0)"

# Parse the NDJSON event stream: identity, tool usage, final answer. The node
# program prints a COMPACT JSON line on stdout (captured below) and writes a
# pretty-printed copy for humans/artifacts.
SUMMARY_JSON="$(node --input-type=module - "$SCENARIO_JSON" "$SCENARIO_SUMMARY" <<'NODE'
import fs from 'node:fs';
const [jsonPath, summaryPath] = process.argv.slice(2);
const lines = fs.readFileSync(jsonPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
const events = [];
for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* ignore a torn final line */ } }
const session = events.find((event) => event.type === 'session');
const final = [...events].reverse().find((event) => event.type === 'final');
if (!session || typeof session.sessionId !== 'string') {
  console.error('scenario stream has no session event with a sessionId');
  process.exit(1);
}
const calls = events.filter((event) => event.type === 'tool_call');
const results = events.filter((event) => event.type === 'tool_result');
const summary = {
  sessionId: session.sessionId,
  cwd: session.cwd ?? null,
  eventCount: events.length,
  toolCalls: calls.length,
  toolNames: [...new Set(calls.map((event) => event.name ?? event.toolName ?? event?.data?.name).filter(Boolean))],
  toolResults: results.length,
  finalPresent: final !== undefined,
  finalText: final?.text ?? null,
  finalReason: final?.reason ?? null,
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, undefined, 2) + '\n');
process.stdout.write(JSON.stringify(summary));
NODE
)"
log "scenario summary: $SUMMARY_JSON"
SESSION_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).sessionId)' "$SUMMARY_JSON")" 
[[ -n "$SESSION_ID" ]] || die "could not read the session id from $SCENARIO_SUMMARY"
TOOL_CALLS="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).toolCalls))' "$SUMMARY_JSON")"
log "session: $SESSION_ID (tool calls: $TOOL_CALLS)"

if (( TOOL_CALLS < 2 )); then
  warn "the agent made only $TOOL_CALLS tool call(s); the plugin's everyNToolCalls threshold may not be reached"
fi

# Locate the persisted session directory and log.
SESSION_DIR="$(find "$DSH_HOME/sessions" -maxdepth 2 -type d -name "$SESSION_ID" -print -quit 2>/dev/null || true)"
[[ -n "$SESSION_DIR" && -d "$SESSION_DIR" ]] || die "session directory not found under $DSH_HOME/sessions for $SESSION_ID"
SESSION_LOG="$(find "$SESSION_DIR" -maxdepth 1 -type f -name 'session.v*.jsonl*' -print 2>/dev/null | sort -V | tail -1 || true)"
[[ -n "$SESSION_LOG" && -f "$SESSION_LOG" ]] || die "session log not found in $SESSION_DIR"

VERIFY_SESSION_JSONL="$CI_ARTIFACTS_DIR/verify-session.jsonl"
case "$SESSION_LOG" in
  *.zstd)
    command -v zstd >/dev/null || die "session log is zstd-compressed but the zstd CLI is missing; set SESSION_COMPRESSION=none in the profile"
    zstd -dc "$SESSION_LOG" > "$VERIFY_SESSION_JSONL"
    ;;
  *) cp "$SESSION_LOG" "$VERIFY_SESSION_JSONL" ;;
esac
log "plain session log: $VERIFY_SESSION_JSONL ($(wc -l < "$VERIFY_SESSION_JSONL") events)"

# Register the workspace + session in the Web GUI's workspace store so the
# screenshot step can open the session (the UI has no deep link).
node --input-type=module - "$DSH_HOME" "$DSH_WORKSPACE_ROOT" "$SESSION_ID" "$CI_ARTIFACTS_DIR" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const [home, workspace, sessionId, artifactsDir] = process.argv.slice(2);
const storagesDir = path.join(home, 'storages');
const storePath = path.join(storagesDir, 'workspace.json');
fs.mkdirSync(storagesDir, { recursive: true });
let store;
if (fs.existsSync(storePath)) {
  try { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); }
  catch { fs.copyFileSync(storePath, `${storePath}.invalid-${Date.now()}.bak`); store = undefined; }
}
if (store === undefined) {
  store = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } };
}
store.tables = store.tables ?? { workspaces: {} };
store.tables.workspaces = store.tables.workspaces ?? {};
store.global = store.global ?? { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] };
store.global.workspaceIds = Array.isArray(store.global.workspaceIds) ? store.global.workspaceIds : [];
store.global.archivedSessionIds = Array.isArray(store.global.archivedSessionIds) ? store.global.archivedSessionIds : [];
store.global.pinnedSessionIds = Array.isArray(store.global.pinnedSessionIds) ? store.global.pinnedSessionIds : [];
store.global.initialized = true;

const resolved = fs.realpathSync(workspace);
let match;
for (const [id, item] of Object.entries(store.tables.workspaces)) {
  let itemPath = item.path;
  try { itemPath = fs.realpathSync(itemPath); } catch { /* keep recorded path */ }
  if (itemPath === resolved) { match = { id, item }; break; }
}
if (!match) {
  const id = randomUUID();
  const title = path.basename(resolved) || resolved;
  const now = new Date().toISOString();
  store.tables.workspaces[id] = { path: resolved, title, sessionIds: [], createdAt: now, updatedAt: now };
  store.global.workspaceIds.push(id);
  match = { id, item: store.tables.workspaces[id] };
}
match.item.sessionIds = Array.isArray(match.item.sessionIds) ? match.item.sessionIds : [];
if (!match.item.sessionIds.includes(sessionId)) match.item.sessionIds.push(sessionId);
match.item.updatedAt = new Date().toISOString();
fs.writeFileSync(storePath, JSON.stringify(store, undefined, 2) + '\n');
fs.mkdirSync(artifactsDir, { recursive: true });
fs.copyFileSync(storePath, path.join(artifactsDir, 'workspace-store.json'));
console.log(`workspace store: registered ${sessionId} under ${resolved}`);
NODE

cp "$SCENARIO_SUMMARY" "$CI_ARTIFACTS_DIR/scenario-summary.json" 2>/dev/null || true
set_env SESSION_ID "$SESSION_ID"
set_env SESSION_DIR "$SESSION_DIR"
set_env SESSION_LOG "$SESSION_LOG"
set_env VERIFY_SESSION_JSONL "$VERIFY_SESSION_JSONL"
set_env SCENARIO_STATUS "completed"
set_env SCENARIO_TOOL_CALLS "$TOOL_CALLS"
set_env SCENARIO_JSON "$SCENARIO_JSON"
set_env SCENARIO_SUMMARY "$SCENARIO_SUMMARY"
set_env SCENARIO_STDERR "$SCENARIO_STDERR"

log "evidence written:"
log "  $VERIFY_SESSION_JSONL"
log "  $SCENARIO_JSON"
log "  $SCENARIO_STDERR"
log "  $SCENARIO_SUMMARY"
log "OK"
