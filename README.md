# code-nav

LSP-backed code navigation for pi. Eight tools the LLM can call — six backed
by real language servers (ccls for C++, ty/pyright for Python,
bash-language-server for bash, typescript-language-server for TypeScript &
JavaScript) plus one backed by tree-sitter for third-party symbol discovery,
plus one diagnostic reporter:

| Tool              | Backing                            | Notes                                                |
| ----------------- | ---------------------------------- | ---------------------------------------------------- |
| `code_outline`    | LSP `textDocument/documentSymbol`  | File structure: functions, classes, methods, sigs   |
| `code_definition` | LSP `textDocument/definition`      | Location + full source body of a symbol's definition   |
| `code_references`| LSP `textDocument/references`      | All references to a symbol                            |
| `code_search_symbol` | LSP `workspace/symbol`             | Ranked symbol search by name, workspace-wide         |
| `code_rename`     | LSP `textDocument/rename`          | Rename, edits applied to disk                        |
| `code_hover`      | LSP `textDocument/hover`           | Docstring / signature / type info                     |
| `code_scan` | tree-sitter (WASM, in-process)     | Identifier table for a line range — the third-party entry point |
| `code_diagnostics`| LSP `textDocument/diagnostic` (pull) | Errors/warnings for a file, fetched on demand       |

`code_definition`, `code_hover`, and `code_references` each take a **scalar**
`(path, line, column)` — one symbol per call (no batching). `code_definition`
returns the verbatim source body of the symbol: a header line
`<defPath>:<sl>-<el>` followed by the raw source lines (no code fence), ready
to copy straight into an edit. A position may resolve to **multiple**
definition sites (overloads, header-vs-source in C++, re-exports); in that
case the tool returns one block per site (each with the same
`<defPath>:<sl>-<el>` header + body, blank-line-separated) plus a trailing
`# N definitions for <inPath>:<line>:<col>` count — multiple sites are data,
not an error.

`code_definition` also accepts an optional `list_symbols` boolean (default
`false`). When true, a tree-sitter symbol table is appended to the returned
body, so the agent can discover third-party/stdlib symbols used inside the
definition body and pass their coordinates to `code_hover`/
`code_definition`/`code_references` without a separate call.

Lines/columns in tool parameters are **1-based** (agent-friendly); the extension
translates to the 0-based coords LSP uses. **Tool output is also 1-based**
(`code_search_symbol`, `code_definition`, `code_references`, `code_outline`,
`code_scan`, `code_diagnostics` all print 1-based `line:col`), so a
position printed by one tool can be fed directly into another tool's
`line`/`column` params without manual conversion.

**Positions point at the symbol's identifier, not the enclosing range.** The
entry-point tools (`code_outline`, `code_search_symbol`, `code_scan`) print the
identifier position so the coordinates resolve in `code_hover`/`code_definition`/`code_references`.
- `code_outline` uses the server's `selectionRange` (the identifier span).
- `code_search_symbol` resolves the identifier via `documentSymbol` per file (cached
  for the call), falling back to a source-line scan if unavailable.
- `code_scan` parses the line range with tree-sitter and prints each
  identifier's absolute 1-based column (tree-sitter is 0-based; we add 1).

This makes `code_search_symbol` / `code_outline` / `code_scan` → `code_hover` / `code_definition` / `code_references` a clean round-trip: take the printed `line:col` and pass it straight back as `line` and `column`.

## Two groups: entry points → detail tools

The nine tools split into two groups. **Entry points** are what you call when
you don't yet have a precise position — they produce one. **Detail tools**
consume a position (from an entry point, from a diagnostic, or from anywhere a
symbol's identifier sits) and tell you something about that symbol. Every
entry point prints 1-based `line:col` that feeds straight into a detail tool's
`line`/`column` params.

**Entry points** (no precise position yet):

| Tool | Use when |
|------|----------|
| `code_search_symbol` | you know a symbol **name** and want to find it across the workspace |
| `code_outline` | you have a **file** and want its structure (functions/classes/methods + signatures) |
| `code_tree` | you have a file and want symbols **matching a name pattern** (e.g. a class's members) |
| `code_scan` | you have a file/range and want **every identifier** with its role (calls, imports, members) |

**Detail tools** (take `path` + 1-based `line` + `column`):

| Tool | Returns |
|------|---------|
| `code_definition` | the definition's location + **full source body** |
| `code_references` | all call sites of the symbol |
| `code_hover` | docstring / signature / type info |
| `code_rename` | renames the symbol across the workspace (edits applied to disk) |
| `code_diagnostics` | errors/warnings the language server reports for a file |

### Prefer `code_*` over grep/read

The language servers index the workspace, so for code tasks these tools are
faster, semantic, and return positions that round-trip. Common reflexes and
their `code_*` replacement:

| Task | Old (grep/read/sed) | New (`code_*`) |
|------|---------------------|----------------|
| find a symbol by name | `rg` then `read` each hit | `code_search_symbol` |
| read a function's source body | `grep -n "^def foo\|^function foo"` then `read` | `code_outline` to locate it, then `code_definition` |
| list every identifier in a snippet | `rg -o '\b\w+\b'` (no roles, no positions you can reuse) | `code_scan` |
| find all call sites of a symbol | `rg symbolname` | `code_references` |
| rename a symbol | `sed -i` across files | `code_rename` |
| check a file for errors | write a paren/quote-matching script | `code_diagnostics` |
| learn a symbol's type or docs | `read` the file and eyeball | `code_hover` |

The same grouping and table are injected into the agent's system prompt while
`/code-nav` is enabled, so the LLM is steered toward the `code_*` tools instead
of its default grep/read reflex.

### Worked example: third-party docs/source via `code_scan`

`code_search_symbol` is workspace-scoped, so it cannot find symbols in
`site-packages`, `node_modules`, nix store, or system headers. But
`code_definition`/`code_hover` **do** resolve third-party symbols at a known
position. `code_scan` bridges the gap: it parses a snippet's syntax (no LSP
index needed) and returns each identifier with a reusable 1-based position.
Feed a row straight into a detail tool.

Example — you're reading a function body that calls `cbor2.loads` and want to
see `loads`'s signature/source, but `cbor2` is in `site-packages`:

```
1) code_scan(path="app.py", startLine=42, endLine=58, pattern="loads")
     →
   Symbols in app.py:42-58 (1-based, reusable as code_* input):
     call   loads   app.py:44:18

2) code_hover(path="app.py", line=44, column=18)
     →
   app.py:44:18 — loads
   def loads(data: bytes, /) -> Any: ...

   # or, to read the full verbatim source body instead of just the signature:
   code_definition(path="app.py", line=44, column=18)
     → jumps into cbor2/_decoder.py and returns the complete function body
       (header `<defPath>:<sl>-<el>` + raw source, no code fence)
```

The `pattern` arg narrows the scan to `loads` (a regexp on symbol names);
without it, `code_scan` returns every identifier in the range. The row's
`(path, line, column)` is what you pass to the detail tool — no manual
conversion. For the name-only case (you have a third-party name from docs but
no file/position at all), see `code_scan`'s guidelines for the
resolve-package-root → rg → `code_definition` workflow.

## Why `code_diagnostics` (LSP pull model)

`code_diagnostics` reports the errors/warnings a language server computes for
a file — e.g. undefined names, type mismatches, unused variables. It is a
**pure request/response tool**: the agent calls `code_diagnostics(path)`, the
extension opens the document on the server and sends a single
`textDocument/diagnostic` request (the LSP 3.17 **pull model**), and the server
returns the diagnostic set for that document synchronously. No
`publishDiagnostics` notification collection — the tool contract is "agent
calls, waits, gets the result back."

```
code_diagnostics(path="widget.cpp")
  →
3 diagnostic(s) for widget.cpp:
  widget.cpp:6:12  error  ccls  `greeter` used when not defined
  widget.cpp:13:10  error  ccls  type mismatch
  widget.cpp:5:5  hint  ccls  `x` is unused
```

Output positions are **1-based** and point at each diagnostic's range start,
so a row can be fed straight into `code_hover` / `code_definition` /
`code_references` to inspect the offending symbol.

**Capability advertisement is unreliable, so the tool does not gate on it.**
ty advertises `diagnosticProvider`; pyright answers the request without
advertising it; ccls/bash-language-server reject it with a JSON-RPC error. The
tool sends the request and surfaces the server's actual response (or error)
honestly — a server that can't answer returns an error rather than silently
empty/stale results. bash-language-server and typescript-language-server do
not implement the pull model, so `code_diagnostics` returns an error for bash
and TypeScript files (by design — no async
fallback).

## Why `code_scan` (tree-sitter)

The six LSP tools answer "tell me about the symbol at this position." They
cannot answer "I'm looking at a snippet — what are the symbols in it and where
do they sit?" That gap matters most for **third-party / stdlib / system**
symbols: `code_search_symbol` (`workspace/symbol`) is useless because LSP
`workspace/symbol` is **workspace-scoped by spec** — it indexes your project
tree, never `site-packages` or `/usr/include`.

`code_scan` fills the gap: given a real file and a line range, it parses
the range with tree-sitter (in-process, WASM — no LSP server) and returns a
table of every identifier with its **absolute 1-based** `(path, line, col)`
and syntactic **role** (`type` / `call` / `member` / `import` / `var`). The
agent reads a row and passes its coordinates straight into `code_hover` /
`code_definition` / `code_references` — which already resolve third-party
symbols at a known position.

```
code_scan(path="widget.cpp", startLine=43, endLine=49)
  →
Symbols in widget.cpp:43-49 (1-based, reusable as code_* input):
  type   vector      widget.cpp:43:11
  call   sort        widget.cpp:43:9
  member begin       widget.cpp:43:15
  ...
```

`var` rows (local variables, parameters) are omitted by default — they are
the snippet's own locals, rarely worth learning about. Pass `roles` to
include them or to narrow the set. `import` (module names and imported
symbols) IS included by default, since imports are the primary entry point
for third-party discovery.

The default path (`include_docs=false`) makes **zero LSP calls** — it is a
pure tree-sitter parse, fast and cheap. Set `include_docs=true` to also hover
each unique symbol and append a one-line label column (one LSP round-trip per
unique `(name, role)`). tree-sitter (not regex) is used because it
distinguishes identifiers from comment/string noise for free, skips keywords
by node type (no keyword blacklist to maintain), and gives a syntactic role
per node.

## Commands

The tools are **not** registered at session start. Opt in per session:

| Command            | Effect                                                        |
| ------------------ | ------------------------------------------------------------ |
| `/code-nav`        | Enable the eight `code_*` tools for this session              |
| `/code-nav:off`    | Disable the tools and shut down all running LSP servers      |
| `/code-nav:status` | Show which language servers are currently running            |

Servers are spawned **lazily** on first tool call and shut down on
`session_shutdown` (covers `/new`, `/resume`, `/reload`, quit) and on
`/code-nav:off`.

## Per-project config (`.pi/lsp.json`)

Optional. Overrides the built-in defaults for any language. Keys per language:
`command` (string), `args` (string[]), `initOptions` (object merged over the
defaults).

```json
{
  "cpp":    { "initOptions": { "compilationDatabaseDirectory": "cmake-build-debug" } },
  "python": { "command": "basedpyright-langserver", "args": ["--stdio"] }
}
```

The global default lives at `~/.pi/lsp.json`; project config wins.

## Built-in defaults

Match the user's Emacs config.

**ccls** (`cpp`):
```json
{
  "cache": { "directory": "~/.cache/ccls-pi" },
  "compilationDatabaseDirectory": "build"
}
```
`$HOME` is resolved at spawn time. The `cache.directory` is passed through to
ccls; `compilationDatabaseDirectory` is relative to the workspace root
(`ctx.cwd`). ccls reads `compile_commands.json` from `<cwd>/build/` by default;
your existing `.ccls` files / `compile_commands.json` setup is used as-is.

**python** — auto-detected:
- **ty** (preferred, when on PATH): command `ty server`, no init options. ty
  implements `workspace/symbol` (pyright does not) and reports standard LSP
  `SymbolKind` values. It discovers `pyproject.toml` / `.venv` from the root.
- **pyright** (fallback): `{ "multiRoot": false, "useLibraryCodeForTypes": true }`,
  command `pyright-langserver --stdio`. Matches the user's Emacs config.

To force pyright even when `ty` is installed, set an explicit `command` in
`.pi/lsp.json` (see above) — an explicit command disables auto-detection.

**bash-language-server** (`bash`):
```json
{}
```
Command: `bash-language-server start`.

**typescript-language-server** (`typescript` — covers `.ts`, `.tsx`, `.js`,
`.jsx`, and the `.mts`/`.cts`/`.mjs`/`.cjs` module variants):
```json
{ "hostInfo": "pi-code-nav" }
```
Command: `typescript-language-server --stdio`. One server serves all
TS/JS file kinds; the `languageId` sent in `didOpen` (`typescript` /
`typescriptreact` / `javascript` / `javascriptreact`) tells the underlying
tsserver which syntax + JSX rules to apply. The server implements
`workspace/symbol`, hover, definition, references, and rename.

Note: tsserver loads its project lazily on the first `didOpen` of a file in
that project. `code_search_symbol` opens one source file first (scanning the
workspace root, skipping `node_modules`/`build`/`dist`) so `workspace/symbol`
does not fail with "No Project.". `code_diagnostics` is unavailable for
TypeScript — typescript-language-server does not implement the LSP 3.17 pull
model (it uses the push `publishDiagnostics` model, which this extension does
not collect).

## File-extension → language map

| Language   | Extensions                                                       |
| ---------- | ---------------------------------------------------------------- |
| cpp        | `.c .cc .cpp .cxx .h .hh .hpp .hxx .m .mm`                        |
| python     | `.py`                                                            |
| bash       | `.sh .bash`                                                       |
| typescript | `.ts .tsx .js .jsx .mts .cts .mjs .cjs`                           |

## Workspace root

Always `ctx.cwd` (the directory pi was started in). One server per
`(cwd, language)`.

## Dependencies

`vscode-jsonrpc` and `vscode-languageserver-protocol` for the LSP tools, plus
`web-tree-sitter` and `tree-sitter-wasm` for `code_scan` (the WASM
tree-sitter runtime and prebuilt grammar WASMs). All installed via
`npm install` in this directory; jiti resolves them from the extension's own
`node_modules`. The tree-sitter grammars (python, cpp, bash, typescript, tsx)
ship as prebuilt WASM — no native compilation, no peer-dependency conflicts.

## Testing

Unit tests for `tree-sitter-parse.ts` (the `code_scan` backing module)
live in `test/*.test.mjs` and run with no LSP servers and no pi — pure
tree-sitter:

```
npm test            # run all unit tests (node --test test/*.test.mjs)
npm run test:unit   # same
```

End-to-end tests for `nav.ts` (the eight tool implementations) live in
`test/*.e2e.mjs` and run against **real language servers** via the same
`nav.*` functions `index.ts` uses at runtime:

```
npm run test:e2e    # requires the language servers on PATH (project nix shell)
```

E2e tests are skipped automatically when a server isn't available, so
`npm run test:e2e` stays green on a server-less machine (reports skips).
Set `CODE_NAV_SKIP_E2E=1` to force-skip the whole e2e suite.

The harness loads the extension's `.ts` sources through **jiti** — the same
loader pi uses to load extensions — so module resolution (`node_modules`,
tsconfig `paths`) matches production exactly. Bare `node
--experimental-strip-types` is not used: it can't resolve the extension's
dependencies relative to the extension dir, and it can't honor the tsconfig
`paths` mappings that `index.ts` relies on. The jiti dependency is already
present (transitively, via pi) — no new install is needed.

The tests pin the documented role classification per language (python, cpp,
bash), the default role set (drops `var`), dedup (first occurrence wins),
absolute 1-based position math, the `renderSymbolTable` / `hoverFirstLine`
output formats, and the load-bearing guarantees: snippet fragments parse
without wrapping, and comment/string noise is excluded. See `test/core.test.mjs`
for cross-cutting behavior and `test/{python,cpp,bash}.test.mjs` for per-language
contracts. Add tests there when changing `classifyRole` or rendering.

Integration tests for `lsp-client.ts` and the tool layer (`nav.ts`) **are
included** as `test/*.e2e.mjs` (run `npm run test:e2e`). For manual checks,
`scripts/nav-cli.mjs` is a thin argv-parser around the same `nav.ts` — so
the CLI's output is byte-identical to what the agent receives.

## Verified

End-to-end smoke-tested against **ty** (auto-detected default) and **pyright**:
- `documentSymbol` → hierarchical symbol tree ✓
- `hover` → signature + docstring ✓
- `definition`, `references` ✓
- `workspace/symbol` ✓ (ty; pyright returns empty — known server limitation)
- `rename` → `WorkspaceEdit` applied to disk ✓ (ty uses `changes`; pyright uses `documentChanges`)
- graceful `shutdown` ✓

`code_scan` (tree-sitter, WASM) verified:
- identifier table for python / cpp / bash line ranges ✓
- skips comment/string noise and keywords (no regex false positives) ✓
- absolute 1-position math round-trips into `code_hover`/`code_definition` ✓
- third-party discovery: `code_scan` → `code_definition` jumps into
  nix-store `site-packages` (e.g. `cbor2._decoder.py`) — `code_search_symbol` cannot ✓
- `code_definition {list_symbols: true}` appends the table to the body ✓
