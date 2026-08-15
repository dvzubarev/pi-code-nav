/**
 * code_search_symbol — fan-out renderer.
 *
 * When `info` is non-empty and the post-tier/filter/dedupe pipeline leaves
 * ≤ SYMBOL_FANOUT_MAX_MATCHES exact matches, `symbol()` (in `../symbol.ts`)
 * hands the matches to `renderSymbolFanOut`, which emits one `== [N] ... ==`
 * block per match and, within each, a `--- section ---` block for each
 * requested `info` kind (`code` / `hover` / `references`). The fan-out
 * reuses the existing `nav.definition` / `nav.hover` / `nav.references`
 * functions (the SAME code path the standalone tools use — the CLI and tests
 * exercise it too), with two caps:
 *   - `code`: head-snippeted to `floor(SYMBOL_FANOUT_CODE_BUDGET_LINES / N)`
 *     lines per match (2000 split evenly), with a
 *     `# (showing X of Y lines; use code_definition for full body)` note.
 *     Single match → full 2000-line budget (effectively the whole body —
 *     matches `code_definition`'s direct output).
 *   - `references`: first contextual page of SYMBOL_FANOUT_REFS_CAP (25)
 *     results, with pagination metadata and a code_references follow-up note.
 * `hover` is uncapped and retained whenever explicitly requested because it
 * may include inferred types absent from source.
 */

import { readFile } from "node:fs/promises";
import type { SymbolInformation } from "vscode-languageserver-protocol";
import { definition } from "../definition";
import { hover } from "../hover";
import type { ClientProvider } from "../nav-core";
import type { Lang } from "../languages/types";
import { references } from "../references";
import { renderSymbolInfo, uriToPath } from "../render";
import type { SymbolRole } from "../syntax/types";

/** Max exact matches code_search_symbol fans out over when `info` is
 * non-empty. Over this cap the tool returns a row list + a "narrow with
 * filters" note instead of fanning out — a 10-row fan-out would flood the
 * agent's context with 10 bodies + 10×25 references. The cap protects the
 * common-name case (10 `__init__` methods) while serving the overload case
 * (2-3 sites) the fan-out was designed for. */
export const SYMBOL_FANOUT_MAX_MATCHES = 5;

/** Total line budget for the `code` sections across ALL matches in a fan-out,
 * split evenly (`floor(BUDGET / N)` per match). Anchored to pi's
 * `DEFAULT_MAX_LINES` (2000) — the built-in truncation limit for tool output
 * — so a single-match fan-out gets the full 2000 lines (effectively the whole
 * body for any real function, matching `code_definition`'s direct output), and
 * N matches each get a head snippet big enough to decide between them. */
export const SYMBOL_FANOUT_CODE_BUDGET_LINES = 2000;

/** Per-match page size for contextual references in a fan-out. */
export const SYMBOL_FANOUT_REFS_CAP = 25;

/** One match in a fan-out: the language it was found under, the LSP
 * SymbolInformation (with its `location`), and the resolved identifier
 * position (selectionRange.start) used to drive the detail tools. */
export interface FanOutMatch {
    lang: Lang;
    sym: SymbolInformation;
    selStart?: { line: number; character: number };
}

/** Render the full fan-out: a `# N match(es) for ...` header, then one
 * `== [i] [lang] <row> ==` block per match, each containing the requested
 * `--- section ---` blocks in order: code, then hover (if not deduped), then
 * references. Explicitly requested hover information is retained even when
 * code is also requested because hover may contain inferred types. Blocks are
 * blank-line-separated.
 *
 * The `code` section is normally simplified for symbol kinds whose definition
 * IS the declaration — there is no multi-line body to show. With
 * `list_symbols`, these kinds use the normal definition path as well so their
 * declaration receives chainable symbol metadata. Declaration-only kinds
 * include ccls extended kind 252 (using-aliases, typedefs) and standard LSP
 * kinds such as TypeParameter 26; enums are not declaration-only because their
 * enumerator list is a useful body. */
export async function renderSymbolFanOut(
    matches: FanOutMatch[],
    info: ("code" | "hover" | "references")[],
    query: string,
    cwd: string,
    clientOf: ClientProvider,
    symbolRoles: SymbolRole[] | undefined,
    publicInclude?: ("definition" | "hover" | "references")[],
): Promise<string> {
    const n = matches.length;
    const wantCode = info.includes("code");
    const wantHover = info.includes("hover");
    const wantRefs = info.includes("references");
    // Even split of the code budget across matches; wantCode===false → unused.
    const codeBudget = wantCode ? Math.floor(SYMBOL_FANOUT_CODE_BUDGET_LINES / Math.max(1, n)) : 0;
    const blocks: string[] = [];
    const detailLabel = publicInclude ? "include" : "info";
    const detailNames = publicInclude ?? info;
    blocks.push(
        `# ${n} match${n === 1 ? "" : "es"} for "${query}" — ${detailLabel}: ${detailNames.join(", ")}`,
    );
    for (let i = 0; i < n; i++) {
        const { lang, sym, selStart } = matches[i];
        const row = `[${lang}] ${renderSymbolInfo(sym, selStart)}`;
        const matchBlocks: string[] = [`== [${i + 1}] ${row} ==`];
        const path = uriToPath(sym.location.uri);
        const start = selStart ?? sym.location.range?.start;
        const line1 = start ? start.line + 1 : 1;
        const col1 = start ? start.character + 1 : 1;
        if (wantCode) {
            // Without symbol metadata, render declaration-only kinds directly:
            // their source declaration is all the definition can add. With
            // selected symbol roles, use the normal definition path below so identifiers
            // in the declaration receive reusable positions.
            if (isDeclarationOnlyKind(sym.kind ?? 0) && !symbolRoles?.length) {
                // For declaration-only kinds, show the verbatim source line
                // from the file (not ccls's fully-qualified `name`, which
                // differs from what the user wrote — e.g. ccls renders
                // `using DealableCard = std::unique_ptr<Card>` as
                // `using blackjack::Deck::DealableCard = std::unique_ptr<Card>`).
                const heading = publicInclude ? "definition" : "code";
                let declText: string;
                try {
                    const src = await readFile(path, "utf8");
                    const srcLines = src.split(/\r?\n/);
                    const range = sym.location.range;
                    const sl = range?.start?.line ?? start?.line ?? 0;
                    const el = range?.end?.line ?? sl;
                    declText = srcLines.slice(sl, el + 1).join("\n") || sym.name;
                } catch {
                    declText = sym.name;
                }
                matchBlocks.push(`--- ${heading} ---\n${declText}`);
            } else {
                const section = start
                    ? await renderFanOutCodeSection(
                          path,
                          line1,
                          col1,
                          codeBudget,
                          cwd,
                          clientOf,
                          symbolRoles,
                      )
                    : `(no position to resolve definition)`;
                const heading = publicInclude ? "definition" : "code";
                matchBlocks.push(`--- ${heading} ---\n${section}`);
            }
        }
        if (wantHover) {
            const section = start
                ? await renderFanOutHoverSection(path, line1, col1, cwd, clientOf)
                : `(no position)`;
            matchBlocks.push(`--- hover ---\n${section}`);
        }
        if (wantRefs) {
            const section = start
                ? await renderFanOutRefsSection(path, line1, col1, cwd, clientOf, symbolRoles)
                : `(no position)`;
            matchBlocks.push(`--- references ---\n${section}`);
        }
        blocks.push(matchBlocks.join("\n"));
    }
    return blocks.join("\n\n");
}

/** True when a symbol kind is declaration-only (no multi-line body to
 * surface via `code_definition`). For these kinds the `code` section is
 * skipped in the fan-out — the declaration line is already in the row.
 * Covers ccls extended kind 252 (using-aliases, typedefs) and standard LSP
 * SymbolKinds where the symbol IS the declaration (TypeParameter, Module,
 * Namespace, etc. — anything that is not a function/method/class/struct/enum
 * with a multi-line body). Enum is NOT declaration-only: an enum's
 * enumerator list (`enum class Rank : std::uint16_t { ACE = 1, TWO, ... };`)
 * is a valuable multi-line body that `code_definition` surfaces, so it goes
 * through the normal `code` path. */
function isDeclarationOnlyKind(kind: number): boolean {
    // ccls extended kind: 252 = using-alias / typedef.
    if (kind === 252) return true;
    // Standard LSP SymbolKinds that are declaration-only.
    return (
        kind === 26 || // TypeParameter
        kind === 2 || // Module
        kind === 3 || // Namespace
        kind === 4 || // Package
        kind === 1
    ); // File
}

/** `--- code ---` section: the verbatim source body from `nav.definition`,
 * head-snippeted to `budget` lines. The header (`<defPath>:<sl>-<el>`) shows
 * the FULL body range (not the snippet range) so the agent has the real
 * position for a follow-up `code_definition`. A per-match failure (e.g. no
 * definition found for a workspace/symbol hit that turned out to be a
 * re-export alias) is caught and reported inline as `ERROR: ...` so one bad
 * match doesn't abort the whole fan-out. */
async function renderFanOutCodeSection(
    path: string,
    line: number,
    column: number,
    budget: number,
    cwd: string,
    clientOf: ClientProvider,
    symbolRoles: SymbolRole[] | undefined,
): Promise<string> {
    try {
        const out = await definition(
            { path, line, column, list_symbols: symbolRoles },
            cwd,
            clientOf,
        );
        // `nav.definition` returns `<defPath>:<sl>-<el>\n<body>[\n\n<sym table>]`
        // (single site) or multi-site blocks separated by blank lines + a
        // trailing `# N definitions` count. We head-snippet the WHOLE output
        // to `budget` lines — the first block's body is what the agent needs
        // to decide between matches; the note points at `code_definition` for
        // the full multi-site output if the budget cuts a later site.
        const lines = out.split("\n");
        if (budget > 0 && lines.length > budget) {
            const shown = lines.slice(0, budget).join("\n");
            return `${shown}\n# (showing ${budget} of ${lines.length} lines; use code_definition for full body)`;
        }
        return out;
    } catch (e) {
        // Per-match hard failure (no definition found, cannot read source,
        // cannot resolve body). Report inline so the fan-out keeps the other
        // matches; the agent can call code_definition directly to retry.
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/** `--- hover ---` section: signature-first line + full hover markdown body,
 * uncapped. Reuses `nav.hover` verbatim (which emits an `ERROR  ...` row on
 * recoverable failures — unknown language, cannot read, server unavailable —
 * and a `(no hover information)` note on empty). */
async function renderFanOutHoverSection(
    path: string,
    line: number,
    column: number,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    try {
        return await hover({ path, line, column }, cwd, clientOf);
    } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
}

/** `--- references ---` section: the same AST-aware contextual page returned
 * by code_references. Pagination and total-count reporting are owned by
 * nav.references, so blocks are never split by a line-based post-processor. */
async function renderFanOutRefsSection(
    path: string,
    line: number,
    column: number,
    cwd: string,
    clientOf: ClientProvider,
    symbolRoles: SymbolRole[] | undefined,
): Promise<string> {
    try {
        const out = await references(
            {
                path,
                line,
                column,
                context: "syntax",
                offset: 1,
                limit: SYMBOL_FANOUT_REFS_CAP,
                list_symbols: symbolRoles,
            },
            cwd,
            clientOf,
        );
        const page = /# showing references 1-(\d+) of (\d+)$/.exec(out);
        return page ? `${out}\n(${page[1]} of ${page[2]}, use code_references for all)` : out;
    } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
}
