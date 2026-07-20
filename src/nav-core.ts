/**
 * Shared core for the code-nav tool implementations.
 *
 * Holds the cross-cutting pieces every per-tool file (outline.ts, tree.ts,
 * definition.ts, references.ts, symbol.ts, rename.ts, hover.ts, scan.ts,
 * diagnostics.ts) needs:
 *   - `ClientProvider`     — the `(lang) => Promise<LspClient>` callback shape
 *                            every tool takes (mirrors ServerPool.client).
 *   - `ALL_LANGS`          — the single source of truth for the `Lang` union's
 *                            members (one array, many call sites — adding a
 *                            language can't silently miss one).
 *   - `UnknownLanguageError` — top-level hard failure for the single-file tools
 *                            (outline/tree/definition/rename/scan/diagnostics);
 *                            references/hover emit it inline as an ERROR row.
 *   - `awaitReadyForQuery` — openDocument + (cpp) ccls indexing wait before a
 *                            per-file LSP query, deduplicated across tools.
 *
 * Per-tool implementations live in their own files; `nav.ts` is the barrel that
 * re-exports everything `index.ts` and the tests consume as `nav.*`.
 */

import type { Lang, LspClient } from "./lsp-client";

/** Provides a per-language LspClient on demand (mirrors ServerPool.client). */
export interface ClientProvider {
    (lang: Lang): Promise<LspClient>;
}

/** Every language this extension supports — the single source of truth for
 * the `Lang` union's members. Used for project-language detection (all
 * tiers), to validate an agent-supplied `language` string (code_search_symbol),
 * and by index.ts for the `.pi/lsp.json` merge loop and the code_search_symbol
 * tool's `language` parameter StringEnum — one array, four call sites, so
 * adding a language can't silently miss one of them. */
export const ALL_LANGS = ["cpp", "python", "bash", "typescript"] as const satisfies readonly Lang[];

// ---------------------------------------------------------------------------
// Per-file query readiness (openDocument + cpp indexing wait)
// ---------------------------------------------------------------------------

/**
 * Open `abs` on its server and, for cpp, wait for ccls to finish indexing
 * this translation unit before per-file LSP queries. On a cold ccls cache,
 * queries issued before indexing finishes return stale/incomplete results
 * — e.g. `code_outline` on a freshly-opened .cpp shows only the namespace
 * with `{0:0}` ranges, `textDocument/definition` bounces to the declaration,
 * `documentSymbol` returns placeholder ranges. The wait is best-effort
 * (try/catch around `waitForIndexingComplete`): a wedged server must not
 * block the query — the caller still gets whatever (possibly stale) result
 * the server can produce, which is strictly better than hanging.
 *
 * Idempotent: `openDocument` dedupes by URI, and `waitForIndexingComplete`
 * is a no-op once ccls's `indexState === "ended"` (warm cache). So on a warm
 * cache this is essentially free — `openDocument` is a single dedup'd didOpen
 * (or no-op) and the indexing wait returns immediately. No behavior change
 * on a warm cache; the cold-cache path becomes reliable.
 *
 * `definition()` and `diagnostics()` did this inline; the helper deduplicates
 * and applies the same wait to `outline`/`tree`/`hover`/`references`/`rename`,
 * which previously queried on a not-yet-indexed TU.
 */
export async function awaitReadyForQuery(
    lang: Lang,
    client: LspClient,
    abs: string,
    text: string,
): Promise<void> {
    await client.openDocument(abs, text);
    if (lang === "cpp") {
        try {
            await client.waitForIndexingComplete();
        } catch {
            // Best-effort: a wedged server shouldn't block the query.
        }
    }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** The caller (index.ts) decides whether to return isError.
 * Unknown-language is a top-level hard failure for the single-file tools
 * (outline/tree/definition/rename/scan/diagnostics); references/hover emit
 * it inline as an ERROR row. We throw here so index.ts can mark
 * isError: true for the single-file case; references/hover check
 * langForFile inline and emit an ERROR row instead of letting it escape. */
export class UnknownLanguageError extends Error {
    constructor(public readonly path: string) {
        super(`Unknown language for file: ${path}`);
        this.name = "UnknownLanguageError";
    }
}
