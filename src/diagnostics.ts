/**
 * code_diagnostics — errors/warnings for a file, fetched on demand.
 *
 * Pure request/response: opens the document on the server (didOpen is required
 * for the server to analyze it), then tries the LSP 3.17 pull model
 * (textDocument/diagnostic). The push model (textDocument/publishDiagnostics)
 * is the fallback for servers that reject the pull request
 * (typescript-language-server, bash-language-server, ccls). The push wait is
 * event-driven (blocks on the actual notification, not a fixed poll budget).
 *
 * Capability advertisement is unreliable: pyright implements
 * textDocument/diagnostic but does NOT advertise diagnosticProvider, while
 * bash-language-server rejects the method with a JSON-RPC error. So we do NOT
 * gate on supportsPullDiagnostics() — we send the request and let the server's
 * actual response (or error) decide. See docs/code_diagnostics.md.
 */

import { readFile } from "node:fs/promises";
import type { Diagnostic } from "vscode-languageserver-protocol";
import type { Lang, LspClient } from "./lsp-client";
import { awaitReadyForQuery, ClientProvider, UnknownLanguageError } from "./nav-core";
import { langForFile, renderDiagnostic, toAbs } from "./render";

export interface DiagnosticsParams {
    path: string;
}

export async function diagnostics(
    params: DiagnosticsParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the file at all. Throw so index.ts's err()
        // sets isError: true — the agent gets a machine-readable failure bit
        // instead of an inline string indistinguishable from a data row.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        // Hard failure: the language server could not be spawned.
        throw new Error(`${lang}: server unavailable: ${e}`);
    }
    // Open the document on the server and (for cpp) wait for ccls to finish
    // indexing this TU. didOpen is required for the server to analyze the
    // file; both the pull model (textDocument/diagnostic) and the push model
    // (textDocument/publishDiagnostics) operate on opened documents. The cpp
    // indexing wait is best-effort (see awaitReadyForQuery); the push
    // fallback below no longer needs to repeat it. Idempotent (openDocument
    // dedupes by URI).
    await awaitReadyForQuery(lang, client, abs, text);
    // Try the pull model first (LSP 3.17 textDocument/diagnostic). We do NOT
    // pre-gate on supportsPullDiagnostics(): pyright answers without
    // advertising diagnosticProvider, while bash-language-server rejects with
    // a JSON-RPC "Unhandled method" error. The request itself is the source
    // of truth: a server that can't answer returns an error we fall back
    // from (below) rather than trusting advertised capabilities.
    let diags: Diagnostic[] | null | undefined;
    let pullError: Error | null = null;
    try {
        diags = await client.pullDiagnostics(abs);
    } catch (e) {
        pullError = e instanceof Error ? e : new Error(String(e));
    }
    // FALLBACK: push model (textDocument/publishDiagnostics). Servers that reject
    // the pull model (typescript-language-server, bash-language-server, ccls)
    // still emit publishDiagnostics notifications after didOpen, but only if the
    // client advertised textDocument.publishDiagnostics in initialize (which
    // LspClient.start() does). This wait is now EVENT-DRIVEN: instead of polling
    // the push cache on a fixed ~1.2s budget (far too short for ccls, which
    // publishes only after whole-project indexing — often 10-60s on a cold
    // cache), we block on a promise that resolves the instant the server
    // actually pushes diagnostics for this URI. The contract stays
    // synchronous (one bounded wait → one result); it is NOT an open-ended
    // notification collector.
    //
    // For cpp specifically, ccls publishes publishDiagnostics for a file only
    // once its translation unit has compiled — which on a cold cache happens
    // DURING whole-project indexing. We already waited for indexing to
    // complete above (awaitReadyForQuery, event-driven via ccls's $/progress
    // "end"), so the push is ready to arrive; here we just wait for it. This
    // is the user's "wait while it is ready" ask: the tool no longer times
    // out mid-index and surfaces a misleading pull-error.
    if (pullError || diags === null) {
        // cpp indexing was already waited for above (awaitReadyForQuery), so
        // ccls's publishDiagnostics (which fires only after the TU compiles)
        // is now ready to arrive. We just wait for the push.
        const pushed = await client.waitForPushedDiagnostics(abs);
        if (pushed !== undefined) {
            // Push succeeded. If the push cache is ALSO empty but pull rejected,
            // mention the pull failure so the user can tell a clean file from a
            // silent server.
            if (pushed.length === 0 && pullError) {
                return `(no diagnostics for ${params.path}; pull model rejected: ${pullError.message})`;
            }
            return renderDiagnostics(params.path, pushed);
        }
        // No push diagnostics arrived either - surface the pull error honestly.
        if (pullError) {
            // Hard failure: the pull request errored AND no push diagnostics
            // arrived — the server cannot report diagnostics for this file.
            throw new Error(
                `${lang}: textDocument/diagnostic request failed: ${pullError.message}`,
            );
        }
        return `(no diagnostics returned for ${params.path})`;
    }
    return renderDiagnostics(params.path, diags as Diagnostic[]);
}

/** Shared renderer for the diagnostic list (pull or push origin). */
function renderDiagnostics(path: string, diags: Diagnostic[]): string {
    if (diags.length === 0) {
        return `(no diagnostics for ${path})`;
    }
    const lines = diags.map((d) => renderDiagnostic(path, d));
    return `${diags.length} diagnostic(s) for ${path}:\n` + lines.join("\n");
}
