#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_repo.sh"
BASE="${HARNESS_BRAIN_BASE:-http://127.0.0.1:4600}"

if curl -sf "${BASE}/internal/llm/stats" >/dev/null; then
  echo "API up — recovering stale harness state"
  pnpm exec tsx --env-file-if-exists=.env.local src/scripts/harness-recover-stale.ts
else
  echo "API down — start server: pnpm dev"
  exit 1
fi

"$(dirname "$0")/start-supervisor.sh"
curl -sf -X POST "${BASE}/v1/exoskeleton/harness/run" | python3 -m json.tool 2>/dev/null || true
echo ""
echo "Ready. Invoke @drain-waiting-room — agent must claim → answer → POST until done."
