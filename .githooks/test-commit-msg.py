#!/usr/bin/env python3
"""Behavior tests for .githooks/commit-msg."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent / "commit-msg"
TRAILER = "Co-authored-by: Cursor <cursoragent@cursor.com>\n"


def run_hook(text: str) -> tuple[int, str, str]:
    with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False) as handle:
        handle.write(text)
        path = Path(handle.name)
    proc = subprocess.run([str(HOOK), str(path)], capture_output=True, text=True)
    return proc.returncode, path.read_text(encoding="utf-8"), proc.stderr


class CommitMsgStripTests(unittest.TestCase):
    def test_strips_cursor_coauthor_and_keeps_subject(self) -> None:
        code, result, _stderr = run_hook("feat: add tabs\n\n" + TRAILER)
        self.assertEqual(code, 0)
        self.assertEqual(result, "feat: add tabs\n")
        self.assertNotIn("cursoragent@cursor.com", result)

    def test_leaves_unrelated_message_alone(self) -> None:
        code, result, _stderr = run_hook("fix: parser crash\n")
        self.assertEqual(code, 0)
        self.assertEqual(result, "fix: parser crash\n")

    def test_strips_trailer_between_body_paragraphs(self) -> None:
        code, result, _stderr = run_hook(
            "docs: hooks\n\nBody.\n" + TRAILER + "\nMore body.\n"
        )
        self.assertEqual(code, 0)
        self.assertEqual(result, "docs: hooks\n\nBody.\n\nMore body.\n")


class CommitMsgFormatTests(unittest.TestCase):
    def test_rejects_subject_without_type_prefix(self) -> None:
        code, _result, stderr = run_hook("add path-filtered hooks\n")
        self.assertNotEqual(code, 0)
        self.assertIn("<type>:", stderr)

    def test_rejects_type_without_space_after_colon(self) -> None:
        code, _result, stderr = run_hook("feat:missing space\n")
        self.assertNotEqual(code, 0)
        self.assertIn("<type>:", stderr)

    def test_allows_merge_and_revert_subjects(self) -> None:
        merge_code, _, _ = run_hook("Merge branch 'topic'\n")
        revert_code, _, _ = run_hook('Revert "feat: add tabs"\n')
        self.assertEqual(merge_code, 0)
        self.assertEqual(revert_code, 0)


if __name__ == "__main__":
    unittest.main()
