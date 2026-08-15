/**
 * Symbol-search strategy contract — the per-language policy surface extracted
 * out of `src/symbol.ts`.
 *
 * Each of cpp / python+typescript / bash has distinct rules for how a query is
 * parsed, how the language server is queried, and how raw `workspace/symbol`
 * rows are ranked. The generic pipeline (server availability, capability
 * check, readiness, root discovery, dedupe, kind/name filters, row rendering
 * and fan-out) lives in `src/symbol.ts` and only calls through this interface
 * — it contains no per-language ranking branches.
 */

import type { SymbolInformation } from "vscode-languageserver-protocol";
import type { Lang } from "../languages/types";
import { cppStrategy } from "./strategies/cpp";
import { pythonStrategy, typescriptStrategy } from "./strategies/dotted";
import { bashStrategy } from "./strategies/bash";

/** A parsed (possibly qualified) symbol query. */
export interface ParsedQuery {
    /** The original agent-supplied query, unmodified. */
    readonly raw: string;
    /** The qualifier part (everything before the last separator), or null. */
    readonly qualifier: string | null;
    /** The bare (unqualified) name — always the last path component. */
    readonly bare: string;
    /** The qualifier split into tokens (`::` for cpp, `.` for python/ts). */
    readonly qualifierTokens: readonly string[];
    /** True when the query carried a qualifier at all. */
    readonly isQualified: boolean;
}

/**
 * Context handed to `rank` — everything the strategy needs to tier raw
 * `workspace/symbol` results that is NOT query-shaped.
 */
export interface SearchContext {
    /** The language this search is running under. */
    readonly lang: Lang;
    /** All workspace folders (root + added third-party roots), longest-first. */
    readonly workspaceFolders: readonly string[];
    /** The filesystem path of the primary workspace root. */
    readonly rootPath: string;
}

/**
 * A tiered result: rows ordered most → least relevant, plus which of them are
 * exact-name matches. The generic pipeline uses `ordered` for list mode and
 * `exactIndexes` to decide what fans out when `include` is non-empty.
 */
export interface RankedSymbols {
    /** Tiered rows, most relevant first (preserves server order per tier). */
    readonly ordered: readonly SymbolInformation[];
    /** Indexes into `ordered` that are exact-name matches. */
    readonly exactIndexes: ReadonlySet<number>;
}

/**
 * A per-language symbol-search strategy: everything that differs between
 * cpp / python+typescript / bash.
 */
export interface SymbolSearchStrategy {
    /** Break an agent-supplied query into its parts. */
    parseQuery(query: string): ParsedQuery;
    /** Transform the parsed query into what the server's `workspace/symbol` sees. */
    queryForServer(parsed: ParsedQuery): string;
    /** Tier + filter raw `workspace/symbol` results most-relevant-first. */
    rank(symbols: SymbolInformation[], parsed: ParsedQuery, context: SearchContext): RankedSymbols;
    /** Best-effort discovery of extra (third-party/stdlib) workspace roots. */
    discoverExtraRoots?(cwd: string): Promise<string[]>;
}

/** Select the strategy for a language. `undefined` means "no strategy", which
 * the pipeline treats as an internal invariant violation (it always knows the
 * language). */
export function strategyFor(lang: Lang): SymbolSearchStrategy | undefined {
    switch (lang) {
        case "cpp":
            return cppStrategy;
        case "python":
            return pythonStrategy;
        case "typescript":
            return typescriptStrategy;
        case "bash":
            return bashStrategy;
    }
}
