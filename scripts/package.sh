#!/usr/bin/env bash
# Package desktop app: builds frontend, creates Tauri release bundle,
# and collects all build artifacts into the root `output/` directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> building desktop package (tauri build)..."
pnpm --filter @omd/desktop tauri build

OUTPUT_DIR="$ROOT/output"
mkdir -p "$OUTPUT_DIR"

BUNDLE_DIR="$ROOT/apps/desktop/src-tauri/target/release/bundle"
RELEASE_DIR="$ROOT/apps/desktop/src-tauri/target/release"

echo "==> collecting artifacts into $OUTPUT_DIR..."

if [[ -d "$BUNDLE_DIR" ]]; then
  find "$BUNDLE_DIR" -maxdepth 3 \( -name "*.dmg" -o -name "*.app.tar.gz" -o -name "*.deb" -o -name "*.AppImage" -o -name "*.msi" -o -name "*-setup.exe" \) -exec cp -f {} "$OUTPUT_DIR/" \; 2>/dev/null || true
fi

if [[ -f "$RELEASE_DIR/omd" ]]; then
  cp -f "$RELEASE_DIR/omd" "$OUTPUT_DIR/"
elif [[ -f "$RELEASE_DIR/omd.exe" ]]; then
  cp -f "$RELEASE_DIR/omd.exe" "$OUTPUT_DIR/"
fi

echo "==> package complete. Output files in $OUTPUT_DIR:"
ls -lh "$OUTPUT_DIR"
