# Package desktop app on Windows: builds frontend, creates Tauri release bundle,
# and collects all build artifacts into the root `output/` directory.

$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ROOT

Write-Host "==> building desktop package (tauri build)..."
pnpm --filter @omd/desktop tauri build
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$OUTPUT_DIR = Join-Path $ROOT "output"
if (-not (Test-Path $OUTPUT_DIR)) {
    New-Item -ItemType Directory -Path $OUTPUT_DIR | Out-Null
}

$BUNDLE_DIR = Join-Path $ROOT "apps/desktop/src-tauri/target/release/bundle"
$RELEASE_DIR = Join-Path $ROOT "apps/desktop/src-tauri/target/release"

Write-Host "==> collecting artifacts into $OUTPUT_DIR..."

if (Test-Path $BUNDLE_DIR) {
    Get-ChildItem -Path $BUNDLE_DIR -Recurse -Include *.msi, *-setup.exe, *.exe, *.dmg, *.deb, *.AppImage | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $OUTPUT_DIR -Force
    }
}

$OMD_EXE = Join-Path $RELEASE_DIR "omd.exe"
if (Test-Path $OMD_EXE) {
    Copy-Item -Path $OMD_EXE -Destination $OUTPUT_DIR -Force
}

Write-Host "==> package complete. Output files in $OUTPUT_DIR:"
Get-ChildItem -Path $OUTPUT_DIR
