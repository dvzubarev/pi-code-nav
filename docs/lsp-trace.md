
## The LSP trace tool — `scripts/lsp-trace.mjs`

A reusable debug harness for tracing **raw JSON-RPC traffic** between the
client and a real language server. Use it when you need to see exactly what
messages the server sends (or doesn't send) — `$/progress` notifications,
`window/workDoneProgress/create` requests, `publishDiagnostics`, etc. — without
the `LspClient` abstraction filtering or consuming them.

**When to use it:**
- Diagnosing indexing wait issues (why does `ensureProjectLoaded` time out?)
- Verifying ccls's `$/progress` begin/report/end sequence for a fixture
- Debugging why `workspace/symbol` returns empty for a cold cache
- Investigating server-specific behavior (init options, capabilities, timing)

**How it works:** spawns a real server using the same config as `LspClient`
(`resolveConfig` from `src/lsp-client.ts`), performs the full initialize
handshake with identical capabilities and `initializationOptions`, and enables
`vscode-jsonrpc`'s built-in `Trace.Verbose` to log every sent/received message
with timestamps (elapsed ms from startup). Registers the same handlers as
`LspClient` (`textDocument/publishDiagnostics`, `window/workDoneProgress/create`,
`$/progress`) and prints them as structured events.

**Auto-generates `build/compile_commands.json`** before initialize when it
doesn't exist — ccls reads it during init to start project-wide indexing.
Without it, ccls only indexes the file opened via `didOpen` (no `$/progress`
notifications, no multi-TU `workspace/symbol` results).

**Usage:** positional args are consumed sequentially as commands (chaining):

```bash
# Observe what ccls sends during cold indexing of a fixture:
node scripts/lsp-trace.mjs cpp --root /tmp/foo open blackjack.cpp

# Open, wait for indexing, then query:
node scripts/lsp-trace.mjs cpp --root /tmp/foo open blackjack.cpp symbol drawCard

# Just observe background traffic for 5s after handshake:
node scripts/lsp-trace.mjs cpp --root /tmp/foo idle 5000

# Hover a symbol (requires a file to be open first):
node scripts/lsp-trace.mjs cpp --root /tmp/foo open blackjack.cpp hover blackjack.cpp 212 22

# Use test/fixtures directly (auto-generates compile_commands.json):
node scripts/lsp-trace.mjs cpp --root test/fixtures/ open blackjack.cpp symbol drawCard

# Print the resolved initializationOptions (check ccls config):
node scripts/lsp-trace.mjs cpp initOptions
```

**Commands:**

| Command                          | Description                                                  |
|----------------------------------|--------------------------------------------------------------|
| `open <file>`                    | `textDocument/didOpen` + wait for `$/progress end` (15s max) |
| `symbol <query>`                 | `workspace/symbol` search                                    |
| `hover <file> <line> <col>`      | `textDocument/hover` (1-based)                               |
| `definition <file> <line> <col>` | `textDocument/definition` (1-based)                          |
| `references <file> <line> <col>` | `textDocument/references` (1-based)                          |
| `idle <ms>`                      | Wait, observing background traffic                           |
| `initOptions`                    | Print resolved `initializationOptions` and exit              |

**Reading the output:** lines prefixed with `[<elapsed>ms]` are the tool's
structured events. Lines prefixed with `[ccls]` are the server's stderr log.
`TRACE` lines show every JSON-RPC message (sent/received) with truncated
params/results. `PROGRESS` / `PROGRESS-CREATE` / `WAIT-PROGRESS` lines show
the `$/progress` state machine. `CMD` lines show the command being executed.

**Difference from `nav-cli.mjs`:** `nav-cli.mjs` exercises the *rendered
output* of the nav tools (what the agent sees). `lsp-trace.mjs` exercises the
*transport layer* (what the server sends/receives). Use `nav-cli.mjs` to debug
tool rendering; use `lsp-trace.mjs` to debug server behavior.
