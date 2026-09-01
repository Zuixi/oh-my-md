# Live Preview Task List Item Rendering Spec

Date: 2026-08-31
Status: Approved

## 1. Problem Statement
In Live Preview mode, task list items such as:
```markdown
- [x] Live Preview with folded inline syntax
- [ ] Next item
```
currently render with both the literal `-` mark and the checkbox widget: `- [✓] Live Preview...`.
This happens because `styleListMark` in `packages/engine/src/decorations/blocks.ts` early-returns on `node.node.parent?.getChild("Task")`, leaving the `ListMark` syntax text unreplaced and visible.

In Typora and standard WYSIWYG markdown editors, task list items hide/fold the leading `-` / `*` list marker so that only the checkbox widget is displayed at the front of the list item text, aligning cleanly with regular list item bullet indentation.

## 2. Goals
1. Fold the leading `ListMark` (e.g. `-`, `*`, `+` or digit mark) in a task list item into a clean replace decoration so that no stray `-` is displayed before the checkbox widget.
2. Ensure no overlapping replace decorations occur between `ListIndent`, `ListMark`, and `TaskMarker`.
3. Preserve task list checkbox toggling, click interactions, read-only mode behavior, indentation depth classes (`omd-li-1..4`), and ordered list normalization invariants.
4. Add comprehensive unit tests in engine and verify desktop tests.

## 3. Implementation Details
In `packages/engine/src/decorations/blocks.ts`:
- In `styleListMark`, when `node.node.parent?.getChild("Task")` is present:
  - Keep the line depth class decoration (`omd-li-*`) and `ListIndent` folding if applicable.
  - Instead of returning early without decoration, emit a replace decoration for `ListMark`:
    `out.push({ from: node.from, to: node.to, tag: "replace:ListMark", deco: Decoration.replace({}) })`
  - When the cursor is positioned directly on the `ListMark`, follow existing live-preview mark behavior (or keep it seamlessly folded like other list marks in Route A).
- In `packages/engine/test/blocks.test.ts`:
  - Verify that `collectDecorationSpecs` on task list items produces `replace:ListMark` (with empty replacement) and `widget:checkbox` without overlap.
