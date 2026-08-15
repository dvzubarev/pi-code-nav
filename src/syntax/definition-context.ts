/**
 * Enclosing-definition + doc-comment resolution (subsystem 4 of the
 * tree-sitter support, previously a section of `../tree-sitter-parse.ts`).
 *
 * code_definition's contract is "return the verbatim source body of the
 * symbol at this position". The LSP `documentSymbol` + `textDocument/definition`
 * pair is the primary mechanism, but it has two gaps tree-sitter fills:
 *
 *   1. ccls's `textDocument/definition` MERGES "go to declaration" and "go to
 *      definition"; on a cursor sitting ON a definition it deliberately jumps
 *      to a (non-def) declaration (see docs/code_definition.md). ccls's
 *      `documentSymbol` DOES reflect the opened file's actual syntax, so we
 *      use it as a fast path — but for files ccls hasn't indexed (headers
 *      pulled in via #include but not in compile_commands.json) ccls throws
 *      `not indexed` for BOTH methods, leaving no way to resolve the body via
 *      LSP at all.
 *   2. For a header-only declaration (third-party API, no out-of-line body),
 *      the best available source is the declaration + its preceding doc
 *      comment. The doc comment is a sibling `comment` node immediately before
 *      the declaration in the syntax tree.
 *
 * Tree-sitter parses the file LOCALLY (no language server, no compile
 * database) so it works on un-indexed headers and third-party trees. It gives
 * us the enclosing function/method/class/struct node at a position with a
 * real body extent (vs LSP's identifier-span-only Location) AND the preceding
 * comment sibling (the doc comment) in one parse.
 *
 * `findEnclosingDefWithDoc` is the helper. It returns the enclosing definition
 * node's range, whether it has a body (a compound_statement / statement_block /
 * class body — i.e. it's a real definition, not a prototype), and the range of
 * the preceding doc comment if one is immediately above. Used by code_definition
 * as the primary resolver on ccls-rejecting headers and as a verification /
 * fallback on the languages where LSP already resolves the body.
 */

import { Parser } from "web-tree-sitter";
import { syntaxLanguage, TsLang } from "./languages/index";
import { getLanguage } from "./runtime";
import type { TSNode } from "./types";

/** Is this node a broad declaration whose declarator is a function prototype
 * (so it's a function declaration, not a variable)? Only consulted for the
 * node types the profile's `definitionPolicy.functionDeclarationCheck` names
 * (cpp's `declaration` / `field_declaration`). Languages without such broad
 * node types in `defNodes` leave that set empty and never enter here. */
function isFunctionDeclarationNode(node: TSNode): boolean {
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
 * node (function/method/class/struct/etc. — see the profile's
 * definitionPolicy.defNodes). Returns that
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
        const profile = syntaxLanguage(lang);
        const defNodes = profile.definitionPolicy.defNodes;
        const defBodyNodes = profile.definitionPolicy.defBodyNodes;
        const functionDeclCheck = profile.definitionPolicy.functionDeclarationCheck;
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
            // `Language.types` includes anonymous keyword/punctuation tokens;
            // only a named AST node can enclose a useful source definition.
            // In particular, a cursor on `class` must walk through the token
            // to its class_definition/class_specifier/class_declaration.
            if (cur.isNamed && defNodes.has(cur.type)) {
                // For broad declaration node types (cpp's `declaration` /
                // `field_declaration`), only treat them as a def when they
                // declare a FUNCTION prototype (a `field_declaration` of
                // `int x;` is a member variable, not a function def — the
                // cursor on `x` should NOT resolve to the field's extent via
                // this path; LSP handles it).
                if (functionDeclCheck.has(cur.type)) {
                    if (isFunctionDeclarationNode(cur)) {
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
        const hasBody = defBodyNodes.has(defNode.type);
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
