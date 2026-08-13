#!/usr/bin/env python3
"""Behavior tests for path-filtered pre-commit classification."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from classify import needed_checks


class NeededChecksTests(unittest.TestCase):
    def test_docs_only_runs_nothing(self) -> None:
        self.assertEqual(needed_checks(["docs/manual-qa.md", "AGENTS.md"]), ())

    def test_engine_source_runs_engine_tests(self) -> None:
        self.assertEqual(
            needed_checks(["packages/engine/src/decorations/build.ts"]),
            ("engine",),
        )

    def test_engine_fixture_markdown_runs_engine_tests(self) -> None:
        self.assertEqual(
            needed_checks(["packages/engine/test/fixtures/lists.md"]),
            ("engine",),
        )

    def test_engine_agents_guide_runs_nothing(self) -> None:
        self.assertEqual(needed_checks(["packages/engine/AGENTS.md"]), ())

    def test_desktop_frontend_runs_desktop_tests(self) -> None:
        self.assertEqual(needed_checks(["apps/desktop/src/App.tsx"]), ("desktop",))

    def test_desktop_package_manifest_runs_desktop_tests(self) -> None:
        self.assertEqual(needed_checks(["apps/desktop/package.json"]), ("desktop",))

    def test_desktop_agents_guide_runs_nothing(self) -> None:
        self.assertEqual(needed_checks(["apps/desktop/AGENTS.md"]), ())

    def test_tauri_source_runs_rust_tests(self) -> None:
        self.assertEqual(
            needed_checks(["apps/desktop/src-tauri/src/lib.rs"]),
            ("rust",),
        )

    def test_tauri_does_not_also_select_desktop(self) -> None:
        self.assertEqual(
            needed_checks(["apps/desktop/src-tauri/tauri.conf.json"]),
            ("rust",),
        )

    def test_cross_layer_runs_each_matching_domain(self) -> None:
        self.assertEqual(
            needed_checks(
                [
                    "packages/engine/src/index.ts",
                    "apps/desktop/src/Editor.ts",
                    "apps/desktop/src-tauri/src/menu.rs",
                ]
            ),
            ("engine", "desktop", "rust"),
        )


if __name__ == "__main__":
    unittest.main()
