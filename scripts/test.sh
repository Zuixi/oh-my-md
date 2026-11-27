#!/usr/bin/env bash
# Thin shim kept for CI steps, docs, and muscle memory: the cross-platform
# sequences live in scripts/task.mjs. Do not add commands here.
#
# Note: cargo test alone never links the app binary. `pnpm verify` or
# `node scripts/task.mjs build` is the gate for link-stage failures.
set -euo pipefail

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/task.mjs" test all
