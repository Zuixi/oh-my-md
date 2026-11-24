#!/usr/bin/env bash
# Single-source version sync. The source of truth is
# apps/desktop/src-tauri/tauri.conf.json `version`; this script propagates
# one <x.y.z> value to the five version locations:
#   package.json, apps/desktop/package.json,
#   apps/desktop/src-tauri/Cargo.toml, apps/desktop/src-tauri/Cargo.lock,
#   apps/desktop/src-tauri/tauri.conf.json
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

# Cargo.lock also records the local `omd` package version. Rewrite only that
# one [[package]] entry: `cargo update` would move every dependency version and
# turn a version bump into an unrelated lockfile churn commit. CRLF is accepted
# because a Windows checkout with core.autocrlf=true reads it back that way.
set_cargo_lock_version() {
  local file="$1"
  node -e '
    const fs = require("node:fs");
    const [file, version] = process.argv.slice(1);
    const source = fs.readFileSync(file, "utf8");
    const next = source.replace(
      /(\[\[package\]\]\r?\nname = "omd"\r?\nversion = ")[^"]+(")/,
      (_, head, tail) => `${head}${version}${tail}`,
    );
    if (!/\[\[package\]\]\r?\nname = "omd"\r?\nversion = "[^"]+"/.test(source)) {
      console.error(`error: no local omd [[package]] entry in ${file}`);
      process.exit(1);
    }
    if (next !== source) fs.writeFileSync(file, next);
  ' "$file" "$VERSION"
}

set_json_version "package.json"
set_json_version "apps/desktop/package.json"
set_json_version "apps/desktop/src-tauri/tauri.conf.json"

sed -i.bak -E 's/^version = ".*"/version = "'"$VERSION"'"/' \
  apps/desktop/src-tauri/Cargo.toml
rm -f apps/desktop/src-tauri/Cargo.toml.bak

set_cargo_lock_version "apps/desktop/src-tauri/Cargo.lock"

echo "package.json"
echo "apps/desktop/package.json"
echo "apps/desktop/src-tauri/Cargo.toml"
echo "apps/desktop/src-tauri/Cargo.lock"
echo "apps/desktop/src-tauri/tauri.conf.json"
