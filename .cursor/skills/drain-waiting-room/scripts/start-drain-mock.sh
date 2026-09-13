#!/usr/bin/env bash
# OFFLINE/TEST ONLY — mock editorial brain + supervisor. Not real LLM judgment.
set -euo pipefail
source "$(dirname "$0")/_repo.sh"
BASE="${HARNESS_BRAIN_BASE:-http://127.0.0.1:4600}"
MAX="${HARNESS_BRAIN_MAX:-25000}"
SUP_MAX="${HARNESS_SUPERVISOR_MAX:-200}"
LOG_BRAIN="${HARNESS_BRAIN_LOG:-/tmp/harness-brain-loop.log}"
LOG_SUP="${HARNESS_SUPERVISOR_LOG:-/tmp/harness-supervisor.log}"

if ! curl -sf "${BASE}/internal/llm/stats" >/dev/null; then
  echo "API not reachable at ${BASE} — start dev server first: pnpm dev"
  exit 1
fi

pkill -f harness-brain-loop 2>/dev/null || true
pkill -f harness-supervisor 2>/dev/null || true
sleep 1

export HARNESS_BRAIN_MAX="${MAX}"
export HARNESS_SUPERVISOR_MAX="${SUP_MAX}"
export HARNESS_BRAIN_BASE="${BASE}"

nohup pnpm exec tsx --env-file=.env.local src/scripts/harness-brain-loop.ts >"${LOG_BRAIN}" 2>&1 &
BRAIN_PID=$!
nohup pnpm exec tsx --env-file=.env.local src/scripts/harness-supervisor.ts >"${LOG_SUP}" 2>&1 &
SUP_PID=$!

echo "MOCK brain loop pid=${BRAIN_PID} log=${LOG_BRAIN}"
echo "supervisor pid=${SUP_PID} log=${LOG_SUP}"
echo ""
echo "⚠  MockProvider only — blocked from publishing in harness mode."
echo "   Production: invoke @drain-waiting-room in Cursor."
