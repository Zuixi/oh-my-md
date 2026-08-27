#!/usr/bin/env bash
# Generate Windows installer bitmaps from the master app icon.
#
# NSIS sidebar / WiX banners use fixed-aspect 24-bit BMPs. Inner installer pages
# intentionally omit headerImage — brand lives on the welcome/finish sidebar only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_PYTHON="$ROOT/scripts/.venv/bin/python"

if [[ -x "$VENV_PYTHON" ]]; then
  exec "$VENV_PYTHON" "$ROOT/scripts/generate_installer_images.py"
fi

if ! python3 -c "from PIL import Image" 2>/dev/null; then
  echo "Pillow is required. Either:" >&2
  echo "  python3 -m venv scripts/.venv && scripts/.venv/bin/pip install Pillow" >&2
  echo "  pip install Pillow  # in your environment" >&2
  exit 1
fi

exec python3 "$ROOT/scripts/generate_installer_images.py"
