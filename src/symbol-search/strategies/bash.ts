/**
 * Bash symbol-search strategy — the plain-name policy.
 *
 * Bash has no qualified-name concept, so the whole query is always the bare
 * name and the server receives it verbatim.
 *
 * Matching is CASE-SENSITIVE: Bash identifiers are case-sensitive, so
 * `deploy_release` must not treat `DEPLOY_RELEASE` as an exact workspace hit
 * (which would suppress other results through T1 precedence). This matches
 * the pre-extraction behavior (`caseInsensitive` was only true for
 * python/typescript).
 */

import type { SymbolInformation } from "vscode-languageserver-protocol";
import { containsBare, tierByWorkspace } from "../tier";
import type { ParsedQuery, RankedSymbols, SearchContext, SymbolSearchStrategy } from "../types";

function parseBashQuery(query: string): ParsedQuery {
    return { raw: query, qualifier: null, bare: query, qualifierTokens: [], isQualified: false };
}

function bashRank(
    symbols: SymbolInformation[],
    parsed: ParsedQuery,
    ctx: SearchContext,
): RankedSymbols {
    const bare = parsed.bare;
    const isExact = (s: SymbolInformation): boolean => s.name === bare;
    return tierByWorkspace(
        symbols,
        {
            isExact,
            nameHasBare: (s) => containsBare(s, bare, false),
        },
        ctx,
    );
}

export const bashStrategy: SymbolSearchStrategy = {
    parseQuery: parseBashQuery,
    queryForServer: (parsed) => parsed.bare,
    rank: bashRank,
};
