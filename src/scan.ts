/**
 * code_scan — tree-sitter-backed identifier scan of a file (or line range).
 * Walks the source's syntax tree and emits every identifier-class node with
 * its absolute 1-based position and syntactic role (type/call/member/import/var).
 * Because it parses syntax directly (not the LSP symbol index), it sees
 * third-party / stdlib / system symbols the LSP workspace/symbol cannot find —
 * that's the whole reason it exists. See docs/code_scan.md.
 */

import { readFile } from "node:fs/promises";
import { ClientProvider, UnknownLanguageError } from "./nav-core";
import { hoverText, toAbs } from "./render";
import {
    hoverFirstLine,
    parseSymbols,
    renderSymbolTable,
    tsLangForFile,
    tsLangToLspLang,
} from "./tree-sitter-parse";

export interface ScanParams {
    path: string;
    /** Optional 1-based inclusive start line; omitted → from start of file. */
    startLine?: number;
    /** Optional 1-based inclusive end line; omitted → to end of file. */
    endLine?: number;
    /** Optional regexp source; when set, only symbols whose name matches are kept. */
    pattern?: string;
    /** Which syntactic roles to emit. Default: type,call,member,import (no var). */
    roles?: string[];
    /** If true, hover each emitted symbol and append a one-line label. */
    include_docs?: boolean;
}

export async function scan(
    params: ScanParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const tsLang = tsLangForFile(params.path);
    if (!tsLang) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot proceed at all. Throw so index.ts's err() sets
        // isError: true — the agent gets a machine-readable success/failure bit
        // instead of an inline string indistinguishable from a data row.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    // Resolve the effective line range. Both optional → default to the whole
    // file (1 .. last line). If only one is given, fill the other end. This
    // keeps the contract simple: pass just a path for a full-file scan.
    const lineCount = text.split(/\r?\n/).length;
    const startLine = params.startLine ?? 1;
    const endLine = params.endLine ?? lineCount;
    if (!Number.isInteger(startLine) || startLine < 1)
        throw new Error(`startLine (${startLine}) must be a positive integer`);
    if (!Number.isInteger(endLine) || endLine < 1)
        throw new Error(`endLine (${endLine}) must be a positive integer`);
    if (endLine < startLine)
        throw new Error(`endLine (${endLine}) must be >= startLine (${startLine})`);
    // Optional name-pattern filter. Compiled as a regexp — no substring
    // fallback, matching code_tree's contract. A bad pattern is a hard error
    // (isError) so the agent learns the syntax fast.
    let nameRe: RegExp | undefined;
    if (params.pattern !== undefined && params.pattern !== "") {
        try {
            nameRe = new RegExp(params.pattern);
        } catch (e) {
            throw new Error(
                `Invalid regexp /${params.pattern}/: ${e instanceof Error ? e.message : e}`,
            );
        }
    }
    let entries;
    try {
        entries = await parseSymbols(tsLang, {
            text,
            startLine,
            endLine,
            roles: params.roles as Parameters<typeof parseSymbols>[1]["roles"],
        });
    } catch (e) {
        // Hard failure: tree-sitter or a grammar failed to load. Throw so the
        // agent gets isError: true rather than an unparseable string.
        throw new Error(`parse failed: ${e}`);
    }
    if (entries === null) throw new Error(`No grammar for ${params.path}`);
    // Apply the optional name filter after parsing. Filtering here (rather than
    // inside parseSymbols) keeps parseSymbols a pure syntax-walk and lets this
    // tool own the "pattern scopes the candidate set" contract.
    if (nameRe) entries = entries.filter((e) => nameRe!.test(e.name));
    // Optional hover enrichment. One LSP hover call per unique (name, role);
    // the LSP server for the file's language is spawned lazily here (and only
    // when include_docs is true — the default path makes zero LSP calls).
    // The scan itself already succeeded; if the enrichment server is
    // unavailable, return the scan WITHOUT docs plus a trailing note rather
    // than discarding the valid scan results.
    let docs: Map<string, string> | undefined;
    let docsNote = "";
    if (params.include_docs && entries.length > 0) {
        const lang = tsLangToLspLang(tsLang);
        let client;
        try {
            client = await clientOf(lang);
        } catch (e) {
            docsNote = `\n# WARNING: could not enrich with docs (${lang}: server unavailable: ${e})`;
            return renderSymbolTable(params.path, startLine, endLine, entries) + docsNote;
        }
        docs = new Map();
        for (const e of entries) {
            const key = `${e.name}|${e.role}`;
            if (docs.has(key)) continue;
            const h = await client.hover(abs, e.line - 1, e.column - 1, text);
            const first = hoverFirstLine(hoverText(h));
            docs.set(key, first);
        }
    }
    return renderSymbolTable(params.path, startLine, endLine, entries, docs);
}
