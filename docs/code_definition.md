# code_definition

##  ccls bounce + cold-cache race

`code_definition` previously bounced to the header declaration when the cursor
was on an out-of-line C++ member definition (`fbin_file_t::assign` in a .cpp).
ccls's `textDocument/definition` does `on_def → getNonDefDeclarations` — the
editor's "go to definition" bounces too, so this is a ccls quirk, not a bug in
our code. Two causes, two fixes:

1. **documentSymbol step 0** (`nav.ts` `definition()`). Before calling
   `textDocument/definition`, fetch `documentSymbol` for the input file (ccls
   parses the opened file locally — equivalent to tree-sitter, no per-language
   grammar needed). Find the symbol whose `selectionRange.start` == cursor
   (`findDocSymbolBySelStart`). If that symbol's source range has a body
   (`snippetHasBody` — contains `{`), return it directly and skip
   `textDocument/definition` entirely → no bounce. If the symbol at the cursor
   is a declaration (no body), fall through to `textDocument/definition`, which
   correctly jumps declaration→definition (the bounce is asymmetric:
   cpp-def→header-decl bounces; header-decl→cpp-def works).

2. **Indexing wait before LSP queries** (`nav.ts` `definition()`). On a cold
   ccls cache, `documentSymbol` returns stale `{0:0}` ranges and
   `textDocument/definition` bounces because ccls's preamble session for the
   file isn't ready yet. Added `openDocument` + `waitForIndexingComplete()`
   (cpp only, best-effort) before the query — mirrors `diagnostics()`. The wait
   is event-driven (`$/progress` "end"), ~60s cold / instant warm.

### Tests pinning the fix

- `test/cpp.e2e.mjs` "code_definition on a cpp def returns the cpp body (not
  the header decl)" — real reproducer using the user's minimal `fbin_file`
  example. **Fails on the baseline** (bounces to header), **passes with the
  fix** (returns cpp body). Cold-cache path (waits for indexing).
- `test/python.e2e.mjs` — 5 new tests: top-level def, class def, method inside
  class, call site → def jump, class call site → class def. The call-site
  tests pin that step 0 does NOT short-circuit on a use (only on a def).
- `test/errors.test.mjs` — mocks updated to add `openDocument` /
  `waitForIndexingComplete` to the mock client (the new pre-query calls).
