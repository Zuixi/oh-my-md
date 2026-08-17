"""Run domain test suites for staged paths."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify import needed_checks

COMMANDS = {
    "engine": [["pnpm", "test"]],
    "desktop": [["pnpm", "--filter", "@omd/desktop", "test"]],
    "rust": [
        [
            "cargo",
            "fmt",
            "--all",
            "--manifest-path",
            "apps/desktop/src-tauri/Cargo.toml",
            "--",
            "--check",
        ],
        [
            "cargo",
            "test",
            "--manifest-path",
            "apps/desktop/src-tauri/Cargo.toml",
        ],
    ],
}


def staged_paths() -> list[str]:
    output = subprocess.check_output(
        ["git", "diff", "--cached", "--name-only", "-z"],
        text=True,
    )
    return [path for path in output.split("\0") if path != ""]


def run_checks(checks: tuple[str, ...], *, cwd: Path) -> int:
    if checks == ():
        print("[pre-commit] no domain test files staged; skipping")
        return 0
    for check in checks:
        for command in COMMANDS[check]:
            printable = " ".join(command)
            print(f"[pre-commit] {check}: {printable}")
            completed = subprocess.run(command, cwd=cwd)
            if completed.returncode != 0:
                print(
                    f"[pre-commit] {check} failed ({printable})",
                    file=sys.stderr,
                )
                return completed.returncode
    return 0


def main() -> int:
    root = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            text=True,
        ).strip()
    )
    checks = needed_checks(staged_paths())
    return run_checks(checks, cwd=root)


if __name__ == "__main__":
    raise SystemExit(main())
