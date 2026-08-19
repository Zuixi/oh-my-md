# Build the whole workspace without launching the app: frontend production
# build plus the Rust app binary link (the same profile `tauri dev` runs).
# This is the gate that catches link-stage failures such as stale
# src-tauri/target artifacts after a toolchain upgrade (see known-gotchas).
#
# A packaged desktop build is a separate, slower step:
#   pnpm --filter @omd/desktop tauri build

$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

Write-Host "==> desktop (tsc + vite build)"
pnpm --filter @omd/desktop build
if ($LASTEXITCODE -ne 0) { throw "desktop build failed" }

Write-Host "==> rust app binary link (matches tauri dev)"
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --no-default-features
if ($LASTEXITCODE -ne 0) { throw "rust build failed" }

Write-Host "==> build OK"
