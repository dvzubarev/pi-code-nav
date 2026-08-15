/**
 * Shared core for the code-nav tool implementations.
 *
 * Holds the cross-cutting pieces every per-tool file (outline.ts, tree.ts,
 * definition.ts, references.ts, symbol.ts, rename.ts, hover.ts, scan.ts,
 * diagnostics.ts) needs:
 *   - `ClientProvider`     — the `(lang) => Promise<LspClient>` callback shape
 *                            every tool takes (mirrors ServerPool.client).
 *   - `ALL_LANGS`          — the supported language ids, RE-EXPORTED from the
 *                            neutral catalog (`src/languages/catalog.ts`,
 *                            where `LANGUAGES` is the single source of truth).
 *   - `UnknownLanguageError` — hard failure for single-file tools.
 *   - position-selector validation/resolution for detail tools called directly.
 *   - `awaitReadyForQuery` — openDocument + project-readiness wait before a
 *                            per-file LSP query, deduplicated across tools.
 *
 * Per-tool implementations live in their own files; `nav.ts` is the barrel that
 * re-exports everything `index.ts` and the tests consume as `nav.*`.
 */

import type { LspClient } from "./lsp-client";
import type { Lang } from "./languages/types";

export type { Lang } from "./languages/types";
/** `ALL_LANGS` lives in the neutral catalog (`src/languages/catalog.ts`,
 * derived from `LANGUAGES`); keep this re-export so `nav.ts`'s public surface
 * and its existing consumers (code_search_symbol validation, the
 * `.pi/lsp.json` merge loop, the `StringEnum` for the tool's `language`
 * parameter) stay unchanged. Adding a language to `LANGUAGES` in the catalog
 * still reaches every `ALL_LANGS` call site. */
export { ALL_LANGS } from "./languages/catalog";

/** Provides a per-language LspClient on demand (mirrors ServerPool.client). */
export interface ClientProvider {
    (lang: Lang): Promise<LspClient>;
}

// ---------------------------------------------------------------------------
// Per-file query readiness (openDocument + cpp indexing wait)
// ---------------------------------------------------------------------------

/**
 * Open `abs` and establish the language-specific project barrier before a
 * per-file query. ccls waits for its indexing pipeline; ty performs one
 * whole-workspace diagnostic check and waits for standard work-done progress.
 * This avoids plausible but stale/incomplete navigation results on cold,
 * large projects.
 *
 * The operation is idempotent: document opens are deduplicated, ccls caches
 * its established idle state, and ty memoizes its first workspace check for
 * the server lifetime. Timeouts are surfaced rather than returning stale data.
 */
export async function awaitReadyForQuery(
    lang: Lang,
    client: LspClient,
    abs: string,
    text: string,
): Promise<void> {
    await client.openDocument(abs, text);
    if (lang === "cpp" || lang === "python") await client.ensureProjectLoaded();
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** A detail-tool target is either a precise 1-based column or the first exact
 * occurrence of a symbol on the supplied line. */
export type PositionSelector =
    | { column: number; symbol?: never }
    | { column?: never; symbol: string };

/** Validate an agent-facing 1-based symbol position. Tool schemas enforce this
 * too; runtime validation protects the CLI and tests that call nav.* directly. */
export function validateLine(line: number): void {
    if (!Number.isInteger(line) || line < 1) {
        throw new Error(`line (${line}) must be a positive integer`);
    }
}

export function validatePosition(line: number, column: number): void {
    validateLine(line);
    if (!Number.isInteger(column) || column < 1) {
        throw new Error(`column (${column}) must be a positive integer`);
    }
}

/** Resolve a mutually-exclusive column/symbol selector to a 1-based UTF-16
 * column. JavaScript string offsets are UTF-16, matching LSP coordinates. */
export function resolvePositionColumn(
    params: { line: number; column?: number; symbol?: string },
    text: string,
): number {
    validateLine(params.line);
    const hasColumn = params.column !== undefined;
    const hasSymbol = params.symbol !== undefined;
    if (hasColumn === hasSymbol) {
        throw new Error("exactly one of column or symbol must be provided");
    }
    if (hasColumn) {
        validatePosition(params.line, params.column!);
        return params.column!;
    }

    const symbol = params.symbol!;
    if (symbol.length === 0) throw new Error("symbol must not be empty");
    const lines = text.split(/\r?\n/);
    const lineText = lines[params.line - 1];
    if (lineText === undefined) {
        throw new Error(`line (${params.line}) is outside the file (${lines.length} lines)`);
    }

    // Require identifier boundaries when the corresponding edge of `symbol`
    // is identifier-like, so `parse` does not silently select `parseResult`.
    const identifierChar = /[\p{ID_Continue}$]/u;
    let from = 0;
    while (from <= lineText.length - symbol.length) {
        const index = lineText.indexOf(symbol, from);
        if (index < 0) break;
        const before = index > 0 ? lineText[index - 1] : "";
        const after = lineText[index + symbol.length] ?? "";
        const leftOk = !identifierChar.test(symbol[0]) || !identifierChar.test(before);
        const rightOk =
            !identifierChar.test(symbol[symbol.length - 1]) || !identifierChar.test(after);
        if (leftOk && rightOk) return index + 1;
        from = index + 1;
    }
    throw new Error(`symbol ${JSON.stringify(symbol)} not found on line ${params.line}`);
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Unknown-language is a hard failure for single-file tools. The wrapper in
 * index.ts converts it to a tool result with `isError: true`. */
export class UnknownLanguageError extends Error {
    constructor(public readonly path: string) {
        super(`Unknown language for file: ${path}`);
        this.name = "UnknownLanguageError";
    }
}
