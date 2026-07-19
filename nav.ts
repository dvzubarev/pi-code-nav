/**
 * The eight code_* tool implementations as plain async functions.
 *
 * This module has NO dependency on pi. Each function takes:
 *   - the validated tool params (plain object),
 *   - a `cwd` (workspace root, for resolving relative paths),
 *   - a `ClientProvider` — `async (lang) => LspClient` — so the function can
 *     obtain a per-language LSP client without depending on ServerPool or the
 *     extension's state.
 * and returns the rendered text string the agent would see (the same string
 * index.ts wraps in `text_result`).
 *
 * Error contract (two tiers — so an agent can tell success from failure
 * without regex-sniffing prose):
 *   - HARD failures (top-level, single-file tools: outline/tree/definition/
 *     rename/scan/diagnostics) THROW. index.ts's err() catches and sets
 *     `isError: true` — the agent gets a machine-readable success/failure bit.
 *     Covers: cannot read the file, unknown language, invalid regexp, no
 *     grammar, parse failed, bad params, server unavailable, no definition
 *     found, could not resolve body range, pull-diagnostics request failed.
 *     (Multiple definitions is NOT a failure — it's reported as data.)
 *   - SOFT failures (references/hover; per-language in symbol) are emitted
 *     as a structured row `ERROR  <path>:<line>:<col>  <reason>` (or
 *     `ERROR  [lang]  <reason>` for symbol) that parses with the SAME column
 *     grammar as a data row. The leading `ERROR` token distinguishes them
 *     from data; a consumer splits rows on `\n` and checks the first token.
 *     Applies to: unknown language, cannot read, server unavailable.
 * Clean empty results (no references found, no symbols, no diagnostics, no
 * identifiers) are NOT failures — they're returned as a
 *     parenthesized note like `(no references found for …)`, matching the
 *     long-standing empty-result convention. The distinction matters: a
 *     symbol with no references is a legitimate outcome, not an error.
 *     NOTE: code_definition is the exception — its contract is "return
 *     verbatim source code", so even a clean "no definition found" is a HARD
 *     failure there (no source code to return).
 *
 * Both the extension (index.ts → registerTools) and the CLI harness
 * (scripts/nav-cli.mjs) import these functions, so the CLI and automated tests
 * exercise the EXACT same code path the agent uses. This replaces the old
 * "nav-cli.mjs must mirror index.ts by hand" landmine.
 *
 * All tool params are 1-based (line/column). The functions do `line - 1` /
 * `column - 1` before calling LSP. All output positions are 1-based.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type {
    DocumentSymbol,
    SymbolInformation,
    Location,
    Diagnostic,
} from "vscode-languageserver-protocol";
import type { Lang, LspClient } from "./lsp-client";
import { SOURCE_EXTS } from "./lsp-client";
import {
    parseSymbols,
    renderSymbolTable,
    hoverFirstLine,
    tsLangForFile,
    tsLangToLspLang,
    findEnclosingDefWithDoc,
} from "./tree-sitter-parse";
import {
    toAbs,
    uriToPath,
    hoverText,
    hoverSignature,
    symbolKindName,
    renderDocSymbol,
    renderSymbolInfo,
    renderLocation,
    renderErrorRow,
    renderDiagnostic,
    resolveSymbolSelStart,
    resolveDefBodyRange,
    findDocSymbolBySelStart,
    snippetHasBody,
    applyWorkspaceEdit,
    langForFile,
} from "./render";

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
// Project language detection
// ---------------------------------------------------------------------------

/**
 * Root-level marker files that signal a language is in use. Checked first
 * (instant existsSync, no recursion) — the primary signal for languages with
 * a real build/dependency manifest. Source-extension scan (below) is the
 * fallback for languages whose projects often have no marker (e.g. a dir of
 * .sh scripts, or a bare .cpp playground).
 */
const ROOT_MARKERS: Partial<Record<Lang, readonly string[]>> = {
    python: [
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "requirements.txt",
        "Pipfile",
        "poetry.lock",
        "uv.lock",
        ".python-version",
    ],
    typescript: [
        "package.json",
        "tsconfig.json",
        "jsconfig.json",
        "deno.json",
    ],
    cpp: [
        "CMakeLists.txt",
        "Makefile",
        "meson.build",
        "compile_commands.json",
        "CMakeCache.txt",
        "Makefile.am",
        "configure.ac",
    ],
    bash: ["shell.nix"],
};

/** Directories never descended into during the source-file scan. */
const SCAN_SKIP = new Set([
    "node_modules",
    ".git",
    ".",
    "build",
    "dist",
    "out",
    ".next",
    ".cache",
    ".direnv",
    ".venv",
    "venv",
    "__pycache__",
    ".ruff_cache",
    ".pytest_cache",
    "target",
]);

/**
 * Detect which languages are present in a project root, so code_search_symbol
 * (which iterates languages when the caller didn't pin one) only spawns
 * servers that can actually find a project here. Without this, a pure-Python
 * project still spawns typescript-language-server, whose workspace/symbol
 * throws "No Project." (tsserver loads its project lazily on the first didOpen
 * of a .ts/.js file; if none exists, it has no project) and aborts the whole
 * multi-language query — discarding results already collected from python.
 *
 * Two tiers, short-circuiting per language as soon as it's confirmed present:
 *   1. Root-level marker files (existsSync — no I/O recursion).
 *   2. A bounded breadth-first source-file scan: descend one directory at a
 *      time, checking every file's extension against SOURCE_EXTS. The scan
 *      stops as soon as every language is either confirmed or ruled out, and
 *      is capped at SCAN_MAX_DIRS visited directories so a huge tree (e.g.
 *      node_modules leaking in) can't make the first symbol query slow.
 *
 * Returns the full language set (never empty — falls back to all four so a
 * mis-detection never silently hides results; the caller still pays the cost
 * but gets correct answers).
 */
const SCAN_MAX_DIRS = 2000;
/**
 * Memoized detection results, keyed by resolved absolute root path. A
 * project's language set is stable for the session (servers are likewise
 * kept alive for the whole session — see AGENTS.md), so the filesystem scan
 * runs at most once per workspace. Subsequent code_search_symbol calls hit
 * the cache and skip both the marker checks and the BFS source scan.
 */
const detectedLanguagesCache = new Map<string, Lang[]>();
export async function detectProjectLanguages(rootPath: string): Promise<Lang[]> {
    const key = resolve(rootPath);
    const cached = detectedLanguagesCache.get(key);
    if (cached) return cached;
    const result = await detectProjectLanguagesUncached(key);
    detectedLanguagesCache.set(key, result);
    return result;
}

async function detectProjectLanguagesUncached(rootPath: string): Promise<Lang[]> {
    const found = new Set<Lang>();
    // Tier 1: root markers.
    for (const lang of ALL_LANGS) {
        const markers = ROOT_MARKERS[lang];
        if (markers?.some((m) => existsSync(resolve(rootPath, m)))) {
            found.add(lang);
        }
    }
    if (found.size === 4) return [...found];

    // Tier 2: bounded breadth-first source-extension scan. Build the set of
    // languages still unconfirmed so we can stop early once all resolve.
    const wanted = new Set<Lang>(ALL_LANGS);
    for (const l of found) wanted.delete(l);
    let dirsVisited = 0;
    let queue: string[] = [rootPath];
    while (queue.length > 0 && wanted.size > 0 && dirsVisited < SCAN_MAX_DIRS) {
        const dir = queue.shift()!;
        dirsVisited++;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SCAN_SKIP.has(e.name)) continue;
                queue.push(resolve(dir, e.name));
            } else if (e.isFile() && wanted.size > 0) {
                const dot = e.name.lastIndexOf(".");
                if (dot < 0) continue;
                const ext = e.name.slice(dot).toLowerCase();
                for (const lang of wanted) {
                    if (SOURCE_EXTS[lang].includes(ext)) {
                        found.add(lang);
                        wanted.delete(lang);
                        break;
                    }
                }
            }
        }
    }
    if (found.size === 0) return [...ALL_LANGS];
    return [...found];
}

/** Clear the detection cache. Tests call this between cases so results from
 * one temp-dir root don't leak into another through the shared module. */
export function clearDetectedLanguagesCache(): void {
    detectedLanguagesCache.clear();
}

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
async function awaitReadyForQuery(
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
// 1. code_outline
// ---------------------------------------------------------------------------

export interface OutlineParams {
    path: string;
}

/**
 * LSP SymbolKind values `code_outline` keeps. The tool's stated purpose is
 * "functions, classes, methods" — an allowlist is more honest than a
 * denylist of noisy kinds: it says exactly what the overview shows rather
 * than what it happens to hide. Kept:
 *
 *   5  Class        9  Constructor  12 Function       23 Struct
 *   6  Method       11 Interface
 *
 * Property(7)/Field(8) are deliberately DROPPED. They sound structural but
 * aren't reliably so: tsserver emits `Property` for object-literal keys
 * (e.g. every field of a `registerTool({...})` call or a returned object
 * literal), which floods the outline with non-structural noise. ty/ccls use
 * Field(8) only for real class/struct fields, but even there a field list is
 * rarely what a "compact overview" wants — the agent can `code_tree` a class
 * name to see its members, or read the file. Dropping 7/8 keeps the outline
 * to the callable/type-declaration surface. Constructor is a kind of method.
 * Dropped: Variable(13), Constant(14), Property(7), Field(8), and everything
 * else (Enum/Namespace/etc. — none appear in practice for our servers; if
 * one ever does, dropping it is the safe default for a "compact overview").
 * See docs/code_outline.md.
 */
const OUTLINE_KEEP_KINDS = new Set([5, 6, 9, 11, 12, 23]);

/**
 * Prune a DocumentSymbol tree to nodes whose kind is in `keep`, recursing
 * into kept nodes' children. Returns a new top-level array; may rewrite a
 * kept node's `.children` to its filtered sublist (the input comes from a
 * fresh `documentSymbol` call and is rendered once, so this in-place rewrite
 * is safe and avoids a deep clone). A dropped node's children are NOT lifted
 * to the parent — they're structural subordinates (a constant's locals, a
 * method's temps), and lifting them would distort the tree.
 */
function pruneDocSymbolTree(syms: DocumentSymbol[], keep: Set<number>): DocumentSymbol[] {
    const out: DocumentSymbol[] = [];
    for (const s of syms) {
        const kind = (s as unknown as { kind?: number }).kind ?? 0;
        if (!keep.has(kind)) continue;
        const children = (s as unknown as { children?: DocumentSymbol[] }).children;
        if (children && children.length > 0) {
            (s as unknown as { children?: DocumentSymbol[] }).children = pruneDocSymbolTree(
                children,
                keep,
            );
        }
        out.push(s);
    }
    return out;
}

/** Keep only rows whose kind is in `keep` from a flat SymbolInformation[]. */
function filterSymbolInfoList(syms: SymbolInformation[], keep: Set<number>): SymbolInformation[] {
    return syms.filter((s) => keep.has(s.kind ?? 0));
}

export async function outline(
    params: OutlineParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the file. Throw so index.ts's err() sets
        // isError: true rather than returning an inline string that looks like
        // a (empty) result.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    const client = await clientOf(lang);
    // Wait for ccls to finish indexing this TU before querying documentSymbol.
    // On a cold cache, documentSymbol returns stale {0:0} ranges until the
    // file's preamble session is ready. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const syms = await client.documentSymbols(abs, text);
    if (syms.length === 0) return `(no symbols found in ${params.path})`;
    const lines: string[] = [];
    // Hierarchical (DocumentSymbol[]) vs flat (SymbolInformation[]).
    // Only structural kinds (class/method/function/field/...) are kept — the
    // outline is a bloat-free structural overview. No arguments, no hovers,
    // no opt-out. Server-provided `detail` is rendered inline where present
    // (ccls fills it; tsserver/ty leave it empty).
    if ("range" in syms[0] && "selectionRange" in syms[0]) {
        const tree = pruneDocSymbolTree(syms as DocumentSymbol[], OUTLINE_KEEP_KINDS);
        for (const s of tree) renderDocSymbol(s, 0, lines);
    } else {
        const flat = filterSymbolInfoList(syms as SymbolInformation[], OUTLINE_KEEP_KINDS);
        for (const s of flat) lines.push(renderSymbolInfo(s));
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 1b. code_tree
// ---------------------------------------------------------------------------

export interface TreeParams {
    path: string;
    /** RegExp source tested against each symbol's name. */
    pattern: string;
}

/**
 * One row of the tree result: the symbol, its tree depth (for indentation),
 * whether this node itself matched the pattern, and whether it's a direct
 * child of a class/interface/struct match (in which case it's hovered for a
 * signature even though it isn't itself a match — see DWYM rule below).
 */
interface TreeRow {
    sym: DocumentSymbol;
    depth: number;
    matched: boolean;
    /** True for direct children of a class/interface/struct match. */
    directClassChild: boolean;
}

/** LSP SymbolKind values that trigger the class-match DWYM path. */
const CLASS_LIKE_KINDS = new Set([5, 11, 23]); // Class, Interface, Struct

/**
 * Prune a DocumentSymbol tree to matches, returning a flat list of rows
 * with depth + flags. Used by code_tree (pattern-driven). Semantics (DWYM —
 * do what the agent means):
 *
 *   1. A node whose name matches the pattern is a match. The matched node is
 *      always emitted (matched: true).
 *        a. If the match is a class/interface/struct, emit ONLY its DIRECT
 *           children (methods/properties/fields) as context rows with
 *           `directClassChild: true` — the agent asked about the class, so it
 *           wants the member list, not the deep locals of every method. Deep
 *           nesting (constants inside methods, properties inside those) is
 *           dropped; the agent can code_hover/code_definition a member to go
 *           deeper. Direct children are hovered for signatures (see tree).
 *        b. If the match is anything else (method/function/property/…), emit
 *           NOTHING from its subtree. The agent asked about this specific
 *           symbol; its body locals are noise. Ancestors still provide context.
 *   2. A node with a matching descendant is kept as an ancestor for context
 *      (so the agent sees where the match sits in the hierarchy), but its
 *      non-matching sibling subtrees are pruned.
 *
 * Output is in pre-order (parents before children) so indentation renders the
 * hierarchy correctly.
 */
function collectTreeRows(syms: DocumentSymbol[], re: RegExp): TreeRow[] {
    const out: TreeRow[] = [];
    const walk = (nodes: DocumentSymbol[], depth: number): boolean => {
        let anyMatchInSubtree = false;
        for (const s of nodes) {
            const selfMatch = re.test(s.name);
            const children = (s as unknown as { children?: DocumentSymbol[] }).children ?? [];
            const kind = (s as unknown as { kind?: number }).kind;
            if (selfMatch) {
                // Rule 1: self-match — emit (matched: true).
                out.push({ sym: s, depth, matched: true, directClassChild: false });
                if (CLASS_LIKE_KINDS.has(kind ?? 0)) {
                    // Rule 1a (class-like): emit ONLY direct children, flagged so the
                    // caller knows to hover them for signatures. Do NOT recurse —
                    // deep locals of each member are dropped (DWYM).
                    for (const ch of children) {
                        out.push({
                            sym: ch,
                            depth: depth + 1,
                            matched: false,
                            directClassChild: true,
                        });
                    }
                }
                // Rule 1b (non-class): emit nothing from the subtree.
                anyMatchInSubtree = true;
                continue;
            }
            // Rule 2: no self-match — keep this node only if a descendant matched.
            // We don't yet know whether a descendant matches, so reserve a slot now
            // (pre-order: parent before children) and fill/evict it after recursing.
            const slot = out.length;
            out.push({ sym: s, depth, matched: false, directClassChild: false }); // tentative
            const childMatch = walk(children, depth + 1);
            if (childMatch) {
                anyMatchInSubtree = true; // keep the slot
            } else {
                out.splice(slot, 1); // no match below — evict the tentative ancestor
            }
        }
        return anyMatchInSubtree;
    };
    walk(syms, 0);
    return out;
}

/**
 * Render one tree row as an indented line mirroring `renderDocSymbol`'s shape,
 * but with an appended signature label (from `detail` or a hover).
 * Format: `<pad><Kind> <name>  <signature>  :line:col` where the signature
 * is the server `detail` when present, otherwise the provided hover signature.
 */
function renderTreeRow(row: TreeRow, signature: string | undefined): string {
    const pad = "  ".repeat(row.depth);
    const sym = row.sym;
    const kind = (sym as unknown as { kind?: number }).kind;
    const kindName = symbolKindName(kind);
    const sel = sym.selectionRange?.start;
    const pos = sel ? `${sel.line + 1}:${sel.character + 1}` : "";
    // `detail` (server-provided, e.g. ccls declarations) takes precedence — it's
    // free and authoritative. The hover signature fills in where detail is empty
    // (tsserver/ty). Both never apply simultaneously.
    const detail = (sym as unknown as { detail?: string | null }).detail;
    const label = detail ? detail : (signature ?? "");
    const l = label ? `  ${label}` : "";
    // Position column is grep-style `:line:col` (no parens, no path — the path is
    // the outline's input file) so the row shares the `line:col` grammar every
    // other tool uses. Consistent with renderDocSymbol / renderSymbolInfo.
    return `${pad}${kindName} ${sym.name}${l}  :${pos}`;
}

export async function tree(
    params: TreeParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the file. Throw so index.ts's err() sets
        // isError: true.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    // Compile the pattern as a regexp. No substring fallback — the agent is
    // told this is a regexp and can escape/anchor as needed. A bad pattern is
    // a hard error (isError) so the agent learns the syntax contract fast.
    let re: RegExp;
    try {
        re = new RegExp(params.pattern);
    } catch (e) {
        throw new Error(
            `Invalid regexp /${params.pattern}/: ${e instanceof Error ? e.message : e}`,
        );
    }
    const client = await clientOf(lang);
    // Wait for ccls to finish indexing this TU before querying documentSymbol.
    // On a cold cache, documentSymbol returns stale {0:0} ranges and the
    // tree's body ranges / hover signatures are wrong until the file's
    // preamble session is ready. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const syms = await client.documentSymbols(abs, text);
    if (syms.length === 0) return `(no symbols found in ${params.path})`;
    // code_tree is pattern-driven and does NOT drop constants/variables — the
    // pattern scopes the candidate set, so noise filtering would only hide
    // symbols the agent explicitly asked for. Requires a hierarchical tree
    // (DocumentSymbol[]); the flat SymbolInformation[] case has no nesting to
    // prune and is reported as unsupported (no current server hits it for
    // documentSymbol, but we guard rather than crash).
    if (!("range" in syms[0] && "selectionRange" in syms[0])) {
        // Hard failure: code_tree's pruning semantics require a hierarchical
        // tree; a flat SymbolInformation[] has no nesting to prune. No current
        // server hits this for documentSymbol, but we guard rather than crash.
        throw new Error(
            `code_tree requires hierarchical documentSymbol; ${params.path} returned flat SymbolInformation`,
        );
    }
    const rows = collectTreeRows(syms as DocumentSymbol[], re);
    if (rows.length === 0) {
        return `(no symbols matching /${params.pattern}/ in ${params.path})`;
    }
    // Hover the rows whose `detail` is empty, in parallel (JSON-RPC over stdio
    // supports concurrent in-flight requests; measured ~4ms for 10 hovers):
    //   - matched rows (any kind) — the agent asked about these by name;
    //   - direct children of a class/interface/struct match (DWYM rule 1a) —
    //     the agent asked about the class, so its member list should carry
    //     signatures, not just bare names. This is where code_tree earns its
    //     "signature-enriched" promise for tsserver/ty (which leave `detail`
    //     empty); ccls fills `detail` for members, so they're skipped here.
    // Ancestors kept for context (rule 2) are NOT hovered — they're just the
    // path to the match; their own signature is rarely interesting and hovering
    // them would balloon the candidate set when the match is deep. Skip rows
    // that already have a non-empty `detail` — no point paying a hover to
    // duplicate the server's own declaration string.
    const hoverTargets = rows.filter(
        (r) =>
            (r.matched || r.directClassChild) &&
            !(r.sym as unknown as { detail?: string | null }).detail,
    );
    const signatures = new Map<DocumentSymbol, string>();
    if (hoverTargets.length > 0) {
        const hovers = await Promise.all(
            hoverTargets.map((r) => {
                const sel = r.sym.selectionRange?.start;
                if (!sel) return Promise.resolve(null);
                return client.hover(abs, sel.line, sel.character, text);
            }),
        );
        hoverTargets.forEach((r, i) => {
            const sig = hoverSignature(hoverText(hovers[i]));
            if (sig) signatures.set(r.sym, sig);
        });
    }
    const lines = rows.map((r) => renderTreeRow(r, signatures.get(r.sym)));
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 2. code_definition
//
// The tool's PRIMARY purpose is retrieving verbatim source code of a
// function/class/method so the agent can reuse it instantly for editing —
// like the read tool, but scoped to a symbol's body. Output format (single
// site — the common case):
//
//   <defPath>:<sl>-<el>
//   <body verbatim from source code>
//   <optional sym table when list_symbols=true>
//
// The header is `rel/or/abs/path.ts:42-45` (1-based inclusive line range of
// the body slice). defPath is the path the definition lives in (may differ
// from the input path — the definition can be in another file, including
// third-party trees). The body is the raw source lines, NO code fence, so an
// agent can copy it straight into an edit.
//
// A position may resolve to MULTIPLE definition sites (overloads,
// multi-definition symbols, header-vs-source in C++, re-exports). This is a
// legitimate LSP outcome (`textDocument/definition` returns Location[]), so
// the tool reports every site rather than refusing the call. The multi-site
// output is one block per site (each using the SAME `<defPath>:<sl>-<el>`
// header grammar as the single-site case, so a single-site result is
// byte-identical), blocks separated by a blank line, with a trailing
// `# N definitions for <inPath>:<line>:<col>` count. The agent gets every
// body and can pick the one it meant.
//
// Error contract: HARD failures THROW (index.ts's err() sets isError: true).
// There are NO fallbacks and NO soft-failure rows — if we cannot return
// verbatim source code for any reason, the tool fails loudly so the agent
// knows it got nothing reusable. Covers: unknown language, cannot read input
// file, server unavailable, no definition found, could not read the
// definition's source file, could not resolve the body range, symbol scan
// failed. A clean "no definition found" (e.g. a built-in, or a position that
// isn't a symbol) is ALSO a hard error — the tool's contract is "returns
// source code", so the absence of a definition is a failure to fulfill that
// contract, not a legitimate empty result. Multiple definitions is NOT a
// failure (it's data).
// ---------------------------------------------------------------------------

export interface DefinitionParams {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
    list_symbols?: boolean;
}

export async function definition(
    params: DefinitionParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the input file. Throw so index.ts's err()
        // sets isError: true — no fallback, no partial result.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        // Hard failure: the language server could not be spawned. No source
        // code can be retrieved without it.
        throw new Error(`${lang}: server unavailable: ${e}`);
    }
    // Wait for ccls to finish indexing this TU before querying. On a cold
    // cache, textDocument/definition bounces to the declaration and
    // documentSymbol returns stale {0:0} ranges because ccls's preamble
    // session for this file isn't ready yet. diagnostics() does the same.
    await awaitReadyForQuery(lang, client, abs, text);
    // STEP 0 — documentSymbol fast path (the ccls bounce fix).
    //
    // ccls's textDocument/definition, when the cursor is ON a C++ function
    // DEFINITION (out-of-line .cpp member, template specialization, etc.),
    // bounces to the header DECLARATION instead of returning the def position.
    // The editor "go to definition" does the same — it's a ccls quirk in
    // getNonDefDeclarations (textDocument_definition.cc: on_def → returns
    // the non-def declarations). This bounce means we'd render the header
    // prototype, not the cpp body the agent asked for.
    //
    // Fix: before calling textDocument/definition, fetch documentSymbol for
    // THIS file (ccls parses the opened file locally — equivalent to
    // tree-sitter, no per-language grammar needed) and find the symbol whose
    // selectionRange.start == cursor. If that symbol's source range has a body
    // (contains `{` — a real definition, not a prototype), return it directly
    // and skip textDocument/definition entirely → no bounce. If the symbol at
    // the cursor is a declaration (no body), fall through to
    // textDocument/definition, which correctly jumps declaration→definition.
    // If the cursor isn't on any symbol in this file (e.g. a call site, or
    // whitespace), also fall through to textDocument/definition.
    const cursor = { line: params.line - 1, character: params.column - 1 };
    // When step 0 finds a DECLARATION (no body) at the cursor, remember its
    // range in the input file. If textDocument/definition then returns empty
    // (ccls only resolves use→def, never decl→decl — so a cursor ON a
    // header-only third-party declaration yields `[]`), we fall back to
    // rendering that declaration + its preceding doc comment from the input
    // file instead of throwing "No definition found". The doc comment is
    // resolved by findEnclosingDefWithDoc inside renderSnippetBlock.
    let declInInput: { sl: number; el: number } | null = null;
    try {
        const syms = await client.documentSymbols(abs, text);
        const flat =
            syms.length > 0 && "selectionRange" in syms[0]
                ? (syms as DocumentSymbol[])
                : [];
        const atCursor = findDocSymbolBySelStart(flat, cursor);
        if (atCursor?.range?.start && atCursor?.range?.end) {
            const sl = atCursor.range.start.line;
            const el = atCursor.range.end.line;
            const srcLines = text.split(/\r?\n/);
            const snippet = srcLines.slice(sl, el + 1).join("\n");
            if (snippetHasBody(snippet)) {
                // Cursor is on a body-bearing symbol in this file → it IS the
                // definition. Render it directly; skip textDocument/definition
                // (which would bounce to the declaration for ccls).
                return renderSnippetBlock(
                    client,
                    abs,
                    sl,
                    el,
                    text,
                    params,
                    params.list_symbols ?? false,
                );
            }
            // Declaration (no body): remember it for the empty-locs fallback.
            declInInput = { sl, el };
        }
    } catch {
        // documentSymbol failed (e.g. ccls "not indexed" on an un-indexed
        // header — deferred to a future session's tree-sitter fallback).
        // Fall through to textDocument/definition.
    }
    const def = await client.definition(abs, params.line - 1, params.column - 1, text);
    const locs = (Array.isArray(def) ? def : def ? [def] : []) as Location[];
    if (locs.length === 0) {
        // ccls's textDocument/definition only resolves use→def, never
        // decl→decl: a cursor ON a header-only declaration (no out-of-line
        // definition exists — third-party / stdlib / header-only library)
        // returns `[]`. Step 0 already located the declaration in the input
        // file in that case (declInInput). Fall back to rendering that
        // declaration + its preceding doc comment from the input file so the
        // agent gets the docstring instead of a hard "No definition found"
        // error. renderSnippetBlock prepends the doc comment via
        // findEnclosingDefWithDoc (tree-sitter, no LSP round-trip).
        if (declInInput) {
            return renderSnippetBlock(
                client,
                abs,
                declInInput.sl,
                declInInput.el,
                text,
                params,
                params.list_symbols ?? false,
                { line: params.line, column: params.column },
            );
        }
        // Hard failure: no definition found and the cursor isn't on a
        // declaration in this file either (e.g. a use of a built-in, or
        // whitespace). The tool's contract is "returns verbatim source code";
        // the absence of a definition means we cannot fulfill it. No
        // parenthesized-note fallback — throw so the agent knows it got
        // nothing reusable and can try another approach (code_hover,
        // code_search_symbol, etc.).
        throw new Error(
            `No definition found for ${params.path}:${params.line}:${params.column}`,
        );
    }
    // A position may resolve to multiple definition sites (overloads,
    // multi-definition symbols, header-vs-source in C++, re-exports). This is
    // a legitimate, common LSP outcome — `textDocument/definition` returns a
    // Location[] and we report every site rather than refusing the call.
    //
    // Output is ONE block per site, each using the SAME header grammar as the
    // single-site case (`<defPath>:<sl>-<el>\n<body>`), so a single-site result
    // is byte-identical to today. Blocks are separated by a blank line, and a
    // trailing `# N definitions` count follows the last block (mirroring
    // code_references' trailing-count convention). The agent gets every body
    // and can pick the one it meant.
    const blocks: string[] = [];
    for (const loc of locs) {
        const block = await renderDefinitionBlock(client, loc, params, params.list_symbols ?? false);
        blocks.push(block);
    }
    // Single site: no separator, no count — byte-identical to the old contract.
    // Multiple sites: blank-line-separated blocks + trailing count.
    if (blocks.length === 1) return blocks[0];
    return blocks.join("\n\n") + `\n# ${blocks.length} definitions for ${params.path}:${params.line}:${params.column}`;
}

/**
 * Render a definition snippet as `<defPath>:<sl>-<el>\n<body>[\n\n<sym table>]`.
 *
 * Shared by the documentSymbol fast path (step 0, which already has the
 * body range) and renderDefinitionBlock (which resolves the range from a
 * textDocument/definition Location). `sl`/`el` are 0-based LSP line numbers
 * of the body range; `src` is the source text of the file the body lives in;
 * `defPath` is that file's path (for the header line and the symbol table).
 * Throws a hard error on a symbol-scan failure (list_symbols only) — there
 * are no fallbacks, since the tool's contract is verbatim source code or
 * failure.
 *
 * Doc-comment prefix: when the snippet has NO body (it's a declaration /
 * prototype, e.g. a third-party header-only API), prepend the preceding doc
 * comment (slash-star star, triple-slash, or bang-slash-slash) so the agent
 * gets the docstring. Resolved with findEnclosingDefWithDoc (tree-sitter,
 * local parse — works on un-indexed headers without an LSP round-trip).
 * `docAnchor` is a 1-based position inside the declaration used to anchor
 * the tree-sitter lookup (the identifier column when known from the LSP
 * Location, else the cursor position from the tool input, else the start of
 * the snippet line). Bodies are returned verbatim — the snippetHasBody gate
 * stays.
 */
async function renderSnippetBlock(
    client: LspClient,
    defPath: string,
    sl: number,
    el: number,
    src: string,
    _params: DefinitionParams,
    listSymbols: boolean,
    docAnchor?: { line: number; column: number }, // 1-based, inside the declaration
): Promise<string> {
    const srcLines = src.split(/\r?\n/);
    let snippet = srcLines.slice(sl, el + 1).join("\n");
    let renderSl = sl; // start line actually rendered (0-based) — may move up
                       // to include a preceding doc comment.
    if (!snippetHasBody(snippet)) {
        // Declaration (prototype): try to prepend the preceding doc comment.
        // findEnclosingDefWithDoc parses the file locally with tree-sitter so
        // it works on un-indexed third-party headers (no LSP round-trip). On
        // any failure (no grammar, parse error, no preceding comment) we
        // return the bare declaration — strictly better than throwing.
        const tsLang = tsLangForFile(defPath);
        if (tsLang) {
            try {
                const anchor = docAnchor ?? { line: sl + 1, column: 1 };
                const enc = await findEnclosingDefWithDoc(tsLang, src, anchor.line, anchor.column);
                if (
                    enc &&
                    enc.docStartLine != null &&
                    enc.docEndLine != null &&
                    enc.docStartLine < sl
                ) {
                    // Extend the snippet UPWARD to include the doc comment.
                    // Keep LSP's `el` as the declaration's end (the doc range
                    // and LSP range come from different parses; only the
                    // upward extension is safe — overlapping downward risks
                    // pulling in trailing lines LSP didn't intend).
                    renderSl = enc.docStartLine;
                    snippet = srcLines.slice(renderSl, el + 1).join("\n");
                }
            } catch {
                // tree-sitter parse failed — fall through with the bare
                // declaration (renderSl == sl, snippet unchanged).
            }
        }
    }
    const out: string[] = [];
    // Header: <defPath>:<sl>-<el> (1-based inclusive line range of the body).
    // defPath is the path the definition lives in — relative or absolute as
    // the server returned it (the agent can feed it back into code_* tools).
    out.push(`${defPath}:${renderSl + 1}-${el + 1}`);
    out.push(snippet);
    // Optional tree-sitter symbol table over the snippet. Reuses the same
    // parseSymbols helper as code_scan. The snippet's absolute line range is
    // (renderSl+1 .. el+1) in 1-based coords. Only run when requested: default
    // false keeps code_definition's output focused on the verbatim body.
    if (listSymbols) {
        const tsLang = tsLangForFile(defPath);
        if (tsLang) {
            try {
                const entries = await parseSymbols(tsLang, {
                    text: src,
                    startLine: renderSl + 1,
                    endLine: el + 1,
                });
                if (entries && entries.length > 0) {
                    // Blank line separates the verbatim body from the symbol
                    // table so an agent can unambiguously tell where the body
                    // ends and the table begins (the body itself may contain
                    // lines that look table-like).
                    out.push("");
                    out.push(renderSymbolTable(defPath, renderSl + 1, el + 1, entries));
                }
            } catch (e) {
                // Hard failure: the symbol scan failed. The verbatim body was
                // already retrieved (the primary contract), but list_symbols
                // is an explicit request the agent is relying on — surface the
                // failure rather than silently omitting the table.
                throw new Error(`symbol scan failed for ${defPath}:${renderSl + 1}-${el + 1}: ${e}`);
            }
        }
    }
    return out.join("\n");
}

/**
 * Render one definition site as `<defPath>:<sl>-<el>\n<body>[\n\n<sym table>]`.
 *
 * Reads the definition's source file, resolves the enclosing DocumentSymbol to
 * the full body range (the server's Location is usually just the identifier
 * span), slices the raw source, and optionally appends a tree-sitter symbol
 * table over the body. Throws a hard error on any per-site failure (cannot
 * read source, cannot resolve body, symbol scan failed) — there are no
 * fallbacks, since the tool's contract is verbatim source code or failure.
 */
async function renderDefinitionBlock(
    client: LspClient,
    loc: Location,
    params: DefinitionParams,
    listSymbols: boolean,
): Promise<string> {
    const defPath = uriToPath(loc.uri);
    let src: string;
    try {
        src = await readFile(defPath, "utf8");
    } catch (e) {
        // Hard failure: the definition's source file can't be read (e.g. a
        // server pointed at a stale or unreadable path). No fallback.
        throw new Error(`Cannot read definition source ${defPath}: ${e}`);
    }
    // The definition range from the server is usually just the identifier
    // span (e.g. the 9 chars of `punintend`). Resolve the enclosing
    // DocumentSymbol to extract the full function/class body range.
    const body = await resolveDefBodyRange(client, loc);
    if (!body) {
        // Hard failure: could not resolve the enclosing symbol's body range.
        // Without it we'd return only the identifier span, which is NOT the
        // verbatim source body the tool promises — so fail rather than return
        // a misleading snippet.
        throw new Error(
            `Could not resolve definition body for ${defPath} at ${params.path}:${params.line}:${params.column}`,
        );
    }
    return renderSnippetBlock(
        client,
        defPath,
        body.startLine,
        body.endLine,
        src,
        params,
        listSymbols,
        // Anchor the doc-comment lookup at the definition's identifier
        // position (1-based) so tree-sitter walks up from the right token.
        { line: body.startLine + 1, column: (loc.range?.start?.character ?? 0) + 1 },
    );
}

// ---------------------------------------------------------------------------
// 3. code_references
//
// Takes a single symbol position (path, line, column) and returns all
// references to that symbol. Output is one reference location per line
// (`<path>:<line>:<col>`, grep-style) plus a trailing `# N references` count
// comment.
// A clean empty result (no references) is a parenthesized note, NOT an error —
// an unused symbol is a legitimate outcome.
//
// Recoverable failures (unknown language, cannot read, server unavailable)
// are emitted as a structured `ERROR  <path>:<line>:<col>  <reason>` row —
// the leading `ERROR` token distinguishes them from data rows.
// ---------------------------------------------------------------------------

export interface ReferencesParams {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
}

export async function references(
    params: ReferencesParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) {
        return renderErrorRow(params.path, params.line, params.column, `unknown language for file`);
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        return renderErrorRow(
            params.path,
            params.line,
            params.column,
            `${lang}: server unavailable: ${e}`,
        );
    }
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        return renderErrorRow(params.path, params.line, params.column, `cannot read ${abs}: ${e}`);
    }
    // Wait for ccls to finish indexing this TU before querying references.
    // On a cold cache, textDocument/references can miss cross-TU call sites
    // until indexing finishes. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const refs = await client.references(abs, params.line - 1, params.column - 1, text);
    if (refs.length === 0) {
        // Clean empty result (the symbol has no references) — NOT a failure.
        // Kept as a parenthesized note (matching outline/diagnostics/scan's
        // empty-result convention) rather than an ERROR row, so an agent
        // checking the leading token doesn't mistake a legitimate "unused
        // symbol" for a failure.
        return `(no references found for ${params.path}:${params.line}:${params.column})`;
    }
    const rendered = refs.map((r) => renderLocation(r));
    // Drop the leading "N reference(s):" count line — it was prose the agent
    // had to strip to get the list. A trailing comment line (# N references)
    // is trivially ignorable while keeping the count for the few callers that
    // want it.
    return rendered.join("\n") + `\n# ${rendered.length} references`;
}

// ---------------------------------------------------------------------------
// 4. code_search_symbol
// ---------------------------------------------------------------------------

export interface SymbolParams {
    query: string;
    language?: string;
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

/**
 * Parse a (possibly qualified) symbol query into `(qualifier, bareName)`.
 * `qualifier` is null when the query has no separator (a bare name). The bare
 * name is the last path component after splitting on the language's
 * separator — e.g. `typing.cast` -> `(qualifier="typing", bare="cast")`,
 * `std::vector::push_back` -> `(qualifier="std::vector", bare="push_back")`.
 * For bash (no separator) the whole query is the bare name.
 */
function parseSymbolQuery(
    query: string,
    lang: Lang,
): { qualifier: string | null; bare: string } {
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
function modulePathOf(
    uri: string,
    folders: string[],
): string | null {
    const p = uriToPath(uri);
    const f = homeFolderOf(uri, folders);
    if (!f || p === f) return null;
    let rel = p.slice(f.length + 1).replace(/\.py[i]?$/, "").replace(/\.ts$/, "").replace(/\.tsx$/, "");
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

/**
 * Soft cap on the number of rows `code_search_symbol` emits per language.
 * ty's fuzzy search can return hundreds of results for a bare common name
 * (`cast` -> ~400, `loads` -> ~120) once third-party/stdlib roots are added;
 * flooding the agent's context with every match defeats the tool's purpose as
 * a quick entry point. Exact-name matches are ALWAYS kept (they're what the
 * agent asked for); only the fuzzy tail is trimmed, with a trailing note.
 */
const SYMBOL_MAX_ROWS_PER_LANG = 50;

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
    const langs: Lang[] = params.language
        ? [params.language as Lang]
        : await detectProjectLanguages(cwd);
    const out: string[] = [];
    // Cache documentSymbol results per file so we don't re-fetch for every hit.
    const docCache = new Map<string, DocumentSymbol[]>();
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
            const exactThirdParty = syms.filter(
                (s) => exactName(s) && isThirdParty(s),
            );
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
            // `name` is a full signature; "exact" means the bare query appears
            // as a substring — for a QUALIFIED query (`std::vector::push_back`)
            // the `::<bare>` boundary is required so the qualifier's scope is
            // honored, but for a BARE query (`occlude_list`) a plain substring
            // match suffices (the agent asked for any symbol containing this
            // name; before this, bare cpp queries fell through to the unfiltered
            // T3 and let the `thrust::iterator_*` noise through).
            const folders = client.workspaceFolderPaths();
            // ty's workspace/symbol is case-INSENSITIVE fuzzy, so `s.name`
            // may differ in case from the bare query (`TempC` for query `tempc`).
            // The "exact name" check must therefore be case-insensitive for
            // python/typescript. C++ (ccls) is case-sensitive and `name` is a
            // full signature, so cpp keeps the case-sensitive substring checks.
            const caseInsensitive = lang === "python" || lang === "typescript";
            const bareCmp = caseInsensitive ? bare.toLowerCase() : bare;
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
                const nm = caseInsensitive ? s.name.toLowerCase() : s.name;
                if (nm === bareCmp) return true;
                if (lang === "cpp") {
                    // cpp `name` is a full C++ qualified signature
                    // (`void diskann::Index::occlude_list(...)`). For a
                    // QUALIFIED query require the `::<bare>` boundary so the
                    // qualifier's scope is honored and `occlude_list` doesn't
                    // rank `occlude_list_v2`-style cousins as exact; for a
                    // BARE query a plain substring match suffices (the agent
                    // asked for any symbol containing this name).
                    if (qualifier !== null) {
                        const tail = QUALIFIED_SEP[lang]! + bare;
                        return s.name.includes(tail);
                    }
                    return nm.includes(bareCmp);
                }
                return false;
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
                syms = [...t2, ...t3];
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
        // Render. When the result set is large (third-party/stdlib added),
        // trim the fuzzy tail to keep the output useful — exact-name matches
        // are always preserved (they're what the agent asked for).
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
            out.push(`[${lang}] # ${trimmed} more result(s) trimmed (narrow with a qualified name like "pkg.symbol")`);
        }
    }
    if (out.length === 0) return `(no symbols matching "${params.query}")`;
    return out.join("\n");
}

// ---------------------------------------------------------------------------
// 5. code_rename
// ---------------------------------------------------------------------------

export interface RenameParams {
    path: string;
    line: number;
    column: number;
    newName: string;
}

export async function rename(
    params: RenameParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the file. Throw so index.ts's err() sets
        // isError: true.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    const client = await clientOf(lang);
    // Wait for ccls to finish indexing this TU before computing rename edits.
    // On a cold cache, textDocument/rename can miss cross-TU occurrences until
    // indexing finishes, producing a partial rename. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const edit = await client.rename(abs, params.line - 1, params.column - 1, text, params.newName);
    const applied = await applyWorkspaceEdit(edit);
    if (applied.length === 0) return `(rename produced no edits)`;
    const lines = applied.map((f) => `${f.path}: ${f.edits} edit(s)`);
    return `Renamed to "${params.newName}". Applied:\n` + lines.join("\n");
}

// ---------------------------------------------------------------------------
// 6. code_hover
//
// Takes a single symbol position (path, line, column) and returns the
// hover/documentation for that symbol. Output is signature-first: a
// `signature: <collapsed one-line signature>` line (when one can be
// extracted), then the full hover markdown body. A clean empty result (no
// hover info) returns the parenthesized note `(no hover information)`.
//
// Recoverable failures (unknown language, cannot read, server unavailable)
// are emitted as a structured `ERROR  <path>:<line>:<col>  <reason>` row.
// ---------------------------------------------------------------------------

export interface HoverParams {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
}

export async function hover(
    params: HoverParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) {
        return renderErrorRow(params.path, params.line, params.column, `unknown language for file`);
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        return renderErrorRow(
            params.path,
            params.line,
            params.column,
            `${lang}: server unavailable: ${e}`,
        );
    }
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        return renderErrorRow(params.path, params.line, params.column, `cannot read ${abs}: ${e}`);
    }
    // Wait for ccls to finish indexing this TU before querying hover. On a
    // cold cache, textDocument/hover can return empty or partial signatures
    // until the file's preamble session is ready. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const h = await client.hover(abs, params.line - 1, params.column - 1, text);
    const body = hoverText(h);
    // Signature-first: emit the collapsed one-line signature (when one can
    // be extracted) as the first line, then the full hover markdown. This
    // surfaces structured signature info that would otherwise be buried in
    // a ```python fence or a multi-paragraph docstring. The `signature:`
    // prefix lets a consumer pick the first line cheaply without parsing
    // the markdown body.
    const sig = hoverSignature(body);
    const sigLine = sig ? `signature: ${sig}\n` : "";
    return sigLine + body;
}

// ---------------------------------------------------------------------------
// 7. code_scan (tree-sitter identifier scan)
//
// This is the tree-sitter-backed identifier scanner (NOT the LSP documentSymbol
// tree tool — that's code_tree above). It walks a source file's syntax tree
// and emits every identifier-class node with its absolute 1-based position and
// syntactic role (type/call/member/import/var). Because it parses syntax
// directly (not the LSP symbol index), it sees third-party / stdlib / system
// symbols the LSP workspace/symbol cannot find — that's the whole reason it
// exists. See docs/code_scan.md.
// ---------------------------------------------------------------------------

export interface ScanParams {
    path: string;
    /** Optional 1-based inclusive start line; omitted → from start of file. */
    startLine?: number;
    /** Optional 1-based inclusive end line; omitted → to end of file. */
    endLine?: number;
    /** Optional regexp source; when set, only symbols whose name matches are kept. */
    pattern?: string;
    /** Which syntactic roles to emit. Default: type,call,member,import (no var). */
    roles?: string[];
    /** If true, hover each emitted symbol and append a one-line label. */
    include_docs?: boolean;
}

export async function scan(
    params: ScanParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const tsLang = tsLangForFile(params.path);
    if (!tsLang) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot proceed at all. Throw so index.ts's err() sets
        // isError: true — the agent gets a machine-readable success/failure bit
        // instead of an inline string indistinguishable from a data row.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    // Resolve the effective line range. Both optional → default to the whole
    // file (1 .. last line). If only one is given, fill the other end. This
    // keeps the contract simple: pass just a path for a full-file scan.
    const lineCount = text.split(/\r?\n/).length;
    const startLine = params.startLine ?? 1;
    const endLine = params.endLine ?? lineCount;
    if (!Number.isInteger(startLine) || startLine < 1)
        throw new Error(`startLine (${startLine}) must be a positive integer`);
    if (!Number.isInteger(endLine) || endLine < 1)
        throw new Error(`endLine (${endLine}) must be a positive integer`);
    if (endLine < startLine)
        throw new Error(`endLine (${endLine}) must be >= startLine (${startLine})`);
    // Optional name-pattern filter. Compiled as a regexp — no substring
    // fallback, matching code_tree's contract. A bad pattern is a hard error
    // (isError) so the agent learns the syntax fast.
    let nameRe: RegExp | undefined;
    if (params.pattern !== undefined && params.pattern !== "") {
        try {
            nameRe = new RegExp(params.pattern);
        } catch (e) {
            throw new Error(
                `Invalid regexp /${params.pattern}/: ${e instanceof Error ? e.message : e}`,
            );
        }
    }
    let entries;
    try {
        entries = await parseSymbols(tsLang, {
            text,
            startLine,
            endLine,
            roles: params.roles as Parameters<typeof parseSymbols>[1]["roles"],
        });
    } catch (e) {
        // Hard failure: tree-sitter or a grammar failed to load. Throw so the
        // agent gets isError: true rather than an unparseable string.
        throw new Error(`parse failed: ${e}`);
    }
    if (entries === null) throw new Error(`No grammar for ${params.path}`);
    // Apply the optional name filter after parsing. Filtering here (rather than
    // inside parseSymbols) keeps parseSymbols a pure syntax-walk and lets this
    // tool own the "pattern scopes the candidate set" contract.
    if (nameRe) entries = entries.filter((e) => nameRe!.test(e.name));
    // Optional hover enrichment. One LSP hover call per unique (name, role);
    // the LSP server for the file's language is spawned lazily here (and only
    // when include_docs is true — the default path makes zero LSP calls).
    // The scan itself already succeeded; if the enrichment server is
    // unavailable, return the scan WITHOUT docs plus a trailing note rather
    // than discarding the valid scan results.
    let docs: Map<string, string> | undefined;
    let docsNote = "";
    if (params.include_docs && entries.length > 0) {
        const lang = tsLangToLspLang(tsLang);
        let client: LspClient;
        try {
            client = await clientOf(lang);
        } catch (e) {
            docsNote = `\n# WARNING: could not enrich with docs (${lang}: server unavailable: ${e})`;
            return renderSymbolTable(params.path, startLine, endLine, entries) + docsNote;
        }
        docs = new Map();
        for (const e of entries) {
            const key = `${e.name}|${e.role}`;
            if (docs.has(key)) continue;
            const h = await client.hover(abs, e.line - 1, e.column - 1, text);
            const first = hoverFirstLine(hoverText(h));
            docs.set(key, first);
        }
    }
    return renderSymbolTable(params.path, startLine, endLine, entries, docs);
}

// ---------------------------------------------------------------------------
// 8. code_diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticsParams {
    path: string;
}

export async function diagnostics(
    params: DiagnosticsParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the file at all. Throw so index.ts's err()
        // sets isError: true — the agent gets a machine-readable failure bit
        // instead of an inline string indistinguishable from a data row.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        // Hard failure: the language server could not be spawned.
        throw new Error(`${lang}: server unavailable: ${e}`);
    }
    // Open the document on the server and (for cpp) wait for ccls to finish
    // indexing this TU. didOpen is required for the server to analyze the
    // file; both the pull model (textDocument/diagnostic) and the push model
    // (textDocument/publishDiagnostics) operate on opened documents. The cpp
    // indexing wait is best-effort (see awaitReadyForQuery); the push
    // fallback below no longer needs to repeat it. Idempotent (openDocument
    // dedupes by URI).
    await awaitReadyForQuery(lang, client, abs, text);
    // Try the pull model first (LSP 3.17 textDocument/diagnostic). We do NOT
    // pre-gate on supportsPullDiagnostics(): pyright answers without
    // advertising diagnosticProvider, while bash-language-server rejects with
    // a JSON-RPC "Unhandled method" error. The request itself is the source
    // of truth: a server that can't answer returns an error we fall back
    // from (below) rather than trusting advertised capabilities.
    let diags: Diagnostic[] | null | undefined;
    let pullError: Error | null = null;
    try {
        diags = await client.pullDiagnostics(abs);
    } catch (e) {
        pullError = e instanceof Error ? e : new Error(String(e));
    }
    // FALLBACK: push model (textDocument/publishDiagnostics). Servers that reject
    // the pull model (typescript-language-server, bash-language-server, ccls)
    // still emit publishDiagnostics notifications after didOpen, but only if the
    // client advertised textDocument.publishDiagnostics in initialize (which
    // LspClient.start() does). This wait is now EVENT-DRIVEN: instead of polling
    // the push cache on a fixed ~1.2s budget (far too short for ccls, which
    // publishes only after whole-project indexing — often 10-60s on a cold
    // cache), we block on a promise that resolves the instant the server
    // actually pushes diagnostics for this URI. The contract stays
    // synchronous (one bounded wait → one result); it is NOT an open-ended
    // notification collector.
    //
    // For cpp specifically, ccls publishes publishDiagnostics for a file only
    // once its translation unit has compiled — which on a cold cache happens
    // DURING whole-project indexing. We already waited for indexing to
    // complete above (awaitReadyForQuery, event-driven via ccls's $/progress
    // "end"), so the push is ready to arrive; here we just wait for it. This
    // is the user's "wait while it is ready" ask: the tool no longer times
    // out mid-index and surfaces a misleading pull-error.
    if (pullError || diags === null) {
        // cpp indexing was already waited for above (awaitReadyForQuery), so
        // ccls's publishDiagnostics (which fires only after the TU compiles)
        // is now ready to arrive. We just wait for the push.
        const pushed = await client.waitForPushedDiagnostics(abs, lang === "cpp" ? 30000 : 5000);
        if (pushed !== undefined) {
            // Push succeeded. If the push cache is ALSO empty but pull rejected,
            // mention the pull failure so the user can tell a clean file from a
            // silent server.
            if (pushed.length === 0 && pullError) {
                return `(no diagnostics for ${params.path}; pull model rejected: ${pullError.message})`;
            }
            return renderDiagnostics(params.path, pushed);
        }
        // No push diagnostics arrived either - surface the pull error honestly.
        if (pullError) {
            // Hard failure: the pull request errored AND no push diagnostics
            // arrived — the server cannot report diagnostics for this file.
            throw new Error(
                `${lang}: textDocument/diagnostic request failed: ${pullError.message}`,
            );
        }
        return `(no diagnostics returned for ${params.path})`;
    }
    return renderDiagnostics(params.path, diags as Diagnostic[]);
}

/**
 * Removed: the old `pollPushedDiagnostics` polled the push cache on a fixed
 * ~1.2s budget. That was too short for ccls (publishes only after indexing)
 * and not event-driven. `code_diagnostics` now uses
 * `LspClient.waitForPushedDiagnostics()`, which resolves on the actual
 * `textDocument/publishDiagnostics` notification. See
 * `docs/code_diagnostics.md`.
 */

/** Shared renderer for the diagnostic list (pull or push origin). */
function renderDiagnostics(path: string, diags: Diagnostic[]): string {
    if (diags.length === 0) {
        return `(no diagnostics for ${path})`;
    }
    const lines = diags.map((d) => renderDiagnostic(path, d));
    return `${diags.length} diagnostic(s) for ${path}:\n` + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Error type: the caller (index.ts) decides whether to return isError.
// Unknown-language is a top-level hard failure for the single-file tools
// (outline/tree/definition/rename/scan/diagnostics); references/hover emit
// it inline as an ERROR row. We throw here so index.ts can mark
// isError: true for the single-file case; references/hover check
// langForFile inline and emit an ERROR row instead of letting it escape.
// ---------------------------------------------------------------------------

export class UnknownLanguageError extends Error {
    constructor(public readonly path: string) {
        super(`Unknown language for file: ${path}`);
        this.name = "UnknownLanguageError";
    }
}
