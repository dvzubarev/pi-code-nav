# `code_scan` — identifier scan via tree-sitter

> Implementation notes for the tree-sitter-backed symbol-discovery tool
> (`tree-sitter-parse.ts` + `nav.ts` `scan()` + `code_definition`'s
> `list_symbols` integration). Read before touching the tree-sitter path.

## What it solves

The LSP detail tools answer "given a `(path, line, col)`, tell me about the
symbol there." They do **not** answer "I'm looking at a snippet — what's the
position of this symbol in it?" That gap matters most for **third-party /
stdlib / system** symbols, where `code_search_symbol` (`workspace/symbol`)
is unreliable: it indexes files the server indexed at startup (your project
tree), not `site-packages`, `/usr/include`, or nix-store headers — unless
those were explicitly added as workspace folders (see
`code_search_symbol.md`).

Hover/definition at a **known position** already resolves third-party and
system code in every language (verified for ty, pyright, ccls). So the only
gap is getting from "a snippet in view" to "a precise position in a real
file." `code_scan` parses the file (or a range) with tree-sitter and returns
every identifier with its absolute 1-based `(path, line, col)` and a
syntactic **role**.

```
code_scan(path="widget.cpp", startLine=43, endLine=49)
  →
Symbols in widget.cpp:43-49 (roles: type|call|member|import|var, 1-based, reusable as code_* input):
  type   vector      :43:11
  call   sort        :43:9
  member begin       :43:15
  member end         :43:27
  member push_back   :45:10
  member size        :46:23
  member empty       :47:11
```

The full path appears once in the header; each row carries only `:line:col`
(repeat-the-long-nix-path-on-every-row is pure context-window tax). The
header also carries the role legend.

## Why tree-sitter, not regex or LSP

- **Regex** `[A-Za-z_]\w*` cannot tell identifiers from comment/string noise
  (`# TODO: fix the load function`, `"sort the data"` → false `load`/`sort`
  hits) and needs a per-language keyword blacklist that drifts across
  versions. tree-sitter's identifier walk returns real identifiers, zero
  noise — `if`/`return`/`for` are `if_statement`/`return_statement` nodes,
  not `identifier` nodes, so they're naturally skipped. **No keyword list,
  ever.**
- **tree-sitter gives a node type**, so the table can label `vector` as
  `type`, `sort` as `call`, `begin`/`size` as `member` — for free, with no
  LSP call.
- **Snippet parsing works without wrapping.** tree-sitter's error-recovery
  handles raw function-body fragments (no enclosing `def`/`#include`/`{}`).
  Verified against the exact snippets `code_definition` returns: Python body
  and C++ body both parse with `has_error: false`. No wrapping, no scratch
  file, no import guessing.
- **LSP `semanticTokens/range`** was considered and rejected: not portable
  (bash-language-server doesn't implement it; ccls/pyright/ty vary), it
  breaks the zero-LSP-call default path (requires `didOpen` + indexing), and
  its token-type taxonomy can't express occurrence roles (`call`, `import`).
  See "Dead ends" below.

## Role taxonomy — `type | call | member | import | var`

| Role | Meaning | Why the agent wants it |
| ---- | ------- | ---------------------- |
| `type` | type name (Python annotation, C++ `type_identifier`) | hover → docstring/signature; definition → declaration |
| `call` | function/method being called | hover → full signature; definition → callee body (incl. third-party/stdlib) |
| `member` | field/attribute access (`.push_back`, `.encode`, `.begin`) | the third-party API surface the agent most wants |
| `import` | name brought into scope by an import | **primary entry point for third-party discovery** — `cbor2`, `CBOREncoder`, `Callable`, `os` |
| `var` | locals, parameters, assignment targets | semantic anchors for hover, references, and rename |

The standalone scan default is `type, call, member, import` — all except
`var`. Broad symbol-table scans can contain many locals, so callers use `roles`
to include `"var"` or narrow further. `import` remains separate so compact
scans retain third-party entry points.

Definition/reference `list_symbols` is different: it is an explicit request
for line-local navigation metadata, so it includes all five roles, including
`var`. Every occurrence is preserved rather than deduplicated; each rendered
source line therefore carries positions for the symbols visible on that line.

## `include_docs` — opt-in hover enrichment

`include_docs` defaults to `false`. The default path makes **zero LSP
calls** — tree-sitter alone. Hover is purely enrichment, not a filter (the
symbol list is already correct without it — that's the whole point of
tree-sitter vs. regex). When true, each unique symbol is hovered at its
absolute position (one `LspClient.hover` call each) and the first line of
`hoverText` is appended as a label column. The common case stays cheap: one
tool call, no server round-trips, no document open on the LSP server unless
the agent asks for docs.

## Node types per language

| Language | identifier | type_identifier | field/member | call form |
| -------- | ---------- | ---------------- | ------------ | --------- |
| python | `identifier` | `type` (annotation) | `attribute` | `call` (function child) |
| cpp | `identifier` | `type_identifier` | `field_identifier` | `call_expression` child |
| bash | `variable_name` / `word` (in `command_name`) | n/a | — (subscript skipped) | `command_name` (the `word` child) |
| typescript | `identifier` | `type_identifier` + `predefined_type` | `property_identifier` / `shorthand_property_identifier` | `call_expression` field `function`; `new_expression` field `constructor` |

**`classifyRole` decides the role from the node's parent type + field name,
not from the node text.** Use `fieldOf(node)` (not `===`) to compare node
identity — web-tree-sitter returns a fresh proxy per `.child()`, so
reference equality is always false. This was a real bug; do not "simplify"
it back. **Probe the grammar first** before writing rules: parse a
representative snippet and walk the tree printing `node.type`, `node.text`,
`node.parent.type`, and the field name (see the snippet in
`adding-a-language.md`). Node-type names and field structure vary per
grammar; do not guess from another language's grammar.

### Python `type` nodes: emit only the outermost

Python's grammar wraps **every** annotation in a `type` node, and
generics/unions spawn child `type` nodes for each component — a single
annotation like `Callable[[CBOREncoder, Any], None] | None` parses as four
nested `type` nodes. Emitting all four floods the table with subtypes the
agent didn't ask for. So `classifyRole` emits only the **outermost** `type`
and skips a `type` whose parent is itself a type-context node (`type`,
`union_type`, `type_parameter`). The inner identifiers (`Callable`,
`CBOREncoder`, `Any`) are still emitted individually as `var`, so the agent
still sees every name it might hover. C++ uses `type_identifier`/
`primitive_type` (no wrapping), so no equivalent rule is needed there.

### `import` role (Python + TypeScript only)

Imported names are `identifier` nodes under import constructs:
- **Python**: `dotted_name` under `import_statement`/`import_from_statement`/
  `aliased_import` (module names like `cbor2`, imported symbols like
  `CBOREncoder`, aliases like `np`).
- **TypeScript/TSX**: `import_specifier` (`import { readFile }`),
  `namespace_import` (`import * as fs`), `import_clause` (default),
  `export_specifier` (re-export), `aliased_import`/`aliased_export`.
- **C++** `#include` is a preprocessor directive (no identifier node);
  **bash** has no import construct. So the role is Python/TS-specific.

### bash

Bash is the loose one: `variable_name` → `var`, the `word` child of a
`command_name` → `call`, everything else (bare `word` arguments, `string`,
`subscript` indices) → skipped. Bare `word` nodes are mostly arguments/
literals and too noisy; this conservative set is what shipped. Do not block
the tool on bash polish.

## Definition/reference integration — `list_symbols`

`code_definition` and `code_references` expose optional `list_symbols?: boolean`
(default `false`). They run the same `parseSymbols` over rendered source with
all roles enabled and place compact `name@column role` metadata directly below
each relevant numbered source line. Every occurrence is retained, so each line
is independently navigable. Source remains unchanged, while its gutter line
plus `@column` forms a reusable code_* position.

`code_references` annotates only source rows retained by syntax/enclosing
context rendering; it rejects `list_symbols` with `context: "none"`. Both tools
reuse the exact same `parseSymbols` helper as `code_scan`, so discovery and role
classification share one implementation. The standalone `code_scan` keeps its
symbol-table format because it has no source body to annotate.

## Dependency — WASM, not native bindings

The implementation uses the WASM path, not the native node bindings:
- `web-tree-sitter@^0.26.10` — the WASM runtime (auto-locates
  `web-tree-sitter.wasm` via `import.meta.url` in Node).
- `tree-sitter-wasm@^1.1.2` — prebuilt grammar WASMs (`out/{python,cpp,bash,typescript,tsx}/`).

The native packages (`tree-sitter` + per-grammar) have irreconcilable
peer-dependency ranges (`tree-sitter-cpp@0.23.4` needs `tree-sitter@^0.21`,
`tree-sitter-python@0.25`/`tree-sitter-bash@0.25` need `tree-sitter@^0.25`)
— no single version satisfies all three without `--legacy-peer-deps`. The
WASM path avoids native compilation and peer conflicts. The package is large
(~144 MB unpacked, all grammars bundled); if size ever matters, vendor only
the five needed `.wasm` files.

**Bump deliberately.** tree-sitter's ABI has broken downstream consumers
before. If a `web-tree-sitter` bump makes `Language.load` throw
("incompatible language version"), bump `tree-sitter-wasm` to a matching
build — pin both, bump together. Re-test the snippet-parse cases (Python
body, C++ body, the comment/string noise snippet) after any bump — those are
the cases that motivated tree-sitter over regex.

**jiti resolution verified.** Both `web-tree-sitter` and `tree-sitter-wasm`
are ESM using `import.meta.url`; they load correctly under jiti (the same
loader pi uses). `Parser.init()` must be called once before constructing a
`Parser`; `tree-sitter-parse.ts` caches the init promise and per-language
`Language` objects.

**`.tsx`/`.jsx` MUST use the `tsx` grammar**, not `typescript` — the
`typescript` grammar mis-parses JSX (`<Card>` becomes `type_arguments`,
`{value}` an `object`), which would misclassify JSX element names as `type`.
`tsLangForFile` maps `.tsx`/`.jsx` → `tsx`, other TS/JS extensions →
`typescript`.

## Dead ends (do not revive)

- **Scratch-file synthesis tool.** A tool that takes a qualified name like
  `cbor2.load`, synthesizes a scratch `.py` with `import cbor2; __x =
  cbor2.load`, opens it on the server, and hovers. Works when the import is
  obvious; breaks on a C++ function body using `std::vector` or
  `mylib::Widget` where the agent can't know the right `#include`, and
  transitively-included symbols are flatly impossible. The symbol is
  already in scope in the real file; synthesizing a fresh file to re-resolve
  it is fragile and unnecessary.
- **Regex identifier scan.** Can't distinguish identifiers from
  comment/string noise; needs a drifting per-language keyword blacklist.
  Kept only as a degraded-mode fallback if tree-sitter ever becomes
  unavailable, not the primary design.
- **`workspace/symbol` extension / initOptions.** No knob makes ty/pyright/
  ccls index `site-packages` in the DEFAULT index — it's a server-side scope
  decision. (Adding extra workspace folders via `didChangeWorkspaceFolders`
  CAN make ty index them — see `code_search_symbol.md` — but that's a
  separate mechanism, not a `workspace/symbol` flag.)
- **Agent supplies `line`/`column` itself.** The agent is bad at column math
  (the reason `code-nav` exists). Asking it to also do line arithmetic is
  symmetric fragility. The tool must compute positions, not the agent.
- **Agent supplies a verbatim line + token name, tool searches the file.** A
  real improvement over raw line/col math (eliminates line and column
  arithmetic), but still requires the agent to transcribe a line exactly
  (whitespace/indent errors fail the match) and pick which token on a line
  with several. tree-sitter subsumes this. Keep as a degraded-mode fallback
  only.
- **LSP `selectionRange`.** ccls does not support it (returns nothing); ty
  does. Not portable.
- **LSP `semanticTokens/range`.** Superficially a fit but fails on three
  counts: (1) not portable — bash-language-server doesn't implement it at
  all, ccls/pyright/ty support varies (the same unreliable-capability-ad
  trap that plagues `code_diagnostics`); (2) it's an LSP request requiring
  `didOpen` + indexing, breaking the zero-LSP-call default that makes
  `code_scan` a cheap, always-available discovery tool; (3) its token-type
  taxonomy is the wrong shape for roles — no `call` type/modifier
  (`std::sort` is `function` whether called or referenced), no `import`
  concept, `member` vs `property` is muddier. You'd re-derive roles from
  token positions + surrounding text — which tree-sitter already did in one
  parse. If ever revisited, the honest upgrade is **additive**: an optional
  enrichment layer on top of tree-sitter, gated on `supports()` and server
  availability — never a replacement.
- **No overload of `code_hover`/`code_definition` to accept a name instead of
  a column.** Considered; rejected because it forks the coordinate contract
  and `code_scan` already returns the column for the agent to pass verbatim.
- **No hover in the default path.** Hover is opt-in (`include_docs`); the
  symbol table is correct without it. Default = zero LSP calls.

## Testing

- **Unit tests** (`npm test`, `test/*.test.mjs`): pure tree-sitter, no
  servers. Pin `classifyRole` per language, the default role set, occurrence
  preservation, position math, and the `renderSymbolTable`/`hoverFirstLine` formats. They
  load `tree-sitter-parse.ts` through jiti (same loader as production).
  When you change `classifyRole`, `renderSymbolTable`, or `hoverFirstLine`,
  update or add tests there.
- **CLI**: `scan <file> [<startLine> <endLine>] [--pattern <re>] [--docs]
  [--roles type,call,...]` in `scripts/nav-cli.mjs` calls the same
  `nav.scan` — no separate formatting to keep in sync. `definition ...
  --list-symbols` exercises the `list_symbols` integration.
- **Re-test** the snippet-parse cases (raw Python body, raw C++ body, the
  comment/string noise snippet) after any tree-sitter version bump.
- **Verify absolute-position math**: a symbol at snippet-relative
  `(row=2, col=10)` with `startLine=43` must print `path:45:11` (1-based).
  Off-by-one here silently breaks the round-trip into `code_hover`/
  `code_definition` and `code_references`.
