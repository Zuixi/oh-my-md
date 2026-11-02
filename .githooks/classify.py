"""Map staged paths to the domain checks pre-commit should run."""

from __future__ import annotations

from collections.abc import Iterable

SOURCE_EXTENSIONS = frozenset(
    {"ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "rs", "py"}
)
QUALITY_PATHS = frozenset(
    {"scripts/module-size-baseline.json", "package.json", ".github/workflows/ci.yml"}
)


def needed_checks(paths: Iterable[str]) -> tuple[str, ...]:
    modules = False
    engine = False
    desktop = False
    rust = False
    for raw in paths:
        path = raw.replace("\\", "/")
        if path == "AGENTS.md" or path.endswith("/AGENTS.md"):
            continue
        if path.rsplit(".", 1)[-1] in SOURCE_EXTENSIONS or path in QUALITY_PATHS:
            modules = True
        if path.startswith("packages/engine/"):
            engine = True
            desktop = True
        elif path.startswith("apps/desktop/src-tauri/"):
            rust = True
        elif path.startswith("apps/desktop/") and path != "apps/desktop/README.md":
            desktop = True
    selected = []
    if modules:
        selected.append("modules")
    if engine:
        selected.append("engine")
    if desktop:
        selected.append("desktop")
    if rust:
        selected.append("rust")
    return tuple(selected)
