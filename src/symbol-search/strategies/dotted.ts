/**
 * Python + TypeScript symbol-search strategy — the shared "."-qualified policy.
 *
 * ty/tsserver only match BARE names natively (`typing.cast` returns 0 on ty),
 * so the server is queried with the bare tail. Qualified member searches also
 * query the bare container and intersect files/ranges before loading ancestry.
 * Results are tiered by module path and verified lexical containers.
 *
 * Disambiguation by the qualifier is NOT done via `containerName` — no
 * Python/TypeScript server populates it (ty/pyrefly/pyright all leave it null).
 * The hierarchical `documentSymbol` tree carries the missing containers;
 * qualified queries recover that ancestry through the cached search context.
 */

import {
    SymbolKind,
    type DocumentSymbol,
    type SymbolInformation,
} from "vscode-languageserver-protocol";
import { rangeContains } from "../../lsp-resolution";
import { modulePathOf } from "../paths";
import { discoverPythonRoots } from "../roots/python";
import { containsBare, tierByWorkspace } from "../tier";
import type { ParsedQuery, RankedSymbols, SearchContext, SymbolSearchStrategy } from "../types";

const SEP = ".";
const CONTAINER_KINDS = new Set<number>([
    SymbolKind.Module,
    SymbolKind.Namespace,
    SymbolKind.Class,
    SymbolKind.Interface,
    SymbolKind.Struct,
    SymbolKind.Enum,
    SymbolKind.Function,
    SymbolKind.Method,
]);

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
): RankedSymbols | Promise<RankedSymbols> {
    if (parsed.qualifier !== null) {
        return qualifiedDotRank(symbols, parsed, ctx);
    }
    // ty & tsserver both do case-insensitive fuzzy workspace/symbol matching.
    return bareDotRank(symbols, parsed, ctx, true);
}

/** Find the enclosing lexical names of this specific workspace-symbol row.
 * Match by name AND range, not name alone (overloads and sibling classes).
 * null means ancestry is unavailable; [] means a verified top-level symbol. */
function enclosingNames(
    syms: DocumentSymbol[],
    target: SymbolInformation,
    parents: string[] = [],
): string[] | null {
    for (const s of syms) {
        const nested = enclosingNames(s.children ?? [], target, [...parents, s.name]);
        if (nested !== null) return nested;
        if (s.name === target.name && rangeContains(s.range, target.location.range)) return parents;
    }
    return null;
}

/** Token-boundary suffix matching permits Class.member and Outer.Inner.member. */
function hasSuffix(path: string, suffix: string): boolean {
    return path === suffix || path.endsWith(SEP + suffix);
}

/** Search the bare container before loading candidate files. This is only an
 * optimization: an unsupported/empty lookup, or import-binding-only hits,
 * falls back to ancestry verification. Never accept
 * a candidate solely because it shares a file with a container hit.
 *
 * Multi-line workspace-symbol ranges describe container extents on ty. Other
 * servers may return only an identifier span; single-line ranges therefore
 * narrow by file only and leave containment to documentSymbol verification. */
async function containerCandidates(
    exactMatches: SymbolInformation[],
    parsed: ParsedQuery,
    ctx: SearchContext,
): Promise<SymbolInformation[]> {
    const name = parsed.qualifierTokens.at(-1)!;
    let containers: SymbolInformation[];
    try {
        containers = (await ctx.workspaceSymbols(name)).filter(
            (s) => s.name === name && CONTAINER_KINDS.has(s.kind),
        );
    } catch {
        return exactMatches;
    }
    if (containers.length === 0) return exactMatches;
    const byFile = new Map<string, SymbolInformation[]>();
    for (const c of containers) {
        const uri = c.location.uri;
        const rows = byFile.get(uri) ?? [];
        rows.push(c);
        byFile.set(uri, rows);
    }
    const sameFile = exactMatches.filter((s) => byFile.has(s.location.uri));
    return sameFile.filter((s) =>
        byFile.get(s.location.uri)!.some((c) => {
            const range = c.location.range;
            return (
                !range ||
                range.start.line === range.end.line ||
                rangeContains(range, s.location.range)
            );
        }),
    );
}

/** Qualified queries never fall back to unrelated bare-name hits.
 * Direct module matches stay cheap; otherwise recover lexical containers and
 * prefer exact qualification over the constrained package re-export fallback.
 * See docs/code_search_symbol.md "Tiered qualified-name filter". */
export async function qualifiedDotRank(
    symbols: SymbolInformation[],
    parsed: ParsedQuery,
    ctx: SearchContext,
): Promise<RankedSymbols> {
    const qualifier = parsed.qualifier as string;
    const exactMatches = symbols.filter((s) => s.name === parsed.bare);
    const ranked = (ordered: SymbolInformation[]): RankedSymbols => ({
        ordered,
        exactIndexes: new Set(ordered.map((_, i) => i)),
    });
    const moduleMatches = exactMatches.filter((s) => {
        const mod = modulePathOf(s.location.uri, ctx.workspaceFolders);
        return mod !== null && (mod === qualifier || mod.startsWith(qualifier + SEP));
    });
    if (moduleMatches.length > 0) return ranked(moduleMatches);

    if (exactMatches.length === 0) return ranked([]);
    const candidates = await containerCandidates(exactMatches, parsed, ctx);
    const precise: SymbolInformation[] = [];
    const reexports: SymbolInformation[] = [];
    for (const s of candidates) {
        const names = enclosingNames(await ctx.documentSymbols(s.location.uri), s);
        if (names === null) continue;
        const mod = modulePathOf(s.location.uri, ctx.workspaceFolders);
        const containers = names.join(SEP);
        if (
            containers &&
            (hasSuffix(containers, qualifier) ||
                (mod !== null && hasSuffix(mod + SEP + containers, qualifier)))
        ) {
            precise.push(s);
            continue;
        }
        // A package can re-export a top-level class/function from a differently
        // named module (aiohttp.web.Request). For members it must also preserve
        // the requested container suffix (aiohttp.StreamReader.iter_chunks).
        if (mod === null || mod.split(SEP)[0] !== parsed.qualifierTokens[0]) continue;
        if (names.length === 0) {
            reexports.push(s);
            continue;
        }
        for (let i = 1; i < parsed.qualifierTokens.length; i++) {
            const prefix = parsed.qualifierTokens.slice(0, i).join(SEP);
            const tail = parsed.qualifierTokens.slice(i).join(SEP);
            if ((mod === prefix || mod.startsWith(prefix + SEP)) && hasSuffix(containers, tail)) {
                reexports.push(s);
                break;
            }
        }
    }
    return ranked(precise.length > 0 ? precise : reexports);
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
