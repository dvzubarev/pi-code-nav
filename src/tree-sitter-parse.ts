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

import { Parser, Language, Node } from "web-tree-sitter";
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
 *   but noisy in broad scans, so excluded from the scan default and included
 *   by the explicitly requested `list_symbols` integrations.
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

// ---------------------------------------------------------------------------
// Reference context extraction.
//
// code_references already has the semantically-correct locations from LSP.
// This helper adds AST context without trying to rediscover references. It is
// intentionally best-effort: callers can fall back to the LSP location if a
// grammar cannot parse an individual result file.
// ---------------------------------------------------------------------------

export type ReferenceContextMode = "syntax" | "enclosing";

export interface ReferenceSyntaxContext {
    kind: "call" | "type" | "member" | "import" | "write" | "override" | "declaration" | "read";
    startLine: number;
    endLine: number;
    /** Numbered, source-formatted lines for the selected AST construct. */
    source: string;
    enclosing?: { name: string; line: number; column: number };
}

const CALL_NODE_TYPES = new Set(["call", "call_expression", "new_expression"]);
const IMPORT_NODE_TYPES = new Set([
    "import_statement",
    "import_from_statement",
    "import_declaration",
    "export_statement",
    "using_declaration",
]);
const MEMBER_NODE_TYPES = new Set(["attribute", "field_expression", "member_expression"]);
const TYPE_NODE_TYPES = new Set([
    "type",
    "type_identifier",
    "generic_type",
    "template_type",
    "type_annotation",
    "predefined_type",
]);
const DEFINITION_NODE_TYPES = new Set([
    "function_definition",
    "class_definition",
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "function_expression",
    "arrow_function",
    "class",
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "namespace_definition",
    "lambda_expression",
]);
const EXPRESSION_NODE_TYPES = new Set([
    // Calls are useful context even when the reference is an argument rather
    // than the callee (`write(value)`). In that case the role remains `read`,
    // but rendering only `value` throws away more context than grep would.
    "call",
    "call_expression",
    "new_expression",
    "attribute",
    "field_expression",
    "member_expression",
    "subscript",
    "subscript_expression",
    "subscription",
    "binary_expression",
    "binary_operator",
    "boolean_operator",
    "comparison_operator",
    "conditional_expression",
    "ternary_expression",
    "unary_expression",
    "unary_operator",
    "await_expression",
    "cast_expression",
    "parenthesized_expression",
    // C++ wraps control-flow conditions separately from the expression. Keep
    // the complete header when its condition spans physical lines.
    "condition_clause",
]);
const STATEMENT_NODE_TYPES = new Set([
    "expression_statement",
    "return_statement",
    "assignment",
    "assignment_expression",
    "augmented_assignment",
    "declaration",
    "lexical_declaration",
    "variable_declaration",
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "switch_statement",
    "try_statement",
    "with_statement",
]);

function containsNode(outer: Node, inner: Node): boolean {
    const a = outer.startIndex;
    const b = outer.endIndex;
    return a <= inner.startIndex && b >= inner.endIndex;
}

function ancestors(node: Node): Node[] {
    const out: Node[] = [];
    for (let n: Node | null = node; n; n = n.parent) out.push(n);
    return out;
}

function nearest(nodes: Node[], types: Set<string>): Node | undefined {
    return nodes.find((n) => types.has(n.type));
}

function callContainingCallee(nodes: Node[], selected: Node): Node | undefined {
    for (const n of nodes) {
        if (!CALL_NODE_TYPES.has(n.type)) continue;
        const callee =
            n.childForFieldName("function") ??
            n.childForFieldName("constructor") ??
            n.childForFieldName("name");
        if (callee && containsNode(callee, selected)) return n;
    }
    return undefined;
}

function bindingDeclarationContaining(nodes: Node[], selected: Node): Node | undefined {
    for (const n of nodes) {
        if (!/declarator|declaration|parameter/.test(n.type)) continue;
        const name = n.childForFieldName("name") ?? n.childForFieldName("declarator");
        if (name && containsNode(name, selected)) return n;
    }
    return undefined;
}

function assignmentContainingLeft(nodes: Node[], selected: Node): Node | undefined {
    for (const n of nodes) {
        if (!/assignment/.test(n.type)) continue;
        const left = n.childForFieldName("left");
        if (left && containsNode(left, selected)) return n;
    }
    return undefined;
}

function expressionContaining(nodes: Node[]): Node | undefined {
    return nearest(nodes, EXPRESSION_NODE_TYPES);
}

/** Select the outermost complete expression around an occurrence. This keeps
 * the consumer of a nested call/member visible (`use(make())`, not merely
 * `make()`) without crossing into a containing control-flow body or
 * definition. */
function outermostExpressionContaining(nodes: Node[], fallback: Node): Node {
    let expression = fallback;
    for (const node of nodes) {
        if (COMPLETE_STATEMENT_NODE_TYPES.has(node.type)) break;
        if (STRUCTURAL_NODE_TYPES.has(node.type) || BLOCK_NODE_TYPES.has(node.type)) break;
        if (EXPRESSION_NODE_TYPES.has(node.type)) expression = node;
    }
    return expression;
}

function definitionName(node: Node): Node | null {
    const direct = node.childForFieldName("name");
    if (direct) return direct;
    // Anonymous function/arrow/lambda assigned to a variable: use the binding
    // as the enclosing symbol name (`const load = () => ...`).
    if (/function_expression|arrow_function|lambda/.test(node.type)) {
        const parent = node.parent;
        const binding =
            parent?.childForFieldName("name") ??
            parent?.childForFieldName("left") ??
            parent?.childForFieldName("declarator");
        if (binding && !containsNode(binding, node)) return binding;
    }
    let declarator = node.childForFieldName("declarator");
    while (declarator) {
        // Preserve an out-of-line C++ qualified name (`ns::Class::method`)
        // instead of drilling down to only its final identifier.
        if (declarator.type === "qualified_identifier" || declarator.type === "scoped_identifier") {
            return declarator;
        }
        const name =
            declarator.childForFieldName("name") ?? declarator.childForFieldName("declarator");
        if (!name || name.id === declarator.id) break;
        declarator = name;
    }
    if (declarator && /identifier|declarator/.test(declarator.type)) return declarator;
    return null;
}

function terminalNameNode(node: Node): Node {
    const child = node.childForFieldName("name") ?? node.childForFieldName("declarator");
    return child && child.id !== node.id ? terminalNameNode(child) : node;
}

function enclosingSymbol(
    nodes: Node[],
    lang: TsLang,
    sourceLines: string[],
): ReferenceSyntaxContext["enclosing"] {
    const defs = nodes.filter((n) => DEFINITION_NODE_TYPES.has(n.type));
    if (defs.length === 0) return undefined;
    const named = defs
        .map((node) => ({ node, nameNode: definitionName(node) }))
        .filter((x): x is { node: Node; nameNode: Node } => x.nameNode !== null);
    if (named.length === 0) return undefined;
    // ancestors() is inner-to-outer. Reverse it to render Class.method rather
    // than method.Class, while using the innermost identifier as the position.
    const names = [...named]
        .reverse()
        .map((x) => x.nameNode.text.trim())
        .filter(Boolean);
    const inner = terminalNameNode(named[0].nameNode);
    const sep = lang === "cpp" ? "::" : ".";
    return {
        name: names.join(sep),
        line: inner.startPosition.row + 1,
        column:
            byteToStringColumn(
                sourceLines[inner.startPosition.row] ?? "",
                inner.startPosition.column,
            ) + 1,
    };
}

function byteColumn(textLine: string, utf16Column: number): number {
    return Buffer.byteLength(textLine.slice(0, utf16Column), "utf8");
}

function byteToStringColumn(textLine: string, bytes: number): number {
    const buf = Buffer.from(textLine, "utf8");
    return buf.subarray(0, Math.min(bytes, buf.length)).toString("utf8").length;
}

const MAX_CONTEXT_LINES = 80;
const MAX_CONTEXT_CHARS = 12_000;

/** Structural ancestors used by `context: "enclosing"`. Plain blocks and
 * `try` are intentionally absent: they say little about why a statement runs. */
const STRUCTURAL_NODE_TYPES = new Set([
    "if_statement",
    "elif_clause",
    "else_clause",
    "conditional_statement",
    "for_statement",
    "for_in_statement",
    "range_based_for_statement",
    "while_statement",
    "do_statement",
    "switch_statement",
    "case_statement",
    "case_clause",
    "switch_case",
    "switch_default",
    "match_statement",
    "with_statement",
    ...DEFINITION_NODE_TYPES,
]);

const BLOCK_NODE_TYPES = new Set([
    "block",
    "compound_statement",
    "statement_block",
    "class_body",
    "declaration_list",
]);

/** Nodes which are complete executable/declaration statements rather than
 * expression fragments. Structural statements are handled separately. */
const COMPLETE_STATEMENT_NODE_TYPES = new Set([
    "expression_statement",
    "return_statement",
    "co_return_statement",
    "throw_statement",
    "raise_statement",
    "break_statement",
    "continue_statement",
    "assignment",
    "augmented_assignment",
    "declaration",
    "field_declaration",
    "lexical_declaration",
    "variable_declaration",
    "using_declaration",
    "import_statement",
    "import_from_statement",
    "import_declaration",
    "export_statement",
    "command",
    "redirected_statement",
]);

const MAX_STRUCTURAL_SIGNATURE_LINES = 24;
const MAX_STRUCTURAL_BODY_LINES = 80;
const MAX_STRUCTURAL_FOOTER_LINES = 8;

function containingBody(structure: Node, target: Node): Node | null {
    const fields = ["body", "consequence", "alternative"];
    for (const field of fields) {
        const child = structure.childForFieldName(field);
        if (child && containsNode(child, target)) return child;
    }
    // Grammar field names vary (notably bash and switch/case grammars). A
    // containing block child is still unambiguous and keeps this best-effort.
    return (
        structure.namedChildren.find(
            (child) => BLOCK_NODE_TYPES.has(child.type) && containsNode(child, target),
        ) ?? null
    );
}

function completeContainingStatement(syntaxNode: Node): Node {
    for (let node: Node | null = syntaxNode; node; node = node.parent) {
        if (COMPLETE_STATEMENT_NODE_TYPES.has(node.type)) return node;
        if (STRUCTURAL_NODE_TYPES.has(node.type) || BLOCK_NODE_TYPES.has(node.type)) break;
    }
    return syntaxNode;
}

function adjacentCommentRange(statement: Node, text: string): { start: number; end: number } {
    let start = statement.startPosition.row;
    let end = statement.endPosition.row;
    const parent = statement.parent;
    if (!parent) return { start, end };
    const siblings = parent.namedChildren;
    const index = siblings.findIndex((node) => node.id === statement.id);
    if (index < 0) return { start, end };

    // Include an immediately preceding comment block, but stop at a blank
    // line. Following comments are included only when trailing on the same
    // line; a next-line comment normally documents the next statement.
    for (let i = index - 1; i >= 0 && siblings[i].type === "comment"; i--) {
        const comment = siblings[i];
        const gap = text.slice(comment.endIndex, statement.startIndex);
        if (/\n[\t ]*\n/.test(gap)) break;
        start = comment.startPosition.row;
    }
    const following = siblings[index + 1];
    if (
        following?.type === "comment" &&
        following.startPosition.row === statement.endPosition.row
    ) {
        end = following.endPosition.row;
    }
    return { start, end };
}

interface LineSection {
    start: number;
    end: number;
    limit: number;
}

function limitedRows(start: number, end: number, limit: number, focus: number): number[] {
    if (end < start) return [];
    const count = end - start + 1;
    if (count <= limit) return Array.from({ length: count }, (_, i) => start + i);
    // Keep both ends plus the referenced area. This matters for giant template
    // signatures and generated statements: the actual reference never falls
    // out of the skeleton merely because one section hit its own limit.
    const rows = new Set<number>();
    const edge = Math.max(2, Math.floor(limit / 4));
    for (let row = start; row < start + edge; row++) rows.add(row);
    for (let row = end - edge + 1; row <= end; row++) rows.add(row);
    const remaining = limit - rows.size;
    const aroundStart = Math.max(
        start,
        Math.min(focus - Math.floor(remaining / 2), end - remaining + 1),
    );
    for (let row = aroundStart; row < aroundStart + remaining; row++) rows.add(row);
    return [...rows].sort((a, b) => a - b);
}

function renderStructuralSkeleton(
    structure: Node,
    syntaxNode: Node,
    selected: Node,
    text: string,
): string {
    const lines = text.split(/\r?\n/);
    const statement = completeContainingStatement(syntaxNode);
    const comments = adjacentCommentRange(statement, text);
    const body = containingBody(structure, statement);
    const sections: LineSection[] = [];

    if (body) {
        const delimited = body.type !== "block";
        const headerEnd = body.startPosition.row - (delimited ? 0 : 1);
        sections.push({
            start: structure.startPosition.row,
            end: headerEnd,
            limit: MAX_STRUCTURAL_SIGNATURE_LINES,
        });
        sections.push({
            start: comments.start,
            end: comments.end,
            limit: MAX_STRUCTURAL_BODY_LINES,
        });
        if (delimited) {
            sections.push({
                start: body.endPosition.row,
                end: structure.endPosition.row,
                limit: MAX_STRUCTURAL_FOOTER_LINES,
            });
        }
    } else {
        // A case/branch body or a single unbraced statement may not have a
        // grammar `body` field. The structure's first line is still its useful
        // header; retain the target and a closing line when one exists.
        sections.push({
            start: structure.startPosition.row,
            end: structure.startPosition.row,
            limit: MAX_STRUCTURAL_SIGNATURE_LINES,
        });
        sections.push({
            start: comments.start,
            end: comments.end,
            limit: MAX_STRUCTURAL_BODY_LINES,
        });
        sections.push({
            start: structure.endPosition.row,
            end: structure.endPosition.row,
            limit: MAX_STRUCTURAL_FOOTER_LINES,
        });
    }

    const focus = selected.startPosition.row;
    const rows = new Set<number>();
    for (const section of sections) {
        for (const row of limitedRows(section.start, section.end, section.limit, focus))
            rows.add(row);
    }
    const ordered = [...rows].filter((row) => row >= 0 && row < lines.length).sort((a, b) => a - b);
    const rendered: string[] = [];
    for (let i = 0; i < ordered.length; i++) {
        if (i > 0 && ordered[i] > ordered[i - 1] + 1) rendered.push("... | <...>");
        rendered.push(`${ordered[i] + 1} | ${lines[ordered[i]]}`);
    }
    // Do not prefix-truncate a skeleton here: its reference is often in the
    // middle. The references renderer applies its page budget around the exact
    // reference line after metadata has been added.
    return rendered.join("\n");
}

function renderNodeSource(node: Node, text: string): string {
    const lines = text.split(/\r?\n/);
    const start = node.startPosition;
    const end = node.endPosition;
    // Render complete physical lines. AST-column slicing often removes the
    // consumer that makes a reference understandable, as well as indentation,
    // terminators, attributes, and control-flow keywords on boundary lines.
    let selected = lines.slice(start.row, end.row + 1);
    if (selected.length === 0) return "";

    let omitted = 0;
    if (selected.length > MAX_CONTEXT_LINES) {
        omitted = selected.length - MAX_CONTEXT_LINES;
        selected = [...selected.slice(0, 60), ...selected.slice(-20)];
    }
    let rendered = selected.map((line, i) => `${start.row + 1 + i} | ${line}`);
    if (omitted > 0) {
        rendered = [
            ...rendered.slice(0, 60),
            `... | … ${omitted} lines omitted …`,
            ...rendered
                .slice(60)
                .map((line, i) => line.replace(/^\d+/, String(end.row - 19 + i + 1))),
        ];
    }
    let out = rendered.join("\n");
    if (out.length > MAX_CONTEXT_CHARS)
        out = out.slice(0, MAX_CONTEXT_CHARS) + "\n... | … context truncated …";
    return out;
}

/** Return AST-aware source context for one 0-based LSP reference position. */
export async function referenceSyntaxContext(
    lang: TsLang,
    text: string,
    line: number,
    character: number,
    mode: ReferenceContextMode = "syntax",
): Promise<ReferenceSyntaxContext | null> {
    const sourceLines = text.split(/\r?\n/);
    if (line < 0 || line >= sourceLines.length) return null;
    const language = await getLanguage(lang);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(text);
    if (!tree) return null;
    try {
        const column = byteColumn(sourceLines[line], character);
        let selected = tree.rootNode.descendantForPosition(
            { row: line, column },
            { row: line, column: column + 1 },
        );
        if (!selected) return null;
        // Punctuation can be the smallest descendant when an LSP range starts
        // at a qualifier boundary. Prefer the nearest named ancestor.
        while (selected && !selected.isNamed && selected.parent) selected = selected.parent;
        const chain = ancestors(selected);
        const call = callContainingCallee(chain, selected);
        const imported = nearest(chain, IMPORT_NODE_TYPES);
        const member = nearest(chain, MEMBER_NODE_TYPES);
        const typeNodes = chain.filter((n) => TYPE_NODE_TYPES.has(n.type));
        // The outer type node carries the complete expression (`list[Point]`,
        // `std::vector<T>`), while the innermost is often just one identifier.
        const typed = typeNodes.length > 0 ? typeNodes[typeNodes.length - 1] : undefined;
        const declaration = bindingDeclarationContaining(chain, selected);
        const assigned = assignmentContainingLeft(chain, selected);
        const definition = chain.find((n) => {
            if (!DEFINITION_NODE_TYPES.has(n.type)) return false;
            const name = definitionName(n);
            return !!name && containsNode(name, selected);
        });

        let kind: ReferenceSyntaxContext["kind"] = "read";
        let syntaxNode = selected;
        if (call) {
            kind = "call";
            syntaxNode = outermostExpressionContaining(chain, call);
        } else if (imported) {
            kind = "import";
            syntaxNode = imported;
        } else if (definition) {
            kind = /\boverride\b/.test(definition.text) ? "override" : "declaration";
            // Do not return the whole function/class body for its declaration
            // reference. The enclosing metadata composes with code_definition
            // when that body is wanted; the identifier is the smallest useful
            // declaration construct here.
            syntaxNode = selected;
        } else if (declaration) {
            // A variable/parameter binding introduces the name; it is not a
            // write reference merely because its declarator is a left-hand
            // syntactic field (for example `int data[N]`).
            kind = "declaration";
            syntaxNode = nearest(chain, STATEMENT_NODE_TYPES) ?? declaration;
        } else if (assigned) {
            // Assignment wins over member/type shape: `obj.field = value` is
            // semantically a write, not merely a member occurrence.
            kind = "write";
            syntaxNode = nearest(chain, STATEMENT_NODE_TYPES) ?? assigned;
        } else if (typed) {
            kind = "type";
            syntaxNode = typed;
        } else if (member) {
            kind = "member";
            syntaxNode = outermostExpressionContaining(chain, member);
        } else {
            // An identifier by itself is usually less useful than grep output.
            // Select the nearest complete expression (including a containing
            // call when this is a bare argument), and fall back to a statement
            // for constructs such as `return value`.
            syntaxNode =
                expressionContaining(chain) ?? nearest(chain, STATEMENT_NODE_TYPES) ?? selected;
        }

        let contextNode = syntaxNode;
        let renderedSource: string;
        if (mode === "enclosing") {
            // Select the nearest ancestor with control/scope meaning, skipping
            // plain blocks and try. Render a sparse AST-aware skeleton so a
            // huge function/loop does not hide the referenced statement.
            const structure = chain.find((node) => STRUCTURAL_NODE_TYPES.has(node.type));
            if (structure) {
                contextNode = structure;
                renderedSource = renderStructuralSkeleton(structure, syntaxNode, selected, text);
            } else {
                const statement = completeContainingStatement(syntaxNode);
                contextNode = statement;
                renderedSource = renderNodeSource(statement, text);
            }
        } else {
            renderedSource = renderNodeSource(syntaxNode, text);
        }
        return {
            kind,
            startLine: contextNode.startPosition.row + 1,
            endLine: contextNode.endPosition.row + 1,
            source: renderedSource,
            enclosing: enclosingSymbol(chain, lang, sourceLines),
        };
    } finally {
        tree.delete();
        parser.delete();
    }
}

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
 * Parse a line range of `text` with tree-sitter and return every
 * identifier-class occurrence with absolute 1-based positions and roles.
 *
 * Steps (mirrors code_scan.md "What it solves"):
 *   1. Slice lines [startLine, endLine] (1-based, inclusive) from the full text.
 *   2. Parse the slice directly — NO wrapping, NO scratch file. tree-sitter's
 *      error-recovery handles function-body fragments.
 *   3. Walk the tree, classify each identifier-class node into a role.
 *   4. Filter to `opts.roles` (default: all except `var`).
 *   5. Map (row, col) → absolute 1-based (startLine + row, col + 1).
 *   6. Preserve every occurrence so line-local annotations are complete and
 *      each rendered source line is independently navigable.
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
        const walk = (node: TSNode): void => {
            const role = classifyRole(node, lang);
            if (role && allow.has(role)) {
                const sp = node.startPosition;
                // Tree row is 0-based relative to the slice; startLine is 1-based.
                // absolute 1-based line = startLine + row. Column is 0-based → +1.
                entries.push({
                    role,
                    name: node.text,
                    line: startLine + sp.row,
                    column: sp.column + 1,
                });
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

/** Render a contiguous 1-based line range with the shared source gutter. */
export function renderNumberedSource(
    text: string,
    startLine: number,
    endLine: number,
    entries: SymbolEntry[] = [],
): string {
    const sourceLines = text.split(/\r?\n/);
    const numbered = sourceLines
        .slice(startLine - 1, endLine)
        .map((line, index) => `${startLine + index} | ${line}`)
        .join("\n");
    return annotateNumberedSource(numbered, text, entries);
}

/**
 * Add compact, line-local navigation metadata without modifying source text.
 * `numberedSource` may be contiguous definition output or the sparse source
 * skeleton produced for references. Only symbols whose original token is
 * actually visible on a rendered line are included.
 *
 *   43 | return build(value);
 *      | symbols: build@12 call, value@18 var
 */
export function annotateNumberedSource(
    numberedSource: string,
    originalText: string,
    entries: SymbolEntry[],
): string {
    if (entries.length === 0) return numberedSource;
    const originalLines = originalText.split(/\r?\n/);
    const out: string[] = [];
    for (const rendered of numberedSource.split("\n")) {
        out.push(rendered);
        const match = /^(\d+) \| (.*)$/.exec(rendered);
        if (!match) continue;
        const line = Number(match[1]);
        const shown = match[2];
        const original = originalLines[line - 1];
        if (original === undefined || shown.length === 0) continue;
        const shownIndex = original.indexOf(shown);
        if (shownIndex < 0) continue; // truncated/marker line, not verbatim source
        const shownStartByte = Buffer.byteLength(original.slice(0, shownIndex), "utf8");
        const shownEndByte = shownStartByte + Buffer.byteLength(shown, "utf8");
        const visible = entries.filter((entry) => {
            if (entry.line !== line) return false;
            const startByte = entry.column - 1;
            const endByte = startByte + Buffer.byteLength(entry.name, "utf8");
            return startByte >= shownStartByte && endByte <= shownEndByte;
        });
        if (visible.length === 0) continue;
        const gutter = " ".repeat(match[1].length);
        out.push(
            `${gutter} | symbols: ${visible
                .map((entry) => `${entry.name}@${entry.column} ${entry.role}`)
                .join(", ")}`,
        );
    }
    return out.join("\n");
}

/**
 * Render the standalone code_scan symbol table. Definition/reference snippets
 * use line-local annotations instead, but code_scan keeps this compact survey
 * format because it has no source body to annotate.
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
