# `code_outline` Constant/Variable verbosity — investigation notes

Status: **investigated, not yet decided/fixed.** This file records the
findings so we can pick the fix later without re-deriving the behavior.

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

`code_symbols_in` already drops "noisy" rows by default for the same
reason: its default role set is `[type, call, member, import]` — **omitting
`var`** — with the rationale (code_symbols_in.md):

> "import was separated from var specifically so that 'drop the noisy locals'
> … `var` is a local variable, parameter, or assignment target — hoverable
> but rarely worth learning about."

`code_outline` is the same product decision waiting to happen, applied to
`Constant`/`Variable` SymbolKinds instead of the tree-sitter `var` role.

## Candidate fix (not implemented)

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
  mirroring `code_symbols_in`'s `roles: ["var"]` escape hatch. This
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
- The `code_symbols_in` precedent shows this default-drop + opt-in pattern
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

## Decision needed

- Drop both top-level AND nested constants/variables, or only top-level?
- Cross-language default, or TS/JS-only?
- Check ccls behavior for C++ constants before deciding the cross-language
  default.
- Confirm the `include_variables` opt-in name/shape (mirror `code_symbols_in`
  `roles`, or a simpler boolean?).
