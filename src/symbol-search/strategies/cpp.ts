/**
 * C++ (ccls) symbol-search strategy.
 *
 * ccls handles qualified names natively and ranks them, so the FULL query is
 * passed through (stripped of balanced template arguments — ccls returns a
 * specialization declaration for `Result`, not `Result<void>`; the exact
 * post-filter restores precision). The qualifier is only used for ranking:
 * the ccls `name` is a full C++ qualified signature
 * (`void diskann::Index::occlude_list(...)`), so "exact" is a TOKEN-LEVEL
 * match (bare equality +, for a qualified query, the query's qualifier-token
 * chain is a suffix of the candidate's) rather than a plain equality.
 *
 * The pure parsing/matching functions live in `src/symbol-search/cpp-parse.ts`,
 * moved verbatim out of `src/symbol.ts` (stage 1). This file only wires them
 * into the strategy interface.
 */

import type { SymbolInformation } from "vscode-languageserver-protocol";
import { containsBare, tierByWorkspace } from "../tier";
import type { ParsedQuery, RankedSymbols, SearchContext, SymbolSearchStrategy } from "../types";
import {
    isCppExactMatch,
    lastCppScopeSeparator,
    stripCppTemplateArguments,
    tokenizeCppQualifier,
} from "../cpp-parse";

const SEP = "::";

function parseCppQuery(query: string): ParsedQuery {
    const idx = lastCppScopeSeparator(query);
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
        qualifierTokens: tokenizeCppQualifier(qualifier),
        isQualified: true,
    };
}

/**
 * ccls ranking: workspace-first tiering with the token-level exact rule.
 *
 * For a bare cpp query the T1/T2/T3 logic is identical to the plain-name
 * strategies but the exact predicate is token-level (`isCppExactMatch`) and
 * the substring comparison is case-sensitive. For a QUALIFIED cpp query the
 * full query was passed to the server, and "exact" is still the token-level
 * rule — the qualifier tokens from `parsed` participate.
 */
function cppRank(
    symbols: SymbolInformation[],
    parsed: ParsedQuery,
    ctx: SearchContext,
): RankedSymbols {
    const queryQualifierTokens = parsed.qualifierTokens;
    const bare = parsed.bare;
    const isExact = (s: SymbolInformation): boolean =>
        isCppExactMatch([...queryQualifierTokens], bare, s.name);
    return tierByWorkspace(
        symbols,
        {
            isExact,
            nameHasBare: (s) => containsBare(s, bare, false),
        },
        ctx,
    );
}

export const cppStrategy: SymbolSearchStrategy = {
    parseQuery: parseCppQuery,
    queryForServer: (parsed) => stripCppTemplateArguments(parsed.raw),
    rank: cppRank,
};
