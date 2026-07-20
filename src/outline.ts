/**
 * code_outline — list the structure of a source file (functions, classes,
 * methods) via LSP documentSymbol. Only structural kinds are kept; the output
 * is a bloat-free overview. See docs/code_outline.md.
 */

import { readFile } from "node:fs/promises";
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";
import { awaitReadyForQuery, ClientProvider, UnknownLanguageError } from "./nav-core";
import { langForFile, renderDocSymbol, renderSymbolInfo, toAbs } from "./render";

export interface OutlineParams {
    path: string;
}

/**
 * LSP SymbolKind values `code_outline` keeps. The tool's stated purpose is
 * "functions, classes, methods" — an allowlist is more honest than a
 * denylist of noisy kinds: it says exactly what the overview shows rather
 * than what it happens to hide. Kept:
 *
 *   5  Class        9  Constructor  12 Function       23 Struct
 *   6  Method       11 Interface
 *
 * Property(7)/Field(8) are deliberately DROPPED. They sound structural but
 * aren't reliably so: tsserver emits `Property` for object-literal keys
 * (e.g. every field of a `registerTool({...})` call or a returned object
 * literal), which floods the outline with non-structural noise. ty/ccls use
 * Field(8) only for real class/struct fields, but even there a field list is
 * rarely what a "compact overview" wants — the agent can `code_tree` a class
 * name to see its members, or read the file. Dropping 7/8 keeps the outline
 * to the callable/type-declaration surface. Constructor is a kind of method.
 * Dropped: Variable(13), Constant(14), Property(7), Field(8), and everything
 * else (Enum/Namespace/etc. — none appear in practice for our servers; if
 * one ever does, dropping it is the safe default for a "compact overview").
 * See docs/code_outline.md.
 */
const OUTLINE_KEEP_KINDS = new Set([5, 6, 9, 11, 12, 23]);

/**
 * Prune a DocumentSymbol tree to nodes whose kind is in `keep`, recursing
 * into kept nodes' children. Returns a new top-level array; may rewrite a
 * kept node's `.children` to its filtered sublist (the input comes from a
 * fresh `documentSymbol` call and is rendered once, so this in-place rewrite
 * is safe and avoids a deep clone). A dropped node's children are NOT lifted
 * to the parent — they're structural subordinates (a constant's locals, a
 * method's temps), and lifting them would distort the tree.
 */
function pruneDocSymbolTree(syms: DocumentSymbol[], keep: Set<number>): DocumentSymbol[] {
    const out: DocumentSymbol[] = [];
    for (const s of syms) {
        const kind = (s as unknown as { kind?: number }).kind ?? 0;
        if (!keep.has(kind)) continue;
        const children = (s as unknown as { children?: DocumentSymbol[] }).children;
        if (children && children.length > 0) {
            (s as unknown as { children?: DocumentSymbol[] }).children = pruneDocSymbolTree(
                children,
                keep,
            );
        }
        out.push(s);
    }
    return out;
}

/** Keep only rows whose kind is in `keep` from a flat SymbolInformation[]. */
function filterSymbolInfoList(syms: SymbolInformation[], keep: Set<number>): SymbolInformation[] {
    return syms.filter((s) => keep.has(s.kind ?? 0));
}

export async function outline(
    params: OutlineParams,
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
        // Hard failure: cannot read the file. Throw so index.ts's err() sets
        // isError: true rather than returning an inline string that looks like
        // a (empty) result.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    const client = await clientOf(lang);
    // Wait for ccls to finish indexing this TU before querying documentSymbol.
    // On a cold cache, documentSymbol returns stale {0:0} ranges until the
    // file's preamble session is ready. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const syms = await client.documentSymbols(abs, text);
    if (syms.length === 0) return `(no symbols found in ${params.path})`;
    const lines: string[] = [];
    // Hierarchical (DocumentSymbol[]) vs flat (SymbolInformation[]).
    // Only structural kinds (class/method/function/field/...) are kept — the
    // outline is a bloat-free structural overview. No arguments, no hovers,
    // no opt-out. Server-provided `detail` is rendered inline where present
    // (ccls fills it; tsserver/ty leave it empty).
    if ("range" in syms[0] && "selectionRange" in syms[0]) {
        const tree = pruneDocSymbolTree(syms as DocumentSymbol[], OUTLINE_KEEP_KINDS);
        for (const s of tree) renderDocSymbol(s, 0, lines);
    } else {
        const flat = filterSymbolInfoList(syms as SymbolInformation[], OUTLINE_KEEP_KINDS);
        for (const s of flat) lines.push(renderSymbolInfo(s));
    }
    return lines.join("\n");
}
