# Thin shim kept for CI steps, docs, and muscle memory: the cross-platform
# sequences live in scripts/task.mjs. Do not add commands here.
#
# Note: cargo test alone never links the app binary. `pnpm verify` or
# `node scripts/task.mjs build` is the gate for link-stage failures.

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $SCRIPT_DIR "task.mjs") test all
exit $LASTEXITCODE
