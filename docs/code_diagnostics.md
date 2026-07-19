# `code_diagnostics` — pull first, event-driven push fallback

> Implementation notes for the diagnostics tool (`nav.ts` `diagnostics()`,
> `lsp-client.ts` push cache + event-driven wait). Reports errors/warnings for
> a file.

## The contract: one call → one result string

The user-facing tool contract is **synchronous**: the agent calls
`code_diagnostics(path)`, waits, and gets the result back. The user
explicitly rejected an *open-ended* push-notification collection ("No async
bullshit from notifications from the lsp server"). Do NOT convert this to an
unbounded notification collector the tool waits on unpredictably — that's
the async collection the user rejected.

## The design: pull first, event-driven push fallback

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
falls back to an **event-driven** wait on the push model: `openDocument` →
(for cpp) `waitForIndexingComplete()` → `LspClient.waitForPushedDiagnostics()`.
It resolves the instant the server actually pushes
`textDocument/publishDiagnostics` for that URI, bounded by a timeout (5s for
tsserver/bash, 30s for ccls after indexing). The push cache
(`diagnosticsByUri` in `LspClient`) is latest-wins per URI, populated by a
`textDocument/publishDiagnostics` handler installed in `start()`. It is NOT
an open-ended collector the tool waits on unpredictably — the wait resolves
on a real notification (or the budget), and the budget is an upper bound
chosen per language, not the expected duration.

## Why event-driven, not a fixed-budget poll

An earlier implementation polled `getPushedDiagnostics()` on a fixed ~1.2s
budget. That was far too short for **ccls**: ccls rejects the pull model AND
publishes `publishDiagnostics` for a file only once its translation unit has
compiled — which on a cold cache happens DURING whole-project indexing
(often 10-60s for a project like DiskANN). The poll returned nothing mid-
index and the tool surfaced the misleading pull error:

```
cpp: textDocument/diagnostic request failed: unknown request textDocument/diagnostic
```

The new flow is event-driven on both signals ccls already emits:

1. **Indexing done** — ccls reports whole-project indexing via the LSP
   work-done-progress protocol: it sends a `window/workDoneProgress/create`
   SERVER request to register its "index" token, then `$/progress`
   `begin`/`report`/`end` notifications on that token. `LspClient.start()`
   advertises `window.workDoneProgress` and answers the create request so
   ccls emits the progress. `waitForIndexingComplete()` blocks until "end"
   (cold cache) or a short no-begin timeout (warm cache / tiny project).
   `code_diagnostics` calls this FIRST for cpp, so the subsequent push wait
   isn't racing the indexer.
2. **Push diagnostics** — `LspClient.waitForPushedDiagnostics(uri, ms)`
   registers a per-URI resolver in `diagnosticWaiters` and resolves it from
   the `textDocument/publishDiagnostics` handler the moment a set arrives
   for that URI (returning a cached snapshot immediately if one is already
   present, covering the "already published during didOpen round-trip" race).
   On server exit/shutdown `resetPushState()` resolves dangling waiters with
   `undefined` so the tool falls through to the honest pull-error path
   instead of hanging or timing out.

For non-cpp push servers (tsserver, bash-language-server) there is no
project-wide index, so the indexing wait is skipped and the tool waits
event-drivenly for the publish (5s budget — tsserver's diagnostics delayer
is 300-800ms by line count; the wait resolves the moment the publish lands).

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
| ccls | no | no (rejected) | yes (event-driven, after indexing) |
| bash-language-server | no | no (rejected: "Unhandled method") | yes (event-driven) |
| typescript-language-server | no | no (rejected: "Unhandled method") | yes (event-driven) |

`LspClient.supportsPullDiagnostics()` exists as introspection (it reads
`ServerCapabilities.diagnosticProvider`) but the tool does **not** pre-gate
on it — pyright would be wrongly rejected if it did. The tool tries pull
first; on rejection it falls back to the event-driven push wait; if no push
arrives within the budget, it surfaces the pull error honestly. This is more
accurate than trusting advertised capabilities.

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
the push cache (which `code_diagnostics` does before the event-driven push
wait).
