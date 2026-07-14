# `code_outline` & `code_tree` — overview vs. pattern-driven tree

> Implementation notes for the two `documentSymbol`-backed tools
> (`nav.ts` `outline()` and `tree()`). The `code_outline`/`code_tree` split
> replaced a rejected `brief` flag on `code_outline`.

## The problem

`code_outline` on a TS/JS (or Python) file is dominated by `Constant`
(SymbolKind 14) and `Variable` (13) rows — one per top-level `const`/`let`/
`var` binding (TS) or module-level assignment (Python: `GLOB = '38'` →
`kind:14`). This is **the language server's choice, not a rendering bug** —
tsserver returns `SymbolKind.Constant` for module-level `const`/`let`, and ty
does the same for module-level assignments. Our `symbolKindName` correctly
maps 14 → "Constant"; the output is accurate but defeats the tool's stated
purpose ("a compact overview"). Worse, tsserver returns top-level symbols
alphabetically, not in source order, so the constants are also out of
position.

`Constant` appears in two roles:
1. **Top-level** module bindings (`TOP`, `ROOT`, `count`) — pure noise.
2. **Nested** inside a function/method (locals like `local`, `inside`) —
   also noise, but already children of their enclosing symbol so they
   clutter each method's subtree without breaking the tree.

`Property` (7) under a class is the one `Constant`-adjacent kind that IS
structurally meaningful — but see below.

## Decision: two tools, not a flag

The shipped design split the concern across two tools rather than adding a
`brief` flag to `code_outline`.

### `code_outline` — allowlist, no arguments

`code_outline` takes only a path and keeps an **allowlist** of structural
SymbolKinds: `{5 Class, 6 Method, 9 Constructor, 11 Interface, 12 Function,
23 Struct}`. Everything else is dropped, with **no opt-out**.

- **`Property`(7)/`Field`(8) are deliberately dropped.** They sound
  structural but aren't reliably so: tsserver emits `Property` for
  object-literal keys (every field of a `registerTool({...})` call or a
  returned object literal becomes a `Property` row), flooding the outline
  with non-structural noise. ty/ccls use `Field`(8) only for real
  class/struct fields, but even there a field list is rarely what a "compact
  overview" wants — the agent can `code_tree` a class name to see its
  members.
- **An allowlist is more honest than a denylist**: it states what the
  overview shows rather than what it happens to hide, and it's robust to
  servers returning kinds we didn't anticipate (dropped by default — the
  safe choice for a "compact overview"). It also drops the alphabetical-sort
  noise (tsserver's out-of-source-order constants are just gone).
- **`Enum`(10)/`EnumMember`(22)/`Namespace`(3) are dropped**; none appeared
  in practice for our servers (verified across tsserver/ty/ccls).
- **`detail` (the server-populated signature/declaration string) is rendered
  inline after the name where present** — already valuable for C++ (ccls
  fills `detail` with declarations like `int main()`,
  `void Widget::method()`), so the C++ outline is an annotated overview for
  free. tsserver/ty leave `detail` empty, so TS/Python outlines show no
  signature column. Getting one there requires LSP hover per row, which
  `code_outline` deliberately does NOT do — it stays a single
  `documentSymbol` round-trip. That job is `code_tree`'s.

### `code_tree` — pattern + parallel hover signatures

`code_tree(path, pattern)` takes a **regexp** matched against symbol names
and returns matches with their signatures. Tree semantics:
1. A node whose name matches → keep it AND its entire subtree (members,
   locals) as context.
2. A node with a matching descendant → keep as an ancestor for context
   (so the agent sees where the match sits); prune non-matching sibling
   subtrees.

Signatures come from `detail` where populated (ccls — no hover needed), or
from **parallel LSP hover** (`Promise.all`) for matched rows whose `detail`
is empty (tsserver/ty). Only matched nodes are hovered; ancestor/subtree
context rows are not (use `code_hover` on their position if needed).

**Why parallel hover is acceptable here but not in `code_outline`:**
measured ~4ms for 10 hovers parallel vs 29ms sequential (JSON-RPC over
stdio supports concurrent in-flight requests). The pattern scopes the
candidate set to a small number of matched nodes, so the hover cost is
bounded and tiny. In `code_outline` there's no pattern → the candidate set
is the whole file → N hovers on every call, defeating "bloat-free, speedy."

`code_tree` does **NOT** apply the outline allowlist — the pattern is the
scoping mechanism, so filtering by kind would hide symbols the agent
explicitly asked for (e.g. scanning for a constant by name).

### Why not the `brief` flag

The original proposal was `brief?: boolean` (default true) on `code_outline`
that dropped 13/14, with `brief=false` to restore everything. That was built
and tested, then superseded: the allowlist is simpler and more honest, and
the pattern-driven `code_tree` absorbs the "I want signatures for specific
symbols" use case that `brief=false` + manual `code_hover` was a poor fit
for. Two tools with clear jobs beat one tool with a flag that changes its
output shape.

### Rejected: hover-based signatures as a default in `code_outline`

A `include_docs?: boolean` flag (mirroring `code_scan`) was considered for
`code_outline`: when true, hover each kept row and append a signature label.
Rejected as a default because it is N LSP hover round-trips and the whole
point of `code_outline`'s default path is a single `documentSymbol` call.
`detail` already gives C++ signatures for free, and the user explicitly said
"no need for include_docs, since it is already working for ccls. Let's
include details by default." The hover-enriched-signatures job instead
became `code_tree`, where the pattern bounds N to a small set and parallel
hover makes it cheap.

## Implementation notes

- The allowlist filter (`pruneDocSymbolTree` / `filterSymbolInfoList`) lives
  in `nav.ts` `outline()`, operating on the `DocumentSymbol[]` tree / flat
  `SymbolInformation[]` **before** rendering — NOT in the shared
  `renderDocSymbol` / `renderSymbolInfo` (also used by `code_search_symbol`,
  which must NOT be filtered).
- `code_tree`'s `collectTreeRows` prunes the tree to
  matches+ancestors+subtree in pre-order (parents before children),
  returning rows with depth + a `matched` flag. A tentative-slot-then-evict
  technique keeps ancestors before their children without a two-pass
  design.
- `hoverSignature` (in `render.ts`, next to `hoverText`) collapses a hover
  body into a one-line signature — handles the multi-line fenced signatures
  ty returns (`def alpha(\n    a: int,\n    b: str\n) -> bool` →
  `def alpha(a: int, b: str) -> bool`). Distinct from `hoverFirstLine` (in
  `tree-sitter-parse.ts`), which returns only the first physical line and
  truncates multi-line signatures mid-paren.
- CLI: `outline <file>` (no flags) and `tree <file> <pattern>`.

## Verification commands

```sh
# outline: structural kinds only, constants/variables dropped.
CODE_NAV_ROOT=$(pwd) node scripts/nav-cli.mjs outline test/fixtures/second.py
# tree: pattern-driven, signatures via parallel hover (TS/Python) or detail (C++).
CODE_NAV_ROOT=$(pwd) node scripts/nav-cli.mjs tree test/fixtures/second.py "TempC"
CODE_NAV_ROOT=/tmp node scripts/nav-cli.mjs tree /tmp/many.ts "^get|^set"
# C++ outline carries ccls detail signatures on kept rows.
CODE_NAV_ROOT=/tmp node scripts/nav-cli.mjs outline /tmp/sample.cpp
```
