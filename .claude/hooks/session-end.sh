#!/usr/bin/env bash
# Claude Code hook: SessionEnd
# Marks executor offline in CV-Hub and cleans up local state.
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

# ── API path: mark executor offline ──────────────────────────────────
if [[ -n "${CV_HUB_EXECUTOR_ID:-}" && -n "${CV_HUB_API:-}" && -n "${CV_HUB_PAT:-}" ]]; then
  curl -sf -X POST \
    -H "Authorization: Bearer ${CV_HUB_PAT}" \
    "${CV_HUB_API}/api/v1/executors/${CV_HUB_EXECUTOR_ID}/offline" \
    >/dev/null 2>&1 || true
fi

# ── Cleanup ──────────────────────────────────────────────────────────
rm -f "$SESSION_ENV" 2>/dev/null || true
rm -f /tmp/cv-connect-turn-* 2>/dev/null || true
if [[ -n "${CV_HUB_SESSION_ID:-}" ]]; then
  rm -f "/tmp/cv-connect-turn-${CV_HUB_SESSION_ID}" 2>/dev/null || true
fi
if [[ -n "${CV_SESSION_ID:-}" ]]; then
  rm -f "/tmp/cv-turn-${CV_SESSION_ID}" 2>/dev/null || true
fi
