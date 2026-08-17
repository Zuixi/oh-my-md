#!/usr/bin/env bash
# Build the whole workspace without launching the app: frontend production
# build plus the Rust app binary link (the same profile `tauri dev` runs).
# This is the gate that catches link-stage failures such as stale
# src-tauri/target artifacts after a toolchain upgrade (see known-gotchas).
#
# A packaged desktop build is a separate, slower step:
#   pnpm --filter @omd/desktop tauri build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> desktop (tsc + vite build)"
pnpm --filter @omd/desktop build

echo "==> rust app binary link (matches tauri dev)"
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features

echo "==> build OK"
