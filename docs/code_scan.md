# DESIGN (implemented): `code_scan` — third-party symbol discovery via tree-sitter

> This section records a design that was worked out in full and **has been
> implemented** (`tree-sitter-parse.ts` + the `code_scan` tool in
> `index.ts`, plus `list_symbols` integration into `code_definition`). It
> exists because the user asked a real question the original six tools cannot
> answer, and the path to the answer went through several dead ends that
> future-me must not rediscover. Read this before touching the implementation;
> the dead-ends section especially is load-bearing.

## The problem the six tools do not solve

The six existing tools answer: "given a `(path, line, col)` position, tell me
about the symbol there." They do **not** answer: "I'm looking at a code snippet
and I want to know about a symbol in it — what's its position?" That position
computation is the gap, and it matters most for **third-party / stdlib /
system** symbols, where `code_symbol` (`workspace/symbol`) is useless because
LSP `workspace/symbol` is **workspace-scoped by spec** — it indexes files the
server indexed at startup (your project tree), never `site-packages`, never
`/usr/include`, never nix store headers. Verified empirically against all
three servers in this environment:

```
ty:       query="load"        → 3 hits, ALL in dummy-project/combo.py (workspace only)
          query="cbor2.load"  → 0
          query="cbor2"       → 0
          query="array"       → 0
pyright:  query="load"        → 0  (pyright doesn't implement workspace/symbol at all)
ccls:     query="sort"        → 0
          query="std::sort"   → 0
```

So `code_symbol` cannot serve as the entry point for third-party discovery.
`code_outline` works on any file (including third-party) but needs a *path*
the agent doesn't have until it has already done a lookup — chicken-and-egg.

**Note: hover/definition at a known position already resolves third-party
and system code in every language.** Verified: `ty` and `pyright` both hover
`cbor2.load` at a known position and return the full docstring + signature;
both definition-jump into `_decoder.py` in the nix store. `ccls` hovers
`std::vector` and definition-jumps into `stl_vector.h` in the gcc nix store.
`uriToPath()` + `readFile` already handle these paths (nix store files are
world-readable `-r--r--r--`), and `resolveDefBodyRange()` already expands the
identifier span to the full function body even in third-party files. So the
existing six tools work on third-party **at a known position**; the only gap
is getting from "I'm looking at a snippet" to "a precise position in a real
file."

## The scenario that drives the design

1. Agent calls `code_definition(path, line, col)` on some function.
2. It receives a snippet with a real absolute path and a real start line
   (today's `code_definition` output: `path:line:col - line:col` header +
   fenced source).
3. Inside the snippet it sees a usage of, say, `std::vector` (C++) or
   `cbor2.load` (Python) and wants that symbol's API.
4. The snippet is a **function body** — it carries no `#include` / `import`
   lines, and even if it did the symbol may be **transitively included**
   (C++ especially). The agent cannot reliably write a scratch file with the
   right imports to synthesize the symbol's position.

The conclusion: the symbol the agent wants is **already in scope in the real
file** the snippet came from. We don't need to synthesize anything — we need
to find the symbol's precise position in that real file and hand it to the
existing six tools, which already work on third-party at known positions.

## Dead ends (do not revive these)

- **`code_inspect` via scratch-file synthesis.** The first idea: a tool that
  takes a qualified name like `cbor2.load`, synthesizes a scratch `.py` with
  `import cbor2; __x = cbor2.load`, opens it on the server at a known column,
  and hovers. I tested this and it works — *when the import is obvious*. It
  breaks on the driving scenario: a C++ function body using `std::vector` or
  `mylib::Widget` where the agent cannot know the right `#include`, and
  transitively-included symbols are flatly impossible. Rejected.
- **Regex identifier scan over the snippet.** The second idea: scan the
  snippet with `[A-Za-z_]\w*`, compute absolute positions, and optionally
  hover each to filter false positives. Rejected because regex cannot
  distinguish identifiers from **comment/string noise** — `# TODO: fix the
  load function` and `"sort the data"` produce false `load`/`sort` hits. The
  "filter by non-empty hover" workaround costs N server round-trips *and*
  still lists garbage until the round-trip returns null. It also needs a
  **per-language keyword blacklist** (`if`/`return`/`for`/`int`/...) that
  drifts across language versions and is itself a maintenance trap.
- **`workspace/symbol` extension / initOptions.** No knob makes ty/pyright/ccls
  index `site-packages`. Checked — it's a server-side scope decision, not a
  client flag.
- **Agent supplies `line`/`column` itself.** The MAINTAINER doc already says
  the agent is bad at column math (the reason `code-nav` exists). Asking it to
  also do line arithmetic (`absolute = snippet_start_line + relative_offset`,
  a 1-based-add-zero trap) is symmetric fragility. Rejected — the tool must
  compute positions, not the agent.
- **Agent supplies a verbatim line + token name, tool searches the file.** A
  real improvement over raw line/col math (it eliminates both line and column
  arithmetic — the agent copies a line and names a token), and it's the
  fallback if tree-sitter ever becomes unavailable. But it still requires the
  agent to transcribe a line exactly (whitespace/indent errors fail the match)
  and to pick which token on a line with several. Tree-sitter does better
  (below) and subsumes this. Keep the line+name idea only as a degraded-mode
  fallback, not the primary design.
- **LSP `selectionRange` as the basis.** Tested: ccls does **not** support it
  (returns nothing); ty does. Not portable. Don't build on it.
- **LSP `textDocument/semanticTokens/range` as the basis.** Superficially a
  fit — "tokens with types over a range" — but it fails the tool on three
  counts, only the first of which is a portability issue:
  1. **Not portable across the three servers.** `semanticTokens` is an
     optional, server-gated capability: the server must advertise
     `semanticTokensProvider` with a `legend` and support the `range`
     request shape. **bash-language-server does not implement it at all**;
     ccls/pyright/ty support varies. This is the same "unreliable capability
     advertisement" trap that already plagues `code_diagnostics` (see
     `lsp-client.ts` — pyright answers `textDocument/diagnostic` without
     advertising `diagnosticProvider`, bash rejects it with a JSON-RPC error).
     Building `code_scan` on it would give bash no implementation and
     put C++ at the mercy of ccls's token-type legend.
  2. **Breaks the zero-LSP-call default path.** `semanticTokens/range` is an
     LSP request: it requires `didOpen`, requires the server to have
     analyzed the document (ccls indexes the whole project on startup —
     *seconds to minutes for large C++*), and costs a round-trip. The
     `include_docs=false` default making **zero LSP calls** is a load-bearing
     property — it is what makes `code_scan` a cheap, always-available
     discovery tool rather than a seventh server-dependent one. tree-sitter
     runs in-process with no server, no `didOpen`, no indexing. (If you ever
     forget *why* the default is server-free, re-read the `include_docs`
     paragraph above — hover is the opt-in LSP path; the baseline is not.)
  3. **Its token-type taxonomy is the wrong shape for roles.** LSP semantic
     token types are *semantic categories* (`namespace`, `type`, `class`,
     `function`, `method`, `variable`, `property`, …) with *modifiers*
     (`declaration`, `definition`, `readonly`, `static`, …). They say what a
     name **is**, not how it is **used at this occurrence**. `code_scan`'s
     role column (`type` / `call` / `member` / `import` / `var`) is
     occurrence-based and is not expressible in the standard legend:
       - **No `call` type or modifier.** `std::sort` is `function` whether
         it is *called* (`…(v.begin(), v.end())` → role `call`) or *referenced*
         (`auto f = std::sort;` → role `var`). tree-sitter gets the call-vs-var
         distinction for free via `call_expression` parentage; the token stream
         cannot express it.
       - **No `import` concept.** The `import` role — which the design calls
         "the primary entry point for third-party discovery" — has no LSP
         token type/modifier that says "this occurrence is an import binding."
         `cbor2`/`CBOREncoder`/`np` would be misclassified as `variable`/
         `function` and lost under the default "no var" filter. tree-sitter
         gets it from grammar structure (`identifier` under `dotted_name` +
         `import_statement`).
       - **`member` vs `property`.** `property`/`method` cover both calls and
         references; the `field_identifier` / `attribute`-field distinction
         tree-sitter gives is sharper.
     You'd end up re-deriving roles from token positions + surrounding text —
     which is what tree-sitter already did in one parse.
  What `semanticTokens` *would* have given us: (a) working on third-party
  files without shipping a grammar, and (b) the server's actual semantic
  resolution (it knows a `type_identifier` use resolves to a `class`, not a
  `typedef`). But (a) is undermined by the portability gap, and (b) is a
  marginal win that doesn't outweigh losing the role taxonomy and the
  zero-LSP-call default. The tool's job is **position discovery + role
  triage**, not semantic resolution — resolution is what `code_hover` /
  `code_definition` are for, and they already work on third-party at a known
  position. If ever revisited, the honest upgrade is **additive**: an optional
  enrichment layer on top of tree-sitter, gated on `supports()` and server
  availability (like `include_docs` gates hover) — never a replacement.

## The design: `code_scan(path, startLine?, endLine?, pattern?, roles?, include_docs?)`

A **seventh tool** that, given a real file (and optionally a line range or
a name pattern), parses the range with **tree-sitter** and returns a table of
every identifier in it with its **absolute** 1-based `(path, line, col)` and
its syntactic **role** (`type` / `call` / `member` / `import` / `var`). The
agent reads a row and passes its coordinates straight into the existing
`code_hover` / `code_definition` / `code_references` / `code_outline` — which
already work on third-party at known positions. With no line range, the
whole file is scanned. With `pattern` (a regexp), only symbols whose name
matches are kept — useful for narrowing a large file to one imported module
or one called method.

```
code_scan(path="widget.cpp", startLine=43, endLine=49)
  →
Symbols in widget.cpp:43-49 (1-based, reusable as code_* input):
  type   vector      widget.cpp:43:11
  call   sort        widget.cpp:43:9
  member begin       widget.cpp:43:15
  member end         widget.cpp:43:27
  member push_back   widget.cpp:45:10
  member size        widget.cpp:46:23
  member empty       widget.cpp:47:11
```

Note: `var` rows (local variables, parameters) are **omitted by default**
— they are the snippet's own locals, hoverable but rarely what the agent
wants to *learn about*. See "Role filtering" below.

Steps:
1. Read `path` (the real file — the agent has it from `code_definition`
   output or from `read`).
2. Slice lines `[startLine, endLine]` (1-based, matching the contract).
3. Parse the slice with tree-sitter for the file's language.
4. Walk the tree, collect `identifier` / `type_identifier` /
   `field_identifier` nodes (and equivalents — see node-types table below).
5. Map each node's `(row, col)` to **absolute** `(path, startLine + row,
   col)` (1-based). Dedupe by `(name, role)`; keep first occurrence's
   position. (If the agent wants a later occurrence it can pass a tighter
   `startLine`/`endLine`.)
6. Filter to `roles` (default: all except `var`).
7. If `include_docs` is true, hover each at the absolute position (one
   `LspClient.hover` call per unique symbol) and append the first line of
   `hoverText` as a label column. Otherwise return role + position only.
8. Return the table.

**`include_docs` is optional and defaults to `false`.** The default path makes
**zero LSP calls** — tree-sitter alone. Hover is purely enrichment, not a
filter (the symbol list is already correct without it — that's the whole
point of using tree-sitter instead of regex). This also keeps the common case
cheap: one tool call, no server round-trips, no document open on the LSP
server unless the agent asks for docs.

## Role filtering — `roles?` (default omits `var`)

Not all roles are equally useful to the agent. The driving scenario is
"I see a snippet and want to learn about an external symbol in it." For
that, the useful roles are:

- **`type`** — a type name (Python annotation, C++ `type_identifier`). Hover
  gives the type's docstring/signature; definition jumps to its declaration.
- **`call`** — a function/method being called. Hover gives the full signature;
  definition jumps into the callee's body (including third-party / stdlib).
- **`member`** — a field/attribute access (`.push_back`, `.encode`,
  `.begin`). This is the third-party API surface the agent most wants.
- **`import`** — a name brought into scope by an import (Python module names
  and imported symbols). This is the **primary entry point** for third-party
  discovery: `cbor2`, `CBOREncoder`, `Callable`, `os` are all here. Hover /
  definition on an import row resolves to the module or the symbol's source.

`var` (local variables, parameters, assignment targets) is different: it is
hoverable and definable, but it is the snippet's **own locals** — loop
variables, temps, counters, function parameters. The agent rarely wants to
"learn about" those; they are implementation detail, not external API. And
they are **noisy**: a typical function body has 5–10 locals for every one
interesting external symbol. Emitting them by default drowns the useful
rows.

So the **default role set is `type, call, member, import` — all except
`var`.** The agent passes `roles` (an array) to override: include `"var"` to
see locals too, or pass a narrower list (e.g. `["import"]` to see only
imports). The filter is applied after classification and before dedup, so
filtered-out roles never consume a dedup slot.

`import` was separated from `var` specifically so that "drop the noisy
locals" does not also drop the third-party entry points imports represent.
Before the split, imported module names (`cbor2`) and imported symbols
(`CBOREncoder`) were classified as `var` (they are `identifier` nodes whose
parent is `dotted_name`); defaulting to "no var" would have lost them —
unacceptable, since imports are the third-party discovery entry point. The
`import` role fixes that: it is always in the default set.

The same default applies to `code_definition`'s `list_symbols` integration
(snippet symbol tables omit `var`), so the two stay consistent. The agent
can always use `code_scan` directly with `roles` if it needs locals.

## Why tree-sitter and not regex (the decisive evidence)

I tested a regex scan vs. tree-sitter on a snippet with comment/string noise:

```
# TODO: fix the load function
msg = "sort the data and check size"
x = cbor2.load(data)  # use load not loads
```

- **Regex** `[A-Za-z_]\w*`: returns `load` (from the comment), `sort`, `size`
  (from the string), `load` (from the trailing comment) — all false positives.
- **tree-sitter** identifier walk: returns `msg`, `x`, `cbor2`, `load`,
  `data` — **5 real identifiers, zero noise.**

And on keyword exclusion:
- **Regex** needs a maintained per-language keyword blacklist (`if`,
  `return`, `for`, `int`, ...) that drifts across language versions.
- **tree-sitter**: `if`/`return`/`for` are `if_statement` /
  `return_statement` / `for_statement` nodes, **not** `identifier` nodes. An
  identifier-only walk naturally skips them. **No keyword list, ever.**

And on syntactic role — regex gives you a string; tree-sitter gives you a
node type (`identifier` vs `type_identifier` vs `field_identifier`), so the
table can label `vector` as `type`, `sort` as `call`, `begin`/`size` as
`member` — for free, with no LSP call.

## Snippet parsing works without wrapping (the load-bearing test)

I worried tree-sitter would choke on function-body fragments (no enclosing
`def`/`#include`/`{}`). It doesn't — verified against the exact snippets
`code_definition` returns:

| Snippet (raw, no wrapping)         | `has_error` | identifiers |
| ---------------------------------- | ----------- | ----------- |
| Python body, dedented              | `false`     | 12 (all real) |
| C++ body, no `#include`/function   | `false`     | 11 (all real) |

So **no wrapping, no scratch file, no import guessing** — feed the slice to
the parser directly. tree-sitter's error-recovery handles fragments.

## Node types to collect (per language)

Collect these node types from the tree walk:

| Language   | identifier          | type_identifier      | field/member          | call form            |
| ---------- | ------------------- | -------------------- | --------------------- | -------------------- |
| python     | `identifier`        | `type` (annotation)  | `attribute`           | `call` (function child) |
| cpp        | `identifier`        | `type_identifier`    | `field_identifier`    | `call_expression` child |
| bash       | `variable_name` / `word` (in `command_name`) | n/a | — (subscript skipped) | `command_name` (the `word` child) |
| typescript | `identifier`        | `type_identifier` + `predefined_type` | `property_identifier` / `shorthand_property_identifier` | `call_expression` field `function`; `new_expression` field `constructor` |

Bash is the loose one — its node set was finalized as: `variable_name` →
`var`, the `word` child of a `command_name` → `call`, everything else
(specifically bare `word` arguments, `string`, `subscript` indices) →
skipped. Bare `word` nodes are mostly arguments/literals and too noisy; the
design doc explicitly deferred bash polish and this conservative set is what
shipped. Revisit if a real use case needs argument-level bash symbols. Do
**not** block the tool on bash.

**`import` role (Python only).** Imported names — module names (`cbor2` in
`from cbor2 import ...`), imported symbols (`CBOREncoder`), and aliases
(`np` in `import numpy as np`) — are `identifier` nodes whose parent is
`dotted_name` under an `import_statement` / `import_from_statement` /
`aliased_import`, or directly under `aliased_import` (the alias). These are
classified as `import`, not `var`, so the default "no var" filter keeps
them. TypeScript/TSX imports are the same role: the `identifier` under an
`import_specifier` (`import { readFile }`), `namespace_import`
(`import * as fs`), `import_clause` (default import), `export_specifier`
(re-export), or `aliased_import`/`aliased_export`. C++ `#include` is a
preprocessor directive (no identifier node) and bash has no import construct,
so the role is Python- and TypeScript-specific.

### Python `type` nodes: emit only the outermost

Python's tree-sitter grammar wraps **every** annotation in a `type` node,
and generics / unions spawn child `type` nodes for each component. A single
annotation like `Callable[[CBOREncoder, Any], None] | None` parses as four
nested `type` nodes:

```
type @0  "Callable[[CBOREncoder, Any], None] | None"   ← union (outer)
  union_type
    type @0  "Callable[[CBOREncoder, Any], None"       ← left of union
      generic_type(Callable, type_parameter(
        type "[CBOREncoder, Any]",                       ← generic arg
        type "None"))                                    ← generic arg
    type "None"                                         ← right of union
```

Emitting all four floods the symbol table with subtypes (`Callable[...]`,
`[CBOREncoder, Any]`, `None`) the agent did not ask for — one logical type
becomes four rows. So `classifyRole` emits only the **outermost** `type`
node and skips a `type` whose parent is itself a type-context node (`type`,
`union_type`, or `type_parameter`). The inner identifiers (`Callable`,
`CBOREncoder`, `Any`) are still emitted individually as `var` (their parent
is `generic_type` / `list`, not `type`), so the agent still sees every name
it might want to hover — it just does not see the wrapping `type` nodes for
the sub-components. This is Python-specific; the C++ grammar does not wrap
annotations in a reusable `type` node (it uses `type_identifier` /
`primitive_type`), so no equivalent rule is needed there.

## Dependency note (the one real cost) — IMPLEMENTED with WASM, not native

tree-sitter was **not installed** in the user's environment during design
(verified: no CLI, no Python `tree_sitter`/`tree_sitter_python`/
`tree_sitter_cpp` modules, no node `tree-sitter` package). The implementation
adds **runtime** npm dependencies — heavier than the previous "zero non-LSP
deps" footprint. The trade-off is worth it because tree-sitter does real
syntactic work that regex cannot do correctly and that LSP doesn't offer as a
method.

**Implementation chose the WASM path, NOT the native node bindings the design
listed.** The design's `package.json` block suggested the native packages
(`tree-sitter` + `tree-sitter-python` / `tree-sitter-cpp` / `tree-sitter-bash`),
but those have **irreconcilable peer-dependency ranges**: `tree-sitter-cpp@0.23.4`
(the latest) requires `tree-sitter@^0.21.1`, while `tree-sitter-python@0.25`
and `tree-sitter-bash@0.25` require `tree-sitter@^0.25.0`. There is no single
`tree-sitter` version satisfying all three grammars without
`--legacy-peer-deps`, which is fragile to ask users to do. So we use:

```json
// package.json (additions, as actually implemented)
{
  "dependencies": {
    "web-tree-sitter": "^0.26.10",
    "tree-sitter-wasm": "^1.1.2"
  }
}
```

- `web-tree-sitter` is the WASM runtime (ships `web-tree-sitter.wasm`,
  auto-located in Node via `import.meta.url`).
- `tree-sitter-wasm` ships **prebuilt grammar WASMs** for all three languages
  (and 100+ others — `out/python/`, `out/cpp/`, `out/bash/`). `getWasmPath(lang)`
  resolves the absolute path. The package is large (~144 MB unpacked) because
  it bundles every grammar; if size ever matters, vendor only the three needed
  `.wasm` files. No native compilation, no peer conflicts.

Notes for the maintainer:
- **jiti resolution**: verified that `web-tree-sitter` (ESM, `type: module`,
  uses `import.meta.url`) and `tree-sitter-wasm` (ESM, `getWasmPath` uses
  `import.meta.url`) both load correctly under jiti — the same way the
  vscode-jsonrpc RAL trap taught us to *test the import path under jiti, not
  just under tsc*. `Parser.init()` with no options works in Node because the
  runtime auto-locates `web-tree-sitter.wasm` relative to the module.
- **Grammar ABI drift**: tree-sitter's ABI bumps (0.20 → 0.22 → 0.25) have
  broken downstream consumers before. The WASM grammars in `tree-sitter-wasm`
  are built against a specific runtime ABI; if a `web-tree-sitter` bump makes
  `Language.load` throw ("incompatible language version"), bump
  `tree-sitter-wasm` to a matching build. Pin both; bump deliberately and
  re-test the snippet-parse cases (especially C++ fragments) after any bump.
- These are the first **runtime** deps beyond `vscode-jsonrpc` /
  `vscode-languageserver-protocol`. The "Dependencies — do not bump without
  reading" section below is updated to list them.

## Integration with `code_definition` — IMPLEMENTED

`code_definition` gained an optional `list_symbols?: boolean` (default
`false`) that runs the same tree-sitter scan over its returned snippet and
appends the symbol table. Default `false` keeps `code_definition`'s output
focused and preserves its contract (the "do not break round-trip" guarantee
in the README). The scan reuses the exact same `parseSymbols` helper as
`code_scan`, so the two share one implementation. The snippet's
absolute line range is computed from the `resolveDefBodyRange` result
(`sl+1 .. el+1` in 1-based coords, where sl/el are the 0-based LSP line
numbers), and the same `renderSymbolTable` formats the output.

This integration was added alongside `code_scan` (not deferred) because
the two-step `code_definition` → `code_scan` flow was the exact driving
scenario (agent reads a definition snippet, sees a third-party symbol, wants
its API). Doing it in one call removes the agent's need to hold the snippet's
path and line range across a turn.

## What this design deliberately does NOT do

- **No `code_inspect` scratch-synthesis tool.** Killed by the
  transitively-included-symbol scenario. The symbol is already in scope in
  the real file; synthesizing a fresh file to re-resolve it is fragile and
  unnecessary.
- **No modification to `code_symbol` (workspace/symbol).** It's
  workspace-scoped by spec; no client-side fix makes it index third-party.
  `code_scan` is the third-party entry point; `code_symbol` remains the
  fuzzy in-workspace search tool. They coexist.
- **No overload of `code_hover`/`code_definition` to accept a name instead of
  a column.** Considered (Option B in the design discussion); rejected because
  it forks the coordinate contract the MAINTAINER doc warns about, and because
  `code_scan` returns the column for the agent to pass verbatim, so the
  existing tools stay position-only and clean.
- **No hover in the default path.** Hover is opt-in (`include_docs`). The
  symbol table is correct without it (tree-sitter, not regex). Default = zero
  LSP calls.
- **No multi-root.** `path` is a real file the agent supplies; the LSP server
  (for optional hover) is the one for `(ctx.cwd, language)` as today.

## Testing this

- A `scan <file> [<startLine:1-based> <endLine:1-based>] [--pattern <re>] [--docs] [--roles type,call,...]`
  subcommand in `scripts/nav-cli.mjs` calls the same `nav.scan` the
  `code_scan` tool uses (no separate formatting to keep in sync).
  `--roles` passes through to the tool's `roles` parameter (default:
  `type,call,member,import` — omit `var`).
  `definition ... --list-symbols` calls `nav.definition` with
  `list_symbols: true`, same as the `list_symbols` integration
  (same default role set). If you change rendering in `tree-sitter-parse.ts`
  (`renderSymbolTable`, `hoverFirstLine`) or the role classification, make the
  same change in the CLI and vice versa.
- Re-test the snippet-parse cases (raw Python body, raw C++ body, the
  comment/string noise snippet) after any tree-sitter version bump — those
  are the cases that motivated choosing tree-sitter over regex.
- Verify the absolute-position math: a symbol at snippet-relative `(row=2,
  col=10)` with `startLine=43` must print `path:45:11` (1-based). Off-by-one
  here silently breaks the round-trip into `code_hover`/`code_definition`.
  Verified: `scan /tmp/test_offset.py 3 5` correctly prints
  `process` at `3:5`, `cbor2.loads` at `4:14`/`4:20`, and those positions
  round-trip into `code_hover` and `code_definition` (which jumps into the
  nix-store `site-packages/cbor2/_decoder.py`).

