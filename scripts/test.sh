#!/usr/bin/env bash
# Run every test suite in the workspace: engine (tsc + vitest), desktop
# (tsc + vitest), and Rust (cargo test).
#
# Note: cargo test alone never links the app binary. To verify the bin links
# (and catch link-stage failures), run build.sh or `pnpm verify` instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> engine (tsc --noEmit + vitest)"
pnpm test

echo "==> desktop (tsc + vitest)"
pnpm --filter @omd/desktop test

echo "==> rust (cargo test)"
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml

echo "==> tests OK"
