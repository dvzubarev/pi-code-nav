# `code_outline` — paginated structural overview with signatures + docs

> Merges the old `code_tree`'s signature-enrichment (parallel LSP hover) into
> `code_outline`'s allowlist-scoped overview. The old split (outline = bare
> overview, tree = pattern + signatures) is gone: one tool, paginated, with
> everything the agent needs to decide whether to go deeper.

## What it does

`code_outline(path, offset=1, limit=20)` returns a paginated, indented listing
of a source file's structural symbols — classes, methods, functions,
constructors, interfaces, structs — with:

- **Signature** per entry (full, never truncated), sourced from the server's
  `detail` field (preferred — ccls fills this with the full declaration) or
  from a parallel LSP hover (`hoverSignature`) when `detail` is absent (e.g.
  tsserver/ty).
- **Reusable identifier position** (`path:line:column`) from the symbol's
  `selectionRange`.
- **Body range** (`range=start-end`) from the symbol's full LSP range. It is
  rendered separately because its start line may differ from the identifier
  line (for example, when decorators are included).
- **One-line doc snippet** (`doc:` sub-line), extracted as the first sentence
  of the docstring prose that follows the signature fence (PEP 257 / Javadoc
  convention — the summary line). Omitted when empty.
- **Pagination**: `offset` (1-based, default 1) and `limit` (default 20,
  hard cap 200) page by rendered rows. When a page opens mid-class, the
  orphaned rows are prefixed with a `(cont.)` ancestor header so indented
  members are never contextless.
- **Trailing message** when more entries exist, mirroring pi's `read` tool:
  `[N more entries in <path>. Use offset=<next> to continue.]`

### Output format (multi-line block per entry)

```
<pad><Kind> <name>  <path>:<line>:<column>  range=<start>-<end>
<pad>  signature: <full signature>
<pad>  doc: <first sentence>
```

The header keeps the reusable identifier position distinct from the body
range. The sub-lines (`signature:`, `doc:`) are labelled so every line is
self-describing.

Example for a method at depth 1 (inside a class):

```
  Method bar  example.py:15:3  range=14-42
    signature: def bar(self, x: int) -> None
    doc: Do the thing.
```

`example.py:15:3` is the 1-based identifier position, directly reusable as
input to `code_hover`/`code_definition`/`code_references`. `range=14-42` is
the enclosing symbol range for `read` or a quick size estimate.

## Allowlist

Only structural kinds are kept: `{5 Class, 6 Method, 9 Constructor,
11 Interface, 12 Function, 23 Struct}`. Everything else (Variable 13,
Constant 14, Property 7, Field 8, Enum 10, etc.) is dropped — no opt-out.

Property(7)/Field(8) are deliberately dropped even though they sound
structural: tsserver emits `Property` for object-literal keys (every field of
a `registerTool({...})` call), flooding the outline with noise. The agent can
`read` a class body to see its fields, or call `code_hover` on a class to
inspect its members via the hover docs.

## Pagination + ancestor context

When `offset` lands on a row that is nested inside a symbol on a previous page
(e.g. offset=5 lands on a class's method), the tool re-emits the ancestor as
a `(cont.)` context row:

```
Class Foo  (cont.)  example.py:12:7  range=12-45
  Method bar  example.py:18:7  range=18-30
    signature: def bar(self)
```

The context row carries no signature or docs (it was shown in full on the
previous page) — it is structural context only.

## Cost

`limit` parallel LSP hover calls per invocation (default 20, hard-capped at
200). JSON-RPC over stdio supports concurrent in-flight requests; measured
~4ms per hover, so 20 hovers ≈ 80ms. The cap prevents a runaway agent from
requesting 10K hovers.

## Design notes

### Why the outline + tree merge?

The original design (commit `0a60a8b` era) split the concern:

- `code_outline` — single `documentSymbol` round-trip, no hovers. Bloat-free
  structural overview, but no signatures for TS/Python (servers leave `detail`
  empty).
- `code_tree(path, pattern)` — pattern-driven prune + parallel hover for
  signatures. The pattern bounded the hover candidate set to a small number,
  making the hover cost acceptable.

The merge keeps the hover cost bounded via `limit` (capped at 200), so the
per-row hover is affordable for a full-file overview. The pattern-driven use
case (find symbol by name, show its members with signatures) is replaced by
the paginated overview: the agent calls `code_outline`, then either
`read`-style continuation or a lower `offset` with a tighter `limit` to
zoom in. The two tools confused agents (two near-duplicate entry points) and
`code_tree` was rarely used.

### Why not a `brief` flag?

Rejected before the split; the allowlist is simpler and more honest than a
flag that changes output shape.

### Identifier positions and body ranges

The reusable `path:line:column` comes entirely from
`DocumentSymbol.selectionRange.start`. The separate `range=start-end` comes
from `DocumentSymbol.range` and spans the full symbol. Keeping them separate
avoids combining a body-range start line with an identifier column when those
positions differ.

### Doc snippet extraction

The `hoverSignature` helper consumes the fenced signature block from the LSP
hover response; `hoverDocSnippet` takes the first non-blank prose line after
that block closes, skipping markdown horizontal rules (`---`) that servers
like ty emit as a signature-docs separator. For ccls's no-fence form it also
skips a first line equal to the selected `detail`/hover signature, preventing a
long signature (including a truncated prefix) from being mislabeled as `doc:`;
a following real comment is still retained. The snippet is cut at the first
sentence boundary (`. ` / `! ` / `? `).
