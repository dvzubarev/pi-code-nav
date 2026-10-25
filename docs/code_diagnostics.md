# `code_diagnostics` — pull first, event-driven push fallback

> Implementation notes for the diagnostics tool (`nav.ts` `diagnostics()`,
> `lsp-client.ts` push cache + event-driven wait). Reports errors/warnings for
> a Python, C/C++, or Bash file.

## TypeScript/JavaScript: use the compiler CLI

`code_diagnostics` rejects all TypeScript/JavaScript extensions before acquiring
an LSP client. Other navigation tools remain supported. The error includes a
copyable shell command for the target file's project, for example:

```bash
cd '/path/to/project' && npx tsc --noEmit --pretty false -p tsconfig.json
```

The nearest ancestor `tsconfig.json` is used, starting at the target file's
directory, not the session cwd. This lookup is only for CLI guidance; it does
not change the LSP workspace-root policy. With no config, the command names the
file explicitly and uses compiler defaults (`--allowJs --checkJs` for JavaScript,
`--jsx preserve` for JSX/TSX). Paths are shell-quoted. The command is suggested,
not executed. Projects with custom configs or build scripts may prefer their
own type-check command. Project checks intentionally cover more than one file;
passing a source file to tsc would bypass the project's config.

Why not push fallback? typescript-language-server suppresses repeated empty
diagnostic sets. After a clean-to-clean edit, clearing our stale cache and
waiting for a fresh publication therefore times out even though analysis has
finished. Keeping the stale cache or interpreting silence as clean could hide
errors. Rather than add a server-specific diagnostics protocol, use tsc.

## The contract: one call → one result string

The user-facing tool contract is **synchronous**: the agent calls
`code_diagnostics(path)`, waits, and gets the result back. The user
explicitly rejected an asynchronous push-notification collection exposed
outside the tool ("No async bullshit from notifications from the lsp server").
The tool itself may wait synchronously for the one notification that completes
its request.

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
reject the pull request (bash-language-server, ccls), the tool
falls back to an **event-driven** wait on the push model: `openDocument` →
(for cpp, via `ensureDocumentReady`) the ccls pipeline poll →
`LspClient.waitForPushedDiagnostics()`.
It resolves when the server pushes `textDocument/publishDiagnostics` for that
URI, with a generous **60-second deadline**. It also resolves if the language
server exits or shuts down, preventing a dead or live-but-silent process from
leaving a dangling waiter.
The push cache (`diagnosticsByUri` in `LspClient`) is latest-wins per URI,
populated by a `textDocument/publishDiagnostics` handler installed in
`start()`. Before refreshing a changed document, the old cache entry must be
cleared **before** sending the notification: a fast server may publish during
the awaited write, and clearing afterward would erase the fresh result and
force the caller to wait until its 60-second deadline. Most servers are
refreshed with `didChange`; ccls uses `didClose` + `didOpen` so it rebuilds the
translation unit preamble and sees simultaneous edits to included headers.

## Retry server-cancelled pulls before considering push

A concurrent `didOpen` or `didChange` can invalidate ty's in-flight analysis,
causing `textDocument/diagnostic` to fail with LSP `ServerCancelled` (`-32802`)
and `data: { retriggerRequest: true }`. This is an explicit request to retry,
not evidence that pull diagnostics are unsupported. Waiting for push instead
used to stall the tool for 60 seconds and then fail because ty uses pull.

`diagnostics()` retries that exact code/data combination up to **four total
attempts**, backing off **25/50/100ms** between attempts so a burst of document
syncs can settle. Each tool call has its own retry budget; retries neither
reopen the document nor serialize other calls. An exhausted cancellation budget
is a hard diagnostics-unavailable error immediately, with no push wait. Other
errors (including cancellation without `retriggerRequest: true`) retain the
existing push fallback, as does a null pull result.

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

The new flow waits on ccls's authoritative pipeline state and then on the diagnostic notification:

1. **Indexing done** — the cpp readiness policy (`ensureDocumentReady`
   delegating to `CppProjectReadiness`) polls ccls's `$ccls/info`
   request, whose `pipeline.completed` and `pipeline.enqueued` counters expose
   the actual indexing queue. It requires two stable idle samples so the final
   queued database update reaches ccls's query database. This is deliberately
   not based solely on `$/progress`: ccls emits no `begin`/`end` pair when a
   batch contains only one translation unit, even if that TU spends seconds
   parsing the C++ standard library. Warm caches return after a 25ms
   confirmation; cold projects wait exactly until all queued work completes.
   `code_diagnostics` does this first for cpp, so the subsequent push wait is
   not racing the indexer.
2. **Push diagnostics** — `LspClient.waitForPushedDiagnostics(uri)` registers
   a per-URI resolver in `diagnosticWaiters` and resolves it from
   the `textDocument/publishDiagnostics` handler the moment a set arrives
   for that URI (returning a cached snapshot immediately if one is already
   present, covering the "already published during didOpen round-trip" race).
   On server exit/shutdown `resetPushState()` resolves dangling waiters with
   `undefined` so the tool falls through to the honest pull-error path
   instead of hanging or timing out.

For Bash there is no cpp-style indexing barrier, so the tool waits directly
for publication. The 60-second deadline is a safety bound for a live server
that never publishes.

## The push fallback is gated on a client capability we must advertise

typescript-language-server gates its ENTIRE diagnostics flow on
`Boolean(clientCapabilities.textDocument.publishDiagnostics)` (cli.mjs:
`diagnosticsSupport = Boolean(publishDiagnostics)`). Without that cap it
sends *zero* `publishDiagnostics` notifications no matter how long you wait
— the server silently does nothing. `LspClient.start()` advertises
`textDocument.publishDiagnostics: { versionSupport: false }` in client caps
so push servers can opt in (TypeScript diagnostics are nevertheless excluded
from the tool, as explained above). This is harmless to
pyright/ty (they ignore the field and answer pull anyway).

## Do NOT gate on advertised SERVER capabilities

Capability advertisement for the pull model is unreliable across the servers
we support, verified empirically:

| Server | Advertises `diagnosticProvider`? | `textDocument/diagnostic` works? | Push fallback used? |
| --- | --- | --- | --- |
| ty (Astral) | yes | yes (returns diagnostics; retriggerable cancellation is retried) | no (pull works) |
| pyright-langserver | **no** | **yes** (answers anyway) | no (pull works) |
| ccls | no | no (rejected) | yes (event-driven, after indexing) |
| bash-language-server | no | no (rejected: "Unhandled method") | yes (event-driven) |
| typescript-language-server | no | no (rejected: "Unhandled method") | not supported; use tsc CLI |

`LspClient.supportsPullDiagnostics()` exists as introspection (it reads
`ServerCapabilities.diagnosticProvider`) but the tool does **not** pre-gate
on it — pyright would be wrongly rejected if it did. The tool tries pull
first; on rejection it falls back to the event-driven push wait. If the server
terminates before publishing, it surfaces both facts as a hard error. This is
more accurate than trusting advertised capabilities.

## Success and failure messages

An empty pull diagnostic list or an empty push notification is authoritative
and renders `(no diagnostics for <path>)`. A rejected pull request alone is
not evidence that the file is clean. Except for exhausted retriggerable
cancellations (above), the tool waits up to 60 seconds for the push. If no
notification arrives before then (including when the server terminates), it
returns a hard error that names both failures, for example:

```
bash: diagnostics unavailable for src/example.sh: the server does not support pull diagnostics (Unhandled method textDocument/diagnostic); push diagnostics were not received within 60 seconds
```

This means diagnostics could not be obtained—not that the file has no issues.

## Rendering

`renderDiagnostic` (in `render.ts`) prints 1-based `path:line:col` (the
diagnostic range start, +1 from 0-based LSP), severity name
(`error`/`warning`/`info`/`hint`), optional `source` and `(code)`, and the
message. Output positions are reusable as `line`/`column` input to
`code_hover`/`code_definition`/`code_references`, matching the round-trip
contract of the other tools. Both pull and push diagnostics render through
the same path (`renderDiagnostics` in `src/diagnostics.ts`).

The list renderer deduplicates entries within a single server response, not just
across servers. Groups retain first-seen order and match by full range,
severity, source, code (including its type), and message. Repeated entries show
`[N occurrences]`; the header counts displayed groups and includes the original
reported count whenever compaction occurs. The server's cached diagnostics are
never mutated.

For **ccls only**, a message's blank-line-separated suffix is recognized as
Clang context only when *every* paragraph has a `path:line:column: severity:`
shape (including the newline-before-`note:` variant). Such diagnostics group by
the primary message and union their distinct context notes, printed once each
under the group. Template-instantiation notes are not discarded or truncated.
An info diagnostic is folded into a primary only when both sides agree: the
primary embeds that info's position/message in the requested file, and the info
embeds the primary's position/severity/message. Standalone info diagnostics and
unrecognized multiline messages remain visible. This turns ccls's repeated
warning + instantiation-info chains into grouped warnings with unique notes,
without treating arbitrary multiline messages from other servers as duplicates.
