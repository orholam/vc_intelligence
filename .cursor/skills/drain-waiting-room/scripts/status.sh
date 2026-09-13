#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_repo.sh"
BASE="${HARNESS_BRAIN_BASE:-http://127.0.0.1:4600}"
curl -sf "${BASE}/v1/exoskeleton/snapshot" | python3 -c "
import json,sys
d=json.load(sys.stdin)
h=d['harness']
lr=h.get('last_run') or {}
st=d['stages']
print('waiting:', st['waiting_now'])
print('published_24h:', st.get('published_24h'))
print('harness_discards_24h:', st.get('harness_discards_24h'))
print('harness_running:', h['running_now'])
if lr:
    print('last_run:', lr.get('run_id','')[-16:])
    print('  scanned:', lr.get('scanned'), 'published:', lr.get('published'))
    print('  discards:', lr.get('relevance_discards'), 'incomplete:', lr.get('incomplete_skipped'))
    print('  chunk:', lr.get('chunk_done'), '/', lr.get('chunks_total'))
    print('  deep_searched:', lr.get('new_companies_deep_searched'))
    print('  cards_updated:', lr.get('cards_updated'), 'facts_accepted:', lr.get('facts_accepted'))
"
curl -sf "${BASE}/internal/llm/stats" | python3 -c "import json,sys; q=json.load(sys.stdin).get('queue',{}); print('llm_queue:', q)"
