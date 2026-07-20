/**
 * code_references — all references to the symbol at (path, line, column).
 * Output is one reference location per line (`<path>:<line>:<col>`, grep-style)
 * plus a trailing `# N references` count. A clean empty result is a
 * parenthesized note, NOT an error.
 *
 * Recoverable failures (unknown language, cannot read, server unavailable)
 * are emitted as a structured `ERROR  <path>:<line>:<col>  <reason>` row —
 * the leading `ERROR` token distinguishes them from data rows. See
 * docs/code_references.md.
 */

import { readFile } from "node:fs/promises";
import type { LspClient } from "./lsp-client";
import { awaitReadyForQuery, ClientProvider } from "./nav-core";
import { langForFile, renderErrorRow, renderLocation, toAbs } from "./render";

export interface ReferencesParams {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
}

export async function references(
    params: ReferencesParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) {
        return renderErrorRow(params.path, params.line, params.column, `unknown language for file`);
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        return renderErrorRow(
            params.path,
            params.line,
            params.column,
            `${lang}: server unavailable: ${e}`,
        );
    }
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        return renderErrorRow(params.path, params.line, params.column, `cannot read ${abs}: ${e}`);
    }
    // Wait for ccls to finish indexing this TU before querying references.
    // On a cold cache, textDocument/references can miss cross-TU call sites
    // until indexing finishes. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const refs = await client.references(abs, params.line - 1, params.column - 1, text);
    if (refs.length === 0) {
        // Clean empty result (the symbol has no references) — NOT a failure.
        // Kept as a parenthesized note (matching outline/diagnostics/scan's
        // empty-result convention) rather than an ERROR row, so an agent
        // checking the leading token doesn't mistake a legitimate "unused
        // symbol" for a failure.
        return `(no references found for ${params.path}:${params.line}:${params.column})`;
    }
    const rendered = refs.map((r) => renderLocation(r));
    // Drop the leading "N reference(s):" count line — it was prose the agent
    // had to strip to get the list. A trailing comment line (# N references)
    // is trivially ignorable while keeping the count for the few callers that
    // want it.
    return rendered.join("\n") + `\n# ${rendered.length} references`;
}
