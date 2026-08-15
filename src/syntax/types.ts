/**
 * Shared types for the tree-sitter syntax layer (`src/syntax/`).
 *
 * The per-language role classifiers (`classifiers/*.ts`) consume the minimal
 * structural view of a web-tree-sitter `Node` (`TSNode`) and the shared
 * `fieldOf()` helper, and produce a `SymbolRole` classification. Keeping these
 * here (rather than in the symbol-scan/reference/definition modules) lets a
 * new language register its `parseSymbols` role mapping by dropping one
 * classifier file next to the existing ones, with no edits to the modules
 * that dispatch through `classifierFor`. (This is scoped to symbol scanning
 * only; reference/definition support has its own language-sensitive node-type
 * sets — see adding-a-language.md step 8.)
 */

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
 * Minimal structural view of a web-tree-sitter Node (decouples the
 * classifiers from the lib's concrete types).
 */
export interface TSNode {
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
 * A language's identifier-classification function: return the `SymbolRole`
 * for a node, or `null` to skip it (keywords — they are statement nodes, not
 * identifiers — punctuation, comments, strings, namespace qualifiers whose
 * meaningful name is a child node, and nodes that would duplicate a parent's
 * row).
 */
export type RoleClassifier = (node: TSNode) => SymbolRole | null;

/**
 * Look up the field name a node has within its parent (or null).
 *
 * Field-name lookup MUST compare via node.id (not reference equality):
 * web-tree-sitter returns a fresh proxy wrapper per `.child()` call, so
 * `parent.child(i) === node` is always false. This was a real bug during
 * development; do not "simplify" it back to ===.
 */
export function fieldOf(node: TSNode): string | null {
    const parent = node.parent;
    if (!parent) return null;
    for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child && child.id === node.id) return parent.fieldNameForChild(i);
    }
    return null;
}
