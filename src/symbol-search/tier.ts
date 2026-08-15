/**
 * Generic workspace-first tiering shared by the plain-name strategies (bash,
 * python/typescript bare queries) and reused by the cpp strategy for the
 * T1/T2/T3 split.
 *
 * Only the *exact* predicate is strategy-specific; the T1 (exact in
 * workspace root) / T2 (exact elsewhere) / T3 (substring fuzzy tail) ordering
 * and the substring guard are identical across languages.
 *
 * `rank` always returns the FULL tiered order (list mode). The pipeline drops
 * non-exact rows in fan-out mode using `exactIndexes` — this mirrors the
 * original "wantInfo ? t2 : [...t2, ...t3]" branch without the strategy
 * needing to know the fan-out flag.
 */

import type { SymbolInformation } from "vscode-languageserver-protocol";
import type { RankedSymbols, SearchContext } from "./types";
import { homeFolderOf } from "./paths";

/**
 * Order rows as [exact-in-workspace, exact-elsewhere, fuzzy-substring],
 * preserving the server's order within each tier.
 *
 * When T1 (exact in the workspace root) is non-empty, ONLY T1 is returned —
 * the agent's bare name almost always means their own symbol, and third-party
 * fuzzy hits are pure noise. Otherwise T2 then T3 are returned.
 *
 * - `isExact` — true when a row is an exact-name match for the query.
 * - `nameHasBare` — true when a row's name contains the bare query substring.
 */
export function tierByWorkspace(
    symbols: SymbolInformation[],
    params: {
        isExact: (s: SymbolInformation) => boolean;
        nameHasBare: (s: SymbolInformation) => boolean;
    },
    ctx: SearchContext,
): RankedSymbols {
    const { isExact, nameHasBare } = params;
    const inWorkspaceRoot = (s: SymbolInformation): boolean => {
        const home = homeFolderOf(s.location.uri, ctx.workspaceFolders);
        return !!home && home === ctx.rootPath;
    };
    const t1 = symbols.filter((s) => isExact(s) && inWorkspaceRoot(s));
    const t2 = symbols.filter((s) => isExact(s) && !inWorkspaceRoot(s));
    const ordered: SymbolInformation[] =
        t1.length > 0 ? t1 : [...t2, ...symbols.filter((s) => !isExact(s) && nameHasBare(s))];
    // T1/T2 rows are exact; the fuzzy tail is not.
    const exactIndexes = new Set<number>();
    for (let i = 0; i < ordered.length; i++) {
        if (isExact(ordered[i])) exactIndexes.add(i);
    }
    return { ordered, exactIndexes };
}

/** Whether a row's name contains the bare query as a substring, honoring the
 * strategy's case policy. */
export function containsBare(
    s: SymbolInformation,
    bare: string,
    caseInsensitive: boolean,
): boolean {
    const nm = caseInsensitive ? s.name.toLowerCase() : s.name;
    return nm.includes(bare);
}
