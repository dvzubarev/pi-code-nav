# `code_outline` — paginated structural overview with signatures + docs

> Merges the old `code_tree`'s signature-enrichment (parallel LSP hover) into
> `code_outline`'s allowlist-scoped overview. The old split (outline = bare
> overview, tree = pattern + signatures) is gone: one tool, paginated, with
> everything the agent needs to decide whether to go deeper.

## What it does

`code_outline(path, offset=1, limit=20)` returns a paginated, indented listing
of a source file's structural symbols — classes, methods, functions,
constructors, interfaces, structs — with:

- **Signature** per entry (from parallel LSP hover, collapsed to one line,
  falling back to the server's `detail` field when hover yields none).
- **Body line range** (`:sl-el:col`), where `sl-el` is the symbol's full
  extent (1-based) and `col` is the selectionRange (identifier) column. A
  flat declaration shows `:10-10:5`; a function with body shows `:10-42:5`.
- **One-line doc snippet** (`docs:` prefix), extracted as the first sentence
  of the docstring prose that follows the signature fence (PEP 257 / Javadoc
  convention — the summary line). Omitted when empty.
- **Pagination**: `offset` (1-based, default 1) and `limit` (default 20,
  hard cap 200) page by rendered rows. When a page opens mid-class, the
  orphaned rows are prefixed with a `(cont.)` ancestor header so indented
  members are never contextless.
- **Trailing message** when more entries exist, mirroring pi's `read` tool:
  `[N more entries in <path>. Use offset=<next> to continue.]`

### Output format (one row per entry)

```
<pad><Kind> <name>  <signature>  :<sl>-<el>:<col>  docs: <summary>
```

```
  Method bar  def bar(self, x: int) -> None  :15-42:3  docs: Do the thing.
```

`<sl>:<col>` is the identifier position (1-based), directly reusable as input
to `code_hover`/`code_definition`/`code_references`. `<sl>-<el>` is the body
range for a `read` or quick size estimate.

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
Class Foo  (cont.)  :12-45:1
  Method bar  def bar(self)  :18-30:3  docs: ...
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

### Body ranges

The body range (`sl-el`) comes from the LSP `DocumentSymbol.range` (the
symbol's full extent). For a declaration without a body this is a single-line
range (e.g. `:10-10:5`); for a definition with a body it spans the whole
function/class/method. The start line and column are the
`selectionRange.start` (the identifier), so `<sl>:<col>` is directly
feedable to `code_hover`/`code_definition`/`code_references`.

### Doc snippet extraction

The `hoverSignature` helper consumes the fenced signature block from the LSP
hover response; `hoverDocSnippet` takes the first non-blank prose line after
that block closes, skipping markdown horizontal rules (`---`) that servers
like ty emit as a signature-docs separator. The snippet is cut at the first
sentence boundary (`. ` / `! ` / `? `).
