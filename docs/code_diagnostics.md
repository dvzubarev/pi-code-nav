# `code_diagnostics` — pull first, bounded push fallback

> Implementation notes for the diagnostics tool (`nav.ts` `diagnostics()`,
> `lsp-client.ts` push cache). Reports errors/warnings for a file.

## The contract: one call → one result string

The user-facing tool contract is **synchronous**: the agent calls
`code_diagnostics(path)`, waits, and gets the result back. The user
explicitly rejected an *open-ended* push-notification collection ("No async
bullshit from notifications from the lsp server"). Do NOT convert this to an
unbounded notification collector the tool waits on unpredictably — that's
the async collection the user rejected.

## The design: pull first, push fallback

LSP has two diagnostics flows:
- **Pull** (`textDocument/diagnostic`, LSP 3.17): the client sends a request
  for a specific document and the server returns that document's diagnostic
  set in the response. One request → one response.
- **Push** (`textDocument/publishDiagnostics`): the server sends a
  notification whenever it finishes analyzing a document. The client
  collects diagnostics into a per-URI map and reads them later.

The pull model is the natural fit for the synchronous contract — but only
pyright/ty answer the pull request (see table below). For servers that
reject the pull request (tsserver, bash-language-server, ccls), the tool
falls back to a **bounded** read of the push cache: `openDocument` → poll
`LspClient.getPushedDiagnostics()` for up to ~1.2s → render. The push cache
(`diagnosticsByUri` in `LspClient`) is latest-wins per URI, populated by a
`textDocument/publishDiagnostics` handler installed in `start()`. It is NOT
an open-ended collector the tool waits on unpredictably — the poll has a
fixed ~1.2s budget (tsserver's diagnostics delayer is 300-800ms by line
count; ccls publishes after indexing).

## The push fallback is gated on a client capability we must advertise

typescript-language-server gates its ENTIRE diagnostics flow on
`Boolean(clientCapabilities.textDocument.publishDiagnostics)` (cli.mjs:
`diagnosticsSupport = Boolean(publishDiagnostics)`). Without that cap it
sends *zero* `publishDiagnostics` notifications no matter how long you wait
— the server silently does nothing. `LspClient.start()` advertises
`textDocument.publishDiagnostics: { versionSupport: false }` in client caps
precisely so tsserver/bash-language-server/ccls opt in. This is harmless to
pyright/ty (they ignore the field and answer pull anyway).

## Do NOT gate on advertised SERVER capabilities

Capability advertisement for the pull model is unreliable across the servers
we support, verified empirically:

| Server | Advertises `diagnosticProvider`? | `textDocument/diagnostic` works? | Push fallback used? |
| --- | --- | --- | --- |
| ty (Astral) | yes | yes (returns diagnostics) | no (pull works) |
| pyright-langserver | **no** | **yes** (answers anyway) | no (pull works) |
| ccls | no | no (rejected) | yes (after indexing) |
| bash-language-server | no | no (rejected: "Unhandled method") | yes |
| typescript-language-server | no | no (rejected: "Unhandled method") | yes |

`LspClient.supportsPullDiagnostics()` exists as introspection (it reads
`ServerCapabilities.diagnosticProvider`) but the tool does **not** pre-gate
on it — pyright would be wrongly rejected if it did. The tool tries pull
first; on rejection it falls back to the push cache; if the push cache is
also empty after the budget, it surfaces the pull error honestly. This is
more accurate than trusting advertised capabilities.

## Rendering

`renderDiagnostic` (in `render.ts`) prints 1-based `path:line:col` (the
diagnostic range start, +1 from 0-based LSP), severity name
(`error`/`warning`/`info`/`hint`), optional `source` and `(code)`, and the
message. Output positions are reusable as `line`/`column` input to
`code_hover`/`code_definition`/`code_references`, matching the round-trip
contract of the other tools. Both pull and push diagnostics render through
the same path (`renderDiagnostics` in `nav.ts`).

## tsserver's lazy project load (a prerequisite)

typescript-language-server does NOT implement the pull model. It also does
not load a project until the first `didOpen` of a file in that project — so
diagnostics for a never-opened file won't appear until `openDocument` primes
the push cache (which `code_diagnostics` does before polling).
