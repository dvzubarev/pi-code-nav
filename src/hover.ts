/**
 * code_hover — hover/documentation for a symbol selected by line plus column or name.
 * Output is signature-first: a `signature: <collapsed one-line signature>` line
 * (when one can be extracted), then the remaining hover content. The promoted
 * signature is removed from the body so bare and fenced server responses are
 * not duplicated. A clean empty result returns `(no hover information)`.
 *
 * Operational failures throw so index.ts can mark the tool result as an error.
 * A clean empty hover remains a normal parenthesized result.
 */

import { readFile } from "node:fs/promises";
import type { LspClient } from "./lsp-client";
import {
    awaitReadyForQuery,
    ClientProvider,
    type PositionSelector,
    resolvePositionColumn,
    UnknownLanguageError,
    validateLine,
} from "./nav-core";
import { hoverBodyWithoutSignature, hoverSignature, hoverText, langForFile, toAbs } from "./render";

export type HoverParams = {
    path: string;
    line: number; // 1-based
} & PositionSelector;

export async function hover(
    params: HoverParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    validateLine(params.line);
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
    const column = resolvePositionColumn(params, text);
    // Wait for ccls to finish indexing this TU before querying hover. On a
    // cold cache, textDocument/hover can return empty or partial signatures
    // until the file's preamble session is ready. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const h = await client.hover(abs, params.line - 1, column - 1, text);
    const body = hoverText(h);
    if (!h || body === "(empty hover)") return body;
    // Promote the signature to a cheap, labelled first line, then remove its
    // original bare line / fenced block from the body. Keep every remaining
    // doc or inferred-type section intact.
    const sig = hoverSignature(body);
    if (!sig) return body;
    const remainder = hoverBodyWithoutSignature(body, sig);
    return remainder ? `signature: ${sig}\n${remainder}` : `signature: ${sig}`;
}
