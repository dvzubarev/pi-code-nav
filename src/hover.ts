/**
 * code_hover — hover/documentation for the symbol at (path, line, column).
 * Output is signature-first: a `signature: <collapsed one-line signature>` line
 * (when one can be extracted), then the full hover markdown body. A clean
 * empty result returns the parenthesized note `(no hover information)`.
 *
 * Operational failures throw so index.ts can mark the tool result as an error.
 * A clean empty hover remains a normal parenthesized result.
 */

import { readFile } from "node:fs/promises";
import type { LspClient } from "./lsp-client";
import {
    awaitReadyForQuery,
    ClientProvider,
    UnknownLanguageError,
    validatePosition,
} from "./nav-core";
import { hoverSignature, hoverText, langForFile, toAbs } from "./render";

export interface HoverParams {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
}

export async function hover(
    params: HoverParams,
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
    // Wait for ccls to finish indexing this TU before querying hover. On a
    // cold cache, textDocument/hover can return empty or partial signatures
    // until the file's preamble session is ready. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const h = await client.hover(abs, params.line - 1, params.column - 1, text);
    const body = hoverText(h);
    // Signature-first: emit the collapsed one-line signature (when one can
    // be extracted) as the first line, then the full hover markdown. This
    // surfaces structured signature info that would otherwise be buried in
    // a ```python fence or a multi-paragraph docstring. The `signature:`
    // prefix lets a consumer pick the first line cheaply without parsing
    // the markdown body.
    const sig = hoverSignature(body);
    const sigLine = sig ? `signature: ${sig}\n` : "";
    return sigLine + body;
}
