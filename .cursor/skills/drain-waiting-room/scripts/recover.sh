#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_repo.sh"
pnpm exec tsx --env-file-if-exists=.env.local src/scripts/harness-recover-stale.ts
