#!/usr/bin/env bash
# Queue newest-empty companies, then answer profile claims until idle.
# NOT done until pnpm enrich:status shows recent_empty: 0.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
cd "${REPO_ROOT}"

DAYS=2
LIMIT=200
MAX=800
while [[ $# -gt 0 ]]; do
  case "$1" in
    --days=*) DAYS="${1#*=}"; shift ;;
    --limit=*) LIMIT="${1#*=}"; shift ;;
    --max=*) MAX="${1#*=}"; shift ;;
    --days) DAYS="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --max) MAX="$2"; shift 2 ;;
    --) shift ;;
    *) shift ;;
  esac
done

echo "enrich:run days=${DAYS} limit=${LIMIT} answer_max=${MAX}"
"${SCRIPT_DIR}/queue.sh" --days="${DAYS}" --limit="${LIMIT}"
echo "answering company_profile claims (foreground)…"
pnpm exec tsx --env-file-if-exists=.env.local src/scripts/enrich-answer-profiles.ts --max="${MAX}"

echo ""
echo "--- status (recent_empty must be 0 before you tell the user it worked) ---"
pnpm exec tsx --env-file-if-exists=.env.local src/scripts/enrich-status.ts --days="${DAYS}"
