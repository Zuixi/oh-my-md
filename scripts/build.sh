#!/usr/bin/env bash
# Thin shim kept for CI steps, docs, and muscle memory: the cross-platform
# sequences live in scripts/task.mjs. Do not add commands here.
#
# Builds the whole workspace without launching the app: frontend production
# build plus the Rust app binary link (the same profile `tauri dev` runs), which
# is the gate that catches link-stage failures such as stale src-tauri/target
# artifacts after a toolchain upgrade.
set -euo pipefail

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/task.mjs" build app
