#!/bin/bash
# Renders the landing page's pictures (the hero's water, and three views of
# one room) and writes them, at the widths the
# page asks for, to public/images/landing. Needs Blender (4.2+) and Python
# with Pillow. CPU rendering takes about half an hour; pass a lower sample
# count as $1 for a quick draft.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../../public/images/landing"
SAMPLES=${1:-128}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

blender -b --python "$HERE/water.py" -- "$WORK/water.png" 2400 1350 "$SAMPLES" >/dev/null
for shot in board recap orb; do
  blender -b --python "$HERE/scene.py" -- "$shot" "$WORK/$shot.png" 1500 1000 "$SAMPLES" >/dev/null
done

mkdir -p "$OUT"
python3 "$HERE/export.py" "$WORK" "$OUT"
