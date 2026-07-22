#!/usr/bin/env bash
# Claude Code hook: PreCompact
# Saves a checkpoint before compaction. Uses CV-Hub API if available, else local CLI.
set -euo pipefail

SESSION_ENV="/tmp/cv-hub-session-$(id -u).env"

# ── Source shared session env (primary propagation path) ─────────────
if [[ -f "$SESSION_ENV" ]]; then
  set -a; source "$SESSION_ENV"; set +a
fi

# ── Load CV-Hub credentials (fallback if env vars not propagated) ────
if [[ -z "${CV_HUB_API:-}" || -z "${CV_HUB_PAT:-}" ]]; then
  CRED_FILE=""
  for candidate in "${CLAUDE_PROJECT_DIR:-.}/.claude/cv-hub.credentials" \
                   "${HOME}/.config/cv-hub/credentials" \
                   "/root/.config/cv-hub/credentials" \
                   ${SUDO_USER:+"/home/${SUDO_USER}/.config/cv-hub/credentials"}; do
    [[ -z "$candidate" ]] && continue
    if [[ -f "$candidate" ]]; then
      CRED_FILE="$candidate"
      break
    fi
  done
  if [[ -n "$CRED_FILE" ]]; then
    set -a; source "$CRED_FILE"; set +a
  fi
fi

# ── Derive CV_HUB_REPO from git remote if still empty ───────────────
if [[ -z "${CV_HUB_REPO:-}" ]]; then
  repo_url=$(git remote get-url origin 2>/dev/null || true)
  if [[ -n "$repo_url" ]]; then
    CV_HUB_REPO=$(echo "$repo_url" | sed -E 's#\.git$##' | sed -E 's#.*[:/]([^/]+/[^/]+)$#\1#')
    export CV_HUB_REPO
  fi
fi

# ── Generate adhoc session ID if still empty ─────────────────────────
if [[ -z "${CV_HUB_SESSION_ID:-}" ]]; then
  CV_HUB_SESSION_ID="adhoc-$(date +%s)-$$"
  export CV_HUB_SESSION_ID
fi

# ── API path ─────────────────────────────────────────────────────────
if [[ -n "${CV_HUB_API:-}" && -n "${CV_HUB_PAT:-}" && -n "${CV_HUB_REPO:-}" && -n "${CV_HUB_SESSION_ID:-}" ]]; then
  owner="${CV_HUB_ORG_OVERRIDE:-${CV_HUB_REPO%%/*}}"
  repoSlug="${CV_HUB_REPO##*/}"

  input=$(cat)

  summary=$(python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(d.get('summary', '')[:5000])
except:
    print('')
" <<< "$input" 2>/dev/null || true)

  files_json="[]"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    changed=$(git diff --name-only HEAD 2>/dev/null || true)
    staged=$(git diff --name-only --cached 2>/dev/null || true)
    all_files=$(echo -e "${changed}\n${staged}" | sort -u)
    if [[ -n "$all_files" ]]; then
      files_json=$(echo "$all_files" | head -30 | python3 -c "
import sys, json
files = [line.strip() for line in sys.stdin if line.strip()]
print(json.dumps(files))
" 2>/dev/null || echo "[]")
    fi
  fi

  payload=$(python3 -c "
import json, sys
print(json.dumps({
    'session_id': '${CV_HUB_SESSION_ID}',
    'transcript_summary': sys.argv[1][:5000],
    'files_in_context': json.loads(sys.argv[2]),
    'symbols_in_context': []
}))
" "$summary" "$files_json" 2>/dev/null) || exit 0

  curl -sf -X POST \
    -H "Authorization: Bearer ${CV_HUB_PAT}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "${CV_HUB_API}/api/v1/repos/${owner}/${repoSlug}/context-engine/checkpoint" \
    >/dev/null 2>&1 || true

# ── CLI fallback ─────────────────────────────────────────────────────
elif [[ -n "${CV_SESSION_ID:-}" ]]; then
  input=$(cat)

  summary=""
  if command -v python3 >/dev/null 2>&1; then
    summary=$(python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(d.get('summary', '')[:5000])
except:
    print('')
" <<< "$input" 2>/dev/null || true)
  fi

  files_csv=""
  if git rev-parse --git-dir >/dev/null 2>&1; then
    changed=$(git diff --name-only HEAD 2>/dev/null || true)
    staged=$(git diff --name-only --cached 2>/dev/null || true)
    all_files=$(echo -e "${changed}\n${staged}" | sort -u | head -30 | tr '\n' ',' || true)
    all_files="${all_files%,}"
    [[ -n "$all_files" ]] && files_csv="$all_files"
  fi

  if [[ -n "$summary" ]] && command -v cv >/dev/null 2>&1; then
    cv knowledge egress \
      --session-id "$CV_SESSION_ID" \
      --turn 9999 \
      --transcript "$summary" \
      ${files_csv:+--files "$files_csv"} \
      --concern "checkpoint" \
      >/dev/null 2>&1 || true
  fi
fi
