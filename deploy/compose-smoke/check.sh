#!/usr/bin/env bash
set -euo pipefail
compose=(docker compose -f docker-compose.yml -f deploy/compose-smoke/compose.yml)

"${compose[@]}" build migrate
"${compose[@]}" up -d --wait --wait-timeout 90 postgres redis rpc
"${compose[@]}" run --rm migrate
"${compose[@]}" exec -T rpc node apps/listener/smoke.mjs seed
"${compose[@]}" up -d --wait --wait-timeout 120
curl -fsS http://127.0.0.1:3000/api/v1/status | jq -e '.mode == "dry_run"'

# The close appears at RPC only once the listener and executor are both down.
"${compose[@]}" stop listener executor
"${compose[@]}" exec -T rpc node apps/listener/smoke.mjs release
"${compose[@]}" up -d --wait --wait-timeout 90 listener
"${compose[@]}" exec -T rpc node apps/listener/smoke.mjs queued
"${compose[@]}" up -d --wait --wait-timeout 90 executor
"${compose[@]}" exec -T rpc node apps/listener/smoke.mjs closed

"${compose[@]}" restart listener executor
"${compose[@]}" up -d --wait --wait-timeout 90 listener executor
"${compose[@]}" exec -T rpc node apps/listener/smoke.mjs closed
