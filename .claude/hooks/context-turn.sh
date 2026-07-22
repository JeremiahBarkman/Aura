#!/usr/bin/env bash
if [[ "${CV_HUB_DEBUG:-}" == "1" ]]; then
  exec 2>/tmp/cv-hook-context-turn-$(id -u).log
  set -x
fi
# Claude Code hook: Stop (context engine turn injection + egress)
# Fires after each response cycle. Uses CV-Hub API if available, else local CLI.
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

  # Turn counter
  turn_file="/tmp/cv-connect-turn-${CV_HUB_SESSION_ID}"
  if [[ -f "$turn_file" ]]; then
    turn_number=$(( $(cat "$turn_file") + 1 ))
  else
    turn_number=1
  fi
  echo "$turn_number" > "$turn_file"

  # Extract last assistant message
  transcript_segment=$(python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    msg = d.get('last_assistant_message', '')
    print(msg[:2000])
except:
    print('')
" <<< "$input" 2>/dev/null || true)

  # Extract files touched from git changes
  files_json="[]"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    changed=$(git diff --name-only HEAD 2>/dev/null || true)
    if [[ -n "$changed" ]]; then
      files_json=$(echo "$changed" | head -20 | python3 -c "
import sys, json
files = [line.strip() for line in sys.stdin if line.strip()]
print(json.dumps(files))
" 2>/dev/null || echo "[]")
    fi
  fi

  # Pull: call /turn for context injection
  payload=$(python3 -c "
import json
print(json.dumps({
    'session_id': '${CV_HUB_SESSION_ID}',
    'files_touched': ${files_json},
    'symbols_referenced': [],
    'turn_count': ${turn_number},
    'estimated_tokens_used': 0,
    'concern': 'codebase'
}))
" 2>/dev/null) || exit 0

  resp=$(curl -sf -X POST \
    -H "Authorization: Bearer ${CV_HUB_PAT}" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "${CV_HUB_API}/api/v1/repos/${owner}/${repoSlug}/context-engine/turn" 2>/dev/null) || exit 0

  ctx_md=$(python3 -c "
import sys, json
d = json.load(sys.stdin)
md = d.get('data', {}).get('context_markdown', '')
if md.strip():
    print(md)
" <<< "$resp" 2>/dev/null || true)

  if [[ -n "$ctx_md" ]]; then
    echo "$ctx_md"
  fi

  # Push: fire-and-forget /egress call
  if [[ -n "$transcript_segment" ]]; then
    egress_payload=$(python3 -c "
import json, sys
segment = sys.stdin.read()
print(json.dumps({
    'session_id': '${CV_HUB_SESSION_ID}',
    'turn_number': ${turn_number},
    'transcript_segment': segment,
    'files_touched': ${files_json},
    'symbols_referenced': [],
    'concern': 'codebase'
}))
" <<< "$transcript_segment" 2>/dev/null || true)

    if [[ -n "$egress_payload" ]]; then
      curl -sf -X POST \
        -H "Authorization: Bearer ${CV_HUB_PAT}" \
        -H "Content-Type: application/json" \
        -d "$egress_payload" \
        "${CV_HUB_API}/api/v1/repos/${owner}/${repoSlug}/context-engine/egress" \
        >/dev/null 2>&1 &
    fi
  fi

  # ── Task relay: prompt responses + auto-claim ─────────────────────
  if [[ -n "${CV_HUB_EXECUTOR_ID:-}" ]]; then
    task_file="/tmp/cv-hub-task-${CV_HUB_EXECUTOR_ID}"
    seen_file="/tmp/cv-hub-task-prompts-seen-${CV_HUB_EXECUTOR_ID}"

    # ── Check for prompt responses on current task ────────────────
    if [[ -f "$task_file" ]]; then
      current_task_id=$(cat "$task_file")

      if [[ -n "$current_task_id" ]]; then
        prompts_resp=$(curl -sf \
          -H "Authorization: Bearer ${CV_HUB_PAT}" \
          "${CV_HUB_API}/api/v1/tasks/${current_task_id}/prompts" \
          2>/dev/null) || true

        if [[ -n "$prompts_resp" ]]; then
          seen_count=0
          [[ -f "$seen_file" ]] && seen_count=$(cat "$seen_file")

          python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    prompts = d.get('prompts', [])
    seen = int(sys.argv[1])
    seen_file = sys.argv[2]
    responded = [p for p in prompts if p.get('response') is not None]
    new_responses = responded[seen:]
    if new_responses:
        print()
        print('---')
        print('[CV-Hub: User Responded to Your Questions]')
        for r in new_responses:
            print(f'Q: {r["prompt_text"]}')
            print(f'A: {r["response"]}')
            print()
        print('Continue working on the task with this input.')
        print('---')
    with open(seen_file, 'w') as f:
        f.write(str(len(responded)))
except:
    pass
" "$seen_count" "$seen_file" <<< "$prompts_resp" 2>/dev/null || true
        fi

        task_check=$(curl -sf \
          -H "Authorization: Bearer ${CV_HUB_PAT}" \
          "${CV_HUB_API}/api/v1/tasks/${current_task_id}" \
          2>/dev/null) || true

        if [[ -n "$task_check" ]]; then
          task_status=$(python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('task', {}).get('status', ''))
except:
    pass
" <<< "$task_check" 2>/dev/null || true)

          if [[ "$task_status" == "cancelled" ]]; then
            echo ""
            echo "---"
            echo "[CV-Hub: Task Cancelled]"
            echo "Task ${current_task_id} has been cancelled by the user."
            echo "Stop working on this task."
            echo "---"
            rm -f "$task_file" "$seen_file"
          elif [[ "$task_status" == "completed" || "$task_status" == "failed" ]]; then
            rm -f "$task_file" "$seen_file"
          fi
        fi
      fi
    fi

    # ── Auto-claim: poll for new tasks (only if no current task) ──
    if [[ ! -f "$task_file" ]]; then
      task_resp=$(curl -sf -X POST \
        -H "Authorization: Bearer ${CV_HUB_PAT}" \
        -H "Content-Type: application/json" \
        "${CV_HUB_API}/api/v1/executors/${CV_HUB_EXECUTOR_ID}/poll" \
        2>/dev/null || true)

      if [[ -n "$task_resp" ]]; then
        task_id=$(python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    t = d.get('task')
    if t and t.get('id'):
        print(t['id'])
except:
    pass
" <<< "$task_resp" 2>/dev/null || true)

        if [[ -n "$task_id" ]]; then
          echo "$task_id" > "$task_file"

          curl -sf -X POST \
            -H "Authorization: Bearer ${CV_HUB_PAT}" \
            "${CV_HUB_API}/api/v1/executors/${CV_HUB_EXECUTOR_ID}/tasks/${task_id}/start" \
            >/dev/null 2>&1 || true

          python3 -c "
import sys, json
d = json.load(sys.stdin)
t = d.get('task', {})
if t:
    print()
    print('---')
    print('[CV-Hub Task Dispatched]')
    print(f'Task ID: {t["id"]}')
    print(f'Title: {t.get("title", "Untitled")}')
    if t.get('description'):
        print(f'Description: {t["description"]}')
    if t.get('input'):
        inp = t['input']
        if inp.get('instructions'):
            print('Instructions:')
            for i in inp['instructions']:
                print(f'  - {i}')
        if inp.get('constraints'):
            print('Constraints:')
            for c in inp['constraints']:
                print(f'  - {c}')
    print()
    print('When done, report results:')
    print(f'  curl -X POST -H "Authorization: Bearer \\\$CV_HUB_PAT" -H "Content-Type: application/json" \\\\')
    print(f'    -d \'{{"summary": "...", "files_modified": [...]}}\' \\\\')
    print(f'    "\\\$CV_HUB_API/api/v1/executors/\\\$CV_HUB_EXECUTOR_ID/tasks/{t["id"]}/complete"')
    print()
    print('If you need user input:')
    print(f'  curl -X POST -H "Authorization: Bearer \\\$CV_HUB_PAT" -H "Content-Type: application/json" \\\\')
    print(f'    -d \'{{"prompt_text": "your question", "options": ["A", "B"]}}\' \\\\')
    print(f'    "\\\$CV_HUB_API/api/v1/tasks/{t["id"]}/prompts"')
    print('---')
" <<< "$task_resp" 2>/dev/null || true
        fi
      fi
    fi
  fi

# ── CLI fallback ─────────────────────────────────────────────────────
elif [[ -n "${CV_SESSION_ID:-}" ]]; then
  input=$(cat)

  turn_file="/tmp/cv-turn-${CV_SESSION_ID}"
  if [[ -f "$turn_file" ]]; then
    turn_number=$(( $(cat "$turn_file") + 1 ))
  else
    turn_number=1
  fi
  echo "$turn_number" > "$turn_file"

  transcript_segment=""
  if command -v python3 >/dev/null 2>&1; then
    transcript_segment=$(python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(d.get('last_assistant_message', '')[:2000])
except:
    print('')
" <<< "$input" 2>/dev/null || true)
  fi

  files_csv=""
  if git rev-parse --git-dir >/dev/null 2>&1; then
    changed=$(git diff --name-only HEAD 2>/dev/null | head -20 | tr '\n' ',' || true)
    changed="${changed%,}"
    [[ -n "$changed" ]] && files_csv="$changed"
  fi

  if [[ -n "$transcript_segment" ]] && command -v cv >/dev/null 2>&1; then
    cv knowledge egress \
      --session-id "$CV_SESSION_ID" \
      --turn "$turn_number" \
      --transcript "$transcript_segment" \
      ${files_csv:+--files "$files_csv"} \
      --concern "codebase" \
      >/dev/null 2>&1 &
  fi

  if [[ -n "$files_csv" ]] && command -v cv >/dev/null 2>&1; then
    cv knowledge query --files "$files_csv" --exclude-session "$CV_SESSION_ID" --limit 3 2>/dev/null || true
  fi
fi
