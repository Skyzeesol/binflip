#!/usr/bin/env bash
# Corrected pipeline on the full archive, side by side with the old outputs (read-only on data/).
#   bash report_run.sh <research data dir> <recorder dir> <mm-data parent dir>
# Writes only into <research data dir>-v2 (symlinks to the archive + outputs, and the 2a46516
# shadow book built for comparison) and prints every result.
set -euo pipefail
D=$1; LIVE=$2; MMP=$3
V2="${D%/}-v2"
mkdir -p "$V2"
OLD="$V2/oldshadow"; OLDMOD="$OLD/dist/shadow.js"
if [ ! -f "$OLDMOD" ]; then
  mkdir -p "$OLD"
  git show 2a46516:packages/core/src/mm/shadow.ts > "$OLD/shadow.ts"
  git show 2a46516:packages/core/src/mm/engine.ts > "$OLD/engine.ts"
  ../../packages/core/node_modules/.bin/tsc --target es2022 --module nodenext --moduleResolution nodenext --outDir "$OLD/dist" "$OLD/shadow.ts" "$OLD/engine.ts"
  echo '{"type":"module"}' > "$OLD/dist/package.json"
fi
for f in "$D"/*.tx.*.gz "$D"/pools.json; do ln -sf "$(readlink -f "$f")" "$V2/"; done
[ -d "$D/ohlcv" ] && ln -sfn "$(readlink -f "$D/ohlcv")" "$V2/ohlcv"
W=BviQcBvnWv5HHxHcouTwRFhrAMPNKuMLzEaSuxCuv6eU
echo "### 1) extract (fixed)"; DATA_DIR="$V2" node extract.mjs "$W"
echo "### 2) pnl OLD (data/) vs NEW (v2)"
echo "--- old:"; DATA_DIR="$D" node -e 'const fs=require("fs");const c=fs.readFileSync(process.argv[1]+"/pnl.jsonl","utf8").trim().split("\n").map(JSON.parse);console.log("closed",c.length,"Σpnl",c.reduce((s,x)=>s+x.pnlPct*x.lotSol/100,0).toFixed(2),"SOL Σfee",c.reduce((s,x)=>s+x.feePct*x.lotSol/100,0).toFixed(2),"SOL")' "$D"
echo "--- new:"; DATA_DIR="$V2" node pnl.mjs | head -3; DATA_DIR="$V2" node pnl.mjs | grep -E "^kârla kapanan|^SOL'ün Y|^kapanan pozisyon|^fiyatsız"
echo "### 3) reconcile NEW (v2)"; DATA_DIR="$V2" node reconcile.mjs | grep -v bindings | cut -c1-400
echo "### 4) features + holdout NEW (v2)"; DATA_DIR="$V2" node features.mjs > /dev/null 2>&1 || echo "features: no ohlcv"; DATA_DIR="$V2" node holdout.mjs
echo "### 5) selection (recorder universe)"; node selection.mjs "$LIVE"
echo "### 6) shadow rescore OLD vs NEW per live window (leader delay 2 / 3 / 5 s)"
for d in "$MMP"/mm-data*; do for dl in 2 3 5; do for m in "$OLDMOD" ../../packages/core/dist/mm/shadow.js; do POOLS_JSON="$D/pools.json" node rescore.mjs "$d" "$m" "$dl"; done; done; done
echo "### 7) shadow replay on the recorder archive OLD vs NEW"
for m in "$OLDMOD" ../../packages/core/dist/mm/shadow.js; do node shadow_replay.mjs "$LIVE" "$m"; done
