/**
 * code_search_symbol — symbol search by name across the workspace AND
 * third-party/stdlib trees. The omni entry point for code navigation.
 *
 * Given a `query` (bare or qualified), returns a ranked list of matching
 * symbols. With `info` non-empty, fans out per exact match (≤ cap) appending
 * verbatim source body / hover / references sections. See
 * docs/code_search_symbol.md.
 */

import { readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";
import type { Lang, LspClient } from "./lsp-client";
import { detectProjectLanguages } from "./detect";
import { ALL_LANGS, ClientProvider } from "./nav-core";
import { definition } from "./definition";
import { hover } from "./hover";
import { references } from "./references";
import { renderSymbolInfo, resolveSymbolSelStart, symbolKindFromName, uriToPath } from "./render";

export interface SymbolParams {
    query: string;
    language?: string;
    /** Optional detail to fan out on each exact match. `code` → the verbatim
     * source body (via code_definition, head-snippeted against a shared line
     * budget); `hover` → signature + docstring; `references` → up to 25 call
     * sites. `hover` is auto-dropped when `code` is present (code is a
     * superset). See docs/code_search_symbol.md. */
    info?: ("code" | "hover" | "references")[];
    /** Optional filter: keep only matches whose LSP SymbolKind matches one of
     * these friendly names (case-insensitive, e.g. `"function"`, `"method"`,
     * `"class"`). Unknown names silently match nothing. */
    filter_by_kind?: string[];
    /** Optional filter: a case-insensitive regexp tested against each match's
     * rendered name column (for cpp the full signature, for py/ts the bare
     * identifier). Applied AFTER the existing tier filter, so it narrows the
     * exact-match set used for fan-out. */
    filter_by_regex?: string;
}

/**
 * The separator used in a qualified symbol name for each language. `.` for
 * Python/TypeScript (`typing.cast`, `fs.readFileSync`), `::` for C++
 * (`std::vector::push_back`), none for bash (no qualified-name concept).
 * Used by code_search_symbol to split an agent-supplied qualified query into
 * `(qualifier, bareName)` so it can (a) query the server with the bare name on
 * servers that only match bare names (ty) and (b) filter the results to the
 * requested module/namespace. ccls (cpp) handles qualified queries natively,
 * so cpp passes the full query through and uses the separator only for
 * extracting the bare tail when ranking.
 */
const QUALIFIED_SEP: Partial<Record<Lang, string>> = {
    python: ".",
    typescript: ".",
    cpp: "::",
};

/** Soft cap on the number of rows `code_search_symbol` emits per language.
 * ty's fuzzy search can return hundreds of results for a bare common name
 * (`cast` -> ~400, `loads` -> ~120) once third-party/stdlib roots are added;
 * flooding the agent's context with every match defeats the tool's purpose as
 * a quick entry point. Exact-name matches are ALWAYS kept (they're what the
 * agent asked for); only the fuzzy tail is trimmed, with a trailing note. */
const SYMBOL_MAX_ROWS_PER_LANG = 50;

/** Max exact matches code_search_symbol fans out over when `info` is
 * non-empty. Over this cap the tool returns a row list + a "narrow with
 * filters" note instead of fanning out — a 10-row fan-out would flood the
 * agent's context with 10 bodies + 10×25 references. The cap protects the
 * common-name case (10 `__init__` methods) while serving the overload case
 * (2-3 sites) the fan-out was designed for. */
const SYMBOL_FANOUT_MAX_MATCHES = 5;

/** Total line budget for the `code` sections across ALL matches in a fan-out,
 * split evenly (`floor(BUDGET / N)` per match). Anchored to pi's
 * `DEFAULT_MAX_LINES` (2000) — the built-in truncation limit for tool output
 * — so a single-match fan-out gets the full 2000 lines (effectively the whole
 * body for any real function, matching `code_definition`'s direct output), and
 * N matches each get a head snippet big enough to decide between them. */
const SYMBOL_FANOUT_CODE_BUDGET_LINES = 2000;

/** Per-match cap on the `references` section in a fan-out. Reuses
 * `nav.references` verbatim (which has no cap) and trims to this many rows,
 * appending a `(N of M, use code_references for all)` note so the agent can
 * reach the full set via the standalone tool. */
const SYMBOL_FANOUT_REFS_CAP = 25;

/**
 * Parse a (possibly qualified) symbol query into `(qualifier, bareName)`.
 * `qualifier` is null when the query has no separator (a bare name). The bare
 * name is the last path component after splitting on the language's
 * separator — e.g. `typing.cast` -> `(qualifier="typing", bare="cast")`,
 * `std::vector::push_back` -> `(qualifier="std::vector", bare="push_back")`.
 * For bash (no separator) the whole query is the bare name.
 */
function parseSymbolQuery(query: string, lang: Lang): { qualifier: string | null; bare: string } {
    const sep = QUALIFIED_SEP[lang];
    if (!sep) return { qualifier: null, bare: query };
    const idx = query.lastIndexOf(sep);
    if (idx < 0) return { qualifier: null, bare: query };
    return {
        qualifier: query.slice(0, idx),
        bare: query.slice(idx + sep.length),
    };
}

/**
 * The filesystem path of the workspace folder a result file lives under, or
 * null when it is under none. `folders` MUST be sorted longest-first so the
 * most specific folder wins (a broad folder like `lib/python3.13` is a prefix
 * of `lib/python3.13/site-packages`). Used by code_search_symbol to tell
 * workspace-root results from third-party ones.
 */
function homeFolderOf(uri: string, folders: string[]): string | null {
    const p = uriToPath(uri);
    for (const f of folders) {
        if (p === f || p.startsWith(f + sep)) return f;
    }
    return null;
}

/**
 * Derive the dotted module path of a result file relative to its home folder
 * (the longest matching workspace folder), for Python/TypeScript qualified-
 * name filtering.
 *
 * `folders` MUST be sorted longest-first (see `LspClient.workspaceFolderPaths`)
 * so a specific folder (`lib/python3.13/site-packages`) wins over a broad one
 * (`lib/python3.13`) that is a prefix of it. Returns e.g. `cbor2._decoder` for
 * `.../site-packages/cbor2/_decoder.py`, `typing` for `.../python3.13/typing.py`.
 * `__init__.py` maps to the package name (the containing dir name). For a
 * workspace-root file the result is the project-relative path (e.g. `second`
 * for `.../workspace/second.py`); callers distinguish workspace vs third-party
 * with `homeFolderOf` (the home folder equals `rootPath` or not).
 */
function modulePathOf(uri: string, folders: string[]): string | null {
    const p = uriToPath(uri);
    const f = homeFolderOf(uri, folders);
    if (!f || p === f) return null;
    let rel = p
        .slice(f.length + 1)
        .replace(/\.py[i]?$/, "")
        .replace(/\.ts$/, "")
        .replace(/\.tsx$/, "");
    // __init__ -> the package (the containing dir name).
    if (rel.endsWith("/__init__")) rel = rel.slice(0, -9);
    return rel.split(/[/\\]/).join(".");
}

/**
 * Discover third-party / stdlib roots to add as extra workspace folders for
 * `code_search_symbol`, so servers whose default index is workspace-only
 * (notably `ty`) can find symbols in third-party trees.
 *
 * The discovery is environment-driven and nix-aware (the user's primary
 * environment), with a generic fallback:
 *
 *   - Python (`ty`): from `$propagatedBuildInputs` (nix — each entry is a
 *     package prefix; we add `lib/pythonX.Y` (stdlib) and
 *     `lib/pythonX.Y/site-packages` (installed packages)). `$PYTHONPATH` is
 *     ONLY consulted when `$propagatedBuildInputs` is absent — in a typical
 *     nix shell `$PYTHONPATH` carries the FULL transitive dependency closure
 *     (every dependency-of-a-dependency's site-packages), which is a large,
 *     rarely-queried set that would cost ty real index time and inflate the
 *     fuzzy-result tail for bare-name queries. The project's direct deps
 *     (from `$propagatedBuildInputs`) is the targeted set the agent actually
 *     searches. In a regular venv/conda (no `$propagatedBuildInputs`)
 *     `$PYTHONPATH` is the venv's own (small, direct) site-packages and is
 *     the only source, so it's fine to use it then. ccls does NOT use this
 *     — it indexes third-parties via its compilation database's `-isystem`
 *     flags, so adding folders to ccls would just re-parse them as source
 *     trees for no benefit (and real indexing cost).
 *   - C++ / TypeScript / bash: no env-driven discovery (ccls already covers
 *     C++; the others have no third-party symbol-search story this improves).
 *
 * Returns distinct absolute paths that exist and are not the cwd itself.
 * Best-effort: never throws — a missing env var or unreadable dir yields [].
 * Existence is NOT checked here (the caller's `addWorkspaceFolders` is the
 * source of truth and tolerates missing dirs); we only dedupe and skip the
 * cwd to avoid adding the workspace root a second time.
 */
export async function discoverThirdPartyRoots(lang: Lang, cwd: string): Promise<string[]> {
    if (lang !== "python") return [];
    const roots = new Set<string>();
    const seen = new Set<string>();
    const add = (p: string | undefined) => {
        if (!p) return;
        let abs: string;
        try {
            abs = resolve(p);
        } catch {
            return;
        }
        // Skip the cwd (already the server's root folder).
        if (abs === resolve(cwd)) return;
        if (seen.has(abs)) return;
        seen.add(abs);
        roots.add(abs);
    };

    // $propagatedBuildInputs (nix): space-separated package prefixes.
    // Each entry is a DIRECT dependency of the project (not transitive),
    // so this is the targeted set the agent actually searches.
    const prop = (process.env.propagatedBuildInputs ?? "").split(/\s+/).filter(Boolean);
    for (const pkg of prop) {
        // Discover `lib/pythonX.Y` and `lib/pythonX.Y/site-packages` under each.
        const lib = resolve(pkg, "lib");
        let entries;
        try {
            entries = await readdir(lib, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (!/^python\d+\.\d+$/.test(e.name)) continue;
            add(resolve(lib, e.name)); // stdlib (e.g. typing.py lives here)
            add(resolve(lib, e.name, "site-packages")); // installed packages
        }
    }
    // $PYTHONPATH is ONLY consulted when $propagatedBuildInputs is absent.
    // In a nix shell $PYTHONPATH carries the full transitive closure (deep,
    // rarely-queried, costly to index); $propagatedBuildInputs gives the
    // direct deps. In a regular venv/conda (no $propagatedBuildInputs)
    // $PYTHONPATH is the venv's own small site-packages and is the only source.
    if (prop.length === 0) {
        for (const p of (process.env.PYTHONPATH ?? "").split(":").filter(Boolean)) add(p);
    }

    return [...roots];
}

/**
 * Tracks which clients have already had their third-party roots added, so
 * `code_search_symbol` only discovers+adds them once per server per session
 * (the discovery reads env + readdir, and the didChangeWorkspaceFolders
 * notification is idempotent but still costs a round-trip). Keyed by the
 * `LspClient` instance (a per-(cwd, lang) server lives for the session).
 */
const clientsWithRoots = new WeakSet<LspClient>();

/** Parse a cpp workspace/symbol `name` (a full C++ qualified signature like
 * `void diskann::Index::occlude_list(const uint32_t location, ...)`) into its
 * qualifier-token chain and bare identifier. Used by code_search_symbol's
 * token-level exact-match rule for cpp, replacing the old substring check
 * (`name.includes("::" + bare)`) which incorrectly ranked
 * `std::my_vector::push_back` as an exact match for `vector::push_back` — the
 * `_` token boundary wasn't honored.
 *
 * The ccls `name` is a declarator + return type + parameter list — except for
 * `using`-alias and `typedef` declarations, where ccls formats the name as
 * `using <qual>::<name> = <type>` or `typedef <type> <qual>::<name>`. We detect
 * these by the first token: `using`-alias (name starts with "using" and
 * contains "=") extracts the name from between "using " and "=";
 * `using`-declarations ("using <qual>::<member>", no "=") and `typedef` both
 * parse via the general last-token rule (correct because the defined name is
 * the last qualified identifier). For all other forms we strip the parameter
 * list (everything from the first `(`), take the last whitespace-separated
 * token (the qualified declarator, after stripping leading `&`/`*` ref/pointer
 * qualifiers), drop one `<...>` template-arg group, then split on `::`. The
 * last `::`-separated component is the bare identifier; the rest is the
 * qualifier chain.
 *
 * Examples:
 *   `void diskann::Index::occlude_list(...)`
 *     → qual=["diskann","Index"], bare="occlude_list"
 *   `std::vector<uint32_t> diskann::InMemQueryScratch::_occlude_list_output`
 *     → qual=["diskann","InMemQueryScratch"], bare="_occlude_list_output"
 *   `struct AlphaGadget` → qual=[], bare="AlphaGadget"
 *   `push_back`           → qual=[], bare="push_back"
 *   `using my_type_t = int`
 *     → qual=[], bare="my_type_t"
 *   `using MyGadget::inner_type = int`
 *     → qual=["MyGadget"], bare="inner_type"
 *   `using std::pmr::vector = std::vector<_Tp, polymorphic_allocator<_Tp>>`
 *     → qual=["std","pmr"], bare="vector"
 *   `typedef _Vector_base<_Tp, _Alloc> std::vector::_Base`
 *     → qual=["std","vector"], bare="_Base"
 *   `using _Base::_M_allocate`
 *     → qual=["_Base"], bare="_M_allocate"
 *   `TM_TRAIN_CODEC = 1` (ccls enum member)
 *     → qual=[], bare="TM_TRAIN_CODEC"
 *   `struct temp::detail::int_helper {}` (ccls struct with trailing ` {}`)
 *     → qual=["temp","detail"], bare="int_helper"
 *   `template<> struct temp::detail::int_helper<int> {}`
 *     → qual=["temp","detail"], bare="int_helper" (after dropping `<int>` template args) */
function parseCppSymbolName(name: string): {
    qualifierTokens: string[];
    bare: string;
} {
    let s = name;
    // Strip the parameter list: everything from the first `(`. ccls's
    // workspace/symbol `name` has at most one `(...)` (the function's); return
    // types don't contain `(` for the cases we handle.
    const parenIdx = s.indexOf("(");
    if (parenIdx >= 0) s = s.slice(0, parenIdx);
    s = s.trim();

    // Handle `using NAME = TYPE` (ccls name: `using <qual>::<name> = <type>`).
    // We detect this by the first token being "using" AND the name containing
    // "=". `using`-declarations ("using _Base::_M_allocate", no "=") fall
    // through to the general last-token rule, which correctly picks up the
    // member name. `typedef <type> <qual>::<name>` also falls through — the
    // last qualified identifier IS the defined name.
    if (s.startsWith("using ") && s.includes("=")) {
        // Extract the substring between "using " and " =" (or "=").
        // The equal sign is always on the top level (not inside <> template
        // args) because ccls formats these names with a top-level " = ".
        const eqIdx = s.indexOf("=");
        const between = s.slice(6, eqIdx).trim(); // 6 = "using ".length
        // `between` is a (possibly qualified) name like `my_type_t` or
        // `MyGadget::inner_type` or `std::pmr::vector`. Split on `::`.
        const parts = between.split("::").filter((p) => p.length > 0);
        if (parts.length === 0) return { qualifierTokens: [], bare: "" };
        return { qualifierTokens: parts.slice(0, -1), bare: parts[parts.length - 1] };
    }

    // Strip ` = VALUE` suffix (ccls appends e.g. ` = 1` for enum members).
    // This handles all non-`using` forms where ccls appends " = <value>".
    // Look for a top-level ` = ` (not inside `<>`) — the `=` is always at the
    // top level in ccls's name formatting for enum members.
    const eqIdx = s.indexOf(" = ");
    if (eqIdx >= 0 && !s.includes("<") && !s.includes(">")) {
        // No angle brackets — safe to strip from " = " onward.
        s = s.slice(0, eqIdx);
    } else if (eqIdx >= 0) {
        // Angle brackets present — verify the `=` is at the top level by
        // counting angle-bracket depth up to eqIdx.
        let depth = 0;
        let topLevelEq = -1;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === "<") depth++;
            else if (ch === ">") depth--;
            else if (ch === "=" && depth === 0) {
                // Found a top-level `=`. Check it starts with " = ".
                if (i > 0 && s[i - 1] === " " && i + 1 < s.length && s[i + 1] === " ") {
                    topLevelEq = i;
                    break;
                }
            }
        }
        if (topLevelEq >= 0) {
            s = s.slice(0, topLevelEq).trim();
        }
    }

    // Strip trailing ` {}` — ccls appends ` {}` (empty braces) to the end of
    // struct/class/interface definitions (e.g. `struct Foo {}`). The braces
    // are always empty; ccls never includes the body in the name.
    if (s.endsWith("}")) {
        const braceIdx = s.lastIndexOf("{");
        if (braceIdx >= 0 && s.slice(braceIdx + 1).trim() === "}") {
            s = s.slice(0, braceIdx).trim();
        }
    }

    // Strip trailing ` : <inheritance-clause>` suffix — ccls appends this
    // for typed enums (`enum Foo : int {}`) and struct/class inheritances
    // (`struct Derived : Base {}`, `struct Derived : NS::Base {}`,
    // `class Foo : public Bar {}`). After `{}` stripping above, find the
    // last ` : ` (space-colon-space) and strip everything from it onward.
    const lastColonSpace = s.lastIndexOf(" : ");
    if (lastColonSpace >= 0) {
        s = s.slice(0, lastColonSpace).trim();
    }

    // General case: the last whitespace-separated token is the qualified
    // declarator (after return type). Strip leading `&`/`*` (ref/pointer
    // qualifiers on the decl).
    const tokens = s.split(/\s+/).filter(Boolean);
    let last = tokens.length > 0 ? tokens[tokens.length - 1] : "";
    last = last.replace(/^[&*]+\s*/, "");
    // Drop ONE template-arg group `<...>` from the declarator token (e.g.
    // `foo<int>` → `foo`; `vector<uint32_t>::iterator` → `vector::iterator`).
    const ltIdx = last.indexOf("<");
    if (ltIdx >= 0) {
        const gtIdx = last.lastIndexOf(">");
        if (gtIdx > ltIdx) last = last.slice(0, ltIdx) + last.slice(gtIdx + 1);
    }
    const parts = last.split("::").filter((p) => p.length > 0);
    if (parts.length === 0) return { qualifierTokens: [], bare: "" };
    return { qualifierTokens: parts.slice(0, -1), bare: parts[parts.length - 1] };
}

/** Token-level exact-match test for cpp. A candidate is "exact" iff:
 *   - the candidate's bare identifier equals the query's bare name, AND
 *   - for a qualified query, the query's qualifier-token chain is a SUFFIX of
 *     the candidate's qualifier-token chain (token-level, so `vector` matches
 *     `std::vector` and `mystd::vector` but NOT `std::my_vector` — the `_`
 *     token boundary is honored).
 * For a bare query (empty qualifier tokens), only bare equality is required.
 *
 * Replaces the old substring check, which ranked
 * `std::my_vector::push_back` as exact for `vector::push_back`. See
 * docs/code_search_symbol.md. */

function isCppExactMatch(
    queryQualifierTokens: string[],
    queryBare: string,
    candidateName: string,
): boolean {
    const { qualifierTokens, bare } = parseCppSymbolName(candidateName);
    if (bare !== queryBare) return false;
    if (queryQualifierTokens.length === 0) return true; // bare query
    if (qualifierTokens.length < queryQualifierTokens.length) return false;
    const offset = qualifierTokens.length - queryQualifierTokens.length;
    for (let i = 0; i < queryQualifierTokens.length; i++) {
        if (qualifierTokens[offset + i] !== queryQualifierTokens[i]) return false;
    }
    return true;
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
    // Validate + compile filter_by_regex up front (hard error on a bad regexp,
    // matching code_tree/code_scan's pattern contract) so the agent learns the
    // syntax fast rather than getting a silent no-op filter mid-pipeline.
    let regexFilter: RegExp | undefined;
    if (params.filter_by_regex !== undefined && params.filter_by_regex !== "") {
        try {
            regexFilter = new RegExp(params.filter_by_regex, "i");
        } catch (e) {
            throw new Error(
                `Invalid filter_by_regex /${params.filter_by_regex}/: ${
                    e instanceof Error ? e.message : e
                }`,
            );
        }
    }
    // Compile filter_by_kind → Set<number> (reverse map friendly names to LSP
    // SymbolKind numbers). Unknown names silently match nothing — the agent
    // gets an empty result and notices, which is better than a hard error that
    // blocks a partially-correct filter.
    let kindFilter: Set<number> | undefined;
    if (params.filter_by_kind && params.filter_by_kind.length > 0) {
        kindFilter = new Set<number>();
        for (const k of params.filter_by_kind) {
            const n = symbolKindFromName(k);
            if (n !== undefined) kindFilter.add(n);
        }
    }
    // Normalize `info`: drop `hover` when `code` is present (code is a
    // superset — the body carries the signature; the doc comment is already
    // prepended by renderSnippetBlock's findEnclosingDefWithDoc path). This
    // dedup happens once, here, so the fan-out renderer can trust `info`.
    let info: ("code" | "hover" | "references")[] = [];
    if (params.info) {
        const raw = params.info.filter((i) => i === "code" || i === "hover" || i === "references");
        info = raw.includes("code") ? raw.filter((i) => i !== "hover") : raw;
    }
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
    const fanoutMatches: Array<{
        lang: Lang;
        sym: SymbolInformation;
        selStart?: { line: number; character: number };
    }> = [];
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
        // Add third-party/stdlib roots once per server so the symbol search
        // covers third-party trees. Best-effort: failures (no env var, server
        // that doesn't support workspaceFolders) are silent — the query still
        // runs against the workspace root. Only python (ty) discovers roots;
        // ccls already indexes third-parties via its compile flags, and the
        // other languages return [] (see discoverThirdPartyRoots).
        if (!clientsWithRoots.has(client)) {
            clientsWithRoots.add(client);
            try {
                const roots = await discoverThirdPartyRoots(lang, cwd);
                if (roots.length > 0) await client.addWorkspaceFolders(roots);
            } catch {
                // Discovery or folder-add failed — proceed workspace-only.
            }
        }
        // Parse the (possibly qualified) query. For cpp (ccls) the server
        // handles qualified names natively and ranks them, so we pass the
        // FULL query through; the qualifier is still extracted for the bare
        // tail used in ranking. For python/typescript (ty) the server only
        // matches bare names, so we query with the bare tail and filter
        // results by module path against the qualifier.
        const { qualifier, bare } = parseSymbolQuery(params.query, lang);
        const queryForServer = lang === "cpp" ? params.query : bare;
        let syms: SymbolInformation[];
        try {
            syms = await client.workspaceSymbol(queryForServer);
        } catch (e) {
            // One language failing must not discard results already
            // collected from earlier languages.
            out.push(`ERROR  [${lang}]  workspace/symbol failed: ${e}`);
            continue;
        }
        // For python/typescript: when a qualifier is present, the agent asked
        // for a SPECIFIC symbol (e.g. `typing.cast`, `cbor2.loads`). Keep ONLY
        // exact-name matches whose module path matches the qualifier — fuzzy
        // partials in the same module are noise. A qualifier implies a third-
        // party request, so workspace-root results (whose home folder is
        // `rootPath`, i.e. module path is project-relative, not a third-party
        // dotted module) are dropped — they don't carry the qualifier.
        if (lang !== "cpp" && qualifier !== null) {
            // Qualified query (python/typescript): the agent asked for a
            // SPECIFIC symbol like `typing.cast`, `cbor2.loads`,
            // `aiohttp.StreamReader.iter_chunks`, or `aiohttp.web.Request`.
            // ty does NOT support qualified names natively (querying
            // "typing.cast" returns 0) and does NOT populate
            // `SymbolInformation.containerName` (confirmed: every Python
            // server — ty, pyrefly, pyright — leaves it null), so we query
            // with the bare tail and tier the results by how well the
            // qualifier relates to each hit's defining module path.
            //
            // The qualifier is split on the language separator; the bare tail
            // is the last component. `modulePathOf` derives a dotted module
            // path from the result file's location. Three tiers, first
            // non-empty wins (so a precise qualifier is never drowned by the
            // broad fallback):
            //   Q1 — exact name, third-party, module path matches the
            //        qualifier precisely (`mod === qualifier` or
            //        `mod.startsWith(qualifier + ".")`). This is the happy
            //        path: `typing.cast` -> `typing`, `cbor2.loads` ->
            //        `cbor2._decoder` (matches `cbor2.`).
            //   Q2 — exact name, third-party, module path shares the
            //        qualifier's LEADING component. The qualifier's leading
            //        component is its first path segment (e.g. `aiohttp` for
            //        `aiohttp.StreamReader` and `aiohttp.web`). This catches
            //        the two cases `modulePathOf`-vs-qualifier mismatch that
            //        a precise match silently dropped before:
            //          * `aiohttp.StreamReader.iter_chunks`: the qualifier's
            //            `StreamReader` is a CLASS, not a module — the method
            //            lives in `aiohttp.streams`. Leading component `aiohttp`
            //            matches.
            //          * `aiohttp.web.Request`: `Request` is defined in
            //            `aiohttp.web_request` (re-exported from `aiohttp.web`).
            //            `aiohttp.web_request` does NOT `.startsWith("aiohttp.web.")`
            //            (the `_` breaks the `.` boundary), but its leading
            //            component `aiohttp` matches.
            //        A workspace-root hit is excluded (a bare name in the
            //        workspace almost always means the agent's own symbol,
            //        not a third-party one).
            //   Q3 — exact name, third-party, anything else. Last resort so a
            //        qualified query never returns empty when exact-name
            //        third-party hits exist; the agent can disambiguate from
            //        the rendered paths.
            // Fuzzy/partial-name matches are ALWAYS dropped for a qualified
            // query — the agent asked for a specific symbol, so fuzzy noise
            // (e.g. `RequestHandler` for `aiohttp.web.Request`) is not useful.
            const folders = client.workspaceFolderPaths();
            // Case-SENSITIVE name match for a qualified query: the agent
            // spelled the exact symbol (`Request`, not `request`), so a
            // case variant is a different symbol and would be noise. (The
            // bare-query path below is case-insensitive because ty's fuzzy
            // search returns case variants and a bare name is ambiguous;
            // a qualified query is not.)
            const exactName = (s: SymbolInformation): boolean => s.name === bare;
            const qualLeading = qualifier.split(QUALIFIED_SEP[lang]!)[0];
            const isThirdParty = (s: SymbolInformation): boolean => {
                const home = homeFolderOf(s.location.uri, folders);
                return !!home && home !== client.rootPath;
            };
            const modLeadingCmp = (uri: string): string | null => {
                const mod = modulePathOf(uri, folders);
                if (mod === null) return null;
                return mod.split(".")[0];
            };
            const exactThirdParty = syms.filter((s) => exactName(s) && isThirdParty(s));
            const q1 = exactThirdParty.filter((s) => {
                const mod = modulePathOf(s.location.uri, folders);
                return mod !== null && (mod === qualifier || mod.startsWith(qualifier + "."));
            });
            const q2 = exactThirdParty.filter((s) => {
                const lead = modLeadingCmp(s.location.uri);
                return lead !== null && lead === qualLeading;
            });
            const q3 = exactThirdParty;
            syms = q1.length > 0 ? q1 : q2.length > 0 ? q2 : q3;
            // TODO(future): precise container disambiguation via documentSymbol.
            //   Q2 (leading-component fallback) is deliberately loose — it
            //   returns every exact-name hit whose module shares the
            //   qualifier's leading package, so `aiohttp.StreamReader.iter_chunks`
            //   returns the one `iter_chunks` in `aiohttp.streams` (correct)
            //   but `aiohttp.SomeClass.method` would return every `method` in
            //   any `aiohttp.*` module if several existed. When Q2 is ambiguous
            //   (len > 1) AND the qualifier's tail (last component before the
            //   bare name, e.g. `StreamReader`) looks like a CLASS name, we
            //   could `documentSymbol` each Q2 hit's file (cached in `docCache`,
            //   so shared with the resolveSymbolSelStart path below) and keep
            //   only the hits whose ancestor chain in the hierarchical
            //   DocumentSymbol tree contains that tail. workspace/symbol is
            //   flat and leaves `containerName` null on every Python server
            //   (ty/pyrefly/pyright) and on ccls, but the hierarchical
            //   documentSymbol tree DOES carry the class container (verified:
            //   `iter_chunks`'s ancestor in streams.py is `StreamReader`).
            //   This is a per-result extra round-trip, so gate it behind Q2
            //   being non-empty AND ambiguous (len > 1) — the common
            //   single-hit Q2 case needs no extra work. Not implemented yet:
            //   the current Q2/Q3 fallback is correct for the reported cases
            //   and the ambiguous case is rare; add this only if an agent
            //   hits a genuinely ambiguous Q2 in practice.
        } else {
            // Bare query, or cpp. Tier the results so the agent sees the most
            // relevant matches first and is not flooded with third-party fuzzy
            // noise once third-party/stdlib roots are added:
            //   T1 — exact name in the workspace root (the agent's own code;
            //        a bare name almost always means their symbol).
            //   T2 — exact name in third-party/stdlib (e.g. bare `loads` with
            //        no workspace `loads` -> cbor2.loads, json.loads, ...).
            //   T3 — fuzzy matches whose name CONTAINS the bare query as a
            //        substring (kept only when T1 is empty, after T2, and
            //        trimmed at SYMBOL_MAX_ROWS_PER_LANG). Fuzzy hits that
            //        don't even share a substring with the query (e.g.
            //        `using thrust::iterator_traversal<...>` for `occlude_list`,
            //        `encode_stringref_namespace` for `tempc`) are pure noise
            //        that bloats context — they're dropped. The agent almost
            //        always wants results that at least match by substring.
            // When T1 is non-empty, emit ONLY T1 (drop T2/T3) — the agent's
            // bare name is their symbol, and third-party fuzzy hits like
            // `encode_stringref_namespace` for query `tempc` are pure noise.
            // When T1 is empty, emit T2 then T3 (trimmed). For cpp (ccls) the
            // `name` is a full signature; "exact" is a TOKEN-LEVEL match
            // (isCppExactMatch: bare equality +, for a qualified query, the
            // query's qualifier-token chain is a suffix of the candidate's) —
            // so `vector::push_back` ranks `std::vector::push_back` and
            // `mystd::vector::push_back` as exact but NOT
            // `std::my_vector::push_back` (the `_` token boundary is honored),
            // and a bare `push_back` ranks `std::vector::push_back` but NOT
            // `std::vector::push_back_int`. The T3 substring filter then drops
            // the rest of the noise (the `thrust::iterator_*` rows ccls's
            // fuzzy ranker surfaces for almost any query).
            const folders = client.workspaceFolderPaths();
            // ty's workspace/symbol is case-INSENSITIVE fuzzy, so `s.name`
            // may differ in case from the bare query (`TempC` for query `tempc`).
            // The "exact name" check must therefore be case-insensitive for
            // python/typescript. C++ (ccls) is case-sensitive and `name` is a
            // full signature, so cpp uses the token-level rule (isCppExactMatch)
            // rather than a plain equality.
            const caseInsensitive = lang === "python" || lang === "typescript";
            const bareCmp = caseInsensitive ? bare.toLowerCase() : bare;
            // Query qualifier tokenized on `::` for the cpp token-suffix rule.
            // Empty for a bare cpp query (qualifier === null).
            const queryQualifierTokens: string[] =
                qualifier !== null && lang === "cpp" ? qualifier.split("::").filter(Boolean) : [];
            // Loose substring match — the name contains the bare query as a
            // substring. Used to filter out the ccls/ty fuzzy tail that
            // doesn't even share a substring with the query. Without this
            // guard a bare cpp query like `occlude_list` lets through
            // `using thrust::iterator_traversal<...>` (no `occlude_list`
            // substring at all) and a bare python query like `tempc` lets
            // through `encode_stringref_namespace` — both pure context-bloat.
            const nameHasBare = (s: SymbolInformation): boolean => {
                const nm = caseInsensitive ? s.name.toLowerCase() : s.name;
                return nm.includes(bareCmp);
            };
            const isExact = (s: SymbolInformation): boolean => {
                if (lang === "cpp") {
                    // cpp `name` is a full C++ qualified signature
                    // (`void diskann::Index::occlude_list(...)`). Token-level
                    // exact: bare equality + (for a qualified query) the query's
                    // qualifier-token chain is a SUFFIX of the candidate's. This
                    // replaces the old substring check, which ranked
                    // `std::my_vector::push_back` as exact for
                    // `vector::push_back` (the `_` token boundary wasn't
                    // honored). See isCppExactMatch / parseCppSymbolName.
                    return isCppExactMatch(queryQualifierTokens, bare, s.name);
                }
                // py/ts: case-insensitive bare-name equality.
                return s.name.toLowerCase() === bareCmp;
            };
            const inWorkspaceRoot = (s: SymbolInformation): boolean => {
                const home = homeFolderOf(s.location.uri, folders);
                return !!home && home === client.rootPath;
            };
            const t1 = syms.filter((s) => isExact(s) && inWorkspaceRoot(s));
            const t2 = syms.filter((s) => isExact(s) && !inWorkspaceRoot(s));
            if (t1.length > 0) {
                // Bare name resolved to the agent's own symbol — drop all
                // third-party/fuzzy noise.
                syms = t1;
            } else {
                // T3 fuzzy tail: keep only results whose name contains the
                // bare query as a substring. The agent almost always wants
                // results that at least match by substring; fuzzy hits
                // without a shared substring are pure noise that bloats
                // context. Exact matches are already in t2; this only
                // scopes the fuzzy tail.
                const t3 = syms.filter((s) => !isExact(s) && nameHasBare(s));
                // When `info` is non-empty (fan-out mode), drop the fuzzy T3
                // tail entirely — the agent asked for detail on specific
                // symbols, so fuzzy partial-name matches are noise that would
                // inflate the match count past the fan-out cap. Only exact
                // matches (t2) are kept; the agent narrows with filters or a
                // qualified name if it wants a specific fuzzy hit.
                syms = wantInfo ? t2 : [...t2, ...t3];
            }
        }
        // Dedupe identical (path, line, col, name) rows — ty sometimes
        // returns the same symbol twice (e.g. cbor2.loads appears once per
        // re-export path) and the agent gets no value from the duplicate.
        const seenRows = new Set<string>();
        const deduped: SymbolInformation[] = [];
        for (const s of syms) {
            const start = s.location.range?.start;
            const key = `${s.location.uri}|${start?.line ?? -1}|${start?.character ?? -1}|${s.name}`;
            if (seenRows.has(key)) continue;
            seenRows.add(key);
            deduped.push(s);
        }
        syms = deduped;
        // Post-tier filters (apply in BOTH modes — list and fan-out — so an
        // agent can narrow to a single exact match for fan-out). These run
        // AFTER the tier filter so they narrow the exact-match set rather
        // than re-introducing fuzzy hits the tier dropped.
        if (kindFilter) syms = syms.filter((s) => kindFilter!.has(s.kind ?? 0));
        if (regexFilter) syms = syms.filter((s) => regexFilter!.test(s.name));
        if (wantInfo) {
            // Fan-out mode: collect matches (with resolved identifier
            // positions) across languages; the actual fan-out / over-cap list
            // renders AFTER the per-language loop so the cap is cross-language.
            for (const s of syms) {
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
        let emit = syms;
        if (syms.length > SYMBOL_MAX_ROWS_PER_LANG) {
            emit = syms.slice(0, SYMBOL_MAX_ROWS_PER_LANG);
            trimmed = syms.length - emit.length;
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
            return await renderSymbolFanOut(fanoutMatches, info, params.query, cwd, clientOf);
        }
        const lines = fanoutMatches
            .slice(0, SYMBOL_MAX_ROWS_PER_LANG)
            .map((m) => `[${m.lang}] ${renderSymbolInfo(m.sym, m.selStart)}`);
        const shown = lines.length;
        let note = `\n# ${fanoutMatches.length} exact matches — narrow with filter_by_kind / filter_by_regex / a qualified name`;
        if (fanoutMatches.length > shown) note += ` (showing first ${shown})`;
        return lines.join("\n") + note;
    }
    if (out.length === 0) return `(no symbols matching "${params.query}")`;
    return out.join("\n");
}

// ---------------------------------------------------------------------------
// code_search_symbol — fan-out renderer
//
// When `info` is non-empty and the post-tier/filter/dedupe pipeline leaves
// ≤ SYMBOL_FANOUT_MAX_MATCHES exact matches, `symbol()` hands the matches to
// `renderSymbolFanOut`, which emits one `== [N] ... ==` block per match and,
// within each, a `--- section ---` block for each requested `info` kind
// (`code` / `hover` / `references`). The fan-out reuses the existing
// `nav.definition` / `nav.hover` / `nav.references` functions (the SAME code
// path the standalone tools use — the CLI and tests exercise it too), with
// two caps:
//   - `code`: head-snippeted to `floor(SYMBOL_FANOUT_CODE_BUDGET_LINES / N)`
//     lines per match (2000 split evenly), with a
//     `# (showing X of Y lines; use code_definition for full body)` note.
//     Single match → full 2000-line budget (effectively the whole body —
//     matches `code_definition`'s direct output).
//   - `references`: trimmed to SYMBOL_FANOUT_REFS_CAP (25) rows with a
//     `(N of M, use code_references for all)` note.
// `hover` is uncapped (docstrings are auxiliary; the 2000-line code budget is
// the single dominant knob). `hover` is auto-dropped by `symbol()` when
// `code` is present (code is a superset — the body carries the signature,
// and the doc comment is already prepended by renderSnippetBlock).
// ---------------------------------------------------------------------------

/** One match in a fan-out: the language it was found under, the LSP
 * SymbolInformation (with its `location`), and the resolved identifier
 * position (selectionRange.start) used to drive the detail tools. */
interface FanOutMatch {
    lang: Lang;
    sym: SymbolInformation;
    selStart?: { line: number; character: number };
}

/** Render the full fan-out: a `# N match(es) for ...` header, then one
 * `== [i] [lang] <row> ==` block per match, each containing the requested
 * `--- section ---` blocks in order: code, then hover (if not deduped), then
 * references. Blocks are blank-line-separated.
 *
 * The `code` section is SKIPPED for symbol kinds whose definition IS the
 * declaration — there is no multi-line body to show, and `code_definition`
 * just echoes the line already in the row. This includes ccls extended kind
 * 252 (using-aliases, typedefs) and any standard LSP kind where the body
 * would be the declaration line itself (Enum 10, TypeParameter 26, etc. —
 * singletons, not methods/functions/classes). The agent can always call
 * `code_definition` directly if it needs the raw line. */
async function renderSymbolFanOut(
    matches: FanOutMatch[],
    info: ("code" | "hover" | "references")[],
    query: string,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const n = matches.length;
    const wantCode = info.includes("code");
    const wantHover = info.includes("hover");
    const wantRefs = info.includes("references");
    // Even split of the code budget across matches; wantCode===false → unused.
    const codeBudget = wantCode ? Math.floor(SYMBOL_FANOUT_CODE_BUDGET_LINES / Math.max(1, n)) : 0;
    const blocks: string[] = [];
    blocks.push(`# ${n} match${n === 1 ? "" : "es"} for "${query}" — info: ${info.join(", ")}`);
    for (let i = 0; i < n; i++) {
        const { lang, sym, selStart } = matches[i];
        const row = `[${lang}] ${renderSymbolInfo(sym, selStart)}`;
        const matchBlocks: string[] = [`== [${i + 1}] ${row} ==`];
        const path = uriToPath(sym.location.uri);
        const start = selStart ?? sym.location.range?.start;
        const line1 = start ? start.line + 1 : 1;
        const col1 = start ? start.character + 1 : 1;
        if (wantCode) {
            // Skip `code` for declaration-only symbol kinds where the
            // definition IS the declaration line (already shown in the row):
            // ccls extended kind 252 (using-aliases, typedefs) and standard
            // LSP kinds whose body adds nothing (Enum, TypeParameter, etc.).
            // The agent can still call code_definition directly.
            if (isDeclarationOnlyKind(sym.kind ?? 0)) {
                // For declaration-only kinds, the ccls `name` *is* the
                // definition — e.g. "using my_alias = int" or
                // "typedef int my_typedef". Show it inline instead of
                // running code_definition (which would return the same line).
                matchBlocks.push(`--- code ---\n${sym.name}`);
            } else {
                const section = start
                    ? await renderFanOutCodeSection(path, line1, col1, codeBudget, cwd, clientOf)
                    : `(no position to resolve definition)`;
                matchBlocks.push(`--- code ---\n${section}`);
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
                ? await renderFanOutRefsSection(path, line1, col1, cwd, clientOf)
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
 * SymbolKinds where the symbol IS the declaration (Enum, TypeParameter,
 * etc. — anything that is not a function/method/class/struct with a
 * multi-line body). */
function isDeclarationOnlyKind(kind: number): boolean {
    // ccls extended kind: 252 = using-alias / typedef.
    if (kind === 252) return true;
    // Standard LSP SymbolKinds that are declaration-only.
    return kind === 10  // Enum
        || kind === 26  // TypeParameter
        || kind === 2   // Module
        || kind === 3   // Namespace
        || kind === 4   // Package
        || kind === 1;  // File
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
): Promise<string> {
    try {
        const out = await definition({ path, line, column }, cwd, clientOf);
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
    return await hover({ path, line, column }, cwd, clientOf);
}

/** `--- references ---` section: all call sites from `nav.references`, trimmed
 * to SYMBOL_FANOUT_REFS_CAP (25) rows with a `(N of M, use code_references
 * for all)` note. Reuses `nav.references` verbatim — the empty/error contracts
 * (`(no references found for ...)`, `ERROR  ...`) pass straight through. */
async function renderFanOutRefsSection(
    path: string,
    line: number,
    column: number,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const out = await references({ path, line, column }, cwd, clientOf);
    // Pass through empty/error results unchanged.
    if (out.startsWith("ERROR") || out.startsWith("(")) return out;
    const lines = out.split("\n");
    const last = lines[lines.length - 1];
    const m = /^# (\d+) references$/.exec(last);
    const total = m ? Number(m[1]) : lines.length;
    const dataLines = m ? lines.slice(0, -1) : lines;
    if (dataLines.length > SYMBOL_FANOUT_REFS_CAP) {
        const shown = dataLines.slice(0, SYMBOL_FANOUT_REFS_CAP).join("\n");
        return `${shown}\n(${SYMBOL_FANOUT_REFS_CAP} of ${total}, use code_references for all)`;
    }
    return out;
}
