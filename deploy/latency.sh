#!/usr/bin/env bash
# Copy latency from the listener: time from the leader's block to our stored event.
#   ./deploy/latency.sh [since]     e.g. ./deploy/latency.sh 6h
set -euo pipefail
cd "$(dirname "$0")/.."
since="${1:-24h}"
docker compose logs --no-color --since "$since" listener 2>/dev/null \
  | grep -oE '"latencyMs":[0-9]+,"source":"[a-z]+"' \
  | sed -E 's/"latencyMs":([0-9]+),"source":"([a-z]+)"/\1 \2/' \
  | sort -n \
  | awk '{ v[NR]=$1; src[$2]++ } END {
      if (NR == 0) { print "no leader events in the window"; exit }
      printf "events: %d  (ws: %d, poll: %d)\n", NR, src["ws"], src["poll"]
      printf "p50: %.1f s   p90: %.1f s   p95: %.1f s   max: %.1f s\n", v[int(NR*0.5)+0]/1000, v[int(NR*0.9)+0]/1000, v[int(NR*0.95)+0]/1000, v[NR]/1000
      if (src["ws"] == 0) print "note: nothing arrived via WebSocket; everything came from the backup poll"
    }' 2>/dev/null || true
