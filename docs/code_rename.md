# `code_rename` — applying `WorkspaceEdit` to disk

> Implementation notes for the rename applier (`src/workspace-edit.ts`
> `applyWorkspaceEdit` / `applyTextEdits`), used by the `code_rename` tool
> (`nav.ts` `rename()`).

## `applyWorkspaceEdit` — handle with care

`applyWorkspaceEdit` (in `src/workspace-edit.ts`) applies LSP `WorkspaceEdit` results to
disk. It handles both `documentChanges` (preferred, modern) and `changes`
(legacy `{ uri: TextEdit[] }`). It does NOT handle `CreateFile` / `DeleteFile`
/ `RenameFile` resource operations inside `documentChanges` — it skips them
(they're reported but not applied). For rename this is fine (rename produces
text edits, not file ops, except in edge cases like renaming a file's lone
top-level symbol in some servers). **If you add rename-for-files support,
you'll need to handle these.**

The text-edit math sorts edits in **reverse line order** so earlier offsets
stay valid as we splice. Edits are applied in-memory (line array) then written
once. LSP ranges are 0-based. I verified this against a real pyright rename
that produced 3 edits (1 def + 2 refs) → all 3 applied correctly to disk.

Edge case: multi-line `newText` (replacement containing newlines) is handled
via `replacement.split(/\r?\n/)` and re-joining with `head + replacement[0]`
and `tail` on the last segment. Single-line edits take the else branch. If
you touch this, re-test with a multi-line replacement — the splice logic is
fiddly.

## Server variation in `WorkspaceEdit` shape

ty uses the legacy `changes` field (not `documentChanges`) for rename;
`applyWorkspaceEdit` handles both, so the rename tool works with ty
unchanged. pyright/ccls use `documentChanges`. If you add a server that uses
neither field, you'll need a third path. (See also `DESIGN.md` "Python server
auto-detection".)
