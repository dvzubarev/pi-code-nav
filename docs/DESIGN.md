# DESIGN — code-nav

> The requirements and design decisions that shaped this extension. Read
> this to understand *why* the code is the way it is before changing
> fundamental assumptions. Cross-cutting landmines live in `lsp.md`;
> `index.ts`/`lsp-client.ts` implementation invariants live in `IMPL.md`;
> per-tool details in `code_*.md`.

## Why this extension exists (the requirements that drove every decision)

The user wanted to give a pi coding agent "LSP powers" — but specifically these
six capabilities, no more, no less:

1. **outline** — file structure (functions, classes, methods) with *signatures*
   and enough position info to drive follow-up queries.
2. **definition** — the source code of a given symbol's definition.
3. **references** — all references to a given symbol.
4. **lookup symbol by name** — given a string, a ranked list of matching symbols
   across the workspace.
5. **rename symbol** — applied to disk automatically.
6. **lookup documentation** — docstrings / hover for a symbol. **This was the
   decisive requirement.** The user explicitly said the hover/docstring
   function was the whole point of not using a pure tree-sitter tool.

Supported languages: **Python, C++, bash (optional)** — in that priority order.
C++ uses **ccls** (the user's choice, not clangd). Python **auto-detects**:
**ty** (Astral, preferred — implements `workspace/symbol` which pyright does
not, and reports standard LSP SymbolKind) when on PATH, falling back to
**pyright**. Bash uses bash-language-server. TypeScript & JavaScript use
**typescript-language-server** (wrapping tsserver). All were installed on the
machine via nix.

### Why LSP and not tree-sitter

We evaluated, in order: `ast-grep` (has `outline` + JSON + even an LSP server —
excellent, but no semantic hover), `tree-sitter tags` (text only, no hover),
`universal-ctags` (definitions only), `tree-sitter-analyzer` (the user found
this; way over-engineered — MCP server + SQLite FTS5 + TOON format + verdict
envelopes + 13 skills; its "verbose" complaint was the trigger for this
project). Pure tree-sitter tools fail requirement #6: they can't produce
docstrings or type signatures. Only a real language server does hover. So LSP
it is. (`code_scan` DOES use tree-sitter in-process, but only for identifier
position discovery — not hover; see `code_scan.md`.)

### Why a pi extension and not a skill

Two hard constraints from the user made a skill insufficient:
- The agent needs **typed tool calls with structured results** — calling `bash`
  to drive an LSP CLI and parsing free text is unreliable for position math
  (LSP is 0-based; the agent thinks 1-based — easy to get wrong).
- **Server lifecycle must be managed for the model.** ccls indexes the whole
  project on startup (seconds to minutes for large C++); it must be spawned
  once per workspace and kept alive. The model cannot reliably
  "start server → initialize → wait for indexed → query." The extension does
  this in `session_start` / lazy-spawn-on-first-tool-call.

### Three additional user constraints that shaped the design

1. The user said this explicitly: "use ctx.cwd always." Do not "improve" this by
   walking up for `.git` / `compile_commands.json` / `pyproject.toml`. The user
   opens pi in the directory they mean. One server per `(ctx.cwd, language)`.

2. **"I manage LSP servers by myself; you should expect them running."**
   This *cannot* mean "connect to an already-running server over a socket" — I
   verified ccls, pyright-langserver, bash-language-server, and
   typescript-language-server are all **stdio-only** (ccls has no
   `--listen`/`--socket` flag; I checked `--help-hidden`). Once a stdio server
   is spawned its stdin/stdout are wired to that one client; nothing else can
   tap in. So "management" moved to **configuration**: the user controls
   *which* server, *which* init options, *whether* a language is enabled — via
   `.pi/lsp.json` and the built-in defaults (which mirror the user's Emacs
   config — see `IMPL.md`). The extension owns the process lifecycle but the
   user owns the policy. This is the only achievable interpretation given
   stdio-only servers; do not try to "fix" it by adding socket support — the
   servers don't support it.

3. **"Load on demand, not every session."** The tools are NOT registered at
   `session_start`. `/code-nav` registers them on demand (available to the LLM
   immediately, no `/reload` — confirmed in the pi docs: "New tools are
   refreshed immediately in the same session"). `/code-nav:off` disables them
   and shuts down all servers. Servers are also lazily spawned (first tool
   call, not at `/code-nav` time) and shut down on `session_shutdown`. **Most
   sessions pay zero cost.** This is intentional and must be preserved — see
   `IMPL.md` for the exact deferred-registration invariants.

## What I did NOT implement (and why)

These are deliberate design-scope decisions, not TODOs:

- **No completions tool.** Not requested, and completions are low-value for an
  agent (it writes code, it doesn't tab-complete).
- **No ccls hover-chaining.** Known quirk: ccls hover at a call site shows the
  *declaration's* comment, not the definition's. If the user reports hover
  showing the wrong comment for C++, the fix is in the `code_hover` tool:
  fetch `definition` first, then `hover` at the definition location, return
  both. ~5 lines. Not done yet because the user hasn't hit it; pyright doesn't
  have this problem.
- **No multi-root workspace support.** `ctx.cwd` is the single root, per the
  user's instruction (see `IMPL.md` "Workspace root"). pyright's
  `multiRoot: false` mirrors this. (Adding third-party dirs as *extra*
  workspace folders for `code_search_symbol` is a different, scoped mechanism
  — see `code_search_symbol.md` — and does not change the single-root
  invariant for the project itself.)
