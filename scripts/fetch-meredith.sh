#!/usr/bin/env bash
# Fetch David Meredith's "8x25000" pitch-spelling corpus — the literature-standard
# benchmark ps13 / Temperley / Cambouropoulos / Chew report on (216 movements,
# 195,972 notes; Corelli, Vivaldi, Telemann, Bach, Handel, Haydn, Mozart, Beethoven).
# Ground truth we did NOT author, so it is an independent check on our curated fixtures.
#
# Source: http://www.titanmusic.com/data/dphil/{opnd-m,opnd-m-noisy}.zip
# Layout produced (gitignored): corpora/meredith/opnd-m/opnd-m/*.opnd-m  (double-nested)
#                               corpora/meredith/opnd-m-noisy/opnd-m-noisy/*.opnd-m-noisy
#
# Idempotent: skips a variant already extracted. Run from the repo root:
#   scripts/fetch-meredith.sh
set -euo pipefail

BASE_URL="http://www.titanmusic.com/data/dphil"
DEST="corpora/meredith"
mkdir -p "$DEST"

for stem in opnd-m opnd-m-noisy; do
    if [ -d "$DEST/$stem/$stem" ] && [ -n "$(ls -A "$DEST/$stem/$stem" 2>/dev/null)" ]; then
        echo "✓ $stem already present ($(ls "$DEST/$stem/$stem" | wc -l | tr -d ' ') files) — skipping"
        continue
    fi
    zip="$DEST/$stem.zip"
    echo "↓ downloading $stem.zip …"
    curl -fSL --retry 3 -o "$zip" "$BASE_URL/$stem.zip"
    echo "  unzipping into $DEST/$stem/ …"
    unzip -q -o "$zip" -d "$DEST/$stem"
    rm -f "$zip"
    echo "✓ $stem: $(ls "$DEST/$stem/$stem" | wc -l | tr -d ' ') files"
done

echo "Done. Score with:  npm run meredith        (clean)"
echo "                    npm run meredith -- --noisy"
