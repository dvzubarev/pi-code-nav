/**
 * LSP-assisted symbol/body resolution — resolving identifier selection-ranges
 * and full definition-body extents that servers don't return directly.
 *
 * Split out of `render.ts` (see docs/MAINTAINER.md): `render.ts` is now purely
 * output formatting with no filesystem or LSP dependency, while the functions
 * here DO depend on an `LspClient` (for documentSymbols) and read source files
 * from disk. Keeping them separate makes the dependency boundary explicit:
 * `render.ts` is safe for transport-neutral consumers; this module is not.
 *
 * All coordinates handled here are 0-based LSP coords (the input/output
 * contract of the LSP layer). The 1-based conversion happens in the tool
 * layer.
 */

import { readFile } from "node:fs/promises";
import type { DocumentSymbol, SymbolInformation, Location } from "vscode-languageserver-protocol";
import type { LspClient } from "./lsp-client";
import { uriToPath } from "./render";

// ---------------------------------------------------------------------------
// DocumentSymbol tree searches (sel-start resolution, body-range resolution)
// ---------------------------------------------------------------------------

/**
 * Resolve the identifier (selectionRange) start for a SymbolInformation.
 *
 * SymbolInformation (from workspace/symbol) only carries `location.range` —
 * the full symbol extent, whose start is column 0 of the enclosing line and
 * does NOT resolve in hover/definition/references on servers like ty. We need
 * the identifier position so code_search_symbol output is directly reusable as input
 * to the other code_* tools.
 *
 * We fetch documentSymbol for the result's file (cached per uri within a
 * single code_search_symbol call) and find the child whose name matches and whose
 * range contains the SymbolInformation's range. If no match, fall back to
 * scanning the source line for the symbol name. Returns 0-based LSP coords.
 */
export async function resolveSymbolSelStart(
    client: LspClient,
    sym: SymbolInformation,
    docCache: Map<string, DocumentSymbol[]>,
): Promise<{ line: number; character: number } | undefined> {
    const path = uriToPath(sym.location.uri);
    const rangeStart = sym.location.range?.start;
    if (!rangeStart) return undefined;
    // Try documentSymbol lookup for an exact selectionRange.
    try {
        let syms = docCache.get(path);
        if (!syms) {
            let text: string;
            try {
                text = await readFile(path, "utf8");
            } catch {
                text = "";
            }
            const got = await client.documentSymbols(path, text);
            syms = got as DocumentSymbol[];
            docCache.set(path, syms);
        }
        const match = findDocSymbolByNameRange(syms, sym.name, sym.location.range);
        if (match?.selectionRange?.start) {
            return {
                line: match.selectionRange.start.line,
                character: match.selectionRange.start.character,
            };
        }
    } catch {
        // Fall through to source-line scan.
    }
    // Fallback: scan the source line for the symbol name.
    // Only use the fallback when `rangeStart.character` is 0 — servers like
    // `ty` (python/typescript) return line-start ranges for workspace/symbol
    // results, so the fallback scanning finds the actual identifier position.
    // When `rangeStart.character > 0` (ccls provides per-identifier positions
    // already), trust the server — the fallback scan of `sym.name` for cpp
    // (where the name is a full signature like `"using my_type_t = int"`) can
    // match at column 0 and return a WORSE position than `rangeStart`.
    if (rangeStart.character === 0) {
        try {
            const text = await readFile(path, "utf8");
            const lineText = text.split(/\r?\n/)[rangeStart.line] ?? "";
            const idx = lineText.indexOf(sym.name);
            if (idx >= 0) return { line: rangeStart.line, character: idx };
        } catch {}
    }
    return undefined;
}

/** Recursively find a DocumentSymbol by name whose range contains `within`. */
export function findDocSymbolByNameRange(
    syms: DocumentSymbol[],
    name: string,
    within: {
        start?: { line: number; character: number };
        end?: { line: number; character: number };
    },
): DocumentSymbol | undefined {
    for (const s of syms) {
        if (s.name === name && rangeContains(s.range, within)) return s;
        const children = (s as unknown as { children?: DocumentSymbol[] }).children ?? [];
        const m = findDocSymbolByNameRange(children, name, within);
        if (m) return m;
    }
    return undefined;
}

/** Recursively find a DocumentSymbol whose selectionRange.start equals `pos`. */
export function findDocSymbolBySelStart(
    syms: DocumentSymbol[],
    pos: { line: number; character: number },
): DocumentSymbol | undefined {
    for (const s of syms) {
        const sel = s.selectionRange?.start;
        if (sel && sel.line === pos.line && sel.character === pos.character) return s;
        const children = (s as unknown as { children?: DocumentSymbol[] }).children ?? [];
        const m = findDocSymbolBySelStart(children, pos);
        if (m) return m;
    }
    return undefined;
}

export function rangeContains(
    outer:
        | { start?: { line: number; character: number }; end?: { line: number; character: number } }
        | undefined,
    inner: {
        start?: { line: number; character: number };
        end?: { line: number; character: number };
    },
): boolean {
    if (!outer?.start || !outer?.end || !inner?.start || !inner?.end) return false;
    const a = posKey(outer.start),
        b = posKey(outer.end);
    const c = posKey(inner.start),
        d = posKey(inner.end);
    return a <= c && b >= d;
}

export function posKey(p: { line: number; character: number }): number {
    return p.line * 1_000_000 + p.character;
}

/**
 * Resolve the full definition body range for a Location returned by
 * textDocument/definition. LSP servers (pyright/ty/ccls) typically return only
 * the identifier span (e.g. the 9 chars of `punintend`), not the whole
 * function/class body. We fetch documentSymbol for the target file and find the
 * child whose selectionRange.start equals the definition's identifier position;
 * we then return that child's full `range` (the enclosing extent) so callers can
 * slice the actual definition source. Returns 0-based LSP line coords or null.
 */
export async function resolveDefBodyRange(
    client: LspClient,
    loc: Location,
): Promise<{ startLine: number; endLine: number } | null> {
    const path = uriToPath(loc.uri);
    const idStart = loc.range?.start;
    if (!idStart) return null;
    try {
        let text = "";
        try {
            text = await readFile(path, "utf8");
        } catch {}
        const syms = await client.documentSymbols(path, text);
        // Hierarchical DocumentSymbol[] has selectionRange; flat SymbolInformation[]
        // does not — bail (no enclosing extent to resolve).
        const flat =
            syms.length > 0 && "selectionRange" in syms[0] ? (syms as DocumentSymbol[]) : [];
        const m = findDocSymbolBySelStart(flat, idStart);
        if (m?.range?.start && m?.range?.end) {
            return { startLine: m.range.start.line, endLine: m.range.end.line };
        }
    } catch {}
    return null;
}