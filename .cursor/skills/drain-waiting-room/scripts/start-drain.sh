#!/usr/bin/env bash
# Prepare for drain: supervisor only. Agent must answer claims (drain-waiting-room skill).
set -euo pipefail
"$(dirname "$0")/start-supervisor.sh"
