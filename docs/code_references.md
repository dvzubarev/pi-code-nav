# `code_references` — semantic source context

`code_references` asks the language server for semantically correct reference locations, then uses tree-sitter to explain each location. Tree-sitter does **not** discover references; it only selects source ranges and classifies the role at locations already returned by LSP.

## Parameters

```ts
{
  path: string;
  line: number;       // 1-based
  column: number;     // 1-based
  context?: "none" | "syntax" | "enclosing"; // default "syntax"
  offset?: number;    // 1-based reference index, default 1
  limit?: number;     // default 25, hard cap 200
  list_symbols?: boolean; // default false; requires contextual output
}
```

- `none` returns compact `path:line:column` rows.
- `syntax` returns the smallest useful complete expression or statement. Calls and members expand through containing expressions so a nested reference renders its consumer (`player.addCard(deck.drawCard());`, not merely `deck.drawCard()`). Plain reads similarly expand to their nearest complete expression (and, when needed, their containing statement). Every selected range renders complete physical source lines, retaining indentation, attributes, control-flow keywords, and terminators; multiline expressions retain all of their lines.
- `enclosing` finds the nearest meaningful structural ancestor: a loop, branch, switch/case, function/method, class, namespace, or `with`. Plain compound blocks and `try` are skipped. It renders a sparse, tree-aware skeleton rather than dumping the ancestor's contiguous range: the structural header/signature, `<...>` gaps, comments directly adjacent to the containing statement, the complete statement/expression, and a closing delimiter when the language has one. Thus a reference directly in a function body gets function context, while one inside a loop gets the nearer loop.

Every contextual result includes a best-effort role (`call`, `type`, `member`, `import`, `write`, `override`, `declaration`, or `read`) and enclosing function/class/namespace metadata when available:

```text
src/disk_utils.cpp:1573:13
enclosing: diskann::build_disk_index  src/disk_utils.cpp:1295:5
kind: call

1573 | dispatch_index_building<T>(
     | symbols: dispatch_index_building@13 call, T@37 type
1574 |     extra_opts,
1575 |     data_file);
```

Source keeps its original formatting and absolute line numbers. With `list_symbols: true`, each relevant source line is followed by compact `name@column role` metadata. The source line itself is not modified; its absolute line plus each 1-based column can be passed directly to `code_hover`, `code_definition`, or `code_references`. Roles use the same `type|call|member|import|var` taxonomy as `code_scan`; noisy `var` entries remain excluded by default. `list_symbols` is invalid with `context: "none"` because that mode intentionally returns no source.

Syntax contexts are capped at 80 lines and 12,000 characters. Enclosing skeletons apply separate limits to structural signatures, referenced bodies, and closing sections; gaps are explicit and the referenced source line is always retained. A 36,000-character page budget is then divided across the requested results so several pathological expressions cannot trigger pi's whole-output truncation; affected blocks carry an explicit marker while preserving the reference line. A generated, deleted, unreadable, or unsupported result file falls back to its LSP location rather than failing the whole page.

## Pagination and counts

Only the requested page is contextualized. A complete page ends with `# N references`; a partial page ends with `# showing references A-B of N`. An offset beyond the result set returns a clean parenthesized note. Empty semantic results remain successful, not errors.

`code_search_symbol(include=["references"])` calls this same path with `context: "syntax"`, `offset: 1`, and `limit: 25`, forwarding its `list_symbols` option, so fan-out references have identical semantic context and cannot be cut in the middle by line-based trimming.

## Position details

LSP lines/columns are UTF-16 and 0-based. Tool inputs and rendered positions are 1-based. Before querying tree-sitter, the implementation converts the reference's UTF-16 column to a UTF-8 byte column, as required by tree-sitter points. Enclosing positions are reusable with the other `code_*` tools.
