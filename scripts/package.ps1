# Thin shim kept for docs and muscle memory: the cross-platform sequences live
# in scripts/task.mjs. Do not add commands here.
#
# Builds the host-platform Tauri bundle and collects the artifacts into
# output/.

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
node (Join-Path $SCRIPT_DIR "task.mjs") package app
exit $LASTEXITCODE
