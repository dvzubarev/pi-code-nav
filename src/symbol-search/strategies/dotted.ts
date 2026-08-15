/**
 * Python + TypeScript symbol-search strategy — the shared "."-qualified policy.
 *
 * ty/tsserver only match BARE names natively (`typing.cast` returns 0 on ty),
 * so the server is queried with the bare tail and results are tiered by how
 * well the qualifier relates to each hit's defining module path.
 *
 * Disambiguation by the qualifier is NOT done via `containerName` — no
 * Python/TypeScript server populates it (ty/pyrefly/pyright all leave it null).
 * The hierarchical `documentSymbol` tree DOES carry the class container, but
 * `workspace/symbol` is flat and discards it, so this strategy works from the
 * file's module path instead.
 */

import type { SymbolInformation } from "vscode-languageserver-protocol";
import { modulePathOf } from "../paths";
import { discoverPythonRoots } from "../roots/python";
import { containsBare, tierByWorkspace } from "../tier";
import type { ParsedQuery, RankedSymbols, SearchContext, SymbolSearchStrategy } from "../types";

const SEP = ".";

function parseDotQuery(query: string): ParsedQuery {
    const idx = query.lastIndexOf(SEP);
    if (idx < 0)
        return {
            raw: query,
            qualifier: null,
            bare: query,
            qualifierTokens: [],
            isQualified: false,
        };
    const qualifier = query.slice(0, idx);
    return {
        raw: query,
        qualifier,
        bare: query.slice(idx + SEP.length),
        qualifierTokens: qualifier.split(SEP),
        isQualified: true,
    };
}

function dotRank(
    symbols: SymbolInformation[],
    parsed: ParsedQuery,
    ctx: SearchContext,
): RankedSymbols {
    if (parsed.qualifier !== null) {
        return qualifiedDotRank(symbols, parsed, ctx);
    }
    // ty & tsserver both do case-insensitive fuzzy workspace/symbol matching.
    return bareDotRank(symbols, parsed, ctx, true);
}

/**
 * Tiered qualified-name filter for python/typescript (first non-empty tier
 * wins):
 *
 *   Q1 — exact name in any workspace folder, module path matches the
 *        qualifier precisely (`mod === qualifier` or
 *        `mod.startsWith(qualifier + ".")`).
 *   Q2 — exact name in any workspace folder whose module path shares the
 *        qualifier's LEADING `.`-component.
 *   Q3 — exact name in any workspace folder, anything else.
 *
 * Fuzzy/partial-name matches are ALWAYS dropped for a qualified query — the
 * agent asked for a specific symbol. The name match is CASE-SENSITIVE (the
 * agent spelled the exact symbol); the bare-query path stays case-insensitive.
 *
 * See docs/code_search_symbol.md "Tiered qualified-name filter" for the
 * `aiohttp.StreamReader.iter_chunks` / `aiohttp.web.Request` motivation for Q2,
 * and the (deliberately loose) Q2 ambiguity trade-off.
 */
export function qualifiedDotRank(
    symbols: SymbolInformation[],
    parsed: ParsedQuery,
    ctx: SearchContext,
): RankedSymbols {
    const qualifier = parsed.qualifier as string;
    const bare = parsed.bare;
    const folders = ctx.workspaceFolders;
    const exactName = (s: SymbolInformation): boolean => s.name === bare;
    const qualLeading = qualifier.split(SEP)[0];
    const modLeading = (s: SymbolInformation): string | null => {
        const mod = modulePathOf(s.location.uri, folders);
        return mod === null ? null : mod.split(SEP)[0];
    };
    const exactMatches = symbols.filter(exactName);
    const q1 = exactMatches.filter((s) => {
        const mod = modulePathOf(s.location.uri, folders);
        return mod !== null && (mod === qualifier || mod.startsWith(qualifier + SEP));
    });
    const q2 = exactMatches.filter((s) => modLeading(s) === qualLeading);
    const q3 = exactMatches;
    const ordered = q1.length > 0 ? q1 : q2.length > 0 ? q2 : q3;
    return { ordered, exactIndexes: new Set(ordered.map((_, i) => i)) };
}

/**
 * Bare python/typescript query: workspace-first tiering with a
 * case-insensitive exact-name rule and a substring guard on the fuzzy tail.
 */
function bareDotRank(
    symbols: SymbolInformation[],
    parsed: ParsedQuery,
    ctx: SearchContext,
    caseInsensitive: boolean,
): RankedSymbols {
    const bareCmp = caseInsensitive ? parsed.bare.toLowerCase() : parsed.bare;
    const isExact = (s: SymbolInformation): boolean =>
        caseInsensitive ? s.name.toLowerCase() === bareCmp : s.name === bareCmp;
    return tierByWorkspace(
        symbols,
        {
            isExact,
            nameHasBare: (s) => containsBare(s, bareCmp, caseInsensitive),
        },
        ctx,
    );
}

const pythonStrategy: SymbolSearchStrategy = {
    parseQuery: parseDotQuery,
    queryForServer: (parsed) => parsed.bare,
    rank: dotRank,
    discoverExtraRoots: discoverPythonRoots,
};

const typescriptStrategy: SymbolSearchStrategy = {
    parseQuery: parseDotQuery,
    queryForServer: (parsed) => parsed.bare,
    rank: dotRank,
};

export { pythonStrategy, typescriptStrategy };
