#!/usr/bin/env bash
# scan-secrets.sh — fail when credential-looking material is found in the repo.
#
# Used by the static CI job and by .github/workflows/publish.yml (with --publish)
# before any `npm publish`. It never prints a matched value; only file:line and
# the pattern name.
#
# Usage:
#   scripts/ci/scan-secrets.sh                 # scan tracked files (git) or the tree
#   scripts/ci/scan-secrets.sh --publish       # additionally scan npm pack tarballs
#   scripts/ci/scan-secrets.sh --dry-run       # print what would be scanned
#
# Exit codes: 0 clean, 1 findings, 2 usage/precondition error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PUBLISH=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --publish) PUBLISH=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "scan-secrets: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf 'scan-secrets: %s\n' "$*"; }
die() { printf 'scan-secrets: ERROR: %s\n' "$*" >&2; exit 2; }

cd "$REPO_ROOT"

# Credential-looking patterns. None of these match bare environment variable
# *names* such as secrets.DEEPSEEK_API_KEY, so the CI workflow and docs may
# reference those names without tripping the scanner.
# shellcheck disable=SC2016
PATTERNS=(
  'sk-[A-Za-z0-9_-]{16,}'
  'npm_[A-Za-z0-9]{30,}'
  '_authToken[[:space:]]*=[[:space:]]*[^$<{[:space:]]'
  'NPM_TOKEN[[:space:]]*=[[:space:]]*[^$<{[:space:]]'
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
)
# Files that intentionally document the patterns themselves.
EXCLUDE_PATHS='^(scripts/ci/scan-secrets\.sh|docs/ci\.md)$'
# Obvious placeholder tokens are allowed (docs/tests may mention fake keys);
# a real credential never has one of these prefixes.
ALLOWED_FAKE='sk-(testonly|fake|dummy|example|sample|placeholder|redacted|xxxx)'
# Findings never print the matched value: for a real key that would leak it into
# the CI log, so only file:line (and tarball line numbers) are reported.

is_text() { grep -Iq . "$1" 2>/dev/null; }

scan_file() {
  local file="$1"
  local rel="$2"
  [[ -f "$file" ]] || return 0
  is_text "$file" || return 0
  local pattern
  for pattern in "${PATTERNS[@]}"; do
    if matches=$(grep -a -n -E -- "$pattern" "$file" 2>/dev/null | head -20); then
      real_lines="$(printf '%s\n' "$matches" | grep -vE -- "$ALLOWED_FAKE" | cut -d: -f1 | paste -sd, - || true)"
      if [[ -n "$real_lines" ]]; then
        printf 'FINDING pattern=%q file=%s lines=%s\n' "$pattern" "$rel" "$real_lines"
        FOUND=$((FOUND + 1))
      fi
    fi
  done
}

FOUND=0
log "repo: $REPO_ROOT"
log "patterns: ${#PATTERNS[@]} credential-shaped pattern(s)"

if (( DRY_RUN )); then
  if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "dry-run: would scan $(git -C "$REPO_ROOT" ls-files | wc -l) tracked file(s)"
  else
    log "dry-run: not a git work tree; would walk the filesystem (excluding node_modules/.git)"
  fi
  (( PUBLISH )) && log "dry-run: would additionally scan npm pack tarballs of the workspaces"
  exit 0
fi

if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r -d '' rel; do
    [[ "$rel" =~ $EXCLUDE_PATHS ]] && continue
    scan_file "$REPO_ROOT/$rel" "$rel"
  done < <(git -C "$REPO_ROOT" ls-files -z)
else
  log "not a git work tree; falling back to a filesystem walk"
  while IFS= read -r -d '' file; do
    rel="${file#"$REPO_ROOT"/}"
    [[ "$rel" =~ $EXCLUDE_PATHS ]] && continue
    scan_file "$file" "$rel"
  done < <(find "$REPO_ROOT" -type f \
    -not -path "*/node_modules/*" -not -path "*/.git/*" \
    -not -path "*/dist/*" -not -path "*/coverage/*" -print0)
fi

if (( PUBLISH )); then
  command -v npm >/dev/null || die "npm is required for --publish"
  TMP_PACKS="${RUNNER_TEMP:-/tmp}/secret-scan-packs"
  rm -rf "$TMP_PACKS"; mkdir -p "$TMP_PACKS"
  # Pack every npm workspace (and the root) exactly as publish would.
  mapfile -t WORKSPACES < <(node -e '
    const fs = require("fs");
    const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const out = ["."];
    const globs = Array.isArray(root.workspaces) ? root.workspaces
      : root.workspaces && Array.isArray(root.workspaces.packages) ? root.workspaces.packages : [];
    for (const glob of globs) {
      if (!glob.endsWith("/*")) continue;
      const base = glob.slice(0, -2);
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = `${base}/${entry.name}`;
        if (fs.existsSync(`${dir}/package.json`)) out.push(dir);
      }
    }
    process.stdout.write(out.join("\n") + "\n");
  ')
  if (( ${#WORKSPACES[@]} == 0 )); then
    log "warning: no npm workspaces discovered; scanning the root package only"
    WORKSPACES=(.)
  fi
  for dir in "${WORKSPACES[@]}"; do
    log "npm pack --dry-run in $dir"
    ( cd "$REPO_ROOT/$dir" && npm pack --dry-run --json 2>/dev/null >/dev/null ) \
      || die "npm pack --dry-run failed in $dir"
    ( cd "$REPO_ROOT/$dir" && npm pack --pack-destination "$TMP_PACKS" --json 2>/dev/null > "$TMP_PACKS/last-pack.json" ) \
      || die "npm pack failed in $dir"
    tarball="$(node -e '
      const fs = require("fs");
      const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!entry || typeof entry.filename !== "string") process.exit(1);
      process.stdout.write(entry.filename);
    ' "$TMP_PACKS/last-pack.json")" || die "could not parse npm pack output for $dir"
    tarball="$TMP_PACKS/$tarball"
    [[ -f "$tarball" ]] || die "packed tarball not found for $dir: $tarball"
    log "scanning packed tarball $(basename "$tarball")"
    for pattern in "${PATTERNS[@]}"; do
      if matches=$(tar -xOzf "$tarball" 2>/dev/null | grep -a -n -E -- "$pattern" | head -20); then
        real_lines="$(printf '%s\n' "$matches" | grep -vE -- "$ALLOWED_FAKE" | cut -d: -f1 | paste -sd, - || true)"
        if [[ -n "$real_lines" ]]; then
          printf 'FINDING pattern=%q tarball=%s lines=%s\n' "$pattern" "$(basename "$tarball")" "$real_lines"
          FOUND=$((FOUND + 1))
        fi
      fi
    done
    rm -f "$tarball" "$TMP_PACKS/last-pack.json"
  done
fi

if (( FOUND > 0 )); then
  log "FAILED: $FOUND finding(s); remove the credential material before publishing."
  exit 1
fi
log "OK: no credential-shaped material found"
