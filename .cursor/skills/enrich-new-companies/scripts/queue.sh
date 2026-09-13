#!/usr/bin/env bash
# Start the enrich runner. Passing --days / --limit here is required — they
# used to be ignored (env-only), which left newest companies out of the batch.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
cd "${REPO_ROOT}"
BASE="${HARNESS_BRAIN_BASE:-http://127.0.0.1:4600}"
LOG="${ENRICH_QUEUE_LOG:-/tmp/enrich-new-companies.log}"
DAYS="${ENRICH_DAYS:-2}"
LIMIT="${ENRICH_LIMIT:-200}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days=*) DAYS="${1#*=}"; shift ;;
    --limit=*) LIMIT="${1#*=}"; shift ;;
    --days) DAYS="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --) shift ;;
    *) shift ;;
  esac
done

if ! curl -sf "${BASE}/internal/llm/stats" >/dev/null; then
  echo "API not reachable at ${BASE} — start: pnpm dev"
  exit 1
fi

pkill -f "src/scripts/enrich-new-companies.ts" 2>/dev/null || true
sleep 1

nohup pnpm exec tsx --env-file-if-exists=.env.local src/scripts/enrich-new-companies.ts \
  --days="${DAYS}" --limit="${LIMIT}" >"${LOG}" 2>&1 &
PID=$!

echo "enrich runner started pid=${PID} log=${LOG}"
echo "  window: last ${DAYS} days, limit ${LIMIT} (newest empty cards first)"
echo ""
echo "NOT DONE. Stay in the claim loop until pnpm enrich:status shows recent_empty: 0"
echo "  tail -f ${LOG}"
