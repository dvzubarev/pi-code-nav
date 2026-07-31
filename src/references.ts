/**
 * code_references — all semantic references/usages of the symbol at
 * (path, line, column), including its declaration. Output is one location per
 * line (`<path>:<line>:<col>`) plus a trailing count. A clean empty result is
 * not an error; operational failures throw.
 */

import { readFile } from "node:fs/promises";
import type { LspClient } from "./lsp-client";
import {
    awaitReadyForQuery,
    ClientProvider,
    UnknownLanguageError,
    validatePosition,
} from "./nav-core";
import { langForFile, renderLocation, toAbs } from "./render";

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
    validatePosition(params.line, params.column);
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        throw new Error(`${lang}: server unavailable: ${e}`);
    }
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    // Wait for ccls to finish indexing this TU before querying references.
    // On a cold cache, cross-TU usages can be missing until indexing finishes.
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
