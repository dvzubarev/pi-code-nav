# IMPL — `index.ts` / `lsp-client.ts` integration invariants

> Cross-cutting implementation invariants for the pi-extension glue layer
> (`index.ts`) and its integration with the LSP client. LSP transport and
> protocol landmines live in `lsp.md`; design rationale in `DESIGN.md`;
> per-tool details in `code_*.md`.

# Pi stuff
## Tool registration is deferred and must stay deferred

`registerTools()` is only called from the `enable()` function, which is only
called from the `/code-nav` command handler. At `session_start` we register
**only the slash commands** (`code-nav`, `code-nav:off`, `code-nav:status`) and
the `session_shutdown` cleanup hook. The `code_*` tools do not exist until
`/code-nav` runs. This is the on-demand loading the user asked for (see
`DESIGN.md` "Two additional user constraints").

`pi.registerTool` refreshes tools immediately in-session (no `/reload`
needed), so the LLM sees them on the very next turn after `/code-nav`. Do not
move `registerTools()` into `session_start` — that defeats the entire point.

`/code-nav:off` calls `pi.setActiveTools(active.filter(t => !t.startsWith("code_")))`
to hide the tools, then `pool.shutdownAll()`, then nulls `state`. The tools
remain *registered* (you can't unregister per the pi API) but are *inactive*
and invisible to the LLM. Re-running `/code-nav` re-registers them (the
`registeredToolNames` dedup pattern from `dynamic-tools.ts` isn't needed here
because we null `state`; re-enable creates a fresh pool).

## System-prompt block: `before_agent_start` (gated on enabled)

A `before_agent_start` handler is registered at load (always present) and
appends `CODE_NAV_PROMPT_BLOCK` to the system prompt — but **only when
`state.pool.enabled()` is true AND a `code_*` tool is in the active set.**
Otherwise it returns `{}` (no-op). This is the one place the agent gets a
*grouped* view of the tools (entry points vs detail tools) plus the
"prefer code_* over grep/read" reframing.

Why `before_agent_start` and not `promptGuidelines`? `promptGuidelines` are
appended **flat** to the Guidelines section with no tool-name grouping (see
pi docs), so they can't express the two-group framing or the old-vs-new table.
Per-tool `promptGuidelines` stay for tool-specific gotchas (the third-party rg
workflow in `code_scan`, batching in `code_definition`, etc.); the system-prompt
block carries the *structural* overview that flat bullets can't. The block is
~30 lines — acceptable because it's gated on `/code-nav` (the user opted in).

Do not ungate it (no appending when `enabled()` is false — that would spam
every session). Do not move it into `registerTools()` — the handler must be
registered at load so it's present before the first turn after `/code-nav`.

# API impl
## Scalar `(path, line, column)` input — no `positions` array

`code_definition`, `code_hover`, and `code_references` each take a **scalar**
`(path, line, column)` — one symbol per call. There is NO `positions` array
form (the earlier batching design was dropped: one body/result per call
keeps the output clean and the schema simple — no XOR validation between a
scalar triple and an array). (The logic lives in `nav.ts`; both `index.ts`
and `scripts/nav-cli.mjs` call it.)

`code_outline`, `code_search_symbol`, and `code_rename` are inherently
single-symbol-per-call and also take scalar params (rename is destructive;
outline/symbol are already list-shaped).

## Error handling: a two-tier contract

The `code_*` tools give the agent a machine-readable success/failure bit
instead of having to regex-sniff inline prose. This contract is implemented
in `index.ts`'s `err()` (which catches hard throws and sets `isError: true`)
and in the tool bodies in `nav.ts`:

  - **HARD failures** (top-level, single-file tools: outline/tree/definition/
    rename/scan/diagnostics) THROW. `index.ts`'s `err()` catches and sets
    `isError: true`. Covers: `Cannot read …`, `Unknown language for file: …`,
    `Invalid regexp`, `No grammar for …`, `parse failed: …`, bad params,
    server unavailable, no definition found, could not resolve body range,
    pull-diagnostics request failed. (Multiple definitions is NOT a failure —
    it's reported as data: one block per site.) The CLI lets these throw to a
    top-level `FAILED:` message.
  - **SOFT failures** (per-position in the batched tools: references/hover;
    per-language in symbol) are emitted as a structured row
    `ERROR  <path>:<line>:<col>  <reason>` (or `ERROR  [lang]  <reason>` for
    symbol) that parses with the SAME column grammar as a data row. The
    leading `ERROR` token distinguishes them from data; a consumer splits
    rows on `\n` and checks the first token. The `### <path>:<line>:<col>`
    position header is preserved (when batching) so the agent can attribute
    the failure.

Clean empty results (`(no symbols found in …)`, `(no diagnostics for …)`,
`(no identifiers found)`, `(no references found for …)`) are NOT failures —
they're returned as text. NOTE: `code_definition` is the exception — its
contract is "return verbatim source code", so even a clean "no definition
found" is a HARD failure there (no source code to return).

### Per-tool output contracts (scalar input — one symbol per call)

`hover`, `definition`, and `references` each take a **single** `(file line
col)` triple — one symbol per call (no batching; see `DESIGN.md` "Scalar
input"). `definition` returns the verbatim source body of the symbol: a
header line `<defPath>:<sl>-<el>` (1-based inclusive line range of the body)
then the raw source lines (no code fence). A position may resolve to
MULTIPLE definition sites (overloads, header-vs-source, re-exports) — that's
reported as one block per site (each with the same `<defPath>:<sl>-<el>`
header + body, blank-line-separated) plus a trailing
`# N definitions for <inPath>:<line>:<col>` count; a single-site result has
no separator and no count. It THROWS on any failure (no definition found,
cannot resolve body, etc.) — the contract is "source code or a hard error",
no fallbacks. `hover` and `references` emit a structured `ERROR` row on
recoverable failures (unknown language, cannot read, server unavailable); a
clean empty result (no references / no hover info) is a parenthesized note.


# User configuration
## Config: `.pi/lsp.json` merge order

`loadConfig` reads `<cwd>/.pi/lsp.json` then `~/.pi/lsp.json` and merges
per-lang (later = wins, so project overrides global). Each lang's override is
a `Partial<ServerConfig>` shallow-merged over the built-in defaults;
`initOptions` is merged one level deep
(`{...base.initOptions, ...ov.initOptions}`). Do not deep-merge further — the
user's overrides should be able to *replace* a nested key like
`compilationDatabaseDirectory` without surgery.

## The init options match the user's Emacs config — don't drift

These are not arbitrary defaults; they mirror:
```elisp
(setq ccls-initialization-options
      `(:cache (:directory ,(concat (getenv "HOME") "/.cache/ccls-pi"))
               :compilationDatabaseDirectory "build"))
(setq lsp-pyright-multi-root nil
      lsp-pyright-use-library-code-for-types t)
```
If the user updates their Emacs config, update `DEFAULTS` in `lsp-client.ts`
to match, and note it here. The `$HOME` in the ccls cache dir is resolved at
spawn time (`process.env.HOME`) — keep that dynamic, don't hardcode.
