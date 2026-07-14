# AGENTS.md — code-nav

pi extension providing LSP-backed code navigation tools for the LLM.

## What this is

Nine tools the LLM can call after `/code-nav` enables them: `code_outline`,
`code_tree`, `code_definition`, `code_references`, `code_search_symbol`,
`code_rename`, `code_hover`, `code_scan` (tree-sitter),
`code_diagnostics` (LSP pull-first, push-fallback). Seven are backed by real
language servers (ccls/ty/pyright/bash-language-server/typescript-language-
server), one by in-process WASM tree-sitter, one is a diagnostic reporter.
Tool params are 1-based; LSP is 0-based — translation happens in the tool
layer.

## Files
See Quick orientation for the maintainer in docs/MAINTAINER.md

### Documentation strategy

The docs under `docs/` are split by **theme**, not by source file, so a
maintainer (human or agent) can load only what a task touches without
pulling the whole history into context, see **`MAINTAINER.md`** for more details.

## Development

```bash
nix develop          # devShell with node + language servers
npm install          # install node deps (once)
npm test             # unit tests (pure tree-sitter, no servers needed)
npm run test:e2e     # end-to-end tests (real language servers; needs servers on PATH)
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
