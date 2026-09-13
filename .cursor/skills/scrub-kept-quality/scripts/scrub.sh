#!/usr/bin/env bash
# Scrub bad entity links from kept articles. Pass --dry-run to preview.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
cd "${REPO_ROOT}"
pnpm exec tsx --env-file-if-exists=.env.local src/scripts/scrub-kept-quality.ts "$@"
