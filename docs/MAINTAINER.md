# MAINTAINER NOTES — code-nav

> Notes for the future maintainer (most likely future-me). Read this before
> touching `index.ts` or `lsp-client.ts`. The README is for users; this file is
> for you.

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
it is.

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

### Two additional user constraints that shaped the design

1. **"I manage LSP servers by myself; you should expect them running."**
   This *cannot* mean "connect to an already-running server over a socket" — I
   verified ccls, pyright-langserver, bash-language-server, and
   typescript-language-server are all **stdio-only** (ccls has no
   `--listen`/`--socket` flag; I checked `--help-hidden`). Once a stdio server is spawned its stdin/stdout are wired
   to that one client; nothing else can tap in. So "management" moved to
   **configuration**: the user controls *which* server, *which* init options,
   *whether* a language is enabled — via `.pi/lsp.json` and the built-in
   defaults (which mirror the user's Emacs config). The extension owns the
   process lifecycle but the user owns the policy. This is the only achievable
   interpretation given stdio-only servers; do not try to "fix" it by adding
   socket support — the servers don't support it.

2. **"Load on demand, not every session."** The six tools are NOT registered at
   `session_start`. `/code-nav` registers them on demand (available to the LLM
   immediately, no `/reload` — confirmed in the pi docs: "New tools are
   refreshed immediately in the same session"). `/code-nav:off` disables them
   and shuts down all servers. Servers are also lazily spawned (first tool call,
   not at `/code-nav` time) and shut down on `session_shutdown`. **Most
   sessions pay zero cost.** This is intentional and must be preserved.

### Workspace root is always `ctx.cwd`

The user said this explicitly: "use ctx.cwd always." Do not "improve" this by
walking up for `.git` / `compile_commands.json` / `pyproject.toml`. The user
opens pi in the directory they mean. One server per `(ctx.cwd, language)`.

## What's important to know as maintainer

### The vscode-jsonrpc RAL trap (this cost real time)

`vscode-jsonrpc` 8.x has a Runtime Abstraction Layer (RAL) that must be
installed for the Node environment before *any* stream reader/writer works.
Symptom: `Error: No runtime abstraction layer installed` thrown from
`ReadableStreamMessageReader` the moment you construct it.

The trap: `vscode-languageserver-protocol` bundles its *own* nested copy of
`vscode-jsonrpc` (under
`node_modules/vscode-languageserver-protocol/node_modules/vscode-jsonrpc/`).
That nested copy's RAL is NOT auto-installed when you import from the protocol
package's default entry (`lib/common/api.js`). Importing from
**`vscode-languageserver-protocol/node`** instead resolves to
`lib/node/main.js`, which does `require("vscode-jsonrpc/node")` →
`lib/node/main.js` → which calls `RIL.install()` as a side effect at module
load. That's why `lsp-client.ts` imports everything from
`vscode-languageserver-protocol/node` (not the bare `vscode-languageserver-protocol`).

**Do not change that import source to the bare package "to simplify."** It will
break at runtime with the RAL error and you'll spend an hour rediscovering this.
If you ever add a second file that touches jsonrpc directly, import from the
node subpath there too, or factor a single import barrel.

The stream wrappers: use `StreamMessageReader` / `StreamMessageWriter` from
the node entry — they accept `NodeJS.ReadableStream` / `WritableStream`
directly (the node RAL's `asReadableStream`/`asWritableStream` adapters are
wired in). Do NOT use `ReadableStreamMessageReader` / `WriteableStreamMessageWriter`
from the common entry — they want the RAL's own stream type and produce a
type error against Node streams.

### LSP method calls: use string method names, not `.type` objects

`lsp-client.ts` calls e.g. `conn.sendRequest("textDocument/hover", {...})`,
not `conn.sendRequest(HoverRequest.type, {...})`. The `.type` ProtocolRequestType
objects in `vscode-languageserver-protocol` 3.18 have strict overloads that
fail to type-check against the 3.17-typed `MessageConnection` in some
configurations ("Types have separate declarations of a private property
'_parameterStructures'"). String method names go through the generic
`sendRequest(method: string, ...)` overload and are robust across versions.
This is deliberate; don't "fix" it by restoring the `.type` constants.

### 1-based ↔ 0-based coordinate translation

LSP lines/columns are **0-based**. All tool parameters exposed to the agent
are **1-based** (the agent and pi's `read`/`edit` tools think in 1-based
lines). Every tool does `params.line - 1` / `params.column - 1` before calling
the LSP client. **Tool output is uniformly 1-based** — `renderDocSymbol`,
`renderSymbolInfo`, and `renderLocation` all add 1 to the 0-based coords the
server returns, so a position printed by one tool can be fed directly back
into another tool's `line`/`column` params with no manual conversion.

**Positions point at the symbol's identifier, not the enclosing range.** This
matters because `workspace/symbol` (`SymbolInformation`) only returns
`location.range` — the full symbol extent, whose start is column 0 of the
enclosing line and does NOT resolve in `hover`/`definition`/`references` on
servers like ty (only the identifier position does). So:
- `code_outline` (`documentSymbol`) prints `selectionRange.start` (the
  identifier span), not `range.start`.
- `code_symbol` (`workspace/symbol`) resolves the identifier via a per-file
  `documentSymbol` lookup (cached for the call via `resolveSymbolSelStart`),
  falling back to a source-line scan for the symbol name. `renderSymbolInfo`
  takes an optional resolved `selStart` (0-based LSP coords) and prints it.

If a user reports that `code_symbol`/`code_outline` output doesn't round-trip
into `code_hover`/`code_definition`/`code_references`, check (a) that
`renderDocSymbol` still uses `selectionRange` not `range`, and (b) that
`resolveSymbolSelStart`'s `documentSymbol` lookup is matching (name + range
contains) — some servers return `SymbolInformation[]` from `documentSymbol`
when hierarchical support isn't advertised, in which case there is no
`selectionRange` and we fall back to a source-line scan.

### Server lifecycle — the exact invariants

- `ServerPool` holds `Map<Lang, LspClient>`, keyed by language only (cwd is
  fixed at pool construction, set to `ctx.cwd`).
- `LspClient.ensureReady()` is idempotent — it stores the ready promise and
  returns it on repeat calls. `start()` is only ever run once per client.
- On server process exit (the `proc.on("exit")` handler), the client resets
  `ready = null` so a subsequent tool call will re-spawn. This matters: ccls
  can crash on malformed `compile_commands.json`, and the extension should
  self-heal rather than return errors forever.
- `shutdown()` is safe to call multiple times (guards on `conn`/`proc` null).
  It sends LSP `shutdown` request + `exit` notification, then SIGTERM as
  fallback. Race conditions on shutdown are tolerated (try/catch around the
  request — server may already be gone).
- **No idle timeout.** The user explicitly said: "maybe shutdown it when
  session and extension is closed?" — so servers live for the whole session,
  not a 10-minute idle window. Do not add an idle timer "for resource
  cleanliness" without checking with the user; ccls re-indexing after a
  spurious shutdown is expensive.

### Tool registration is deferred and must stay deferred

`registerTools()` is only called from the `enable()` function, which is only
called from the `/code-nav` command handler. At `session_start` we register
**only the slash commands** (`code-nav`, `code-nav:off`, `code-nav:status`) and
the `session_shutdown` cleanup hook. The six `code_*` tools do not exist until
`/code-nav` runs. This is the on-demand loading the user asked for.

`pi.registerTool` refreshes tools immediately in-session (no `/reload`
needed), so the LLM sees them on the very next turn after `/code-nav`. Do not
move `registerTools()` into `session_start` — that defeats the entire point.

`/code-nav:off` calls `pi.setActiveTools(active.filter(t => !t.startsWith("code_")))`
to hide the tools, then `pool.shutdownAll()`, then nulls `state`. The tools
remain *registered* (you can't unregister per the pi API) but are *inactive*
and invisible to the LLM. Re-running `/code-nav` re-registers them (the
`registeredToolNames` dedup pattern from `dynamic-tools.ts` isn't needed here
because we null `state`; re-enable creates a fresh pool).

### The `applyWorkspaceEdit` function — handle with care

This applies LSP `WorkspaceEdit` results to disk. It handles both
`documentChanges` (preferred, modern) and `changes` (legacy `{ uri: TextEdit[] }`).
It does NOT handle `CreateFile` / `DeleteFile` / `RenameFile` resource
operations inside `documentChanges` — it skips them (they're reported but not
applied). For rename this is fine (rename produces text edits, not file ops,
except in edge cases like renaming a file's lone top-level symbol in some
servers). **If you add rename-for-files support, you'll need to handle these.**

The text-edit math sorts edits in **reverse line order** so earlier offsets
stay valid as we splice. Edits are applied in-memory (line array) then written
once. LSP ranges are 0-based. I verified this against a real pyright rename
that produced 3 edits (1 def + 2 refs) → all 3 applied correctly to disk.

Edge case: multi-line `newText` (replacement containing newlines) is handled
via `replacement.split(/\r?\n/)` and re-joining with `head + replacement[0]`
and `tail` on the last segment. Single-line edits take the else branch. If
you touch this, re-test with a multi-line replacement — the splice logic is
fiddly.

### Config: `.pi/lsp.json` merge order

`loadConfig` reads `<cwd>/.pi/lsp.json` then `~/.pi/lsp.json` and merges per-lang
(later = wins, so project overrides global). Each lang's override is a
`Partial<ServerConfig>` shallow-merged over the built-in defaults; `initOptions`
is merged one level deep (`{...base.initOptions, ...ov.initOptions}`). Do not
deep-merge further — the user's overrides should be able to *replace* a nested
key like `compilationDatabaseDirectory` without surgery.

### What I did NOT implement (and why)

- **No completions tool.** Not requested, and completions are
  low-value for an agent (it writes code, it doesn't tab-complete).
- **No ccls hover-chaining.** Known quirk (see that SO thread in the
  research): ccls hover at a call site shows the *declaration's* comment, not
  the definition's. If the user reports hover showing the wrong comment for
  C++, the fix is in the `code_hover` tool: fetch `definition` first, then
  `hover` at the definition location, return both. ~5 lines. Not done yet
  because the user hasn't hit it; pyright doesn't have this problem.
- **No multi-root workspace support.** `ctx.cwd` is the single root, per the
  user's instruction. pyright's `multiRoot: false` mirrors this.

### `code_diagnostics` — design notes (the pull model, not push)

There are now eight tools; `code_diagnostics` was added later than the original
seven. It reports errors/warnings for a file.

**The pull model is the only design, deliberately.** LSP has two diagnostics
flows:
- *Push* (`textDocument/publishDiagnostics`): the server sends a
  notification whenever it finishes analyzing a document. The client collects
  diagnostics into a per-URI map and reads them later. This is **async** — the
  server publishes on its own schedule, and the client must keep a notification
  handler around to gather results over time.
- *Pull* (`textDocument/diagnostic`, LSP 3.17): the client sends a request
  for a specific document and the server returns that document's diagnostic set
  in the response. One request → one response.

The user-facing tool contract is synchronous: the agent calls
`code_diagnostics(path)`, waits, and gets the result back. The user explicitly
rejected the push-notification approach ("No async bullshit from
notifications from the lsp server"). So `code_diagnostics` uses the **pull
model only**: `openDocument` (required for the server to analyze the file) →
`textDocument/diagnostic` request → render the response. There is NO
`publishDiagnostics` handler and NO per-URI notification cache anywhere in
`lsp-client.ts` or `index.ts`. Do not add one — it would reintroduce the async
collection the user rejected.

**Do NOT gate on advertised capabilities.** Capability advertisement for the
pull model is unreliable across the servers we support, verified empirically:

| Server               | Advertises `diagnosticProvider`? | `textDocument/diagnostic` works? |
| -------------------- | ------------------------------- | ------------------------------- |
| ty (Astral)          | yes                             | yes (returns diagnostics)        |
| pyright-langserver   | **no**                          | **yes** (answers anyway)          |
| ccls                 | no                              | no (rejected)                    |
| bash-language-server | no                              | no (rejected: "Unhandled method")|
| typescript-language-server | no                        | no (rejected: "Unhandled method")|

`LspClient.supportsPullDiagnostics()` exists as introspection (it reads
`ServerCapabilities.diagnosticProvider`) but the tool does **not** pre-gate
on it — pyright would be wrongly rejected if it did. The tool sends the
request and lets the server's actual response decide: a server that can't
answer returns a JSON-RPC error, which the tool surfaces honestly
(`bash: textDocument/diagnostic request failed: Unhandled method ...`).
TypeScript is the same (`typescript: textDocument/diagnostic request failed:
Unhandled method ...`). This is more accurate than trusting advertised
capabilities.

**`ccls` note.** ccls rejects the pull request. If C++ diagnostics become
important, the only synchronous option for ccls is the pull model (which it
lacks) — you'd have to either (a) switch C++ to clangd (which implements the
pull model) via `.pi/lsp.json`, or (b) reconsider the user's no-push-policy
for C++ specifically (not recommended). Do not silently fall back to a
publishDiagnostics cache; that violates the synchronous contract.

`renderDiagnostic` in `index.ts` (and its mirror in `nav-cli.mjs`) prints
1-based `path:line:col` (the diagnostic range start, +1 from 0-based LSP),
severity name (`error`/`warning`/`info`/`hint`), optional `source` and
`(code)`, and the message. Output positions are reusable as `line`/`column`
input to `code_hover`/`code_definition`/`code_references`, matching the
round-trip contract of the other tools.

### Testing what's here

The smoke tests were deleted after verification (they hardcoded `/tmp` paths
and imported the bare `.ts` via node's `--experimental-strip-types`, which
can't resolve the pi package outside jiti). To re-test:
1. Write a small `.py` file, then run a node script that imports
   `./lsp-client.ts` (with `--experimental-strip-types`) and calls
   `ensureReady` + `documentSymbols` + `hover`. This works standalone because
   `lsp-client.ts` only depends on the two npm packages, not on pi.
2. To test the full extension including tools, use pi RPC:
   `printf '{"type":"get_commands"}' | pi --mode rpc --no-session` and
   grep for `code-nav`. The tools themselves can only be exercised by the
   LLM after `/code-nav`, so a real test means enabling in a session and
   asking the model to call `code_outline` on a file.
3. `tsc -p tsconfig.json` should always exit 0 before you commit. The
   tsconfig has `paths` mapping `@earendil-works/pi-coding-agent` and
   `typebox` to the global pi install — these paths are **machine-specific**
   (they point under `/home/denin/.npm-local/lib/...`). If you move machines
   or the pi install moves, fix the `paths` in `tsconfig.json`. The runtime
   (jiti) resolves these differently so the extension still loads even if
   tsc can't find types — but keep tsc green.

### The CLI test harness — `lsp-nav-cli-testing/nav-cli.mjs`

There is now a dedicated CLI harness that exercises the six tool wrappers
**without pi or an LLM**, so you can see exactly what text an agent would
receive from each `code_*` tool. It imports `lsp-client.ts` directly and
re-implements the rendering helpers from `index.ts` in plain JS. **It must
stay a precise mirror of `index.ts`'s output formatting** — that is its whole
point ("I want to know what is fed to an agent"). If you change rendering in
`index.ts` (`renderLocation`, `hoverText`, `renderDocSymbol`, the `###`
headers, the source-snippet extraction, `applyWorkspaceEdit`), make the same
change in `nav-cli.mjs` and vice versa. The one allowed divergence is error
handling: the extension pushes `(unknown language for file: …)` / `(cannot
read …)` into the result text and returns a non-error result; the CLI may
throw for unrecoverable CLI-usage errors (missing args) since it's a
human-facing tool.

Subcommands (root = cwd or `CODE_NAV_ROOT`):
```
  outline <file>
  hover <file> <line:1> <col:1> [<file> <line> <col> ...]
  definition <file> <line:1> <col:1> [<file> <line> <col> ...]
  references <file> <line:1> <col:1> [<file> <line> <col> ...]
  rename <file> <line:1> <col:1> <newName>
  symbol <query> [python|cpp|bash]
```
`hover`/`definition`/`references` accept **one or more** `(file line col)`
triples — the extras are batched through one LSP client per language. This
mirrors the optional `positions` array the `code_definition`/`code_hover`/
`code_references` tools now accept in `index.ts` (see "Batched positions"
below). When more than one position is passed, each result block is prefixed
with `### <path>:<line>:<col>` so the agent/user can correlate results to
inputs. Single-position calls produce identical output to the old form (no
header) — so an agent that always passes the scalar form sees no change.

### Batched positions (`positions` array parameter)

`code_definition`, `code_hover`, and `code_references` accept an **optional**
`positions` array in addition to the scalar `path`/`line`/`column`. If
`positions` is non-empty it is used verbatim; otherwise the scalar form is
wrapped into a one-element list. This lets the agent batch several symbol
lookups in a single tool call — one round-trip instead of N — which is
meaningfully cheaper for the model and for the server (one client per
language, documents opened once). The scalar form remains supported so
existing prompts and agents don't break.

**Do not remove the scalar `path`/`line`/`column` parameters** — they are the
common case and keep the tool ergonomic for a single lookup. The array is the
escape hatch for batching. The `code_outline`, `code_symbol`, and
`code_rename` tools are inherently single-symbol-per-call and do **not** take
a `positions` array (rename is destructive; outline/symbol are already
list-shaped).

### Dependencies — do not bump without reading

- `vscode-jsonrpc@^8.2.1` — the RAL/stream behavior described above is
  specific to 8.x. A 9.x release (if one ships) could change the RAL install
  story. Re-test the RAL error path after any bump.
- `vscode-languageserver-protocol@^3.17.5` (resolved to 3.18.2 at install
  time) — the `.type` overload breakage is why we use string method names.
  A 3.19+ release might fix the overloads; even so, string calls are fine.
- `web-tree-sitter@^0.26.10` — the WASM tree-sitter runtime, used by
  `code_symbols_in` (via `tree-sitter-parse.ts`). Bump deliberately: if
  `Language.load` throws "incompatible language version" after a bump, the
  grammar WASMs (from `tree-sitter-wasm`) need a matching build — bump both
  together. `Parser.init()` must be called once before constructing a
  `Parser`; `tree-sitter-parse.ts` caches the init promise and per-language
  `Language` objects. Re-test the snippet-parse cases (python body, C++ body,
  the comment/string noise snippet) after any bump — those are the cases that
  motivated choosing tree-sitter over regex.
- `tree-sitter-wasm@^1.1.2` — prebuilt grammar WASMs
  (`out/{python,cpp,bash,typescript,tsx}/`). `getWasmPath(lang)` resolves the
  absolute path via `import.meta.url` (works under jiti). Large package (~144 MB
  unpacked, all grammars bundled); if size ever matters, vendor only the five
  needed `.wasm` files and drop the dep. Must stay ABI-compatible with
  `web-tree-sitter` (see above). Note: `.tsx`/`.jsx` MUST use the `tsx` grammar
  — the `typescript` grammar mis-parses JSX (`<Card>` becomes `type_arguments`,
  `{value}` an `object`), which would misclassify JSX element names as `type`.
- `@types/node@^22` (devDep, for tsc only — not needed at runtime, jiti
  doesn't type-check).
- `typescript@^5.9.3` (devDep) — added so `npm run check` (which runs
  `tsc -p tsconfig.json --noEmit`) works. Not needed at runtime.

### Python server auto-detection (ty preferred, pyright fallback)

`resolveConfig("python")` in `lsp-client.ts` does NOT use the `DEFAULTS`
table for Python the way cpp/bash do. It branches: if the user set an explicit
`command` in `.pi/lsp.json`, that wins verbatim (so they can force pyright, or
pick basedpyright, etc.). Otherwise it calls `commandExists("ty")` and picks
`TY_CONFIG` if true, else `PYRIGHT_CONFIG`. Only the `command` field is
auto-detected; user `args`/`initOptions` overrides still merge over whichever
base was chosen.

`commandExists` is memoized (one `execSync` per command per process) and uses
`sh -c 'command -v <cmd>'`. It must use the **static `execSync` import** at the
top of the file — do NOT switch to `require("node:child_process")` inside the
function; that throws in ESM and the catch silently returns false, which makes
auto-detection always fall back to pyright even when ty is installed. (This
was a real bug; the ESM `require` issue is silent.)

Why prefer ty: (1) ty implements `workspace/symbol` — pyright returns `[]` for
it, which broke the `code_symbol` tool for Python until ty was added; (2) ty
reports standard LSP `SymbolKind` (12=Function, 5=Class) so `symbolKindName`
labels correctly, whereas pyright's kinds are non-standard and mislabel. ty
also uses the legacy `changes` field in `WorkspaceEdit` (not `documentChanges`)
for rename — `applyWorkspaceEdit` handles both, so the rename tool works with
ty unchanged. If you add a server that uses neither field, you'll need a
third path.

### TypeScript server (typescript-language-server wrapping tsserver)

`resolveConfig("typescript")` uses the `TYPESCRIPT_CONFIG` entry directly (no
auto-detection — there is only one TS LSP server worth using). One server
instance covers all TS/JS file kinds; the `languageId` sent in `didOpen`
(`languageIdFor` in `lsp-client.ts`) distinguishes them: `.ts` → `typescript`,
`.tsx` → `typescriptreact`, `.js` → `javascript`, `.jsx` → `javascriptreact`.
Sending the right id is what makes tsserver apply JSX rules for `.tsx`.

**tsserver loads projects lazily.** Unlike ccls/pyright/ty, which index the
workspace eagerly on `initialize`, tsserver does not load a project until the
first `didOpen` of a file in that project. `workspace/symbol` (tsserver's
`navto`) throws `"No Project."` if called before then. `code_symbol` works
around this with `LspClient.ensureProjectLoaded()`: if no document has been
opened yet, it scans the workspace root (skipping `node_modules`, `build`,
`dist`, `.git`, hidden dirs) for the first source file of the server's
language and opens it. This is a no-op for the other servers (they return
true immediately when `openDocs.size > 0` or when `lang !== "typescript"`).
`code_outline`/`code_hover`/`code_definition`/`code_references`/`code_rename`
all open the target document first, so they load the project naturally and
don't need `ensureProjectLoaded`.

**No pull diagnostics.** typescript-language-server does not implement the
LSP 3.17 `textDocument/diagnostic` pull model — it uses the push
`publishDiagnostics` model. `code_diagnostics` is pull-only (by design — see
the "code_diagnostics design notes" section and landmine #5 in AGENTS.md), so
it returns a `"Unhandled method textDocument/diagnostic"` error for TS files.
This is the same documented limitation as bash-language-server. Do NOT add
`publishDiagnostics` collection to "fix" this.

**Tree-sitter for `.tsx`/`.jsx` uses the `tsx` grammar, not `typescript`.**
The `typescript` tree-sitter grammar mis-parses JSX (`<Card>` becomes
`type_arguments`, `{value}` an `object`), which would misclassify JSX element
names as `type`. `tsLangForFile` maps `.tsx`/`.jsx` → `tsx` (a distinct
grammar in `tree-sitter-wasm`) and `.ts`/`.js`/`.mts`/`.mjs`/`.cts`/`.cjs` →
`typescript`. Because `tsx` is in `TsLang` but not `Lang` (there is only one
TS LSP server), `TsLang` is now a **superset** of `Lang`; `tsLangToLspLang`
maps `tsx` → `typescript` so `code_symbols_in`'s `include_docs` enrichment
spawns the right LSP client.

### LSP `SymbolKind` is 1-based

`symbolKindName(kind)` in `index.ts` uses a padded array with `""` at index 0
so that `names[12]` = "Function", `names[5]` = "Class", etc. The LSP
`SymbolKind` enum starts at 1 (`File=1`); a naive 0-based array is off-by-one
and labels everything wrong (kind 12 → "Variable" instead of "Function").
If you copy the kind-name helper elsewhere (e.g. a CLI test harness), keep the
leading empty string. Verified against ty's raw output: `greet`=`kind:12`,
`Calc`=`kind:5` — correct.

### The init options match the user's Emacs config — don't drift

These are not arbitrary defaults; they mirror:
```elisp
(setq ccls-initialization-options
      `(:cache (:directory ,(concat (getenv "HOME") "/.cache/ccls"))
               :compilationDatabaseDirectory "build"))
(setq lsp-pyright-multi-root nil
      lsp-pyright-use-library-code-for-types t)
```
If the user updates their Emacs config, update `DEFAULTS` in `lsp-client.ts`
to match, and note it here. The `$HOME` in the ccls cache dir is resolved at
spawn time (`process.env.HOME`) — keep that dynamic, don't hardcode.

## Quick orientation for the maintainer

- `lsp-client.ts` — `LspClient` class: spawn, initialize handshake, per-method
  wrappers, shutdown. Pure transport layer. No pi dependency. Testable in
  isolation with node + the two npm deps. Diagnostics: `supportsPullDiagnostics()`
  (capability introspection only — do not gate on it) and `pullDiagnostics(absPath)`
  (the LSP 3.17 textDocument/diagnostic request; throws if the server rejects
  the method). The client advertises `textDocument.diagnostic` capability in
  `initialize` so servers that gate on client caps will offer the pull model.
  There is NO `publishDiagnostics` handler in this file (the push model is
  deliberately unused — see "code_diagnostics — design notes" above).
- `index.ts` — `codeNavExtension(pi)`: registers the 3 slash commands + the
  `session_shutdown` hook at load; `registerTools()` (called only by
  `/code-nav`) registers the 8 LLM tools (6 LSP + `code_symbols_in` +
  `code_diagnostics`). `ServerPool` manages the per-language clients.
  `applyWorkspaceEdit` / `applyTextEdits` apply rename results to disk.
  Rendering helpers (`renderDocSymbol`, `renderSymbolInfo`, `renderLocation`,
  `hoverText`, `symbolKindName`, `renderDiagnostic` / `severityName` /
  `diagnosticMessage`) format LSP results into text the agent can read.
- `tree-sitter-parse.ts` — `parseSymbols(lang, {text, startLine, endLine, roles?})`
  parses a line range with WASM tree-sitter and returns a deduplicated symbol
  table (`SymbolEntry[]`: role + name + absolute 1-based line/column).
  `roles` defaults to all except `var` (`DEFAULT_SYMBOL_ROLES`).
  `renderSymbolTable` formats it; `hoverFirstLine` extracts the first
  substantive line of a hover for the `include_docs` label column.
  `tsLangForFile` maps extensions to `TsLang` (a superset of `Lang`: it has
  both `typescript` and `tsx`, while `Lang` has only `typescript` — the single
  TypeScript LSP server serves both via its `languageId`). `tsLangToLspLang`
  maps a `TsLang` to the `Lang` whose server answers it (`tsx` → `typescript`).
  Callers that spawn an LSP client from a `tsLang` (e.g. `code_symbols_in`'s
  `include_docs` enrichment) MUST go through `tsLangToLspLang`, NOT a bare
  `tsLang as Lang` cast — that cast is only valid for python/cpp/bash/typescript
  and would break for `tsx`. No pi
  dependency, no LSP dependency — pure tree-sitter. Testable in isolation
  with node + the two tree-sitter npm deps. **Unit tests live in `test/`**
  (`test/core.test.mjs` for cross-cutting behavior, `test/{python,cpp,bash}.test.mjs`
  for per-language role contracts); run `npm test`. They load this module
  through jiti (the same loader pi uses) so resolution matches production.
  When you change `classifyRole`, `renderSymbolTable`, or `hoverFirstLine`,
  update or add tests there — they pin the documented contracts in
  `docs/code_symbols_in.md` and catch the off-by-one / role-classification
  regressions that would silently break the `code_symbols_in` → `code_hover`
  round-trip.

Read `README.md` for the user-facing contract (commands, config, defaults).
This file is the "why" and the landmines; the README is the "what."
