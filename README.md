# code-nav

LSP-backed semantic code navigation for pi. `/code-nav` enables seven agent
tools backed by ccls, ty/pyright, bash-language-server, and
typescript-language-server:

| Tool | Backing | Purpose |
| --- | --- | --- |
| `code_outline` | `textDocument/documentSymbol` + hover | Structural file outline with signatures and docs |
| `code_definition` | `textDocument/definition` | Definition location and complete source body |
| `code_references` | `textDocument/references` | Semantic references/usages, including declarations |
| `code_search_symbol` | `workspace/symbol` | Ranked workspace and indexed third-party search |
| `code_rename` | `textDocument/rename` | Semantic rename applied to disk |
| `code_hover` | `textDocument/hover` | Signature, inferred type, and documentation |
| `code_diagnostics` | pull first, push fallback | Current errors, warnings, and hints |

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

`code_references` defaults to the first 25 results with AST-aware source
context: the complete call/type/member/import construct, its syntactic role,
and the enclosing function/class position. Pass `context: "none"` for compact
location-only output, or `context: "enclosing"` for the containing statement.
Use `offset` and `limit` to paginate. `code_search_symbol(include=["references"])`
uses the same contextual format.

`code_definition` also accepts an optional `list_symbols` boolean (default
`false`). When true, a tree-sitter symbol table is appended to the returned
body, so the agent can discover third-party/stdlib symbols used inside the
definition body and pass their coordinates to `code_hover`/
`code_definition`/`code_references` without a separate call.

All tool inputs and outputs use **1-based** positions. Discovery results print
the identifier position—not merely the enclosing range—so a printed
`path:line:column` can be passed directly to a position-based tool.
`code_outline` prints the reusable identifier position separately from the
symbol's body range.

## Three workflow groups

**Discovery tools** produce positions:

| Tool | Use when |
| --- | --- |
| `code_search_symbol` | You know a bare or qualified symbol name |
| `code_outline` | You want a file's classes/functions/methods, signatures, docs, and ranges |

**Position-based tools** consume `path` + 1-based `line` + `column`:

| Tool | Returns |
| --- | --- |
| `code_definition` | Definition location and complete source body |
| `code_references` | Semantic references/usages, including the declaration |
| `code_hover` | Signature, inferred type, and documentation |
| `code_rename` | A semantic workspace rename applied to disk |

**File-analysis tool:** `code_diagnostics(path)` reports current diagnostics.

### Prefer `code_*` over grep/read

The language servers index the workspace, so for code tasks these tools are
faster, semantic, and return positions that round-trip. Common reflexes and
their `code_*` replacement:

| Task | Old (grep/read/sed) | New (`code_*`) |
|------|---------------------|----------------|
| find a symbol by name | `rg` then `read` each hit | `code_search_symbol` |
| read a function's source body | `grep -n "^def foo\|^function foo"` then `read` | `code_outline` to locate it, then `code_definition` |
| find semantic usages of a symbol | `rg symbolname` | `code_references` |
| rename a symbol | `sed -i` across files | `code_rename` |
| check a file for errors | write a paren/quote-matching script | `code_diagnostics` |
| learn a symbol's type or docs | `read` the file and eyeball | `code_hover` |

The same grouping is injected into the agent's system prompt while `/code-nav`
is enabled.

### Third-party symbol search

`code_search_symbol` deliberately searches beyond the project when the language
server can index relevant dependencies:

- **Python with ty:** direct dependencies discovered from the environment are
  added as workspace roots, so ty indexes them alongside the project.
- **C++ with ccls:** headers included by the project—and their transitive
  includes—are available through ccls's compilation database and index.

This does not mean every installed package or system header is indexed. It
means the search covers third-party code that is relevant to the current
project. Qualified queries such as `cbor2.loads`, `typing.cast`, and
`std::vector::push_back` help rank and narrow those results.

Use `include` to expand up to five exact matches in the same call:

```text
code_search_symbol(query="cbor2.loads", include=["definition", "hover"])
code_search_symbol(query="vector::push_back", kinds=["method"],
                   name_pattern="int", include=["definition", "references"])
```

### Internal `code_scan` implementation

`src/scan.ts` remains available to the CLI/tests, and its tree-sitter parser is
also used by `code_definition(list_symbols=true)`. It is not currently
registered as an agent tool. It can bridge from a source range to third-party
identifiers by parsing a snippet's syntax (no LSP
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

## Why `code_diagnostics` (pull first, push fallback)

`code_diagnostics` reports the errors/warnings a language server computes for
a file—e.g. undefined names, type mismatches, and unused variables. The tool
tries the LSP 3.17 pull model first. If the server rejects it, the tool performs
a bounded, event-driven wait for `publishDiagnostics` (up to 60 seconds). In
both cases the agent-facing contract remains synchronous: one call returns one
result.

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
ty advertises `diagnosticProvider`; pyright answers the pull request without
advertising it; ccls, bash-language-server, and typescript-language-server use
the push fallback. If neither flow returns diagnostics within the bounded
wait, the tool surfaces the pull failure honestly.

## Why the internal `code_scan` implementation exists

Position-based LSP tools cannot answer “I’m looking at a snippet—what symbols
occur in it, and where are they?” `code_search_symbol` can find indexed
third-party dependencies, but a relevant package/header may not be indexed or
the agent may know only an occurrence in the current file. The internal scan
implementation covers that occurrence-based workflow.

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
| `/code-nav`        | Enable the seven `code_*` tools for this session              |
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
