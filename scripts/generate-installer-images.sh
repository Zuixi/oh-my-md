#!/usr/bin/env bash
# Generate Windows installer bitmaps from the master app icon.
#
# NSIS expects 24-bit BMP at fixed aspect ratios; dropping a square PNG/ICO
# into headerImage stretches the logo. Regenerate after changing app-icon.png.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/apps/desktop/app-icon.png"
OUT="$ROOT/apps/desktop/src-tauri/icons"
BG="0xF0F0F0"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to generate installer bitmaps" >&2
  exit 1
fi

if [[ ! -f "$SRC" ]]; then
  echo "missing source icon: $SRC" >&2
  exit 1
fi

scale_pad() {
  local max_w="$1" max_h="$2" pad_w="$3" pad_h="$4" pad_y="$5" dest="$6"
  ffmpeg -y -loglevel error -i "$SRC" \
    -vf "scale=${max_w}:${max_h}:force_original_aspect_ratio=decrease,pad=${pad_w}:${pad_h}:(ow-iw)/2:${pad_y}:color=${BG}" \
    -pix_fmt bgr24 "$dest"
}

mkdir -p "$OUT"

# Tauri NSIS: bundle > windows > nsis > headerImage / sidebarImage
scale_pad 130 45 150 57 "(oh-ih)/2" "$OUT/nsis-header.bmp"
scale_pad 120 120 164 314 80 "$OUT/nsis-sidebar.bmp"

# Tauri WiX: bundle > windows > wix > bannerPath / dialogImagePath
scale_pad 480 48 493 58 "(oh-ih)/2" "$OUT/wix-banner.bmp"
scale_pad 220 220 493 312 50 "$OUT/wix-dialog.bmp"

echo "Wrote installer bitmaps to $OUT"
