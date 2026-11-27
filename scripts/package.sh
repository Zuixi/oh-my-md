#!/usr/bin/env bash
# Thin shim kept for docs and muscle memory: the cross-platform sequences live
# in scripts/task.mjs. Do not add commands here.
#
# Builds the host-platform Tauri bundle and collects the artifacts into
# output/.
set -euo pipefail

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/task.mjs" package app
