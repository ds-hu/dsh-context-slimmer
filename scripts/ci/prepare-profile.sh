#!/usr/bin/env bash
# prepare-profile.sh — construct a throw-away DSH profile for CI verification.
#
# Creates a profile from a shipped template, links the local monorepo packages
# into it, records the bundle in `dsh.profile.bundles`, and writes a generated
# `cordis.patch.yml` that:
#   * points `llm-deepseek` at the CI model / output cap / reasoning effort,
#   * points `agent-default-model` at `deepseek-official` + the probed model,
#   * makes session logs plain JSONL (`compression: none`) for artifact upload,
#   * disables the built-in compaction/pruner/title LLM rows so the build-in-test
#     plugin's own events are the only compression evidence,
#   * configures the plugin under test (`SLIMMER_CONFIG_JSON`).
#
# Everything lives under a temp `DSH_HOME`; the user's real profile is never
# touched and no registry install or model API call happens here except the
# optional, non-billed `GET /models` probe.
#
# Usage:
#   scripts/ci/prepare-profile.sh --template headless --profile ci-headless --probe-model
#   scripts/ci/prepare-profile.sh --template web --profile ci-web
#   scripts/ci/prepare-profile.sh --dry-run
#
# Exit codes: 0 ok, 1 failure, 3 skipped (no API key when --probe-model required).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
DSH_HOME="${DSH_HOME:-$RUNNER_TEMP/dsh-home}"
CI_ENV_FILE="${CI_ENV_FILE:-$RUNNER_TEMP/ci-env.sh}"
CI_ARTIFACTS_DIR="${CI_ARTIFACTS_DIR:-$RUNNER_TEMP/ci-artifacts}"

PROFILE="ci-headless"
TEMPLATE="headless"
INSTALL_METHOD="symlink"
DRY_RUN=0
PRINT_DSH_VERSION=0
PROBE_MODEL=0
SKIP_PROBE=0

DSH_TEST_MODEL="${DSH_TEST_MODEL:-}"
DSH_TEST_MAX_OUTPUT_TOKENS="${DSH_TEST_MAX_OUTPUT_TOKENS:-2048}"
DSH_TEST_REASONING_EFFORT="${DSH_TEST_REASONING_EFFORT:-off}"
SESSION_COMPRESSION="${SESSION_COMPRESSION:-none}"
ALLOW_UNLISTED_MODEL="${ALLOW_UNLISTED_MODEL:-0}"
SLIMMER_CONFIG_JSON="${SLIMMER_CONFIG_JSON:-{\"enabled\":true,\"everyNToolCalls\":2,\"minChars\":0,\"protectRecent\":1,\"maxTargets\":6,\"minTargetChars\":0,\"timeoutMs\":180000,\"forkProvider\":\"fork\",\"promptLocale\":\"zh\",\"model\":{\"provider\":\"inherit\"}}}"
SLIMMER_ENTRY_IDS="${SLIMMER_ENTRY_IDS:-}"
SLIMMER_ENTRY_ID_REGEX="${SLIMMER_ENTRY_ID_REGEX:-}"
SLIMMER_PATCH_FILE="${SLIMMER_PATCH_FILE:-}"
ISOLATION_DISABLE_IDS="${ISOLATION_DISABLE_IDS:-compaction-basic,command-compact,tool-result-pruner,session-title-llm,image-offload}"

log()  { printf 'prepare-profile: %s\n' "$*"; }
warn() { printf 'prepare-profile: WARNING: %s\n' "$*" >&2; }
die()  { printf 'prepare-profile: ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --template) TEMPLATE="${2:?--template needs a value}"; shift 2 ;;
    --install-method) INSTALL_METHOD="${2:?--install-method needs a value}"; shift 2 ;;
    --probe-model) PROBE_MODEL=1; shift ;;
    --no-probe-model) SKIP_PROBE=1; shift ;;
    --print-dsh-version) PRINT_DSH_VERSION=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$TEMPLATE" in headless|web|sdk|acp|sdk-minimal) ;; *) die "unsupported --template: $TEMPLATE" ;; esac
case "$INSTALL_METHOD" in symlink|dsh-plugin) ;; *) die "unsupported --install-method: $INSTALL_METHOD" ;; esac

mkdir -p "$(dirname "$CI_ENV_FILE")" "$CI_ARTIFACTS_DIR"

# set_env KEY VALUE — keep CI_ENV_FILE idempotent and mirror to $GITHUB_ENV.
set_env() {
  local key="$1" value="$2"
  touch "$CI_ENV_FILE"
  if grep -q "^${key}=" "$CI_ENV_FILE" 2>/dev/null; then
    grep -v "^${key}=" "$CI_ENV_FILE" > "$CI_ENV_FILE.tmp" || true
    mv "$CI_ENV_FILE.tmp" "$CI_ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$CI_ENV_FILE"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_ENV"
  fi
}

load_env_file() {
  if [[ -f "$CI_ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$CI_ENV_FILE"
  fi
}
load_env_file

# Resolve the exact dsh version to install/verify against: env override first,
# then the repo's declared @deepseek-ai/dsh dependency, then a known-good pin.
resolve_dsh_version() {
  if [[ -n "${DSH_VERSION:-}" ]]; then printf '%s\n' "$DSH_VERSION"; return; fi
  local declared=""
  if [[ -f "$REPO_ROOT/package.json" ]]; then
    declared="$(node -e '
      const fs = require("fs");
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const pick = (deps) => deps && (deps["@deepseek-ai/dsh"] ?? deps["@deepseek-ai/dsh-core"]);
      const v = pick(p.devDependencies) ?? pick(p.peerDependencies) ?? pick(p.dependencies);
      if (v) {
        const m = String(v).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
        if (m) process.stdout.write(m[0]);
      }
    ' "$REPO_ROOT/package.json" 2>/dev/null || true)"
  fi
  if [[ -n "$declared" ]]; then printf '%s\n' "$declared"; else printf '%s\n' "0.2.2-rc.1"; fi
}

node_engines_of_dsh() {
  local dsh_bin dsh_pkg
  dsh_bin="$(command -v dsh || true)"
  [[ -n "$dsh_bin" ]] || return 1
  dsh_pkg="$(node -e '
    const fs = require("fs"), path = require("path");
    let real = process.argv[1];
    try { real = fs.realpathSync(real); } catch {}
    // <install>/lib/bin.js -> <install>/package.json
    const candidate = path.resolve(path.dirname(real), "..", "package.json");
    if (fs.existsSync(candidate)) { const p = JSON.parse(fs.readFileSync(candidate, "utf8")); if (p.engines && p.engines.node) process.stdout.write(String(p.engines.node)); }
  ' "$dsh_bin" 2>/dev/null || true)"
  [[ -n "$dsh_pkg" ]] && printf '%s\n' "$dsh_pkg"
  return 0
}

############################ helpers ############################
discover_workspaces() {
  # Output: one "<dir>\t<name>\t<isBundle>" line per npm workspace package.
  node -e '
    const fs = require("fs"), path = require("path");
    const root = process.argv[1];
    const rootPkgPath = path.join(root, "package.json");
    if (!fs.existsSync(rootPkgPath)) { console.error("package.json missing"); process.exit(2); }
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
    const dirs = [{ dir: "", pkg: rootPkg }];
    const globs = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces
      : rootPkg.workspaces && Array.isArray(rootPkg.workspaces.packages) ? rootPkg.workspaces.packages : [];
    for (const glob of globs) {
      if (!glob.endsWith("/*")) continue;
      const base = glob.slice(0, -2);
      let entries = [];
      try { entries = fs.readdirSync(path.join(root, base), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const rel = `${base}/${entry.name}`;
        const pkgPath = path.join(root, rel, "package.json");
        if (!fs.existsSync(pkgPath)) continue;
        dirs.push({ dir: rel, pkg: JSON.parse(fs.readFileSync(pkgPath, "utf8")) });
      }
    }
    for (const { dir, pkg } of dirs) {
      if (typeof pkg.name !== "string" || !pkg.name) {
        if (dir === "") continue; // an unnamed private root is allowed
        console.error(`workspace package at ${dir} has no name`);
        process.exit(2);
      }
      const isBundle = Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch);
      process.stdout.write([dir === "" ? "." : dir, pkg.name, isBundle ? "1" : "0"].join("\t") + "\n");
    }
  ' "$REPO_ROOT"
}

ensure_bundle_selected() {
  local profile_dir="$1"
  shift
  node -e '
    const fs = require("fs"), path = require("path");
    const profileDir = process.argv[1];
    const bundles = process.argv.slice(2);
    const manifestPath = path.join(profileDir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dsh = manifest.dsh || {};
    manifest.dsh.profile = manifest.dsh.profile || {};
    manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
    for (const name of bundles) if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name);
    manifest.dependencies = manifest.dependencies || {};
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + "\n");
  ' "$profile_dir" "$@"
}

record_profile_dependencies() {
  local profile_dir="$1"
  shift
  node -e '
    const fs = require("fs"), path = require("path");
    const profileDir = process.argv[1];
    const pairs = process.argv.slice(2); // name=absdir
    const manifestPath = path.join(profileDir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies = manifest.dependencies || {};
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx), dir = pair.slice(idx + 1);
      manifest.dependencies[name] = `file:${dir}`;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + "\n");
  ' "$profile_dir" "$@"
}

# Emit the generated patch file. The node program owns all YAML formatting so
# the plugin config JSON can contain arbitrary nested values.
generate_patch() {
  local dump_path="$1" patch_path="$2" bundle_name="$3" discovered_env_path="$4"
  node --input-type=module - "$dump_path" "$patch_path" "$bundle_name" "$discovered_env_path" "$SLIMMER_CONFIG_JSON" "$SLIMMER_ENTRY_IDS" "$SLIMMER_ENTRY_ID_REGEX" "$DSH_TEST_MODEL" "$DSH_TEST_MODEL_CONTEXT_WINDOW" "$DSH_TEST_REASONING_EFFORT" "$DSH_TEST_MAX_OUTPUT_TOKENS" "$SESSION_COMPRESSION" "$ISOLATION_DISABLE_IDS" "$SLIMMER_PATCH_FILE" <<'NODE'
import fs from 'node:fs';

const [
  dumpPath, patchPath, bundleName, discoveredEnvPath,
  configJsonRaw, explicitIdsRaw, idRegexRaw,
  model, modelContextRaw, effort, maxTokensRaw,
  compression, isolationIdsRaw, extraPatchPath,
] = process.argv.slice(2);

const unquote = (value) => {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const dump = fs.readFileSync(dumpPath, 'utf8');
const entries = [];
let current = null;
for (const line of dump.split('\n')) {
  const idMatch = line.match(/^\s*-\s+id:\s*(.+?)\s*$/);
  if (idMatch) { current = { id: unquote(idMatch[1]) }; entries.push(current); continue; }
  const nameMatch = line.match(/^\s+name:\s*(.+?)\s*$/);
  if (nameMatch && current && current.name === undefined) current.name = unquote(nameMatch[1]);
}
const ids = new Set(entries.map((entry) => entry.id));

const scalar = (value) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const text = String(value);
  return /^[A-Za-z0-9_./:@+-]+$/.test(text) ? text : JSON.stringify(text);
};

function emitChild(value, indent) {
  const pad = (n) => ' '.repeat(n);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad(indent)}[]`];
    const lines = [];
    for (const item of value) {
      if (item === null || typeof item !== 'object') { lines.push(`${pad(indent)}- ${scalar(item)}`); continue; }
      const child = emitMapping(item, indent + 2);
      if (child.length === 0) { lines.push(`${pad(indent)}- {}`); continue; }
      child[0] = `${pad(indent)}- ${child[0].slice(indent + 2)}`;
      lines.push(...child);
    }
    return lines;
  }
  if (value && typeof value === 'object') {
    const lines = emitMapping(value, indent);
    return lines.length === 0 ? [`${pad(indent)}{}`] : lines;
  }
  return [`${pad(indent)}${scalar(value)}`];
}

function emitMapping(value, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item !== 'object') { lines.push(`${pad}${key}: ${scalar(item)}`); continue; }
    lines.push(`${pad}${key}:`);
    lines.push(...emitChild(item, indent + 2));
  }
  return lines;
}

const pluginEntries = entries.filter((entry) => entry.name !== undefined && (
  entry.name === bundleName
  || entry.name.startsWith(`${bundleName}/`)
  || entry.name.includes('context-slimmer')
));
const discoveredIds = [...new Set(pluginEntries.map((entry) => entry.id))];
if (discoveredIds.length === 0) {
  console.error(`no composed rows reference bundle ${bundleName} (looked at ${entries.length} rows)`);
  process.exit(2);
}

let targetIds;
if (explicitIdsRaw.trim() !== '') {
  targetIds = explicitIdsRaw.split(',').map((item) => item.trim()).filter(Boolean);
  for (const id of targetIds) if (!ids.has(id)) {
    console.error(`SLIMMER_ENTRY_IDS names an entry missing from the composed profile: ${id}`);
    process.exit(2);
  }
} else {
  targetIds = discoveredIds;
  if (idRegexRaw.trim() !== '') {
    const regex = new RegExp(idRegexRaw);
    targetIds = targetIds.filter((id) => regex.test(id));
    if (targetIds.length === 0) { console.error(`SLIMMER_ENTRY_ID_REGEX=${idRegexRaw} matched no entry of ${bundleName}`); process.exit(2); }
  }
}

let config;
try { config = JSON.parse(configJsonRaw); } catch (error) { console.error(`SLIMMER_CONFIG_JSON is not valid JSON: ${error.message}`); process.exit(2); }
if (config === null || typeof config !== 'object' || Array.isArray(config)) { console.error('SLIMMER_CONFIG_JSON must be a JSON object'); process.exit(2); }

const contextWindow = Number.isInteger(Number(modelContextRaw)) && Number(modelContextRaw) > 0 ? Number(modelContextRaw) : 1048576;
const maxTokens = Number.isInteger(Number(maxTokensRaw)) && Number(maxTokensRaw) > 0 ? Number(maxTokensRaw) : 2048;
const allowedEfforts = new Set(['off', 'low', 'high', 'max']);
if (!allowedEfforts.has(effort)) { console.error(`invalid reasoning effort: ${effort}`); process.exit(2); }

const lines = [
  '# GENERATED by scripts/ci/prepare-profile.sh for CI verification — do not commit.',
  '',
  '# CI model route: small output cap + cheapest reasoning effort keep a run well under budget.',
  '- id: llm-deepseek',
  '  config:',
  '    apiKeyEnv: DEEPSEEK_API_KEY',
  `    reasoningEffort: ${effort}`,
  `    maxTokens: ${maxTokens}`,
  '    models:',
  `      - id: ${scalar(model)}`,
  `        name: ${scalar(model)}`,
  `        contextWindow: ${contextWindow}`,
  '',
  '# Headless one-shot agents take their model from this row.',
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek-official',
  `    model: ${scalar(model)}`,
  '',
  '# Plain JSONL session logs so CI can assert on them and upload them as artifacts.',
  '- id: session-persistence-jsonl',
  '  config:',
  "    root: !!js dshHomePath('sessions')",
  `    compression: ${compression}`,
];

const isolation = isolationIdsRaw.split(',').map((item) => item.trim()).filter(Boolean).filter((id) => ids.has(id));
if (isolation.length > 0) {
  lines.push('', '# Isolate the evidence: no built-in compaction, pruning, or LLM title call in CI.');
  for (const id of isolation) lines.push(`- id: ${id}`, '  disabled: true');
}

lines.push('', `# Plugin under test (${bundleName}): module rows configured for the CI threshold.`);
for (const id of targetIds) {
  lines.push(`- id: ${id}`, '  config:');
  lines.push(...emitMapping(config, 4));
}

if (extraPatchPath) {
  const extra = fs.readFileSync(extraPatchPath, 'utf8').trim();
  if (extra !== '' && extra !== '[]') {
    lines.push('', '# Extra patch fragment from SLIMMER_PATCH_FILE.', extra);
  }
}

fs.writeFileSync(patchPath, lines.join('\n') + '\n');
fs.writeFileSync(discoveredEnvPath, [
  `PLUGIN_ENTRY_IDS=${targetIds.join(',')}`,
  `PLUGIN_ALL_ENTRY_IDS=${discoveredIds.join(',')}`,
].join('\n') + '\n');
console.log(`configured plugin entries: ${targetIds.join(', ')}`);
NODE
}

############################ preflight ############################
if (( PRINT_DSH_VERSION )); then
  resolve_dsh_version
  exit 0
fi
command -v node >/dev/null || die "node is required"
command -v npm  >/dev/null || die "npm is required"

if ! command -v dsh >/dev/null 2>&1; then
  if (( DRY_RUN )); then
    warn "dsh is not on PATH (dry-run continues): install with npm i -g @deepseek-ai/dsh@<version>"
  else
    die "dsh is not on PATH; run: npm install -g @deepseek-ai/dsh@\$(scripts/ci/prepare-profile.sh --print-dsh-version)"
  fi
fi

DSH_VERSION_RESOLVED="$(resolve_dsh_version)"
if command -v dsh >/dev/null 2>&1; then
  DSH_INSTALLED_VERSION="$(dsh --version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
  if [[ -n "$DSH_INSTALLED_VERSION" && "$DSH_INSTALLED_VERSION" != "$DSH_VERSION_RESOLVED" ]]; then
    warn "installed dsh is $DSH_INSTALLED_VERSION but the repo declares $DSH_VERSION_RESOLVED (continuing; the workflow pins the install)"
  fi
  DSH_NODE_ENGINES="$(node_engines_of_dsh || true)"
  if [[ -n "$DSH_NODE_ENGINES" ]]; then
    node -e '
      const required = process.argv[1];
      const current = process.versions.node;
      const min = (required.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
      if (min.length === 3) {
        const cur = current.split(".").map(Number);
        const older = cur[0] < min[0] || (cur[0] === min[0] && (cur[1] < min[1] || (cur[1] === min[1] && cur[2] < min[2])));
        if (older) {
          console.error(`prepare-profile: WARNING: node ${current} is older than dsh engines.node ${required}; CI pins node 24.`);
          process.exit(3);
        }
      }
    ' "$DSH_NODE_ENGINES" || warn "node version is older than dsh's declared engines ($DSH_NODE_ENGINES)"
  fi
fi

if [[ ! -f "$REPO_ROOT/package.json" ]]; then
  if (( DRY_RUN )); then
    warn "no package.json at $REPO_ROOT yet (repository skeleton); dry-run validates wiring only"
    log "dry-run plan: profile=$PROFILE template=$TEMPLATE install=$INSTALL_METHOD home=$DSH_HOME dsh=$DSH_VERSION_RESOLVED"
    log "dry-run OK (waiting for the plugin package manifest before a full validation)"
    exit 0
  fi
  die "no package.json at $REPO_ROOT"
fi

WORKSPACES_TSV="$(discover_workspaces)" || die "could not enumerate npm workspaces from $REPO_ROOT/package.json"
BUNDLE_DIR=""; BUNDLE_NAME=""
while IFS=$'\t' read -r rel name is_bundle; do
  [[ -n "$name" ]] || continue
  if [[ "$is_bundle" == "1" ]] && [[ -z "$BUNDLE_NAME" ]]; then
    if [[ "$rel" == "." ]]; then BUNDLE_DIR="$REPO_ROOT"; else BUNDLE_DIR="$REPO_ROOT/$rel"; fi; BUNDLE_NAME="$name"
  fi
done <<< "$WORKSPACES_TSV"
if [[ -z "$BUNDLE_NAME" ]]; then
  if (( DRY_RUN )); then
    warn "no npm workspace package declares dsh.bundle.patch yet; dry-run validates wiring only"
    log "dry-run plan: profile=$PROFILE template=$TEMPLATE install=$INSTALL_METHOD home=$DSH_HOME dsh=$DSH_VERSION_RESOLVED"
    log "dry-run OK (waiting for the bundle package before a full validation)"
    exit 0
  fi
  die "no workspace package declares dsh.bundle.patch; the profile has no bundle to install"
fi

# Validate the plugin config JSON early (dry-run included).
printf '%s' "$SLIMMER_CONFIG_JSON" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => raw += d).on("end", () => {
    try { const parsed = JSON.parse(raw); if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object"); }
    catch (error) { console.error(`SLIMMER_CONFIG_JSON invalid: ${error.message}`); process.exit(1); }
  });
' || die "SLIMMER_CONFIG_JSON is invalid"

if [[ -n "$SLIMMER_PATCH_FILE" && ! -f "$SLIMMER_PATCH_FILE" ]]; then
  die "SLIMMER_PATCH_FILE does not exist: $SLIMMER_PATCH_FILE"
fi

probe_models() {
  # Non-billed model listing probe. Sets MODEL_PROBE_TSV / MODEL_PROBE_URL.
  local key="${DEEPSEEK_API_KEY:-}"
  [[ -n "$key" ]] || return 1
  local urls=()
  if [[ -z "${DEEPSEEK_BASE_URL:-}" ]]; then
    urls+=("https://api.deepseek.com/models")
  else
    local root="${DEEPSEEK_BASE_URL%/}"
    root="${root%/v1}"; root="${root%/anthropic}"
    urls+=("$root/models" "$root/v1/models")
  fi
  local url body parsed
  for url in "${urls[@]}"; do
    body="$(curl --silent --show-error --max-time 30 --retry 2 --retry-delay 2 \
      -H "x-api-key: ${key}" -H "Authorization: Bearer ${key}" \
      -H "Accept: application/json" "$url" 2>"$CI_ARTIFACTS_DIR/model-probe.err")" || {
        warn "model probe failed for $url: $(head -c 300 "$CI_ARTIFACTS_DIR/model-probe.err" 2>/dev/null)"
        continue
      }
    parsed="$(printf '%s' "$body" | node -e '
      let raw = "";
      process.stdin.on("data", (d) => raw += d).on("end", () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { process.exit(0); }
        const list = Array.isArray(parsed) ? parsed
          : Array.isArray(parsed?.data?.models) ? parsed.data.models
          : Array.isArray(parsed?.models) ? parsed.models
          : Array.isArray(parsed?.data) ? parsed.data
          : [];
        const rows = [];
        for (const item of list) {
          if (typeof item === "string") { rows.push([item, ""]); continue; }
          const id = item?.id ?? item?.name ?? item?.model;
          if (typeof id !== "string" || id.length === 0) continue;
          const ctx = item?.context_window ?? item?.contextWindow ?? item?.context_length ?? item?.max_context_length ?? item?.max_input_tokens ?? "";
          rows.push([id, String(ctx)]);
        }
        process.stdout.write(rows.map(([id, ctx]) => `${id}\t${ctx}`).join("\n"));
      });
    ')"
    if [[ -n "$parsed" ]]; then
      MODEL_PROBE_TSV="$(printf '%s\n' "$parsed" | head -100)"
      MODEL_PROBE_URL="$url"
      printf '%s\n' "$MODEL_PROBE_TSV" > "$CI_ARTIFACTS_DIR/model-probe.tsv"
      printf 'probe_url=%s\nmodel_count=%s\n' "$url" "$(printf '%s\n' "$MODEL_PROBE_TSV" | wc -l)" > "$CI_ARTIFACTS_DIR/model-probe.txt"
      return 0
    fi
  done
  return 1
}

choose_model() {
  local probed="" chosen="" ctx=""
  if { (( PROBE_MODEL )) || (( ! SKIP_PROBE )); } && probe_models; then probed="$MODEL_PROBE_TSV"; fi
  if [[ -n "$DSH_TEST_MODEL" ]]; then
    chosen="$DSH_TEST_MODEL"
    if [[ -n "$probed" ]] && ! printf '%s\n' "$probed" | cut -f1 | grep -Fxq "$chosen"; then
      if [[ "$ALLOW_UNLISTED_MODEL" == "1" ]]; then
        warn "DSH_TEST_MODEL=$chosen is not in the /models listing; continuing because ALLOW_UNLISTED_MODEL=1"
      else
        warn "DSH_TEST_MODEL=$chosen is not in /models. Available ids:"
        printf '%s\n' "$probed" | cut -f1 | sed 's/^/  - /' >&2
        die "refusing to spend budget on an unlisted model; pick one of the ids above or set ALLOW_UNLISTED_MODEL=1"
      fi
    fi
    if [[ -z "$probed" ]]; then warn "model listing unavailable; using DSH_TEST_MODEL=$chosen without validation"; fi
  elif [[ -n "$probed" ]]; then
    if printf '%s\n' "$probed" | cut -f1 | grep -Fxq "deepseek-flash"; then
      chosen="deepseek-flash"
    else
      chosen="$(printf '%s\n' "$probed" | head -1 | cut -f1)"
      warn "deepseek-flash is not listed; falling back to first listed model: $chosen"
    fi
  else
    chosen="deepseek-flash"
    warn "model listing unavailable; falling back to built-in catalog id deepseek-flash (DeepSeek-V4.1-Flash)"
  fi
  if [[ -z "$chosen" ]]; then die "could not resolve a model id"; fi
  if [[ ! "$chosen" =~ ^[A-Za-z0-9._:/@-]+$ ]]; then die "refusing suspicious model id: $chosen"; fi
  if [[ -n "$probed" ]]; then ctx="$(printf '%s\n' "$probed" | awk -F'\t' -v m="$chosen" '$1==m {print $2}' | head -1)"; fi
  [[ "$ctx" =~ ^[0-9]+$ ]] || ctx=1048576
  DSH_TEST_MODEL="$chosen"
  DSH_TEST_MODEL_CONTEXT_WINDOW="$ctx"
}

############################ dry run ############################
if (( DRY_RUN )); then
  log "dry-run plan:"
  log "  repo:            $REPO_ROOT"
  log "  bundle:          $BUNDLE_NAME ($BUNDLE_DIR)"
  log "  dsh:             $DSH_VERSION_RESOLVED (installed: ${DSH_INSTALLED_VERSION:-none})"
  log "  profile:         $PROFILE from template '$TEMPLATE' under $DSH_HOME"
  log "  install method:  $INSTALL_METHOD"
  log "  model:           ${DSH_TEST_MODEL:-<probe during real run>} (ctx ${DSH_TEST_MODEL_CONTEXT_WINDOW:-auto})"
  log "  maxTokens:       $DSH_TEST_MAX_OUTPUT_TOKENS, effort: $DSH_TEST_REASONING_EFFORT"
  log "  session logs:    compression=$SESSION_COMPRESSION"
  log "  plugin config:   $SLIMMER_CONFIG_JSON"
  log "  entry ids:       ${SLIMMER_ENTRY_IDS:-<discovered from --dump-config>}"
  log "  would run:"
  log "    DSH_HOME=$DSH_HOME dsh --profile $PROFILE --from-default-profile $TEMPLATE --dump-config"
  log "    link $(printf '%s\n' "$WORKSPACES_TSV" | grep -c .) package(s) into $DSH_HOME/profiles/$PROFILE/node_modules"
  log "    write $DSH_HOME/profiles/$PROFILE/cordis.patch.yml, then re-run --dump-config to validate"
  (( PROBE_MODEL )) && log "    probe ${DEEPSEEK_BASE_URL:-https://api.deepseek.com}/models with the CI key (non-billed, no inference)"
  log "dry-run OK (no profile, package, or network mutation performed)"
  exit 0
fi

############################ real run ############################
if (( SKIP_PROBE )); then
  if [[ -z "$DSH_TEST_MODEL" ]]; then DSH_TEST_MODEL="deepseek-flash"; fi
  DSH_TEST_MODEL_CONTEXT_WINDOW="${DSH_TEST_MODEL_CONTEXT_WINDOW:-1048576}"
else
  choose_model
fi

export DSH_HOME
mkdir -p "$DSH_HOME/profiles" "$CI_ARTIFACTS_DIR/profile-$PROFILE"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

log "dsh version: $( (dsh --version 2>/dev/null || echo unknown) | head -1 )"
log "initializing profile '$PROFILE' from template '$TEMPLATE' under $DSH_HOME"
if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
  dsh --profile "$PROFILE" --from-default-profile "$TEMPLATE" --dump-config >"$CI_ARTIFACTS_DIR/profile-$PROFILE/template-dump.yml" 2>"$CI_ARTIFACTS_DIR/profile-$PROFILE/init.err" \
    || die "could not initialize profile $PROFILE: $(tail -5 "$CI_ARTIFACTS_DIR/profile-$PROFILE/init.err")"
fi

log "linking local workspace packages into $PROFILE_DIR/node_modules"
declare -a PACKAGE_PAIRS=()
declare -a BUNDLE_NAMES=()
while IFS=$'\t' read -r rel name is_bundle; do
  [[ -n "$name" ]] || continue
  if [[ "$rel" == "." ]]; then abs="$REPO_ROOT"; else abs="$REPO_ROOT/$rel"; fi
  scope_dir="$(dirname "$name")"
  if [[ "$scope_dir" != "." ]]; then mkdir -p "$PROFILE_DIR/node_modules/$scope_dir"; fi
  rm -rf "$PROFILE_DIR/node_modules/$name"
  ln -s "$abs" "$PROFILE_DIR/node_modules/$name"
  PACKAGE_PAIRS+=("$name=$abs")
  if [[ "$is_bundle" == "1" ]]; then BUNDLE_NAMES+=("$name"); fi
done <<< "$WORKSPACES_TSV"

if [[ "$INSTALL_METHOD" == "dsh-plugin" ]]; then
  command -v pnpm >/dev/null || die "--install-method=dsh-plugin requires pnpm on PATH (npm i -g pnpm@10)"
  log "installing packages through the official CLI (dsh plugin add)"
  for pair in "${PACKAGE_PAIRS[@]}"; do
    name="${pair%%=*}"; dir="${pair#*=}"
    if ! ( cd "$REPO_ROOT" && dsh plugin --profile "$PROFILE" add "$dir" ) >>"$CI_ARTIFACTS_DIR/profile-$PROFILE/plugin-add.log" 2>&1; then
      if [[ "$name" == "$BUNDLE_NAME" ]]; then die "dsh plugin add failed for the bundle package $name (see profile-$PROFILE/plugin-add.log)"; fi
      warn "dsh plugin add failed for support package $name (workspace resolution may already cover it)"
    fi
  done
fi

ensure_bundle_selected "$PROFILE_DIR" "${BUNDLE_NAMES[@]}"
record_profile_dependencies "$PROFILE_DIR" "${PACKAGE_PAIRS[@]}"

log "composing profile to discover the plugin's entry ids"
BASE_DUMP="$CI_ARTIFACTS_DIR/profile-$PROFILE/composed-base.yml"
dsh --profile "$PROFILE" --dump-config >"$BASE_DUMP" 2>"$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-base.err" \
  || die "--dump-config failed: $(tail -5 "$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-base.err")"
if grep -q "skipping profile bundle" "$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-base.err"; then
  grep "skipping profile bundle" "$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-base.err" >&2
  die "the launcher skipped a profile bundle (likely a dsh engines/peer compatibility mismatch); pin DSH_VERSION to match the plugin's engines.dsh"
fi
if ! grep -q "$BUNDLE_NAME" "$BASE_DUMP"; then
  die "bundle $BUNDLE_NAME contributes no rows; check package.json dsh.bundle.patch and the profile bundle list"
fi

GENERATED_PATCH="$PROFILE_DIR/cordis.patch.yml"
DISCOVERED_ENV="$CI_ARTIFACTS_DIR/profile-$PROFILE/discovered.env"
generate_patch "$BASE_DUMP" "$GENERATED_PATCH" "$BUNDLE_NAME" "$DISCOVERED_ENV"

# shellcheck disable=SC1090
source "$DISCOVERED_ENV"

log "validating the generated profile patch with --dump-config"
dsh --profile "$PROFILE" --dump-config >"$CI_ARTIFACTS_DIR/profile-$PROFILE/composed-final.yml" 2>"$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-final.err" \
  || die "generated patch does not compose: $(tail -5 "$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-final.err")"
if grep -q "skipping profile bundle" "$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-final.err"; then
  die "generated profile composition skips a bundle: $(grep 'skipping profile bundle' "$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-final.err")"
fi
cp "$GENERATED_PATCH" "$CI_ARTIFACTS_DIR/profile-$PROFILE/cordis.patch.yml"
cp "$PROFILE_DIR/package.json" "$CI_ARTIFACTS_DIR/profile-$PROFILE/package.json"
cp "$BASE_DUMP" "$CI_ARTIFACTS_DIR/profile-$PROFILE/dump-base.yml" 2>/dev/null || true
rm -f "$BASE_DUMP" 2>/dev/null || true

# A fast, zero-model-call boot smoke test: the app's --help mounts the profile
# far enough to validate plugin config schemas and required rows.
if [[ "$TEMPLATE" == "headless" ]]; then
  log "smoke-testing the composed profile (dsh --profile $PROFILE --help; no model call)"
  set +e
  SMOKE_OUT="$(dsh --profile "$PROFILE" --help 2>&1)"
  SMOKE_CODE=$?
  set -e
  printf '%s\n' "$SMOKE_OUT" > "$CI_ARTIFACTS_DIR/profile-$PROFILE/help-smoke.log"
  if (( SMOKE_CODE != 0 )); then
    printf '%s\n' "$SMOKE_OUT" >&2
    die "profile boot smoke test failed (exit $SMOKE_CODE); see profile-$PROFILE/help-smoke.log"
  fi
fi

set_env DSH_HOME "$DSH_HOME"
set_env DSH_TEST_PROFILE_HEADLESS "ci-headless"
set_env DSH_TEST_PROFILE_WEB "ci-web"
set_env DSH_TEST_MODEL "$DSH_TEST_MODEL"
set_env DSH_TEST_MODEL_CONTEXT_WINDOW "${DSH_TEST_MODEL_CONTEXT_WINDOW:-1048576}"
set_env DSH_TEST_MAX_OUTPUT_TOKENS "$DSH_TEST_MAX_OUTPUT_TOKENS"
set_env DSH_TEST_REASONING_EFFORT "$DSH_TEST_REASONING_EFFORT"
set_env PLUGIN_BUNDLE_NAME "$BUNDLE_NAME"
set_env PLUGIN_ENTRY_IDS "$PLUGIN_ENTRY_IDS"
set_env SESSION_COMPRESSION "$SESSION_COMPRESSION"
set_env DSH_WORKSPACE_ROOT "$REPO_ROOT"
set_env CI_ARTIFACTS_DIR "$CI_ARTIFACTS_DIR"

log "profile '$PROFILE' ready: $PROFILE_DIR"
log "plugin bundle: $BUNDLE_NAME"
log "configured entries: ${PLUGIN_ENTRY_IDS:-<none>}"
log "model: $DSH_TEST_MODEL (ctx ${DSH_TEST_MODEL_CONTEXT_WINDOW:-?}), maxTokens=$DSH_TEST_MAX_OUTPUT_TOKENS, effort=$DSH_TEST_REASONING_EFFORT"
log "env file: $CI_ENV_FILE"
