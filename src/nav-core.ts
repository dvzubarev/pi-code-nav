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
 *   - `UnknownLanguageError` — hard failure for single-file tools.
 *   - `validatePosition` — runtime validation for CLI and direct nav callers.
 *   - `awaitReadyForQuery` — openDocument + project-readiness wait before a
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

/** Validate an agent-facing 1-based symbol position. Tool schemas enforce this
 * too; runtime validation protects the CLI and tests that call nav.* directly. */
export function validatePosition(line: number, column: number): void {
    if (!Number.isInteger(line) || line < 1) {
        throw new Error(`line (${line}) must be a positive integer`);
    }
    if (!Number.isInteger(column) || column < 1) {
        throw new Error(`column (${column}) must be a positive integer`);
    }
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
