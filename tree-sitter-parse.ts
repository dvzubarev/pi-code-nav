/**
 * tree-sitter-based symbol discovery for code_scan.
 *
 * Why this module exists: the six LSP tools answer "tell me about the symbol
 * at this position," but they cannot answer "I'm looking at a snippet — what
 * are the symbols in it and where do they sit?" That gap matters most for
 * third-party / stdlib / system symbols, where `workspace/symbol`
 * (`code_search_symbol`) is useless because LSP `workspace/symbol` is
 * workspace-scoped by spec (it indexes your project tree, never site-packages
 * or /usr/include). See code_scan.md "What it solves".
 *
 * The design: parse a line range of a REAL file with tree-sitter, walk the
 * syntax tree collecting identifier-class nodes, and emit a table of
 * (name, role, absolute-1-based-position). The agent reads a row and passes
 * its coordinates straight into code_hover / code_definition / code_references
 * / code_outline — which already resolve third-party symbols at a known
 * position. tree-sitter (not regex) is used because it distinguishes
 * identifiers from comment/string noise for free, skips keywords by node type
 * (no keyword blacklist to maintain), and gives a syntactic role per node.
 *
 * This module makes ZERO LSP calls. `include_docs` enrichment (hovering each
 * symbol) is done by the caller in index.ts, not here, so the common path is
 * pure parsing — one tree-sitter parse, no server round-trips.
 *
 * Snippet parsing works without wrapping: tree-sitter's error-recovery handles
 * function-body fragments (no enclosing def / #include / {}). Verified against
 * the exact snippets code_definition returns. Do NOT add scratch-file wrapping
 * "to be safe" — it is unnecessary and the design explicitly rejects it.
 *
 * Dependency choice: we use the WASM builds (web-tree-sitter runtime +
 * tree-sitter-wasm prebuilt grammars) rather than the native node bindings.
 * The native `tree-sitter` / `tree-sitter-python` / `tree-sitter-cpp` /
 * `tree-sitter-bash` packages have irreconcilable peer-dependency ranges
 * (tree-sitter-cpp@0.23.4 requires tree-sitter@^0.21.1 while
 * tree-sitter-python@0.25 requires tree-sitter@^0.25.0 — there is no single
 * tree-sitter version satisfying all three grammars without --legacy-peer-deps).
 * The WASM path has no native compilation, no peer conflicts, and the grammars
 * ship prebuilt. This is the first runtime dep beyond vscode-jsonrpc /
 * vscode-languageserver-protocol; see code_scan.md "Dependency — WASM, not native bindings".
 */

import { Parser, Language } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { readFile } from "node:fs/promises";

/**
 * The syntactic role assigned to a discovered identifier.
 *
 * - `type`   — a type name (Python annotation, C++ type_identifier).
 * - `call`    — a function/method being called.
 * - `member`  — a field/attribute access (`.push_back`, `.encode`).
 * - `import` — a name brought into scope by an import (Python module /
 *   imported symbol). Separated from `var` so that "drop the noisy locals"
 *   does not also drop the third-party entry points imports represent.
 * - `var`    — a local variable, parameter, or assignment target. Hoverable
 *   but rarely what the agent wants to learn about; noisy by nature (loop
 *   vars, temps, counters), so excluded from the default role set.
 */
export type SymbolRole = "type" | "call" | "member" | "import" | "var";

/** One row of the symbol table returned by parseSymbols. */
export interface SymbolEntry {
    role: SymbolRole;
    name: string;
    /** Absolute 1-based line (startLine + tree-relative 0-based row). */
    line: number;
    /** Absolute 1-based column (0-based tree column + 1). */
    column: number;
}

/**
 * Languages we can parse. Mirrors the LSP `Lang` set, but kept independent so
 * this module has no dependency on lsp-client.ts (it makes no LSP calls).
 * Bash is included; its node classification is deliberately conservative
 * (see classifyBash) — bare `word` nodes are skipped because they are mostly
 * arguments/literals and too noisy, matching the design doc's "finalize bash
 * when implementing; don't block on it" guidance.
 */
export type TsLang = "python" | "cpp" | "bash" | "typescript" | "tsx";

/** Map a file extension to a tree-sitter language, or null if unsupported. */
export function tsLangForFile(path: string): TsLang | null {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    const ext = path.slice(dot).toLowerCase();
    if (ext === ".py") return "python";
    if (
        ext === ".c" ||
        ext === ".cc" ||
        ext === ".cpp" ||
        ext === ".cxx" ||
        ext === ".h" ||
        ext === ".hh" ||
        ext === ".hpp" ||
        ext === ".hxx" ||
        ext === ".m" ||
        ext === ".mm"
    )
        return "cpp";
    if (ext === ".sh" || ext === ".bash") return "bash";
    // TypeScript and TSX get distinct tree-sitter grammars: the `typescript`
    // grammar mis-parses JSX (`<div>` becomes type_arguments, `{x}` an object),
    // so .tsx must use the `tsx` grammar. .js/.jsx/.mjs/.cjs parse with the
    // typescript grammar (JavaScript is a strict subset for our role purposes —
    // call/member/type/import classification is identical).
    if (
        ext === ".ts" ||
        ext === ".mts" ||
        ext === ".cts" ||
        ext === ".js" ||
        ext === ".mjs" ||
        ext === ".cjs"
    )
        return "typescript";
    if (ext === ".tsx" || ext === ".jsx") return "tsx";
    return null;
}

/**
 * Map a tree-sitter language to the LSP `Lang` whose server can answer
 * hover/definition for files of that grammar.
 *
 * `TsLang` is a superset of `Lang`: `.tsx` (and `.jsx`) parse with the `tsx`
 * tree-sitter grammar but are served by the single `typescript` LSP server
 * (typescript-language-server), which distinguishes .ts/.tsx via the
 * `languageId` it gets in didOpen. Callers that need an LSP client for a
 * `tsLang` (e.g. code_scan's `include_docs` enrichment) MUST go through
 * this helper rather than casting `tsLang as Lang` — that cast is only valid
 * for python/cpp/bash/typescript and would break for `tsx`.
 */
export type LspLang = "python" | "cpp" | "bash" | "typescript";
export function tsLangToLspLang(lang: TsLang): LspLang {
    if (lang === "tsx") return "typescript";
    return lang;
}

// ---------------------------------------------------------------------------
// Parser / language lifecycle.
//
// web-tree-sitter's Parser.init() must run once before any Parser is
// constructed; Language.load loads a grammar WASM into a Language object. We
// cache both: the init promise and the per-language Language so repeated
// code_scan calls pay zero startup cost after the first.
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;
const languageCache = new Map<TsLang, Promise<Language>>();

/** Idempotently initialize the web-tree-sitter wasm runtime. */
function ensureInit(): Promise<void> {
    if (!initPromise) {
        // Parser.init() with no options: in Node it auto-locates web-tree-sitter.wasm
        // relative to the module (via import.meta.url). Verified under jiti.
        initPromise = Parser.init().catch((e) => {
            initPromise = null; // allow retry on failure
            throw e;
        });
    }
    return initPromise;
}

/** Get (and cache) the loaded Language for a tree-sitter language. */
async function getLanguage(lang: TsLang): Promise<Language> {
    let cached = languageCache.get(lang);
    if (!cached) {
        cached = (async () => {
            await ensureInit();
            const wasmPath = getWasmPath(lang);
            const wasmBytes = await readFile(wasmPath);
            return Language.load(wasmBytes);
        })().catch((e) => {
            languageCache.delete(lang); // allow retry on failure
            throw e;
        });
        languageCache.set(lang, cached);
    }
    return cached;
}

// ---------------------------------------------------------------------------
// Role classification — the heart of the module.
//
// Each grammar names its identifier-class nodes differently and encodes role
// via parent type + field name. We use field names (fieldNameForChild) where
// the grammar provides them (robust across grammar versions) and fall back to
// parent type otherwise. Field-name lookup MUST compare via node.id (not
// reference equality): web-tree-sitter returns a fresh proxy wrapper per
// .child() call, so `parent.child(i) === node` is always false. This was a
// real bug during development; do not "simplify" it back to ===.
// ---------------------------------------------------------------------------

/** Look up the field name a node has within its parent (or null). */
function fieldOf(node: TSNode): string | null {
    const parent = node.parent;
    if (!parent) return null;
    for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child && child.id === node.id) return parent.fieldNameForChild(i);
    }
    return null;
}

/** Minimal structural view of a web-tree-sitter Node (decouples from the lib's types). */
interface TSNode {
    type: string;
    text: string;
    id: number;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    parent: TSNode | null;
    childCount: number;
    child(index: number): TSNode | null;
    children: TSNode[];
    fieldNameForChild(index: number): string | null;
    /** Return the smallest node covering the span [start, end] (inclusive). */
    descendantForPosition(
        start: { row: number; column: number },
        end: { row: number; column: number },
    ): TSNode | null;
}

/**
 * Classify a tree-sitter node into a SymbolRole, or null to skip it.
 *
 * Returns null for: keywords (they are statement nodes, not identifiers),
 * punctuation, comments, strings, namespace qualifiers (the `std` in
 * `std::sort` — the meaningful name is the `identifier` child), the
 * `identifier` child of a python `type` annotation (the `type` node itself is
 * the entry), and bare bash `word` arguments.
 */
function classifyRole(node: TSNode, lang: TsLang): SymbolRole | null {
    const t = node.type;
    const parent = node.parent;
    const pt = parent?.type ?? null;
    const gp = parent?.parent?.type ?? null;
    const field = fieldOf(node);

    if (lang === "python") {
        // `type` is the annotation node (e.g. `int` in `y: int = ...`); its child
        // `identifier` is the same text — emit the `type` node, skip the child.
        //
        // A `type` node can be nested inside another type construct: Python's
        // grammar wraps every annotation in a `type` node, and generics / unions
        // spawn child `type` nodes for each component, e.g.
        //   Callable[[CBOREncoder, Any], None] | None
        // parses as type(union_type(type(generic_type(Callable, type_parameter(
        // type([CBOREncoder, Any]), type(None)))), type(None))) — four `type`
        // nodes for ONE annotation. Emitting all of them floods the table with
        // subtypes the agent did not ask for. So emit only the OUTERMOST `type`
        // node: skip a `type` whose parent is itself a type-context node (`type`,
        // `union_type`, or `type_parameter`). The inner identifiers (Callable,
        // CBOREncoder, Any) are still emitted individually below as `var`.
        if (t === "type") {
            if (pt === "type" || pt === "union_type" || pt === "type_parameter") return null; // nested subtype — covered by the outer `type` node
            return "type";
        }
        if (t === "identifier") {
            if (pt === "type") return null; // covered by the `type` node above
            // Names brought into scope by imports (module names, imported symbols,
            // aliases) get their own `import` role — distinct from local `var` —
            // so the default "drop the noisy locals" filter does not also drop the
            // third-party entry points imports represent. In the grammar, import
            // identifiers sit inside `dotted_name` (parent) under an import/aliased
            // statement (grandparent), or directly under `aliased_import` (alias).
            // `dotted_name` also appears in expressions as `os.path`, but there the
            // parent is `attribute`, not `dotted_name`, so no false match.
            if (pt === "aliased_import") return "import"; // the alias name (np, CE)
            if (
                pt === "dotted_name" &&
                (gp === "import_statement" ||
                    gp === "import_from_statement" ||
                    gp === "aliased_import")
            )
                return "import";
            if (pt === "attribute") {
                // `cbor2.load`: field "attribute" = the member; field "object" = base.
                return field === "attribute" ? "member" : "var";
            }
            if (pt === "call") return "call"; // bare-name call: `compute(...)`
            return "var"; // assignment target, argument, etc.
        }
        return null;
    }

    if (lang === "cpp") {
        if (t === "type_identifier") return "type";
        if (t === "field_identifier") return "member"; // `data.begin` → `begin`
        if (t === "namespace_identifier") return null; // `std` — skip; name is the identifier child
        if (t === "identifier") {
            // Base object of a field_expression: `data` in `data.begin`.
            if (pt === "field_expression") {
                return field === "argument" ? "var" : null;
            }
            // Right-hand side of `::` in a qualified_identifier: `sort` in `std::sort`.
            // Role depends on whether the qualified_identifier is being called.
            if (pt === "qualified_identifier" && field === "name") {
                return gp === "call_expression" ? "call" : "type";
            }
            // Bare identifier called directly: `foo(...)`.
            if (pt === "call_expression") return "call";
            // Declaration / parameter names.
            if (
                pt === "declaration" ||
                pt === "init_declarator" ||
                pt === "parameter_declaration" ||
                pt === "parameter_list"
            )
                return "var";
            // An identifier passed as an argument.
            if (pt === "argument_list") return "var";
            return "var";
        }
        return null;
    }

    // bash — conservative: variable_name → var, command (the word inside
    // command_name) → call, everything else (bare word arguments, strings) →
    // skip. Bare words are mostly arguments/literals and too noisy; the design
    // doc explicitly deferred bash polish.
    if (lang === "bash") {
        if (t === "variable_name") return "var";
        if (t === "word" && pt === "command_name") return "call";
        return null;
    }

    // TypeScript / TSX — the two grammars share the node-type vocabulary for
    // everything except JSX, so one branch covers both.
    //
    // Node types of interest:
    //   type_identifier        — a type occurrence (class name, interface,
    //                             type alias, generic type, type annotation).
    //                             NOT the definition site only — every use is a
    //                             `type` so the agent can hover any of them.
    //   property_identifier     — the right of `.` in `obj.prop`, a class
    //                             field/method name, an interface member, an
    //                             enum member, a JSX attribute. → `member`.
    //   identifier              — everything else: the imported name, the called
    //                             name, the constructed class, the base of a
    //                             member expression, a declaration / parameter /
    //                             local. Classified by parent + field below.
    if (lang === "typescript" || lang === "tsx") {
        if (t === "type_identifier") return "type";
        // Primitive type annotations (number, string, boolean, void, any, ...) are
        // `predefined_type` nodes, not `type_identifier`. Treat them as `type` so
        // hover/definition works on them too — they are real type references.
        if (t === "predefined_type") return "type";
        if (t === "property_identifier" || t === "shorthand_property_identifier") {
            return "member";
        }
        if (t === "identifier") {
            // Imports — the names brought into scope. The TS grammar puts every
            // imported/aliased identifier under an import/export construct; these
            // are the third-party entry points `code_scan` exists to find.
            //   import { readFile } from "..."   → import_specifier (field name)
            //   import * as fs from "..."         → namespace_import
            //   import foo from "..."             → import_clause (default)
            //   export { bar } from "..."         → export_specifier (re-export)
            //   import type { Lang } from "..."   → same import_specifier path
            if (
                pt === "import_specifier" ||
                pt === "namespace_import" ||
                pt === "import_clause" ||
                pt === "export_specifier" ||
                pt === "aliased_export" ||
                pt === "aliased_import"
            ) {
                return "import";
            }
            // A name being called: `compute(...)`. field `function` of a
            // call_expression. Also covers `obj.method()` because the callee is
            // the whole member_expression (its property_identifier child becomes
            // a `member` above); the bare-identifier call path is just `f()`.
            if (pt === "call_expression" && field === "function") return "call";
            // `new Foo()` — Foo is a constructor reference; treat as a call site.
            if (pt === "new_expression" && field === "constructor") return "call";
            // Right of `.` in a member_expression is a property_identifier (above).
            // The LEFT (field `object`) is the base — a local/var like `obj`, or
            // another member_expression in a chain (`a.b.c`): the outer base is a
            // member_expression whose own property_identifier is emitted as
            // `member`, so this `identifier` base is just `var`.
            if (pt === "member_expression" && field === "object") return "var";
            // Everything else is a declaration name, parameter, or local. Match
            // Python's convention (def name → var) so declaration names are
            // omitted from the default role set and don't clutter the table.
            return "var";
        }
        return null;
    }

    return null;
}

// ---------------------------------------------------------------------------
// The public entry point.
// ---------------------------------------------------------------------------

/**
 * Roles emitted by default. Excludes `var` (local variables, parameters,
 * assignment targets) because those are hoverable but rarely what the agent
 * wants to *learn about* — they are the snippet's own locals, not external
 * APIs. `import` IS included: imported module names and symbols are the
 * primary entry points for third-party discovery (the whole reason this tool
 * exists). Callers wanting locals pass `roles` including `var`.
 */
export const DEFAULT_SYMBOL_ROLES: readonly SymbolRole[] = ["type", "call", "member", "import"];

export interface ParseSymbolsOptions {
    /** The real file's text (full file — we slice to [startLine, endLine]). */
    text: string;
    /** 1-based inclusive start line. */
    startLine: number;
    /** 1-based inclusive end line. */
    endLine: number;
    /**
     * Which roles to emit. Defaults to {@link DEFAULT_SYMBOL_ROLES} (all except
     * `var`). Pass an explicit list to include `var` or to narrow further.
     */
    roles?: readonly SymbolRole[];
}

/**
 * Parse a line range of `text` with tree-sitter and return a deduplicated
 * table of identifier-class symbols with absolute 1-based positions and roles.
 *
 * Steps (mirrors code_scan.md "What it solves"):
 *   1. Slice lines [startLine, endLine] (1-based, inclusive) from the full text.
 *   2. Parse the slice directly — NO wrapping, NO scratch file. tree-sitter's
 *      error-recovery handles function-body fragments.
 *   3. Walk the tree, classify each identifier-class node into a role.
 *   4. Filter to `opts.roles` (default: all except `var`).
 *   5. Map (row, col) → absolute 1-based (startLine + row, col + 1).
 *   6. Dedupe by (name, role); keep the FIRST occurrence's position. If the
 *      agent wants a later occurrence it passes a tighter startLine/endLine.
 *
 * Returns null if the language has no tree-sitter grammar. Throws if
 * tree-sitter or a grammar fails to load (the caller surfaces the error).
 */
export async function parseSymbols(
    lang: TsLang,
    opts: ParseSymbolsOptions,
): Promise<SymbolEntry[] | null> {
    const { text, startLine, endLine } = opts;
    const roleSet = opts.roles ?? DEFAULT_SYMBOL_ROLES;
    const allow = new Set(roleSet);
    // Slice the requested range (1-based inclusive). Lines beyond the file end
    // are simply absent — slice handles that by returning fewer lines.
    const allLines = text.split(/\r?\n/);
    // startLine is 1-based; array is 0-based → startLine - 1. endLine inclusive.
    const slice = allLines.slice(startLine - 1, endLine);
    if (slice.length === 0) return [];
    const sliceText = slice.join("\n");

    const language = await getLanguage(lang);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(sliceText);
    if (!tree) return []; // parser without a language returns null; setLanguage threw otherwise
    try {
        const entries: SymbolEntry[] = [];
        const seen = new Set<string>();
        const walk = (node: TSNode): void => {
            const role = classifyRole(node, lang);
            if (role && allow.has(role)) {
                const name = node.text;
                const key = `${name}|${role}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const sp = node.startPosition;
                    // Tree row is 0-based relative to the slice; startLine is 1-based.
                    // absolute 1-based line = startLine + row. Column is 0-based → +1.
                    entries.push({
                        role,
                        name,
                        line: startLine + sp.row,
                        column: sp.column + 1,
                    });
                }
            }
            for (const child of node.children) walk(child);
        };
        walk(tree.rootNode as unknown as TSNode);
        return entries;
    } finally {
        tree.delete();
        parser.delete();
    }
}

/**
 * Render a symbol table as the text an agent reads. Mirrored exactly in
 * nav-cli.mjs's `scan` subcommand — keep the two in sync (the harness's
 * "precise mirror of index.ts output" rule).
 *
 * Output format (1-based, reusable as code_* input). The full path appears
 * ONCE in the header; each row carries only `:line:col` (the row order is
 * stable, and the header path + row :line:col reconstructs the full position).
 * A one-line role legend follows the header so the agent can branch on the
 * closed enumeration without guessing:
 *
 *   Symbols in <path>:<startLine>-<endLine> (roles: type|call|member|import|var):
 *     type   vector      :43:11
 *     call   sort        :43:9
 *     ...
 *
 * Per-position soft failures emit a structured row with the SAME column
 * grammar as a data row, prefixed `ERROR` (mirrors `### position` headers):
 *
 *     ERROR  <path>:<line>:<col>  <reason>
 *
 * so a consumer splits rows on `\n` and distinguishes data from error by the
 * leading token (an ERROR row has kind `ERROR` and no name column).
 */
export function renderSymbolTable(
    path: string,
    startLine: number,
    endLine: number,
    entries: SymbolEntry[],
    docs?: Map<string, string>,
): string {
    if (entries.length === 0) {
        return `Symbols in ${path}:${startLine}-${endLine} (roles: type|call|member|import|var, 1-based, reusable as code_* input):\n  (no identifiers found)`;
    }
    const lines: string[] = [
        `Symbols in ${path}:${startLine}-${endLine} (roles: type|call|member|import|var, 1-based, reusable as code_* input):`,
    ];
    // Column widths for alignment: role is max 6 chars ("member"), name varies.
    // The path is NOT repeated per row — the header already states it, and the
    // row's `:line:col` plus the header path reconstructs the full position.
    // This matters for nix-store / site-packages paths, where repeating a long
    // absolute path on every row is pure context-window tax.
    const nameWidth = Math.max(...entries.map((e) => e.name.length));
    for (const e of entries) {
        // grep-style `:line:col` (no parens) — matches every other position
        // string in the toolset so a consumer splits on `:` uniformly. The path
        // is NOT repeated per row (header states it); `:line:col` + header path
        // reconstructs the full position.
        const loc = `${e.line}:${e.column}`;
        const doc = docs?.get(`${e.name}|${e.role}`);
        const label = doc ? `  ${doc}` : "";
        lines.push(`  ${e.role.padEnd(6)} ${e.name.padEnd(nameWidth)}  :${loc}${label}`);
    }
    return lines.join("\n");
}

/**
 * First substantive line of a hover text, for the optional include_docs label
 * column. Skips leading markdown code fences (```python / ```xml / ```) and
 * blank lines so the label is the actual signature/summary, not a fence line.
 * Returns "" for an empty hover so the caller can omit the label column.
 */
export function hoverFirstLine(hoverText: string): string {
    const lines = hoverText.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // Skip markdown code fences (```python, ```xml, ```, etc.).
        if (/^```/.test(line)) continue;
        return trunc(line, 80);
    }
    return "";
}

function trunc(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// code_definition support: enclosing-def + preceding doc-comment resolution.
// ---------------------------------------------------------------------------
//
// code_definition's contract is "return the verbatim source body of the
// symbol at this position". The LSP `documentSymbol` + `textDocument/definition`
// pair is the primary mechanism, but it has two gaps tree-sitter fills:
//
//   1. ccls's `textDocument/definition` MERGES "go to declaration" and "go to
//      definition"; on a cursor sitting ON a definition it deliberately jumps
//      to a (non-def) declaration (see docs/code_definition.md). ccls's
//      `documentSymbol` DOES reflect the opened file's actual syntax, so we
//      use it as a fast path — but for files ccls hasn't indexed (headers
//      pulled in via #include but not in compile_commands.json) ccls throws
//      `not indexed` for BOTH methods, leaving no way to resolve the body via
//      LSP at all.
//   2. For a header-only declaration (third-party API, no out-of-line body),
//      the best available source is the declaration + its preceding doc
//      comment. The doc comment is a sibling `comment` node immediately before
//      the declaration in the syntax tree.
//
// Tree-sitter parses the file LOCALLY (no language server, no compile
// database) so it works on un-indexed headers and third-party trees. It gives
// us the enclosing function/method/class/struct node at a position with a
// real body extent (vs LSP's identifier-span-only Location) AND the preceding
// comment sibling (the doc comment) in one parse.
//
// `findEnclosingDefWithDoc` is the helper. It returns the enclosing definition
// node's range, whether it has a body (a compound_statement / statement_block /
// class body — i.e. it's a real definition, not a prototype), and the range of
// the preceding doc comment if one is immediately above. Used by code_definition
// as the primary resolver on ccls-rejecting headers and as a verification /
// fallback on the languages where LSP already resolves the body.

/** Node types that count as a "definition" for code_definition's body
 * retrieval. A node of one of these types, found by walking up from the
 * cursor, is the enclosing definition whose body (or declaration) we
 * return. Function/method definitions and class/struct/enum specifiers are
 * the structural kinds the tool targets (matches code_outline's allowlist
 * plus function_definition for out-of-line C++ defs). */
const DEF_NODE_TYPES = new Set([
    // C++ / C: out-of-line function/method definition (has body).
    "function_definition",
    // C++ / C: class / struct / union / enum specifier (has body in `{ ... };`).
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
    // C++: a free-function or member prototype inside a class / at file scope.
    // `declaration` is broad (also covers `int x;`) so we only treat it as a
    // def when its declarator is a function_declarator (i.e. a function
    // prototype) — see isFunctionDeclaration. `field_declaration` covers
    // method prototypes inside a class body.
    "declaration",
    "field_declaration",
    // TypeScript / JavaScript: function/method/class/enum/interface declarations.
    "function_declaration",
    "method_definition",
    "class_declaration",
    "class",
    "enum_declaration",
    "interface_declaration",
    // Python: function / class definitions (always have bodies).
    "function_definition", // python uses the same node type name as C++
    "class_definition",
]);

/** Node types that carry a body (a `{ ... }` block) — i.e. a real definition,
 * not a prototype. Used to set `hasBody`. For C++ a `function_definition`
 * contains a `compound_statement`; a `class_specifier` contains a
 * `field_declaration_list`; both count as bodies. A `declaration` or
 * `field_declaration` for a function prototype contains NO body node. */
const DEF_BODY_NODE_TYPES = new Set([
    "function_definition", // C++ and Python
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
    "function_declaration", // TS
    "method_definition",
    "class_declaration",
    "class",
    "enum_declaration",
    "interface_declaration",
    "function_definition", // python (duplicate of the C++ entry — set dedupes)
    "class_definition",
]);

/** Is this node a `declaration` / `field_declaration` whose declarator is a
 * function prototype (so it's a function declaration, not a variable)? Used to
 * keep `declaration` out of the false-positive path (`int x;` is a declaration
 * but not a function def). */
function isFunctionDeclarationNode(node: TSNode, lang: TsLang): boolean {
    if (lang !== "cpp") {
        // For TS/Python the broad `declaration` node type isn't in DEF_NODE_TYPES
        // (they use function_declaration / function_definition), so this is moot.
        return false;
    }
    // Walk the declaration's descendants for a function_declarator. A prototype
    // `void foo(int);` parses as declaration > function_declarator; a variable
    // `int x;` parses as declaration > identifier (no function_declarator).
    let found = false;
    const visit = (n: TSNode): void => {
        if (found) return;
        if (n.type === "function_declarator") {
            found = true;
            return;
        }
        for (let i = 0; i < n.childCount; i++) {
            const c = n.child(i);
            if (c) visit(c);
        }
    };
    visit(node);
    return found;
}

export interface EnclosingDef {
    /** 0-based start line of the enclosing definition node (LSP coords). */
    startLine: number;
    /** 0-based end line of the enclosing definition node (inclusive, LSP). */
    endLine: number;
    /** True if the node contains a body (a `{ ... }` block) — i.e. it's a
     * real definition, not a prototype. */
    hasBody: boolean;
    /** 0-based start line of the preceding doc comment, or null when there is
     * none immediately above the definition. When set, `docStartLine` <=
     * `startLine` and the doc comment is a sibling `comment` node directly
     * above the definition with no blank line in between. */
    docStartLine: number | null;
    /** 0-based end line of the preceding doc comment (inclusive). */
    docEndLine: number | null;
}

/**
 * Resolve the enclosing definition at a 1-based (line, column) position and
 * its preceding doc comment, using tree-sitter.
 *
 * `line` is 1-based (the tool input contract); `column` is 1-based. Walks UP
 * from the node at that position to find the nearest enclosing definition
 * node (function/method/class/struct/etc. — see DEF_NODE_TYPES). Returns that
 * node's range, whether it has a body, and the range of the preceding
 * `comment` sibling if one is immediately above (no blank line in between).
 *
 * Returns null when the language has no tree-sitter grammar (the caller falls
 * back to LSP), OR when the position isn't inside any definition node (e.g. a
 * call site, a use, top-level whitespace) — the caller falls back to LSP in
 * that case too.
 *
 * This is the foundation for code_definition's behavior on:
 *   - ccls-rejecting headers (`not indexed`): tree-sitter resolves the body
 *     locally, no LSP needed. See docs/code_definition.md.
 *   - header-only third-party declarations: returns the declaration + its doc
 *     comment (hasBody=false, docStartLine set).
 *   - the cursor-on-a-definition fast path: when hasBody is true, the body at
 *     the cursor is the verbatim source to return (no LSP jump needed).
 */
export async function findEnclosingDefWithDoc(
    lang: TsLang,
    text: string,
    line: number, // 1-based
    column: number, // 1-based
): Promise<EnclosingDef | null> {
    const language = await getLanguage(lang);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(text);
    if (!tree) return null;
    try {
        // Tree-sitter positions are 0-based row/column. The input is 1-based.
        const root = tree.rootNode as unknown as TSNode;
        const node = root.descendantForPosition(
            { row: line - 1, column: column - 1 },
            { row: line - 1, column: column - 1 },
        );
        if (!node) return null;
        // Walk up to the nearest enclosing definition node.
        let cur: TSNode | null = node;
        let defNode: TSNode | null = null;
        while (cur) {
            if (DEF_NODE_TYPES.has(cur.type)) {
                // For the broad `declaration` / `field_declaration` C++ nodes,
                // only treat them as a def when they declare a FUNCTION
                // prototype (a `field_declaration` of `int x;` is a member
                // variable, not a function def — the cursor on `x` should NOT
                // resolve to the field's extent via this path; LSP handles it).
                if (cur.type === "declaration" || cur.type === "field_declaration") {
                    if (isFunctionDeclarationNode(cur, lang)) {
                        defNode = cur;
                        break;
                    }
                } else {
                    defNode = cur;
                    break;
                }
            }
            cur = cur.parent;
        }
        if (!defNode) return null;
        const startLine = defNode.startPosition.row;
        const endLine = defNode.endPosition.row;
        const hasBody = DEF_BODY_NODE_TYPES.has(defNode.type);
        // Find the preceding sibling `comment` node(s) immediately above
        // `defNode`, if any. The doc comment is the comment node directly
        // above the definition with NO blank line in between (a blank line
        // breaks the "immediately above" association). Consecutive `///`
        // line-doc comments are each their own `comment` node, so a run of
        // them is captured as a SPAN from the earliest comment's start to the
        // latest comment's end. Returns the span or null.
        const doc = precedingDocComment(defNode);
        return {
            startLine,
            endLine,
            hasBody,
            docStartLine: doc ? doc.startLine : null,
            docEndLine: doc ? doc.endLine : null,
        };
    } finally {
        tree.delete();
    }
}

/**
 * Find the `comment` sibling(s) immediately preceding `defNode`, if any, and
 * return the 0-based line SPAN covering them.
 *
 * A doc comment is the comment node directly above the definition with NO
 * blank line in between (a blank line breaks the "immediately above"
 * association). Consecutive triple-slash line-doc comments are each their
 * own `comment` node; a run of them is captured as a span from the earliest
 * comment's start row to the latest comment's end row. A block doc comment
 * (slash-star-star opener) is a single `comment` node spanning multiple
 * lines, so its span is just that node's start..end.
 *
 * We don't filter on comment text here: any preceding `comment` sibling
 * without a blank-line gap is included, because (a) tree-sitter tags all
 * line and block comments as `comment` and distinguishing doc (triple-slash
 * or slash-star-star) from ordinary ones by text is a heuristic the caller
 * can apply if it wants, and (b) for the body-return path we DON'T prepend a
 * doc comment at all, so this is only consulted for the declaration path
 * where a preceding comment is almost always the doc string. The blank-line
 * gap rule is the real filter.
 */
function precedingDocComment(defNode: TSNode): { startLine: number; endLine: number } | null {
    const parent = defNode.parent;
    if (!parent) return null;
    let idx = -1;
    for (let i = 0; i < parent.childCount; i++) {
        const c = parent.child(i);
        if (c && c.id === defNode.id) {
            idx = i;
            break;
        }
    }
    if (idx < 1) return null;
    // Walk back over any immediately-preceding comment siblings. Each comment
    // must end on the line immediately before the next node's start (no blank
    // line in between) to stay in the chain. Track the earliest (first seen
    // while walking back) comment's start and the latest (closest to the def)
    // comment's end, so a `///` run produces a span covering all of them.
    let earliestStart: number | null = null;
    let latestEnd: number | null = null;
    let nextStart = defNode.startPosition.row;
    for (let i = idx - 1; i >= 0; i--) {
        const c = parent.child(i);
        if (!c) continue;
        if (c.type === "comment") {
            // Gap check: the comment must end on the line immediately before
            // the next node's start (no blank line in between).
            if (c.endPosition.row === nextStart - 1) {
                earliestStart = c.startPosition.row;
                if (latestEnd === null) latestEnd = c.endPosition.row;
                nextStart = c.startPosition.row;
                continue;
            }
            break;
        }
        // A non-comment sibling (e.g. an attribute, a preprocessor line)
        // breaks the doc association.
        break;
    }
    if (earliestStart === null || latestEnd === null) return null;
    return { startLine: earliestStart, endLine: latestEnd };
}
