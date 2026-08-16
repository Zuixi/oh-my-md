#!/usr/bin/env bash
# Generate CHANGELOG.md from conventional commits via git-cliff.
# git-cliff is a dev-time CLI; install with `brew install git-cliff`
# or `cargo install git-cliff`.
set -euo pipefail

if ! command -v git-cliff >/dev/null 2>&1; then
  echo "error: git-cliff not found; install with 'brew install git-cliff' or 'cargo install git-cliff'" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

git cliff -c cliff.toml -o CHANGELOG.md
echo "wrote CHANGELOG.md"
