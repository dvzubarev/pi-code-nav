/**
 * Symbol scanning and role classification (subsystem 2 of the tree-sitter
 * support, previously a section of `../tree-sitter-parse.ts`).
 *
 * Per-language role rules live in `./classifiers/*.ts`, keyed by grammar in
 * `./index.ts`. Each grammar names its identifier-class nodes differently and
 * encodes role via parent type + field name. We use field names
 * (fieldNameForChild) where the grammar provides them (robust across grammar
 * versions) and fall back to parent type otherwise. Field-name lookup MUST
 * compare via node.id (not reference equality): web-tree-sitter returns a
 * fresh proxy wrapper per .child() call, so `parent.child(i) === node` is
 * always false. This was a real bug during development; do not "simplify" it
 * back to ===.
 *
 * Returns null for: keywords (they are statement nodes, not identifiers),
 * punctuation, comments, strings, namespace qualifiers (the `std` in
 * `std::sort` — the meaningful name is the `identifier` child), the
 * `identifier` child of a python `type` annotation (the `type` node itself is
 * the entry), and bare bash `word` arguments.
 */

import { Parser } from "web-tree-sitter";
import { classifierFor } from "./index";
import { getLanguage, TsLang } from "./runtime";
import type { SymbolEntry, SymbolRole, TSNode } from "./types";

// ---------------------------------------------------------------------------
// Role classification.
// ---------------------------------------------------------------------------

/** Resolve a node's role via the per-language classifier dispatch (src/syntax/). */
function classifyRole(node: TSNode, lang: TsLang): SymbolRole | null {
    return classifierFor(lang)(node);
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
