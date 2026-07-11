# AGENTS.md — code-nav

pi extension providing LSP-backed code navigation tools for the LLM.

## What this is

Eight tools the LLM can call after `/code-nav` enables them: `code_outline`,
`code_definition`, `code_references`, `code_symbol`, `code_rename`,
`code_hover`, `code_symbols_in` (tree-sitter), `code_diagnostics` (LSP pull
model). Six are backed by real language servers (ccls/ty/pyright/
bash-language-server/typescript-language-server), one by in-process WASM
tree-sitter, one is a diagnostic reporter. Tool params are 1-based; LSP is
0-based — translation happens in the tool layer.

## Files

- `index.ts` — extension entry. Registers 3 slash commands
  (`/code-nav`, `/code-nav:off`, `/code-nav:status`) + `session_shutdown`
  hook at load; `registerTools()` (only called by `/code-nav`) registers the
  8 LLM tools. `ServerPool` manages per-language `LspClient` instances.
  Rendering helpers format LSP results into text. `applyWorkspaceEdit` writes
  rename results to disk.
- `lsp-client.ts` — `LspClient` class: spawn, initialize handshake, per-method
  wrappers, shutdown. Pure transport, no pi dependency. Imports from
  `vscode-languageserver-protocol/node` (NOT the bare package — see below).
- `tree-sitter-parse.ts` — `parseSymbols()` parses a line range with WASM
  tree-sitter, returns a deduplicated symbol table. No pi or LSP dependency.
- `test/` — unit tests for `tree-sitter-parse.ts` (pure tree-sitter, no LSP).
- `scripts/nav-cli.mjs` — CLI harness exercising the LSP tools
  without pi/LLM. Must mirror `index.ts` output formatting exactly.
- `docs/MAINTAINER.md` — the "why" behind every decision and the landmines.
  **Read before touching `index.ts` or `lsp-client.ts`.**
- `docs/code_symbols_in.md` — deep-dive on the tree-sitter tool.

## Critical landmines (do NOT "fix" these)

1. **Import from `vscode-languageserver-protocol/node`, never the bare
   package.** The bare package's nested jsonrpc copy doesn't install its RAL;
   the `/node` subpath does. Switching "to simplify" breaks runtime.
2. **Use string LSP method names** (`conn.sendRequest("textDocument/hover")`),
   not `.type` constants. The `.type` overloads fail type-check across
   protocol versions.
3. **Tool registration is deferred.** `registerTools()` runs only from the
   `/code-nav` command, not `session_start`. Most sessions pay zero cost.
4. **No idle timeout on servers.** ccls re-indexing is expensive; the user
   wants servers alive for the whole session.
5. **`code_diagnostics` is pull-model only.** No `publishDiagnostics`
   handler. Do not add push-notification collection.
6. **1-based ↔ 0-based translation.** All tool params are 1-based; every tool
   does `line - 1` / `column - 1` before calling LSP. Output is uniformly
   1-based so positions round-trip between tools.

## Development

```bash
nix develop          # devShell with node + language servers
npm install          # install node deps (once)
npm test             # unit tests (pure tree-sitter, no servers needed)
npm run check        # tsc --noEmit type-check
./install.sh         # symlink this dir into ~/.pi/agent/extensions/code-nav/
```

The tsconfig `paths` for `@earendil-works/pi-coding-agent`, `typebox`, and
`@earendil-works/pi-ai` point to the global pi install
(`/home/denin/.npm-local/lib/...`) — they are machine-specific. The runtime
(jiti) resolves these differently; tsc needs them for type-checking only.

## Installing

`./install.sh` symlinks this directory to `~/.pi/agent/extensions/code-nav/`.
Node deps live in `./node_modules`. Language servers are provided by the
user's project nix shell (ccls, ty, pyright, bash-language-server) — not
installed by this project.

## Dependencies

Runtime: `vscode-jsonrpc`, `vscode-languageserver-protocol` (LSP transport),
`web-tree-sitter`, `tree-sitter-wasm` (tree-sitter runtime + grammar WASMs).
Dev: `typescript`, `@types/node` (type-checking only). The pi packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`) are
bundled by pi — not installed locally, resolved from the global pi install.
