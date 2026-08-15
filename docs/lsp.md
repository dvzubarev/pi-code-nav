# LSP — landmines, invariants, and server notes

> Cross-cutting LSP transport and protocol landmines (mostly in
> `lsp-client.ts` and `render.ts`). Read before touching anything that calls
> the language servers. Per-server quirks are at the bottom.

## The vscode-jsonrpc RAL trap (this cost real time)

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
wired in). Do NOT use `ReadableStreamMessageReader` /
`WriteableStreamMessageWriter` from the common entry — they want the RAL's own
stream type and produce a type error against Node streams.

## LSP method calls: use string method names, not `.type` objects

`lsp-client.ts` calls e.g. `conn.sendRequest("textDocument/hover", {...})`,
not `conn.sendRequest(HoverRequest.type, {...})`. The `.type` ProtocolRequestType
objects in `vscode-languageserver-protocol` 3.18 have strict overloads that
fail to type-check against the 3.17-typed `MessageConnection` in some
configurations ("Types have separate declarations of a private property
'_parameterStructures'"). String method names go through the generic
`sendRequest(method: string, ...)` overload and are robust across versions.
This is deliberate; don't "fix" it by restoring the `.type` constants. The
`conn.onNotification("textDocument/publishDiagnostics", ...)` handler follows
the same rule.

## 1-based ↔ 0-based coordinate translation (and 1-based SymbolKind)

LSP lines/columns are **0-based**. All numeric tool parameters exposed to the
agent are **1-based** (the agent and pi's `read`/`edit` tools think in 1-based
lines). Detail tools either subtract one from the supplied column or resolve
`symbol` to its first exact occurrence on the line, then subtract one before
calling the LSP client. JavaScript string offsets are UTF-16, matching LSP. **Tool output is uniformly 1-based** — `renderDocSymbol`,
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
- `code_search_symbol` (`workspace/symbol`) resolves the identifier via a per-file
  `documentSymbol` lookup (cached for the call via `resolveSymbolSelStart`),
  falling back to a source-line scan for the symbol name. `renderSymbolInfo`
  takes an optional resolved `selStart` (0-based LSP coords) and prints it.

If a user reports that `code_search_symbol`/`code_outline` output doesn't
round-trip into `code_hover`/`code_definition`/`code_references`, check (a)
that `renderDocSymbol` still uses `selectionRange` not `range`, and (b) that
`resolveSymbolSelStart`'s `documentSymbol` lookup is matching (name + range
contains) — some servers return `SymbolInformation[]` from `documentSymbol`
when hierarchical support isn't advertised, in which case there is no
`selectionRange` and we fall back to a source-line scan.

### LSP `SymbolKind` is also 1-based

`symbolKindName(kind)` in `render.ts` uses a padded array with `""` at index 0
so that `names[12]` = "Function", `names[5]` = "Class", etc. The LSP
`SymbolKind` enum starts at 1 (`File=1`); a naive 0-based array is off-by-one
and labels everything wrong (kind 12 → "Variable" instead of "Function"). If
you copy the kind-name helper elsewhere (e.g. a CLI test harness), keep the
leading empty string. Verified against ty's raw output: `greet`=`kind:12`,
`Calc`=`kind:5` — correct.

## Server lifecycle — the exact invariants

- **`Lang` lives in the neutral catalog.** `src/languages/catalog.ts` declares
  the single `LANGUAGES` registry and derives `Lang` (re-exported type-only by
  `src/languages/types.ts`), `ALL_LANGS`, `SOURCE_EXTS`, `EXT_LANG`,
  `ROOT_MARKERS`, `DISPLAY_NAMES`, and `langForFile` from it — all
  transport-neutral. `lsp-client.ts` imports (and re-exports) `Lang` but no
  longer declares it. Adding a language is one edit to `LANGUAGES`, not a
  hand-synced union edit across four files.
- `ServerPool` holds `Map<Lang, LspClient>`, keyed by language only (cwd is
  fixed at pool construction, set to `ctx.cwd`).
- `LspClient.ensureReady()` is idempotent — it stores the ready promise and
  returns it on repeat calls. `start()` is only ever run once per client.
- Project-readiness tracking lives in `src/project-progress.ts`, behind the
  `ProjectReadiness` policy interface. `WorkDoneProgress` is the shared
  standard `$/progress` token tracker; each language/server pair has a policy:
  `TypeScriptProjectReadiness` (bootstrap didOpen + work-done begin/end),
  `CppProjectReadiness` (bootstrap didOpen + `$ccls/info` pipeline polling),
  `BashProjectReadiness` (BackgroundAnalysis log messages), and
  `TyProjectReadiness` (workspace/diagnostic + work-done end); a no-op policy
  covers pyright/custom servers. Selection is by resolved `serverKind`
  (`createProjectReadiness(serverKind)`) — a replacement command resolves to
  `custom` and thus never inherits a built-in server's quirks. Policies drive
  operations through the generic `ProjectHost` (`hasOpenDocuments`,
  `findBootstrapFile`, `openDocument`, `request`); `LspClient` constructs a
  host, wires protocol events into the selected policy, and delegates
  `ensureProjectLoaded`/`ensureDocumentReady` with no language branches.
- On server process exit (the `proc.on("exit")` handler), the client resets
  `ready = null` so a subsequent tool call will re-spawn. This matters: ccls
  can crash on malformed `compile_commands.json`, and the extension should
  self-heal rather than return errors forever.
- `shutdown()` is safe to call multiple times (guards on `conn`/`proc` null).
  It sends LSP `shutdown` request + `exit` notification, then SIGTERM as
  fallback. Race conditions on shutdown are tolerated (try/catch around the
  request — server may already be gone). It also calls `closeLog()` to remove
  the per-server stderr log file; the `proc.on("exit")` handler calls it
  too, and `closeLog()` is idempotent so the double-call is safe.
- **Per-server stderr logs.** When `LspClient` is constructed with a `logDir`
  (the extension passes `~/.pi/agent/logs/code-nav`; the CLI harness and tests
  omit it), each spawned server's stderr is teed to
  `<logDir>/<lang>-<pid>.log` and the file is removed on shutdown/exit. Named
  by PID so concurrent pi instances never collide. Stderr is ALSO surfaced
  via `console.error` (prefixed `[code-nav <lang>]`), so omitting `logDir`
  (the CLI/tests) is unchanged behavior. The log dir is created once per
  pool (`ensureState`) with `mkdirSync({ recursive: true })`.
- **No idle timeout.** The user explicitly said: "maybe shutdown it when
  session and extension is closed?" — so servers live for the whole session,
  not a 10-minute idle window. Do not add an idle timer "for resource
  cleanliness" without checking with the user; ccls re-indexing after a
  spurious shutdown is expensive.

## Server-specific notes

### Python server auto-detection (ty preferred, pyright fallback)

`resolveConfig("python")` in `src/lsp/server-config.ts` does NOT use the `DEFAULTS`
table for Python the way cpp/bash do. It branches: if the user set an explicit
`command` in `.pi/lsp.json`, that wins verbatim (so they can force pyright, or
pick basedpyright, etc.) and the config is marked `serverKind: "custom"`. Otherwise it calls `commandExists("ty")` and picks
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
it, which broke the `code_search_symbol` tool for Python until ty was added; (2) ty
reports standard LSP `SymbolKind` (12=Function, 5=Class) so `symbolKindName`
labels correctly, whereas pyright's kinds are non-standard and mislabel. ty
also uses the legacy `changes` field in `WorkspaceEdit` (not `documentChanges`)
for rename — `applyWorkspaceEdit` (see `code_rename.md`) handles both, so the
rename tool works with ty unchanged. If you add a server that uses neither
field, you'll need a third path.

**ty project readiness.** ty is incremental rather than an eager, standalone
indexer. Its whole-project operation is the standard `workspace/diagnostic`
request when `diagnosticMode: "workspace"`; while checking every project file,
ty reports standard work-done `$/progress` (`begin`, periodic `report`, `end`)
on the request's `workDoneToken`. The default ty config enables workspace
mode. Before the first Python action, `TyProjectReadiness` (selected at
`LspClient` construction from the resolved `serverKind`) sends one
`workspace/diagnostic` request and waits for either its work-done `end` or a
normal response. This populates ty's Salsa query cache before navigation.

A no-change `workspace/diagnostic` request may deliberately remain open as a
long poll after checking finishes. Therefore the response itself is not the
only completion barrier: the progress `end` is authoritative, and the pending
request is retained with a rejection handler until ty completes it on a later
change or shutdown. This warm-up is ty-only (recognized from the resolved `serverKind` in
`src/lsp/server-config.ts`); pyright and user-selected Python servers keep
their previous behavior.

### TypeScript server (typescript-language-server wrapping tsserver)

`resolveConfig("typescript")` uses the `TYPESCRIPT_CONFIG` entry directly (no
auto-detection — there is only one TS LSP server worth using; for Python's
ty/pyright auto-detection see `DESIGN.md`). One server instance covers all
TS/JS file kinds; the `languageId` sent in `didOpen` (`languageIdFor` in
`lsp-client.ts`) distinguishes them: `.ts` → `typescript`, `.tsx` →
`typescriptreact`, `.js` → `javascript`, `.jsx` → `javascriptreact`. Sending
the right id is what makes tsserver apply JSX rules for `.tsx`.

**tsserver loads projects lazily.** Unlike ccls/pyright/ty, which index the
workspace eagerly on `initialize`, tsserver does not load a project until the
first `didOpen` of a file in that project. `workspace/symbol` (tsserver's
`navto`) throws `"No Project."` if called before then. `code_search_symbol`
works around this with `LspClient.ensureProjectLoaded()`, which delegates to
`TypeScriptProjectReadiness`: if no document has been opened yet, it asks the
`ProjectHost` to scan the workspace root (skipping `node_modules`,
`build`, `dist`, `.git`, hidden dirs) for the first source file of the
server's language and open it.

`didOpen` alone is NOT a completion barrier: it is an LSP notification, and a
cold `workspace/symbol` sent immediately afterward can run while tsserver is
still loading the `tsconfig`, returning only symbols from the opened file (or
none). typescript-language-server translates tsserver's
`projectLoadingStart`/`projectLoadingFinish` events into standard LSP
work-done progress: a server-created UUID token followed by `$/progress`
`begin`/`end`. `TypeScriptProjectReadiness` records the work-done tracker
revision before the bootstrap open, waits briefly for that interval to start,
then waits for its end before allowing `workspace/symbol`. The generic token
tracker is shared transport machinery with ccls, but completion policy is
server-specific: TypeScript trusts the matching work-done `end`; ccls still
polls authoritative `$ccls/info` counters because it can omit progress for a
one-TU batch.

The warm-up is a no-op for other policies (the no-op policy returns true
immediately, and the Ty/Bash policies carry their own workspace barriers).
`code_outline`/
`code_hover`/`code_definition`/`code_references`/`code_rename` all open the
target document first, so they load the project naturally and don't need the
cold workspace-search barrier.

**Diagnostics via push fallback.** typescript-language-server does NOT
implement the LSP 3.17 `textDocument/diagnostic` pull model — see
`code_diagnostics.md`.

### Bash server background analysis

bash-language-server implements `workspace/symbol` and eagerly scans workspace
files after the client's `initialized` notification (default glob
`**/*@(.sh|.inc|.bash|.command)`, default cap 500). That scan is asynchronous:
the initialize handshake can complete before any project symbols have entered
the analyzer, so an immediate workspace query can incorrectly return `[]`.
It does not expose the scan through work-done progress. Its only
server-originated completion signal is the standard `window/logMessage`
notification whose message contains `BackgroundAnalysis: Completed`.

`LspClient` always registers a log-message handler before initialize, and
`BashProjectReadiness` is the only policy that observes it; `ensureProjectLoaded()`
waits for the completion log before Bash `workspace/symbol`. The start wait
is bounded because a user-selected server log level can suppress info
messages; once the start message is observed, a missing completion is a hard
project-load timeout. The Bash policy's state and handler do not touch the
TypeScript/ty work-done tracker or the ccls pipeline poll.

**Tree-sitter for `.tsx`/`.jsx` uses the `tsx` grammar, not `typescript`.**
See `code_scan.md`. `tsLangForFile` maps `.tsx`/`.jsx` → `tsx` and
`.ts`/`.js`/`.mts`/`.mjs`/`.cts`/`.cjs` → `typescript`. Because `tsx` is in
`TsLang` but not `Lang` (there is only one TS LSP server), `TsLang` is a
**superset** of `Lang`; `tsLangToLspLang` maps `tsx` → `typescript` so
`code_scan`'s `include_docs` enrichment spawns the right LSP client. Callers
that spawn an LSP client from a `tsLang` MUST go through `tsLangToLspLang`,
NOT a bare `tsLang as Lang` cast — that cast is only valid for
python/cpp/bash/typescript and would break for `tsx`.
