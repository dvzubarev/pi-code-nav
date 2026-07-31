# MAINTAINER NOTES — code-nav

> Read `DESIGN.md` and `lsp.md` before touching `index.ts` or `src/lsp-client.ts`.

## Quick orientation for the maintainer

- `src/lsp-client.ts` — `LspClient` class: spawn, initialize handshake, per-method
  wrappers, shutdown. Pure transport layer. No pi dependency. Testable in
  isolation with node + the two npm deps. Diagnostics: `supportsPullDiagnostics()`
  (capability introspection only — do not gate on it) and `pullDiagnostics(absPath)`
  (the LSP 3.17 textDocument/diagnostic request; throws if the server rejects
  the method). The client advertises BOTH `textDocument.diagnostic` (pull) and
  `textDocument.publishDiagnostics` (push) capabilities in `initialize`. The
  push cap is REQUIRED for typescript-language-server, which gates its whole
  diagnostics flow on `Boolean(clientCaps.textDocument.publishDiagnostics)`.
  A `conn.onNotification("textDocument/publishDiagnostics", ...)` handler
  (string method name, per `lsp.md`) populates `diagnosticsByUri` (latest-
  wins per URI); `getPushedDiagnostics(absPath)` reads a snapshot of it for the
  `code_diagnostics` push fallback. See `lsp.md` and `code_diagnostics.md`.
- `index.ts` — `codeNavExtension(pi)`: registers the 3 slash commands + the
  `session_shutdown` hook + the `before_agent_start` system-prompt hook at
  load; `registerTools()` (called only by `/code-nav`) registers the 7 LLM
  tools. `ServerPool` manages the per-language clients. `CODE_NAV_PROMPT_BLOCK`
  is the grouped tool overview the `before_agent_start` hook appends to the
  system prompt while enabled. `applyWorkspaceEdit` / `applyTextEdits` (in
  `src/render.ts`) apply rename results to disk — see `code_rename.md`. Rendering
  helpers live in `src/render.ts`. Integration invariants in `IMPL.md`.
- `src/render.ts` — pure rendering + small helpers (no pi, no LSP, no fs beyond
  readFile/writeFile in the WorkspaceEdit applier): `symbolKindName`,
  `renderDocSymbol`, `renderSymbolInfo`, `renderLocation`, `renderDiagnostic`,
  `hoverText`, `hoverSignature`, `resolveDefBodyRange`, `resolveSymbolSelStart`,
  `applyWorkspaceEdit`, `langForFile`, `EXT_LANG`. Shared verbatim by
  `index.ts`, the CLI harness, and the e2e tests — this is what killed the
  old "keep nav-cli.mjs in sync with index.ts by hand" landmine.
- `src/nav.ts` — barrel re-exporting eight implementations (seven registered
  agent tools plus the internal `scan`) and the shared `ClientProvider` / `ALL_LANGS` / `UnknownLanguageError` (from
  `src/nav-core.ts`) and project-language detection (from `src/detect.ts`).
  `index.ts` and the tests/CLI import the tools via `./src/nav` so they don't
  need to know about the per-tool file split.
- `src/nav-core.ts` — shared core for every tool: `ClientProvider`, `ALL_LANGS`,
  `UnknownLanguageError`, and `awaitReadyForQuery` (openDocument + ccls
  indexing wait, deduplicated across tools).
- `src/detect.ts` — project language detection (`detectProjectLanguages`,
  memoized per root; `clearDetectedLanguagesCache`) used by `code_search_symbol`
  so the per-language workspace/symbol loop only spawns servers that can find
  a project here.
- `src/<tool>.ts` — one file per implementation: `outline.ts`,
  `definition.ts`, `references.ts`, `symbol.ts`, `rename.ts`, `hover.ts`,
  `scan.ts`, `diagnostics.ts`. Each exports a plain async function
  `(params, cwd, clientOf) => text` and its `*Params` interface. No pi
  dependency; takes a `ClientProvider` (`(lang) => LspClient`) instead of
  `ServerPool`. `index.ts` and `scripts/nav-cli.mjs` call the same exported
  implementations via `src/nav.ts`; `scan` is exercised only by the CLI/tests
  and `code_definition(list_symbols=true)`, not registered as an agent tool.
- `src/tree-sitter-parse.ts` — `parseSymbols()` parses a line range with WASM
  tree-sitter, returns a deduplicated symbol table. No pi or LSP dependency.
  See `code_scan.md`.
- `test/` — unit tests for `src/tree-sitter-parse.ts` (pure tree-sitter, no
  servers, `*.test.mjs`) + end-to-end tests for the nav tools (real language
  servers, `*.e2e.mjs`). Run `npm test` (unit) / `npm run test:e2e` (e2e).
- `scripts/nav-cli.mjs` — CLI harness exercising the tools without pi/LLM.
  Thin argv-parser around the nav tools (via `src/nav.ts`, no duplicated
  logic).

## Testing

- **Unit tests** (`npm test`, `test/*.test.mjs`): pure tree-sitter,
  no servers, no pi. Pin `classifyRole` per language, the default role set,
  dedup, position math, and the `renderSymbolTable` / `hoverFirstLine`
  formats. Load `tree-sitter-parse.ts` through jiti.
- **End-to-end tests** (`npm run test:e2e`, `test/*.e2e.mjs`): real language
  servers. Call the `nav.*` tool implementations through real `LspClient`s
  scoped to a temp workspace with fixture files — the EXACT code path
  `index.ts` uses. Skip automatically when a server isn't on PATH (see
  `serverAvailable` in `test/e2e-helpers.mjs`).
- **Full extension (commands register)**: `printf '{"type":"get_commands"}' |
pi --mode rpc --no-session | grep code-nav`. The tools themselves are best
  exercised by the LLM after `/code-nav`, or by `npm run test:e2e`.
- `tsc -p tsconfig.json` should always exit 0 before you commit. The
  tsconfig has `paths` mapping `@earendil-works/pi-coding-agent` and
  `typebox` to the global pi install — these paths are **machine-specific**
  (they point under `/home/denin/.npm-local/lib/...`). If you move machines
  or the pi install moves, fix the `paths` in `tsconfig.json`. The runtime
  (jiti) resolves these differently so the extension still loads even if
  tsc can't find types — but keep tsc green.

## Documentation strategy

- **`MAINTAINER.md` is the hub** — repository-level material (testing, CLI
  harness, dependencies, file orientation) plus a table pointing to the
  themed docs. Start there.
- **`DESIGN.md`** answers "why does this exist / why this shape" — requirements,
  the LSP-vs-tree-sitter and extension-vs-skill decisions, user constraints,
  and the deliberately-unimplemented features. Read before changing
  fundamental assumptions.
- **`lsp.md`** is the LSP layer — transport landmines (RAL, string method
  names), the 1-based↔0-based + SymbolKind coordinate story, server-lifecycle
  invariants, and per-server notes. Read before touching `src/lsp-client.ts` or
  anything that calls a language server.
- **`IMPL.md`** is the pi-extension glue — deferred tool registration, the
  `before_agent_start` system-prompt block, `.pi/lsp.json` config merge, and
  the two-tier error-handling contract. Read before touching `index.ts`.
- **`code_<tool>.md`** files hold per-tool implementation details (role
  taxonomy, node-types tables, dead-end design notes, capability tables).
  Read the relevant one before touching that tool's body in `src/<tool>.ts`.
- **`adding-a-language.md`** is a step-by-step checklist that cross-references
  the themed docs at each touch point.

When adding a new tool or a substantial per-tool behavior, create a
`code_<tool>.md` and add a row to the table in `MAINTAINER.md` plus the
`docs/` list above. Keep each doc self-contained — cross-reference by file

- section heading, don't duplicate prose. Landmines and "do NOT 'fix' this"
  notes are load-bearing; preserve them verbatim when moving text between
  files. Source files cite these docs by path + heading in comments — keep
  those citations accurate when you move or rename a section.

## The CLI test harness — `scripts/nav-cli.mjs`

A dedicated CLI harness exercises the tool implementations **without pi or an
LLM**, so you can see exactly what text an agent would receive from each
`code_*` tool. It is a THIN argv-parser around the nav tools (via `src/nav.ts`,
which `index.ts` also imports) — it does NOT re-implement any rendering or
tool logic. Both the extension and the CLI import from `src/render.ts` +
`src/nav.ts`, so they produce byte-identical output by construction. **The old
"keep nav-cli.mjs in sync with index.ts by hand" landmine is gone** — there is
nothing to mirror; if you change a render function or a tool body, both
consumers see it automatically.

The two-tier error-handling contract (HARD throws vs SOFT `ERROR` rows) and
the per-tool output contracts are documented in `IMPL.md`. CLI subcommands
(root = cwd or `CODE_NAV_ROOT`):

```
  outline <file> [offset:1-based] [limit]
  hover <file> <line:1> <col:1>
  definition <file> <line:1> <col:1> [--list-symbols]
  references <file> <line:1> <col:1>
  rename <file> <line:1> <col:1> <newName>
  symbol <query> [python|cpp|bash]
  scan <file> [<startLine:1> <endLine:1>] [--pattern <re>] [--docs] [--roles ...]
  diagnostics <file>
```

## Dependencies — do not bump without reading

- `vscode-jsonrpc@^8.2.1` — the RAL/stream behavior in `lsp.md` is specific
  to 8.x. A 9.x release (if one ships) could change the RAL install story.
  Re-test the RAL error path after any bump.
- `vscode-languageserver-protocol@^3.17.5` (resolved to 3.18.2 at install
  time) — the `.type` overload breakage is why we use string method names
  (see `lsp.md`). A 3.19+ release might fix the overloads; even so, string
  calls are fine.
- `web-tree-sitter@^0.26.10` — the WASM tree-sitter runtime, used by
  `code_scan` (via `src/tree-sitter-parse.ts`). Bump deliberately; see
  `code_scan.md`.
- `tree-sitter-wasm@^1.1.2` — prebuilt grammar WASMs
  (`out/{python,cpp,bash,typescript,tsx}/`). Must stay ABI-compatible with
  `web-tree-sitter`; bump both together. Large package (~144 MB unpacked, all
  grammars bundled); if size ever matters, vendor only the five needed `.wasm`
  files and drop the dep. See `code_scan.md`.
- `@types/node@^22` (devDep, for tsc only — not needed at runtime, jiti
  doesn't type-check).
- `typescript@^5.9.3` (devDep) — added so `npm run check` (which runs
  `tsc -p tsconfig.json --noEmit`) works. Not needed at runtime.
