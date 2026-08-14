"""Strip any `Co-authored-by:` trailer and require `<type>: <why>` subjects."""

from __future__ import annotations

import re
import sys
from pathlib import Path

TRAILER_RE = re.compile(
    r"(?m)^Co-authored-by:.*\r?\n?"
)
SUBJECT_RE = re.compile(
    r"^(feat|fix|refactor|docs|test|chore|perf|ci): \S"
)
ALLOWED_TYPES = "feat, fix, refactor, docs, test, chore, perf, ci"


def strip_coauthor_trailer(text: str) -> str:
    cleaned = TRAILER_RE.sub("", text)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).rstrip() + "\n"
    return cleaned


def subject_line(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#"):
            continue
        return stripped
    return ""


def validate_subject(text: str) -> str | None:
    subject = subject_line(text)
    if subject == "":
        return "empty commit message after stripping Co-authored-by trailers"
    if subject.startswith("Merge ") or subject.startswith("Revert "):
        return None
    if SUBJECT_RE.match(subject):
        return None
    return (
        "commit subject must be `<type>: <why>` "
        f"where type is one of {ALLOWED_TYPES}"
    )


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: commitmsg.py <message-file>", file=sys.stderr)
        return 2
    path = Path(argv[1])
    cleaned = strip_coauthor_trailer(path.read_text(encoding="utf-8"))
    path.write_text(cleaned, encoding="utf-8")
    error = validate_subject(cleaned)
    if error is not None:
        print(f"[commit-msg] {error}", file=sys.stderr)
        print("[commit-msg] example: feat: add path-filtered pre-commit", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
