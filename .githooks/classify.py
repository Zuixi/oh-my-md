"""Map staged paths to the domain checks pre-commit should run."""

from __future__ import annotations

from collections.abc import Iterable

ENGINE_SKIP = frozenset({"packages/engine/AGENTS.md"})
DESKTOP_SKIP = frozenset(
    {
        "apps/desktop/AGENTS.md",
        "apps/desktop/README.md",
    }
)
CHECK_ORDER = ("engine", "desktop", "rust")


def needed_checks(paths: Iterable[str]) -> tuple[str, ...]:
    engine = False
    desktop = False
    rust = False
    for raw in paths:
        path = raw.replace("\\", "/")
        if path.startswith("packages/engine/") and path not in ENGINE_SKIP:
            engine = True
        elif path.startswith("apps/desktop/src-tauri/"):
            rust = True
        elif path.startswith("apps/desktop/") and path not in DESKTOP_SKIP:
            desktop = True
    selected = []
    if engine:
        selected.append("engine")
    if desktop:
        selected.append("desktop")
    if rust:
        selected.append("rust")
    return tuple(selected)
