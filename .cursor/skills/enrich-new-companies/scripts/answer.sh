#!/usr/bin/env bash
# Answer company_profile claims from packed evidence (harness:agent).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
cd "${REPO_ROOT}"
MAX=800
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max=*) MAX="${1#*=}"; shift ;;
    --max) MAX="$2"; shift 2 ;;
    --) shift ;;
    *) shift ;;
  esac
done
exec pnpm exec tsx --env-file-if-exists=.env.local src/scripts/enrich-answer-profiles.ts --max="${MAX}"
