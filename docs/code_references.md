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
}
```

- `none` returns compact `path:line:column` rows.
- `syntax` returns the smallest useful AST construct: a complete call, member expression, import, type expression, assignment/declaration occurrence, or identifier read.
- `enclosing` expands that construct to its nearest containing statement or control-flow construct. It deliberately does not return the whole function/class; use the `enclosing` position with `code_definition` for that.

Every contextual result includes a best-effort role (`call`, `type`, `member`, `import`, `write`, `override`, `declaration`, or `read`) and enclosing function/class/namespace metadata when available:

```text
src/disk_utils.cpp:1573:13
enclosing: diskann::build_disk_index  src/disk_utils.cpp:1295:5
kind: call

1573 | dispatch_index_building<T>(
1574 |     extra_opts,
1575 |     data_file);
```

Source keeps its original formatting and absolute line numbers. Individual contexts are capped at 80 lines and 12,000 characters; large constructs retain a marked head/tail excerpt. A 36,000-character page budget is then divided across the requested results so several pathological expressions cannot trigger pi's whole-output truncation; affected blocks carry an explicit marker. A generated, deleted, unreadable, or unsupported result file falls back to its LSP location rather than failing the whole page.

## Pagination and counts

Only the requested page is contextualized. A complete page ends with `# N references`; a partial page ends with `# showing references A-B of N`. An offset beyond the result set returns a clean parenthesized note. Empty semantic results remain successful, not errors.

`code_search_symbol(include=["references"])` calls this same path with `context: "syntax"`, `offset: 1`, and `limit: 25`, so fan-out references have identical semantic context and cannot be cut in the middle by line-based trimming.

## Position details

LSP lines/columns are UTF-16 and 0-based. Tool inputs and rendered positions are 1-based. Before querying tree-sitter, the implementation converts the reference's UTF-16 column to a UTF-8 byte column, as required by tree-sitter points. Enclosing positions are reusable with the other `code_*` tools.
