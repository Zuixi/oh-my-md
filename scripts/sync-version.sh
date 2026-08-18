#!/usr/bin/env bash
# Single-source version sync. The source of truth is
# apps/desktop/src-tauri/tauri.conf.json `version`; this script propagates
# one <x.y.z> value to the four version locations:
#   package.json, apps/desktop/package.json,
#   apps/desktop/src-tauri/Cargo.toml, apps/desktop/src-tauri/tauri.conf.json
set -euo pipefail

VERSION="${1:-}"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must match x.y.z (got \"$VERSION\")" >&2
  echo "usage: $0 <x.y.z>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set_json_version() {
  local file="$1"
  node -e '
    const fs = require("node:fs");
    const [file, version] = process.argv.slice(1);
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    if (pkg.version !== version) {
      pkg.version = version;
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    }
  ' "$file" "$VERSION"
}

set_json_version "package.json"
set_json_version "apps/desktop/package.json"
set_json_version "apps/desktop/src-tauri/tauri.conf.json"

sed -i.bak -E 's/^version = ".*"/version = "'"$VERSION"'"/' \
  apps/desktop/src-tauri/Cargo.toml
rm -f apps/desktop/src-tauri/Cargo.toml.bak

echo "package.json"
echo "apps/desktop/package.json"
echo "apps/desktop/src-tauri/Cargo.toml"
echo "apps/desktop/src-tauri/tauri.conf.json"
