# `code_outline` Constant/Variable verbosity — investigation notes

Status: **implemented** — but not via the `brief` flag this file originally
proposed. The shipped design split the concern across TWO tools:

- **`code_outline`** — a bloat-free structural overview. Takes only a path;
  keeps an **allowlist** of structural SymbolKinds (Class, Method, Function,
  Property, Field, Constructor, Interface, Struct — kinds 5,6,7,8,9,11,12,23);
  drops everything else (including Constant 14 and Variable 13). No
  arguments, no hover round-trips. The server's `detail` is rendered inline
  where present (ccls fills it; tsserver/ty leave it empty).
- **`code_tree`** — a NEW pattern-driven tool. Takes a path + a regexp matched
  against symbol names; prints matches with their ancestors (hierarchy
  context) and the matched node's entire subtree. Fetches signatures via
  **parallel LSP hover** for matched rows whose `detail` is empty (tsserver/ty).
  No constant/variable filtering — the pattern scopes the candidate set.

The investigation below is kept for history; the "Decision (implemented)"
section records the reasoning, including why the original `brief` flag was
abandoned in favor of the allowlist + two-tool split.

## The symptom

`code_outline` on a TypeScript/JavaScript file is dominated by `Constant`
rows — one per top-level `const`/`let`/`var` binding. The tool's stated
purpose is *"a compact overview before reading full files"* / *"functions,
classes, methods, with signatures and positions"* (index.ts tool
description). A TS file full of import-and-binding constants defeats
"compact."

Example (`scripts/nav-cli.mjs outline sample.ts` against):

```ts
import { readFile } from "node:fs/promises";
const ROOT = process.cwd();
const count = 42;
function greet(name: string): string { return `hi ${name}`; }
class Point { x: number; y: number; constructor(x: number, y: number) {...} }
export { greet, Point };
```

current output:
```
Constant count  (4:7)
Function greet  (6:10)
Class Point  (10:7)
  Constructor constructor  (13:2)
  Property x  (11:2)
  Property y  (12:2)
Constant ROOT  (3:7)
```

The two `Constant` rows (and their sort order — tsserver returns them
alphabetically, not in source order) are noise for an "overview."

## Root cause

This is **the language server's choice**, not a bug in our rendering:

- tsserver returns `SymbolKind.Constant` (14) for module-level `const`/`let`
  bindings. Verified by dumping raw `documentSymbol` kinds:
  ```json
  [ {"name":"count","kind":14}, {"name":"greet","kind":12},
    {"name":"Point","kind":5},  {"name":"ROOT","kind":14} ]
  ```
- ty (Python) does the **same** for module-level assignments: `GLOB = '38'`
  → `kind: 14` (Constant). So this is standard LSP behavior across servers,
  not a TS-specific quirk. TS/JS just *has more of them* because the
  convention puts imports and many bindings at module top level.

Our `symbolKindName` (render.ts) correctly maps 14 → "Constant". The output
is accurate; it's just not useful for the tool's stated purpose.

## Where constants show up (the nested case)

Dumped a nested example to understand the full picture:

```ts
const TOP = 1;
class C {
  field = 2;
  method() {
    const local = 3;
    return local + this.field + TOP;
  }
}
function f() {
  const inside = 4;
  return inside;
}
```

tsserver returns:
```
C          (kind=5  Class)
  field    (kind=7  Property)
  method   (kind=6  Method)
    local  (kind=14 Constant)   ← nested const inside a method
f          (kind=12 Function)
  inside   (kind=14 Constant)   ← nested const inside a function
TOP        (kind=14 Constant)   ← top-level
```

So `Constant` appears in two roles:
1. **Top-level** module bindings (e.g. `TOP`, `ROOT`, `count`) — pure noise
   for an outline.
2. **Nested** inside a function/method (locals like `local`, `inside`) —
   also noise for an outline, but at least they're already children of their
   enclosing symbol so they don't break the structural tree; they just
   clutter each method's subtree.

`Property` (7) under a class is the one `Constant`-adjacent kind that IS
structurally meaningful and should stay.

Note: `import` bindings (`readFile` in the first example) do **not** appear
as separate outline rows — tsserver does not return them as DocumentSymbols.
So imports are not part of this problem; only `const`/`let`/`var` bindings
are.

## Precedent in this extension

`code_scan` already drops "noisy" rows by default for the same
reason: its default role set is `[type, call, member, import]` — **omitting
`var`** — with the rationale (code_scan.md):

> "import was separated from var specifically so that 'drop the noisy locals'
> … `var` is a local variable, parameter, or assignment target — hoverable
> but rarely worth learning about."

`code_outline` is the same product decision waiting to happen, applied to
`Constant`/`Variable` SymbolKinds instead of the tree-sitter `var` role.

## Decision (implemented)

The shipped design split the concern across TWO tools rather than adding a
flag to `code_outline`:

### `code_outline` — allowlist, no arguments

`code_outline` keeps an **allowlist** of structural SymbolKinds:
`{5 Class, 6 Method, 9 Constructor, 11 Interface, 12 Function, 23 Struct}`.
Everything else is dropped, with **no opt-out**. Property(7)/Field(8) are
**deliberately dropped**: they sound structural but aren't reliably so —
tsserver emits `Property` for object-literal keys (every field of a
`registerTool({...})` call or a returned object literal becomes a `Property`
row), which floods the outline with non-structural noise. ty/ccls use Field(8)
only for real class/struct fields, but even there a field list is rarely what a
"compact overview" wants — the agent can `code_tree` a class name to see its
members. An allowlist is more honest than a denylist of noisy kinds: it states
what the overview shows rather than what it happens to hide, and it's robust to
servers returning kinds we didn't anticipate (dropped by default, the safe
choice for a "compact overview"). This also drops the alphabetical-sort noise
the original symptom complained about (tsserver returned `count`/`ROOT` out of
source order — now they're just gone).

Constructor is a kind of method. Enum(10)/EnumMember(22)/Namespace(3) are
dropped; none appeared in practice for our servers (verified across
tsserver/ty/ccls), so no special-casing.

`detail` (the server-populated signature/declaration string) is rendered
inline after the name where present — this is **already valuable for C++**
(ccls fills `detail` with declarations like `int main()`,
`void Widget::method()`, `constexpr int MAX`), so the C++ outline is an
annotated overview for free. tsserver and ty leave `detail` empty, so TS/Python
outlines show no signature column. Getting one there requires LSP hover per
row — which `code_outline` deliberately does NOT do (it stays a single
`documentSymbol` round-trip). That job is `code_tree`'s.

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

**Why parallel hover is acceptable here but not in `code_outline`:** measured
~4ms for 10 hovers parallel vs 29ms sequential (JSON-RPC over stdio supports
concurrent in-flight requests). The pattern scopes the candidate set to a
small number of matched nodes, so the hover cost is bounded and tiny. In
`code_outline` there's no pattern → the candidate set is the whole file → N
hovers on every call, defeating "bloat-free, speedy."

`code_tree` does **NOT** apply the outline allowlist — the pattern is the
scoping mechanism, so filtering by kind would hide symbols the agent
explicitly asked for (e.g. scanning for a constant by name).

### Why not the `brief` flag

The original proposal was a `brief?: boolean` (default true) on `code_outline`
that dropped 13/14, with `brief=false` to restore everything. That was built
and tested, then superseded: the allowlist is simpler and more honest, and the
pattern-driven `code_tree` absorbs the "I want signatures for specific symbols"
use case that `brief=false` + manual `code_hover` was a poor fit for. Two
tools with clear jobs beat one tool with a flag that changes its output shape.

### Implementation notes

- The allowlist filter (`pruneDocSymbolTree` / `filterSymbolInfoList`) lives
  in `nav.ts` `outline()`, operating on the `DocumentSymbol[]` tree / flat
  `SymbolInformation[]` **before** rendering — NOT in the shared
  `renderDocSymbol` / `renderSymbolInfo` (also used by `code_search_symbol`, which
  must NOT be filtered).
- `code_tree`'s `collectTreeRows` prunes the tree to matches+ancestors+subtree
  in pre-order (parents before children), returning rows with depth + a
  `matched` flag. A tentative-slot-then-evict technique keeps ancestors before
  their children without a two-pass design.
- `hoverSignature` (in `render.ts`, next to `hoverText`) collapses a hover
  body into a one-line signature — handles the multi-line fenced signatures ty
  returns (`def alpha(\n    a: int,\n    b: str\n) -> bool` →
  `def alpha(a: int, b: str) -> bool`). Distinct from `hoverFirstLine`
  (in tree-sitter-parse.ts), which returns only the first physical line and
  truncates multi-line signatures mid-paren.
- CLI: `outline <file>` (no flags) and `scan <file> <pattern>`.

### Verification commands

```sh
# outline: structural kinds only, constants/variables dropped.
CODE_NAV_ROOT=$(pwd) node scripts/nav-cli.mjs outline test/fixtures/second.py
# tree: pattern-driven, signatures via parallel hover (TS/Python) or detail (C++).
CODE_NAV_ROOT=$(pwd) node scripts/nav-cli.mjs tree test/fixtures/second.py "TempC"
CODE_NAV_ROOT=/tmp node scripts/nav-cli.mjs tree /tmp/many.ts "^get|^set"
# C++ outline carries ccls detail signatures on kept rows.
CODE_NAV_ROOT=/tmp node scripts/nav-cli.mjs outline /tmp/sample.cpp
```

[The "Rejected: hover-based signatures" section below is superseded by
`code_tree`; retained for the reasoning trail.]

### Rejected: hover-based signatures as a default in `code_outline`

A `include_docs?: boolean` flag (mirroring `code_scan`) was
considered for `code_outline`: when true, hover each kept row and append a
signature label. Rejected as a default because it is N LSP hover round-trips
and the whole point of `code_outline`'s default path is a single
`documentSymbol` call. `detail` already gives C++ signatures for free, and the
user explicitly said "no need for include_docs, since it is already working
for ccls. Let's include details by default." The hover-enriched-signatures
job instead became `code_tree`, where the pattern bounds N to a small set and
parallel hover makes it cheap — so the capability exists, just not in
`code_outline`.

## Original investigation (kept for history)



Default-drop `Constant` (14) and `Variable` (13) from the outline, keep an
opt-in:

- **Drop top-level** `Constant`/`Variable` rows (module-level bindings —
  noise in TS/JS/Python). This is the main win.
- **Drop nested** `Constant`/`Variable` rows too (locals inside
  methods/functions — noise; tsserver returns them as children, so dropping
  them just declutters each method's subtree without breaking the tree).
  *Open question: keep or drop nested? The tool is an "overview"; locals
  are even less useful than top-level constants. Lean: drop both.*
- **Keep** `Property`/`Field` (7/8) — structurally meaningful class members.
- Add optional `include_variables: boolean` (default `false`) to opt back in,
  mirroring `code_scan`'s `roles: ["var"]` escape hatch. This
  preserves the old behavior for any prompt that relied on it.

Where to implement: `nav.ts` `outline()`, after `renderDocSymbol` produces
lines — or, cleaner, a filter pass over the `DocumentSymbol[]` tree before
rendering (so nested-vs-top-level can be decided structurally, and the
hierarchical renderer never sees the dropped nodes). A tree-filter also
handles the flat `SymbolInformation[]` case by skipping rows whose `kind`
is 13/14.

Effect on the example above:
```
Function greet  (6:10)
Class Point  (10:7)
  Constructor constructor  (13:2)
  Property x  (11:2)
  Property y  (12:2)
```

## Risk / contract impact

- Changes tool output. An agent prompt relying on seeing a `Constant` in the
  outline wouldn't see it by default — but the tool's description never
  promised constants, and `include_variables: true` restores the old
  behavior.
- The `code_scan` precedent shows this default-drop + opt-in pattern
  is already accepted in the extension.
- **Multi-language consideration:** Python's `GLOB` and any language's
  module-level constants also get dropped. That's consistent with the
  tool's "functions/classes/methods" description, but worth confirming we
  want it cross-language and not just for TS/JS.
- ccls (C++) behavior not yet checked — does it return `Constant` for
  `constexpr`/`#define`/file-scope `static const`? Check before shipping a
  cross-language default. (If C++ constants ARE useful in an outline, the
  filter may need to be language-aware rather than kind-only.)

## Verification commands (reproduce)

```sh
# Dump raw kinds (shows the server's SymbolKind numbers):
cat > /tmp/inspect.mjs <<'EOF'
import { LspClient, resolveConfig } from "/home/denin/.pi/agent/extensions/code-nav/lsp-client.ts";
import { readFile } from "node:fs/promises";
const lang = process.argv[2]; const file = process.argv[3];
const c = new LspClient(lang, "/tmp", resolveConfig(lang));
const syms = await c.documentSymbols(file, await readFile(file, "utf8"));
console.log(JSON.stringify(syms.map(s => ({name: s.name, kind: s.kind, detail: s.detail})), null, 2));
await c.shutdown();
EOF
node /tmp/inspect.mjs typescript /tmp/sample.ts
node /tmp/inspect.mjs python     /tmp/sample.py

# Outline via the CLI (current, verbose):
CODE_NAV_ROOT=/tmp node scripts/nav-cli.mjs outline sample.ts
```

## Decision needed (resolved — see "Decision (implemented)" at top)

- Drop both top-level AND nested constants/variables, or only top-level?
  → both (drop by kind, not by depth).
- Cross-language default, or TS/JS-only? → cross-language (drop 13 and 14
  everywhere).
- Check ccls behavior for C++ constants before deciding the cross-language
  default. → ccls returns Variable (13) for `const`/`constexpr`/`static`,
  confirmed (so the filter covers 13 AND 14).
- Confirm the `include_variables` opt-in name/shape (mirror `code_scan`
  `roles`, or a simpler boolean?). → simpler boolean: `brief` (default true),
  mirroring `code_scan`'s default-drop-of-noisy-rows precedent.
