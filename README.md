# code-nav

LSP-backed code navigation for pi. Eight tools the LLM can call — six backed
by real language servers (ccls for C++, ty/pyright for Python,
bash-language-server for bash, typescript-language-server for TypeScript &
JavaScript) plus one backed by tree-sitter for third-party symbol discovery,
plus one diagnostic reporter:

| Tool              | Backing                            | Notes                                                |
| ----------------- | ---------------------------------- | ---------------------------------------------------- |
| `code_outline`    | LSP `textDocument/documentSymbol`  | File structure: functions, classes, methods, sigs   |
| `code_definition` | LSP `textDocument/definition`      | Location + source snippet of a symbol's definition   |
| `code_references`| LSP `textDocument/references`      | All references to a symbol                            |
| `code_symbol`     | LSP `workspace/symbol`             | Ranked symbol search by name, workspace-wide         |
| `code_rename`     | LSP `textDocument/rename`          | Rename, edits applied to disk                        |
| `code_hover`      | LSP `textDocument/hover`           | Docstring / signature / type info                     |
| `code_symbols_in` | tree-sitter (WASM, in-process)     | Identifier table for a line range — the third-party entry point |
| `code_diagnostics`| LSP `textDocument/diagnostic` (pull) | Errors/warnings for a file, fetched on demand       |

`code_definition`, `code_hover`, and `code_references` accept an optional
`positions` array of `{path, line, column}` objects in addition to the scalar
`path`/`line`/`column` form, so the agent can batch several symbol lookups in
one tool call. When more than one position is passed, each result block is
prefixed with `### <path>:<line>:<col>` to correlate results to inputs.

`code_definition` also accepts an optional `list_symbols` boolean (default
`false`). When true, a tree-sitter symbol table is appended to each returned
snippet, so the agent can discover third-party/stdlib symbols used inside the
definition body and pass their coordinates to `code_hover`/
`code_definition`/`code_references` without a separate call.

Lines/columns in tool parameters are **1-based** (agent-friendly); the extension
translates to the 0-based coords LSP uses. **Tool output is also 1-based**
(`code_symbol`, `code_definition`, `code_references`, `code_outline`,
`code_symbols_in`, `code_diagnostics` all print 1-based `line:col`), so a
position printed by one tool can be fed directly into another tool's
`line`/`column` params without manual conversion.

**Positions point at the symbol's identifier, not the enclosing range.** The
entry-point tools (`code_outline`, `code_symbol`, `code_symbols_in`) print the
identifier position so the coordinates resolve in `code_hover`/`code_definition`/`code_references`.
- `code_outline` uses the server's `selectionRange` (the identifier span).
- `code_symbol` resolves the identifier via `documentSymbol` per file (cached
  for the call), falling back to a source-line scan if unavailable.
- `code_symbols_in` parses the line range with tree-sitter and prints each
  identifier's absolute 1-based column (tree-sitter is 0-based; we add 1).

This makes `code_symbol` / `code_outline` / `code_symbols_in` → `code_hover` / `code_definition` / `code_references` a clean round-trip: take the printed `line:col` and pass it straight back as `line` and `column`.

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

## Why `code_symbols_in` (tree-sitter)

The six LSP tools answer "tell me about the symbol at this position." They
cannot answer "I'm looking at a snippet — what are the symbols in it and where
do they sit?" That gap matters most for **third-party / stdlib / system**
symbols: `code_symbol` (`workspace/symbol`) is useless because LSP
`workspace/symbol` is **workspace-scoped by spec** — it indexes your project
tree, never `site-packages` or `/usr/include`.

`code_symbols_in` fills the gap: given a real file and a line range, it parses
the range with tree-sitter (in-process, WASM — no LSP server) and returns a
table of every identifier with its **absolute 1-based** `(path, line, col)`
and syntactic **role** (`type` / `call` / `member` / `import` / `var`). The
agent reads a row and passes its coordinates straight into `code_hover` /
`code_definition` / `code_references` — which already resolve third-party
symbols at a known position.

```
code_symbols_in(path="widget.cpp", startLine=43, endLine=49)
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
  "cache": { "directory": "~/.cache/ccls" },
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
that project. `code_symbol` opens one source file first (scanning the
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
`web-tree-sitter` and `tree-sitter-wasm` for `code_symbols_in` (the WASM
tree-sitter runtime and prebuilt grammar WASMs). All installed via
`npm install` in this directory; jiti resolves them from the extension's own
`node_modules`. The tree-sitter grammars (python, cpp, bash, typescript, tsx)
ship as prebuilt WASM — no native compilation, no peer-dependency conflicts.

## Testing

Unit tests for `tree-sitter-parse.ts` (the `code_symbols_in` backing module)
live in `test/` and run with no LSP servers and no pi — pure tree-sitter:

```
npm test            # run all unit tests (node --test test/*.test.mjs)
npm run test:unit   # same
```

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

Integration tests for `lsp-client.ts` (and the tool layer in `index.ts`) are
not included — they require real LSP servers running and a workspace to index.
Use `scripts/nav-cli.mjs` for manual end-to-end checks against the
live servers.

## Verified

End-to-end smoke-tested against **ty** (auto-detected default) and **pyright**:
- `documentSymbol` → hierarchical symbol tree ✓
- `hover` → signature + docstring ✓
- `definition`, `references` ✓
- `workspace/symbol` ✓ (ty; pyright returns empty — known server limitation)
- `rename` → `WorkspaceEdit` applied to disk ✓ (ty uses `changes`; pyright uses `documentChanges`)
- graceful `shutdown` ✓

`code_symbols_in` (tree-sitter, WASM) verified:
- identifier table for python / cpp / bash line ranges ✓
- skips comment/string noise and keywords (no regex false positives) ✓
- absolute 1-position math round-trips into `code_hover`/`code_definition` ✓
- third-party discovery: `code_symbols_in` → `code_definition` jumps into
  nix-store `site-packages` (e.g. `cbor2._decoder.py`) — `code_symbol` cannot ✓
- `code_definition {list_symbols: true}` appends the table per snippet ✓
