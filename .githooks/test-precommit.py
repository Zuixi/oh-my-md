#!/usr/bin/env python3
"""Behavior tests for pre-commit command dispatch."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify import needed_checks
from precommit import COMMANDS, run_checks


class PrecommitDispatchTests(unittest.TestCase):
    def test_empty_checks_skip_without_running_commands(self) -> None:
        self.assertEqual(run_checks((), cwd=Path(".")), 0)

    def test_every_classified_check_has_commands(self) -> None:
        sample = needed_checks(
            [
                "packages/engine/src/index.ts",
                "apps/desktop/src/App.tsx",
                "apps/desktop/src-tauri/src/lib.rs",
            ]
        )
        for check in sample:
            self.assertIn(check, COMMANDS)
            self.assertTrue(COMMANDS[check])


if __name__ == "__main__":
    unittest.main()
