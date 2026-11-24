# Run every test suite in the workspace: engine (tsc + vitest), desktop
# (tsc + vitest), and Rust (cargo test).
#
# Note: cargo test alone never links the app binary. To verify the bin links
# (and catch link-stage failures), run build.ps1 or `pnpm verify` instead.

$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

Write-Host "==> quality (module-size gate + behavior tests)"
pnpm check:quality
if ($LASTEXITCODE -ne 0) { throw "quality checks failed" }

Write-Host "==> engine (tsc --noEmit + vitest)"
pnpm test
if ($LASTEXITCODE -ne 0) { throw "engine tests failed" }

Write-Host "==> desktop (tsc + vitest)"
pnpm --filter @omd/desktop test
if ($LASTEXITCODE -ne 0) { throw "desktop tests failed" }

Write-Host "==> rust (cargo fmt + clippy + test)"
cargo fmt --all --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
if ($LASTEXITCODE -ne 0) { throw "rust fmt check failed" }
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
if ($LASTEXITCODE -ne 0) { throw "rust clippy failed" }
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw "rust tests failed" }

Write-Host "==> tests OK"
