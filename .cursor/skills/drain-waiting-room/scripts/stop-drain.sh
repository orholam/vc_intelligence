#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_repo.sh"
pkill -f harness-agent-session 2>/dev/null || true
pkill -f harness-supervisor 2>/dev/null || true
pkill -f harness-brain-loop 2>/dev/null || true
echo "stopped harness supervisor and mock brain loops"
