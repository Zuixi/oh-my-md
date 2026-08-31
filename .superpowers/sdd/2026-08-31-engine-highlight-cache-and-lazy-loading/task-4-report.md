# Task 4 Report

Status: done.

Changed:
- Added `tableEqualityKey(table)` and cached it on `TableWidget` construction.
- Swapped repeated `JSON.stringify(table)` comparisons for cached key equality.
- Added focused table equality regression tests.

Tests:
- `pnpm --filter @omd/engine test -- tableWidgetEquality.test.ts blockwidgets.test.ts`
- `pnpm --filter @omd/engine test`

Concerns:
- None.
