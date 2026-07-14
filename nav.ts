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
 *     found, multiple definitions, could not resolve body range,
 *     pull-diagnostics request failed.
 *   - SOFT failures (per-position in the batched tools: references/hover;
 *     per-language in symbol) are emitted as a structured row
 *     `ERROR  <path>:<line>:<col>  <reason>` (or `ERROR  [lang]  <reason>`
 *     for symbol) that parses with the SAME column grammar as a data row.
 *     The leading `ERROR` token distinguishes them from data; a consumer
 *     splits rows on `\n` and checks the first token. Applies to: unknown
 *     language, cannot read, server unavailable.
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
import { resolve } from "node:path";
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
    applyWorkspaceEdit,
    langForFile,
} from "./render";

/** Provides a per-language LspClient on demand (mirrors ServerPool.client). */
export interface ClientProvider {
    (lang: Lang): Promise<LspClient>;
}

/** A position triple as accepted by the batched-position tools. */
export interface Position {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
}

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
    for (const lang of ["cpp", "python", "bash", "typescript"] as Lang[]) {
        const markers = ROOT_MARKERS[lang];
        if (markers?.some((m) => existsSync(resolve(rootPath, m)))) {
            found.add(lang);
        }
    }
    if (found.size === 4) return [...found];

    // Tier 2: bounded breadth-first source-extension scan. Build the set of
    // languages still unconfirmed so we can stop early once all resolve.
    const wanted = new Set<Lang>(["cpp", "python", "bash", "typescript"]);
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
    if (found.size === 0) return ["cpp", "python", "bash", "typescript"];
    return [...found];
}

/** Clear the detection cache. Tests call this between cases so results from
 * one temp-dir root don't leak into another through the shared module. */
export function clearDetectedLanguagesCache(): void {
    detectedLanguagesCache.clear();
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
 * See docs/outline-constants.md.
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
 * Format: `<pad><Kind> <name>  <signature>  (line:col)` where the signature
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
    return `${pad}${kindName} ${sym.name}${l}  (${pos})`;
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
// like the read tool, but scoped to a symbol's body. Output format:
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
// Error contract: HARD failures THROW (index.ts's err() sets isError: true).
// There are NO fallbacks and NO soft-failure rows — if we cannot return
// verbatim source code for any reason, the tool fails loudly so the agent
// knows it got nothing reusable. Covers: unknown language, cannot read input
// file, server unavailable, no definition found, could not read the
// definition's source file, could not resolve the body range. A clean "no
// definition found" (e.g. a built-in, or a position that isn't a symbol) is
// ALSO a hard error now — the tool's contract is "returns source code", so
// the absence of a definition is a failure to fulfill that contract, not a
// legitimate empty result.
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
    const def = await client.definition(abs, params.line - 1, params.column - 1, text);
    const locs = (Array.isArray(def) ? def : def ? [def] : []) as Location[];
    if (locs.length === 0) {
        // Hard failure: no definition found. The tool's contract is "returns
        // verbatim source code"; the absence of a definition means we cannot
        // fulfill it. No parenthesized-note fallback — throw so the agent knows
        // it got nothing reusable and can try another approach (code_hover,
        // code_search_symbol, etc.).
        throw new Error(
            `No definition found for ${params.path}:${params.line}:${params.column}`,
        );
    }
    // A position may resolve to multiple definition sites (overloads,
    // multi-definition symbols). The contract is ONE verbatim body per call;
    // multiple sites is an ambiguous result the agent can't consume as a single
    // edit target, so it's a hard error naming the count and the sites.
    if (locs.length > 1) {
        const sites = locs
            .map((loc) => {
                const lp = uriToPath(loc.uri);
                const sl0 = loc.range?.start?.line ?? 0;
                const sc0 = loc.range?.start?.character ?? 0;
                return `${lp}:${sl0 + 1}:${sc0 + 1}`;
            })
            .join(", ");
        throw new Error(
            `Multiple definitions (${locs.length}) for ${params.path}:${params.line}:${params.column}: ${sites}`,
        );
    }
    const loc = locs[0];
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
    const sl = body.startLine; // 0-based LSP line
    const el = body.endLine; // 0-based LSP line
    const srcLines = src.split(/\r?\n/);
    const snippet = srcLines.slice(sl, el + 1).join("\n");
    const out: string[] = [];
    // Header: <defPath>:<sl>-<el> (1-based inclusive line range of the body).
    // defPath is the path the definition lives in — relative or absolute as
    // the server returned it (the agent can feed it back into code_* tools).
    out.push(`${defPath}:${sl + 1}-${el + 1}`);
    out.push(snippet);
    // Optional tree-sitter symbol table over the snippet. Reuses the same
    // parseSymbols helper as code_scan. The snippet's absolute line range is
    // (sl+1 .. el+1) in 1-based coords. Only run when requested: default
    // false keeps code_definition's output focused on the verbatim body.
    if (params.list_symbols) {
        const tsLang = tsLangForFile(defPath);
        if (tsLang) {
            try {
                const entries = await parseSymbols(tsLang, {
                    text: src,
                    startLine: sl + 1,
                    endLine: el + 1,
                });
                if (entries && entries.length > 0) {
                    // Blank line separates the verbatim body from the symbol
                    // table so an agent can unambiguously tell where the body
                    // ends and the table begins (the body itself may contain
                    // lines that look table-like).
                    out.push("");
                    out.push(renderSymbolTable(defPath, sl + 1, el + 1, entries));
                }
            } catch (e) {
                // Hard failure: the symbol scan failed. The verbatim body was
                // already retrieved (the primary contract), but list_symbols
                // is an explicit request the agent is relying on — surface the
                // failure rather than silently omitting the table.
                throw new Error(`symbol scan failed for ${defPath}:${sl + 1}-${el + 1}: ${e}`);
            }
        }
    }
    return out.join("\n");
}

// ---------------------------------------------------------------------------
// 3. code_references
// ---------------------------------------------------------------------------

export interface ReferencesParams {
    positions: Position[];
}

export async function references(
    params: ReferencesParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const posList: Position[] = params.positions;
    const out: string[] = [];
    const clients = new Map<Lang, LspClient>();
    for (const pos of posList) {
        const lang = langForFile(pos.path);
        if (lang === null) {
            out.push(
                (posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "") +
                    renderErrorRow(pos.path, pos.line, pos.column, `unknown language for file`),
            );
            continue;
        }
        let client = clients.get(lang);
        if (!client) {
            try {
                client = await clientOf(lang);
            } catch (e) {
                out.push(
                    (posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "") +
                        renderErrorRow(
                            pos.path,
                            pos.line,
                            pos.column,
                            `${lang}: server unavailable: ${e}`,
                        ),
                );
                continue;
            }
            clients.set(lang, client);
        }
        const abs = toAbs(pos.path, cwd);
        let text: string;
        try {
            text = await readFile(abs, "utf8");
        } catch (e) {
            out.push(
                (posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "") +
                    renderErrorRow(pos.path, pos.line, pos.column, `cannot read ${abs}: ${e}`),
            );
            continue;
        }
        const refs = await client.references(abs, pos.line - 1, pos.column - 1, text);
        if (refs.length === 0) {
            // Clean empty result (the symbol has no references) — NOT a failure.
            // Kept as a parenthesized note (matching outline/diagnostics/scan's
            // empty-result convention) rather than an ERROR row, so an agent
            // checking the leading token doesn't mistake a legitimate "unused
            // symbol" for a failure.
            out.push(
                (posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "") +
                    `(no references found for ${pos.path}:${pos.line}:${pos.column})`,
            );
            continue;
        }
        const rendered = refs.map((r) => renderLocation(r));
        const header = posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "";
        // Drop the leading "N reference(s):" count line — it was prose the
        // agent had to strip to get the list. The ### header already labels the
        // position, and a trailing comment line (# N references) is trivially
        // ignorable while keeping the count for the few callers that want it.
        out.push(header + rendered.join("\n") + `\n# ${rendered.length} references`);
    }
    return out.join("\n");
}

// ---------------------------------------------------------------------------
// 4. code_search_symbol
// ---------------------------------------------------------------------------

export interface SymbolParams {
    query: string;
    language?: string;
}

export async function symbol(
    params: SymbolParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
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
            // Per-language soft failure: structured ERROR row (leading `ERROR`
            // token distinguishes it from the `[lang] Kind name path:line:col`
            // data rows). One language failing must not discard results
            // already collected from earlier languages.
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
        // ensureProjectLoaded opens one source file (a no-op for other
        // servers, which index eagerly on initialize). If it returns false
        // (no source file of this language exists in the workspace), skip the
        // language entirely — calling workspace/symbol on a project-less
        // tsserver throws "No Project." and would abort the whole query.
        if (!(await client.ensureProjectLoaded())) continue;
        let syms: SymbolInformation[];
        try {
            syms = await client.workspaceSymbol(params.query);
        } catch (e) {
            // One language failing must not discard results already
            // collected from earlier languages.
            out.push(`ERROR  [${lang}]  workspace/symbol failed: ${e}`);
            continue;
        }
        for (const s of syms) {
            const selStart = await resolveSymbolSelStart(client, s, docCache);
            out.push(`[${lang}] ${renderSymbolInfo(s, selStart)}`);
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
    const edit = await client.rename(abs, params.line - 1, params.column - 1, text, params.newName);
    const applied = await applyWorkspaceEdit(edit);
    if (applied.length === 0) return `(rename produced no edits)`;
    const lines = applied.map((f) => `${f.path}: ${f.edits} edit(s)`);
    return `Renamed to "${params.newName}". Applied:\n` + lines.join("\n");
}

// ---------------------------------------------------------------------------
// 6. code_hover
// ---------------------------------------------------------------------------

export interface HoverParams {
    positions: Position[];
}

export async function hover(
    params: HoverParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    const posList: Position[] = params.positions;
    const out: string[] = [];
    const clients = new Map<Lang, LspClient>();
    for (const pos of posList) {
        const lang = langForFile(pos.path);
        if (lang === null) {
            out.push(
                (posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "") +
                    renderErrorRow(pos.path, pos.line, pos.column, `unknown language for file`),
            );
            continue;
        }
        let client = clients.get(lang);
        if (!client) {
            try {
                client = await clientOf(lang);
            } catch (e) {
                out.push(
                    (posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "") +
                        renderErrorRow(
                            pos.path,
                            pos.line,
                            pos.column,
                            `${lang}: server unavailable: ${e}`,
                        ),
                );
                continue;
            }
            clients.set(lang, client);
        }
        const abs = toAbs(pos.path, cwd);
        let text: string;
        try {
            text = await readFile(abs, "utf8");
        } catch (e) {
            out.push(
                (posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "") +
                    renderErrorRow(pos.path, pos.line, pos.column, `cannot read ${abs}: ${e}`),
            );
            continue;
        }
        const h = await client.hover(abs, pos.line - 1, pos.column - 1, text);
        const body = hoverText(h);
        const header = posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "";
        // Signature-first: emit the collapsed one-line signature (when one can
        // be extracted) as the first line, then the full hover markdown. This
        // surfaces structured signature info that would otherwise be buried in
        // a ```python fence or a multi-paragraph docstring. The `signature:`
        // prefix lets a consumer pick the first line cheaply without parsing
        // the markdown body.
        const sig = hoverSignature(body);
        const sigLine = sig ? `signature: ${sig}\n` : "";
        out.push(header + sigLine + body);
    }
    return out.join("\n");
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
    // Open the document on the server. didOpen is required for the server
    // to analyze the file; both the pull model (textDocument/diagnostic) and
    // the push model (textDocument/publishDiagnostics) operate on opened
    // documents. Idempotent (openDocument dedupes by URI).
    await client.openDocument(abs, text);
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
    // LspClient.start() now does). The notification handler in LspClient caches
    // the latest set per URI; we poll it for up to ~1.2s to let the server's
    // diagnostics delayer fire (tsserver delays 300-800ms by line count; ccls
    // publishes after indexing). The tool contract stays synchronous - this is
    // a bounded wait, not open-ended collection.
    if (pullError || diags === null) {
        const pushed = await pollPushedDiagnostics(client, abs);
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
 * Poll the client's push-diagnostics cache for `absPath` until it has a value
 * or the budget (~1.2s) is exhausted. Returns undefined if nothing arrived.
 * Servers that push publishDiagnostics do so on their own schedule (tsserver:
 * a Delayer(300) + a 300-800ms computed delay after didOpen). The first poll
 * is immediate (the server may have already fired during initialize/didOpen
 * round-trips); later polls back off.
 */
async function pollPushedDiagnostics(
    client: LspClient,
    absPath: string,
): Promise<Diagnostic[] | undefined> {
    const waits = [0, 100, 200, 300, 600]; // ~1.2s total budget
    for (const w of waits) {
        if (w > 0) await new Promise((r) => setTimeout(r, w));
        const diags = client.getPushedDiagnostics(absPath);
        if (diags !== undefined) return diags;
    }
    return undefined;
}

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
// (outline/rename/symbols_in/diagnostics); the batched tools (definition/
// references/hover) push it inline per-position. We throw here so index.ts can
// mark isError: true for the single-file case; the batched functions catch it
// themselves (they never let it escape — they check langForFile inline).
// ---------------------------------------------------------------------------

export class UnknownLanguageError extends Error {
    constructor(public readonly path: string) {
        super(`Unknown language for file: ${path}`);
        this.name = "UnknownLanguageError";
    }
}
