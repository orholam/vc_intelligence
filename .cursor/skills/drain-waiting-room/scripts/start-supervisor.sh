#!/usr/bin/env bash
# Start harness cycle supervisor only — LLM answers must come from drain-waiting-room skill.
set -euo pipefail
source "$(dirname "$0")/_repo.sh"
BASE="${HARNESS_BRAIN_BASE:-http://127.0.0.1:4600}"
SUP_MAX="${HARNESS_SUPERVISOR_MAX:-200}"
LOG_SUP="${HARNESS_SUPERVISOR_LOG:-/tmp/harness-supervisor.log}"

if ! curl -sf "${BASE}/internal/llm/stats" >/dev/null; then
  echo "API not reachable at ${BASE} — start dev server first: pnpm dev"
  exit 1
fi

pkill -f harness-supervisor 2>/dev/null || true
sleep 1

export HARNESS_SUPERVISOR_MAX="${SUP_MAX}"
export HARNESS_BRAIN_BASE="${BASE}"

nohup pnpm exec tsx --env-file=.env.local src/scripts/harness-supervisor.ts >"${LOG_SUP}" 2>&1 &
SUP_PID=$!

echo "supervisor pid=${SUP_PID} log=${LOG_SUP}"
echo ""
echo "Supervisor re-fires harness batches when waiting > 0. It does NOT answer LLM claims."
echo ""
echo "Next: invoke @drain-waiting-room — agent loops claim → answer → POST (model: harness:agent)."
