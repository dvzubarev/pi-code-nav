/**
 * code_search_symbol — symbol search by name across the workspace AND
 * third-party/stdlib trees. The omni entry point for code navigation.
 *
 * Given a `query` (bare or qualified), returns a ranked list of matching
 * symbols. With public `include` non-empty, fans out per exact match (≤ cap)
 * with definition / hover / references sections. See
 * docs/code_search_symbol.md.
 *
 * The per-language query parsing / server-transformation / ranking-rules live
 * in the symbol-search strategies (`src/symbol-search/`). This file is the
 * GENERIC pipeline: server availability, capability check, readiness,
 * third-party-root discovery, dedupe, public kind/regex filters, row
 * rendering and fan-out. There are no per-language ranking branches here.
 */

import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";
import type { LspClient } from "./lsp-client";
import type { Lang } from "./languages/types";
import { detectProjectLanguages } from "./detect";
import { ALL_LANGS, ClientProvider } from "./nav-core";
import { renderSymbolInfo, symbolKindFromName, uriToPath } from "./render";
import { cachedDocumentSymbols, resolveSymbolSelStart } from "./lsp-resolution";
import {
    SYMBOL_FANOUT_MAX_MATCHES,
    renderSymbolFanOut,
    type FanOutMatch,
} from "./symbol-search/fanout";
import type { SymbolRole } from "./syntax/types";
import { strategyFor, type SearchContext } from "./symbol-search/types";
import { discoverPythonRoots } from "./symbol-search/roots/python";

export interface SymbolParams {
    query: string;
    language?: string;
    /** Public agent interface: details to retrieve for each exact match. */
    include?: ("definition" | "hover" | "references")[];
    /** Add line-local metadata for selected roles to included definitions and references. */
    list_symbols?: SymbolRole[];
    /** Public agent interface: LSP symbol kinds to retain. */
    kinds?: string[];
    /** Public agent interface: case-insensitive regexp over rendered names. */
    name_pattern?: string;
    /** Legacy/internal CLI aliases retained for compatibility. */
    info?: ("code" | "hover" | "references")[];
    filter_by_kind?: string[];
    filter_by_regex?: string;
}

/** Soft cap on the number of rows `code_search_symbol` emits per language.
 * ty's fuzzy search can return hundreds of results for a bare common name
 * (`cast` -> ~400, `loads` -> ~120) once third-party/stdlib roots are added;
 * flooding the agent's context with every match defeats the tool's purpose as
 * a quick entry point. Exact-name matches are ALWAYS kept (they're what the
 * agent asked for); only the fuzzy tail is trimmed, with a trailing note. */
const SYMBOL_MAX_ROWS_PER_LANG = 50;

/**
 * Tracks which clients have already had their third-party roots added, so
 * `code_search_symbol` only discovers+adds them once per server per session
 * (the discovery reads env + readdir, and the didChangeWorkspaceFolders
 * notification is idempotent but still costs a round-trip). Keyed by the
 * `LspClient` instance (a per-(cwd, lang) server lives for the session).
 */
const clientsWithRoots = new WeakSet<LspClient>();

/**
 * Third-party/stdlib root discovery, public compatibility wrapper.
 *
 * Kept with its ORIGINAL `(lang, cwd)` signature because
 * `nav.discoverThirdPartyRoots` is called directly by the python e2e helpers
 * (and historically by any caller reaching for the nav surface). Only Python
 * performs discovery; every other language returns `[]` verbatim. New code
 * should use the strategy's `discoverExtraRoots` instead of this wrapper.
 */
export function discoverThirdPartyRoots(lang: Lang, cwd: string): Promise<string[]> {
    if (lang !== "python") return Promise.resolve([]);
    return discoverPythonRoots(cwd);
}

export async function symbol(
    params: SymbolParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    if (params.language !== undefined && !ALL_LANGS.includes(params.language as Lang)) {
        // Defensive: the tool schema (index.ts) already constrains `language`
        // to a StringEnum, but nav.ts is also driven directly by the CLI
        // harness and tests, which bypass that schema. An unchecked cast here
        // would flow into resolveConfig's `DEFAULTS[lang]` lookup and throw a
        // raw "Cannot read properties of undefined" TypeError instead of a
        // clean, agent-readable message.
        throw new Error(
            `Unknown language "${params.language}" — must be one of: ${ALL_LANGS.join(", ")}`,
        );
    }
    // Validate + compile the public name_pattern (or internal compatibility alias).
    const usesPublicPattern = params.name_pattern !== undefined;
    const namePattern = params.name_pattern ?? params.filter_by_regex;
    let regexFilter: RegExp | undefined;
    if (namePattern !== undefined && namePattern !== "") {
        try {
            regexFilter = new RegExp(namePattern, "i");
        } catch (e) {
            const label = usesPublicPattern ? "name_pattern" : "filter_by_regex";
            throw new Error(
                `Invalid ${label} /${namePattern}/: ${e instanceof Error ? e.message : e}`,
            );
        }
    }
    // Compile filter_by_kind → Set<number> (reverse map friendly names to LSP
    // SymbolKind numbers). Unknown names silently match nothing — the agent
    // gets an empty result and notices, which is better than a hard error that
    // blocks a partially-correct filter.
    let kindFilter: Set<number> | undefined;
    const requestedKinds = params.kinds ?? params.filter_by_kind;
    if (requestedKinds && requestedKinds.length > 0) {
        kindFilter = new Set<number>();
        for (const k of requestedKinds) {
            const n = symbolKindFromName(k);
            if (n !== undefined) kindFilter.add(n);
        }
    }
    // Keep every explicitly requested section. Hover often duplicates source,
    // but it can carry inferred types that are absent from the definition.
    const publicInclude = params.include;
    const requestedInfo: ("code" | "hover" | "references")[] = publicInclude
        ? publicInclude.map((item) => (item === "definition" ? "code" : item))
        : (params.info ?? []);
    const info = Array.from(new Set(requestedInfo));
    const wantInfo = info.length > 0;
    const langs: Lang[] = params.language
        ? [params.language as Lang]
        : await detectProjectLanguages(cwd);
    const out: string[] = [];
    // Cache documentSymbol results per file so we don't re-fetch for every hit.
    const docCache = new Map<string, DocumentSymbol[]>();
    // When `info` is non-empty, exact matches across ALL languages are
    // collected here (with their resolved identifier positions) and fanned out
    // after the per-language loop — so a cross-language `query: "foo"` with
    // `info: ["code"]` returns one `== [N] ... ==` block per match, capped at
    // SYMBOL_FANOUT_MAX_MATCHES. The cap is cross-language (not per-language)
    // because the agent asked for detail on N symbols total.
    const fanoutMatches: FanOutMatch[] = [];
    for (const lang of langs) {
        let client: LspClient;
        try {
            client = await clientOf(lang);
        } catch (e) {
            // Missing server binary: skip silently (user: "if I don't have a
            // language server on my PATH I don't want to report it").
            if (/command not found on PATH/.test(String((e as Error)?.message ?? e))) continue;
            out.push(`ERROR  [${lang}]  server unavailable: ${e}`);
            continue;
        }
        if (
            !client.supports(
                "workspaceSymbolProvider" as keyof import("vscode-languageserver-protocol").ServerCapabilities,
            )
        )
            continue;
        // tsserver loads its project lazily on the first didOpen of a file in
        // that project; workspace/symbol throws "No Project." before then.
        // ccls likewise populates its workspace/symbol index by parsing ALL
        // translation units from compile_commands.json — on a cold cache that
        // takes several seconds, and workspace/symbol sees only a subset of
        // TUs until it finishes. ensureProjectLoaded opens one source file and
        // (for ccls) waits for the $/progress "end" signal so the whole
        // project's symbols are findable; for the other servers it's a no-op
        // (they index eagerly on initialize). If it returns false (no source
        // file of this language exists in the workspace), skip the language
        // entirely — calling workspace/symbol on a project-less tsserver throws
        // "No Project." and would abort the whole query.
        if (!(await client.ensureProjectLoaded())) continue;
        const strategy = strategyFor(lang);
        if (!strategy) {
            // Defensive: `detectProjectLanguages` and the caller-supplied
            // `language` are both constrained to the catalog, so this should
            // be unreachable. Fail softly per-language so one bad entry cannot
            // abort results already collected for earlier languages.
            out.push(`ERROR  [${lang}]  no symbol-search strategy`);
            continue;
        }
        // Add third-party/stdlib roots once per server so the symbol search
        // covers third-party trees. Best-effort: failures (no env var, server
        // that doesn't support workspaceFolders) are silent — the query still
        // runs against the workspace root. Only python discovers roots (see
        // its strategy's `discoverExtraRoots`); ccls already indexes
        // third-parties via its compile flags, and the other languages return
        // [].
        if (!clientsWithRoots.has(client)) {
            clientsWithRoots.add(client);
            try {
                const roots = strategy.discoverExtraRoots
                    ? await strategy.discoverExtraRoots(cwd)
                    : [];
                if (roots.length > 0) await client.addWorkspaceFolders(roots);
            } catch {
                // Discovery or folder-add failed — proceed workspace-only.
            }
        }
        // Parse the (possibly qualified) query and compute the server query.
        // For cpp (ccls) the server handles qualified names natively and ranks
        // them, so the strategy passes the FULL query through; the qualifier is
        // still extracted for the bare tail used in ranking. For
        // python/typescript (ty) the server only matches bare names, so the
        // strategy queries with the bare tail and filters results by module
        // path against the qualifier.
        const parsed = strategy.parseQuery(params.query);
        const queryForServer = strategy.queryForServer(parsed);
        let syms: SymbolInformation[];
        try {
            syms = await client.workspaceSymbol(queryForServer);
        } catch (e) {
            // One language failing must not discard results already
            // collected from earlier languages.
            out.push(`ERROR  [${lang}]  workspace/symbol failed: ${e}`);
            continue;
        }
        // Instantiate the search context once for this language: folder list
        // (longest-first), primary root, and the language tag.
        const ctx: SearchContext = {
            lang,
            workspaceFolders: client.workspaceFolderPaths(),
            rootPath: client.rootPath,
            documentSymbols: (uri) => cachedDocumentSymbols(client, uriToPath(uri), docCache),
            workspaceSymbols: (query) => client.workspaceSymbol(query),
        };
        const ranked = await strategy.rank(syms, parsed, ctx);
        // Fan-out mode keeps ONLY exact-name matches (the agent asked for
        // detail on specific symbols, so the fuzzy tail is noise that would
        // inflate the match count past the cap). List mode keeps the full
        // tiered order (exact first, then the substring-guarded fuzzy tail).
        const candidateRows = wantInfo
            ? ranked.ordered.filter((_, i) => ranked.exactIndexes.has(i))
            : ranked.ordered;
        // Dedupe identical (path, line, col, name) rows — ty sometimes
        // returns the same symbol twice (e.g. cbor2.loads appears once per
        // re-export path) and the agent gets no value from the duplicate.
        const seenRows = new Set<string>();
        const deduped: SymbolInformation[] = [];
        for (const s of candidateRows) {
            const start = s.location.range?.start;
            const key = `${s.location.uri}|${start?.line ?? -1}|${start?.character ?? -1}|${s.name}`;
            if (seenRows.has(key)) continue;
            seenRows.add(key);
            deduped.push(s);
        }
        // Post-tier filters (apply in BOTH modes — list and fan-out — so an
        // agent can narrow to a single exact match for fan-out). These run
        // AFTER the tier filter so they narrow the exact-match set rather
        // than re-introducing fuzzy hits the tier dropped.
        let symsFinal = deduped;
        if (kindFilter) symsFinal = symsFinal.filter((s) => kindFilter!.has(s.kind ?? 0));
        if (regexFilter) symsFinal = symsFinal.filter((s) => regexFilter!.test(s.name));
        if (wantInfo) {
            // Fan-out mode: collect matches (with resolved identifier
            // positions) across languages; the actual fan-out / over-cap list
            // renders AFTER the per-language loop so the cap is cross-language.
            for (const s of symsFinal) {
                const selStart = await resolveSymbolSelStart(client, s, docCache);
                fanoutMatches.push({ lang, sym: s, selStart });
            }
            // No per-language row emission in fan-out mode — the matches are
            // rendered as `== [N] ... ==` blocks below. Skip the trim/emit
            // path used by the list mode.
            continue;
        }
        // List mode: render. When the result set is large (third-party/stdlib
        // added), trim the fuzzy tail to keep the output useful — exact-name
        // matches are always preserved (they're what the agent asked for).
        let trimmed = 0;
        let emit = symsFinal;
        if (symsFinal.length > SYMBOL_MAX_ROWS_PER_LANG) {
            emit = symsFinal.slice(0, SYMBOL_MAX_ROWS_PER_LANG);
            trimmed = symsFinal.length - emit.length;
        }
        for (const s of emit) {
            const selStart = await resolveSymbolSelStart(client, s, docCache);
            out.push(`[${lang}] ${renderSymbolInfo(s, selStart)}`);
        }
        if (trimmed > 0) {
            out.push(
                `[${lang}] # ${trimmed} more result(s) trimmed (narrow with a qualified name like "pkg.symbol")`,
            );
        }
    }
    if (wantInfo) {
        // Fan-out mode: render detail for each exact match. The cap is
        // cross-language; over the cap the agent gets a row list + a "narrow"
        // note (trimming at SYMBOL_MAX_ROWS_PER_LANG like list mode so a
        // huge common-name exact set doesn't flood context).
        if (fanoutMatches.length === 0) {
            return `(no symbols matching "${params.query}")`;
        }
        if (fanoutMatches.length <= SYMBOL_FANOUT_MAX_MATCHES) {
            return await renderSymbolFanOut(
                fanoutMatches,
                info,
                params.query,
                cwd,
                clientOf,
                params.list_symbols,
                publicInclude,
            );
        }
        const lines = fanoutMatches
            .slice(0, SYMBOL_MAX_ROWS_PER_LANG)
            .map((m) => `[${m.lang}] ${renderSymbolInfo(m.sym, m.selStart)}`);
        const shown = lines.length;
        const filterNames = publicInclude
            ? "kinds / name_pattern"
            : "filter_by_kind / filter_by_regex";
        let note = `\n# ${fanoutMatches.length} exact matches — narrow with ${filterNames} / a qualified name`;
        if (fanoutMatches.length > shown) note += ` (showing first ${shown})`;
        return lines.join("\n") + note;
    }
    if (out.length === 0) return `(no symbols matching "${params.query}")`;
    return out.join("\n");
}
