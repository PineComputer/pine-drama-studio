#!/usr/bin/env bash
# Builds the macOS app icon upstream/icons/pine-drama-studio.icns (and the 1024-px PNG beside it) from the pixel-drawn small
# sizes in upstream/icons/small/ and upstream/icons/pine-drama-studio.svg with rsvg-convert (librsvg; `brew install librsvg`) and iconutil. Run when the icon changes; the .icns is
# committed, so packaging needs neither tool.
set -euo pipefail
STUDIO="$(cd "$(dirname "$0")/.." && pwd)"
ICONS="$STUDIO/upstream/icons"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
SET="$WORK/pine.iconset"; mkdir "$SET"
# The sizes iconutil expects in an iconset (iconutil(1); Apple, "Optimizing images for icns"). 16, 32 and 64 px are drawn
# on the pixel grid in small/ (upstream/icons/README.md): rasterised from the vector, the clapper stick turns to a faint
# scratch. Only 128 px and up come from the SVG.
cp "$ICONS"/small/icon_16x16.png "$ICONS"/small/icon_16x16@2x.png "$ICONS"/small/icon_32x32.png "$ICONS"/small/icon_32x32@2x.png "$SET/"
for size in 128 256 512; do
	rsvg-convert -w "$size" -h "$size" "$ICONS/pine-drama-studio.svg" -o "$SET/icon_${size}x${size}.png"
	rsvg-convert -w $((size * 2)) -h $((size * 2)) "$ICONS/pine-drama-studio.svg" -o "$SET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$SET" -o "$ICONS/pine-drama-studio.icns"
cp "$SET/icon_512x512@2x.png" "$ICONS/pine-drama-studio-1024.png"
echo "wrote ${ICONS#$STUDIO/}/pine-drama-studio.icns"
