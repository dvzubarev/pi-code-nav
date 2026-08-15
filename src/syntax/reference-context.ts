/**
 * Reference context extraction (subsystem 3 of the tree-sitter support,
 * previously a section of `../tree-sitter-parse.ts`).
 *
 * code_references already has the semantically-correct locations from LSP.
 * This helper adds AST context without trying to rediscover references. It is
 * intentionally best-effort: callers can fall back to the LSP location if a
 * grammar cannot parse an individual result file.
 *
 * The node-type taxonomies are PER-GRAMMAR now: each call resolves them from
 * the language's `SyntaxLanguage.referenceNodes` profile
 * (`./languages/<lang>.ts`), replacing the old shared supersets. A node type
 * from one grammar can no longer fire for another, and each grammar's real
 * structural names (e.g. cpp's `for_range_loop`) are included where the old
 * shared set missed them.
 */

import { Parser, Node } from "web-tree-sitter";
import { syntaxLanguage, TsLang } from "./languages/index";
import { getLanguage } from "./runtime";

export type ReferenceContextMode = "syntax" | "enclosing";

export interface ReferenceSyntaxContext {
    kind: "call" | "type" | "member" | "import" | "write" | "override" | "declaration" | "read";
    startLine: number;
    endLine: number;
    /** Numbered, source-formatted lines for the selected AST construct. */
    source: string;
    enclosing?: { name: string; line: number; column: number };
}

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

function nearest(nodes: Node[], types: ReadonlySet<string>): Node | undefined {
    return nodes.find((n) => types.has(n.type));
}

function callContainingCallee(
    nodes: Node[],
    selected: Node,
    callNodeTypes: ReadonlySet<string>,
): Node | undefined {
    for (const n of nodes) {
        if (!callNodeTypes.has(n.type)) continue;
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

function expressionContaining(
    nodes: Node[],
    expressionNodeTypes: ReadonlySet<string>,
): Node | undefined {
    return nearest(nodes, expressionNodeTypes);
}

/** Select the outermost complete expression around an occurrence. This keeps
 * the consumer of a nested call/member visible (`use(make())`, not merely
 * `make()`) without crossing into a containing control-flow body or
 * definition. */
function outermostExpressionContaining(
    nodes: Node[],
    fallback: Node,
    completeStatementNodeTypes: ReadonlySet<string>,
    structuralNodeTypes: ReadonlySet<string>,
    blockNodeTypes: ReadonlySet<string>,
    expressionNodeTypes: ReadonlySet<string>,
): Node {
    let expression = fallback;
    for (const node of nodes) {
        if (completeStatementNodeTypes.has(node.type)) break;
        if (structuralNodeTypes.has(node.type) || blockNodeTypes.has(node.type)) break;
        if (expressionNodeTypes.has(node.type)) expression = node;
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
    definitionNodeTypes: ReadonlySet<string>,
    qualifierSeparator: string,
    sourceLines: string[],
): ReferenceSyntaxContext["enclosing"] {
    const defs = nodes.filter((n) => definitionNodeTypes.has(n.type));
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
    return {
        name: names.join(qualifierSeparator),
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

const MAX_STRUCTURAL_SIGNATURE_LINES = 24;
const MAX_STRUCTURAL_BODY_LINES = 80;
const MAX_STRUCTURAL_FOOTER_LINES = 8;

interface ContextNodeTypes {
    call: ReadonlySet<string>;
    import: ReadonlySet<string>;
    member: ReadonlySet<string>;
    type: ReadonlySet<string>;
    definition: ReadonlySet<string>;
    expression: ReadonlySet<string>;
    statement: ReadonlySet<string>;
    /** Control-flow ancestors + definition nodes (used by `enclosing`). */
    structural: ReadonlySet<string>;
    block: ReadonlySet<string>;
    completeStatement: ReadonlySet<string>;
}

function containingBody(
    structure: Node,
    target: Node,
    blockNodeTypes: ReadonlySet<string>,
): Node | null {
    const fields = ["body", "consequence", "alternative"];
    for (const field of fields) {
        const child = structure.childForFieldName(field);
        if (child && containsNode(child, target)) return child;
    }
    // Grammar field names vary (notably bash and switch/case grammars). A
    // containing block child is still unambiguous and keeps this best-effort.
    return (
        structure.namedChildren.find(
            (child) => blockNodeTypes.has(child.type) && containsNode(child, target),
        ) ?? null
    );
}

function completeContainingStatement(
    syntaxNode: Node,
    completeStatementNodeTypes: ReadonlySet<string>,
    structuralNodeTypes: ReadonlySet<string>,
    blockNodeTypes: ReadonlySet<string>,
): Node {
    for (let node: Node | null = syntaxNode; node; node = node.parent) {
        if (completeStatementNodeTypes.has(node.type)) return node;
        if (structuralNodeTypes.has(node.type) || blockNodeTypes.has(node.type)) break;
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
    types: ContextNodeTypes,
): string {
    const lines = text.split(/\r?\n/);
    const statement = completeContainingStatement(
        syntaxNode,
        types.completeStatement,
        types.structural,
        types.block,
    );
    const comments = adjacentCommentRange(statement, text);
    const body = containingBody(structure, statement, types.block);
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

    const profile = syntaxLanguage(lang);
    const rn = profile.referenceNodes;
    // `structural` = control-flow constructs LSP reference context renders
    // plus the definition constructs (which provide the `enclosing` metadata's
    // function/class/namespace scope). The profile keeps these separate; here
    // we compose the full set used for the enclosing skeleton.
    const structural: ReadonlySet<string> = new Set([...rn.structural, ...rn.definition]);
    const types: ContextNodeTypes = {
        call: rn.call,
        import: rn.import,
        member: rn.member,
        type: rn.type,
        definition: rn.definition,
        expression: rn.expression,
        statement: rn.statement,
        structural,
        block: rn.block,
        completeStatement: rn.completeStatement,
    };

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
        const call = callContainingCallee(chain, selected, types.call);
        const imported = nearest(chain, types.import);
        const member = nearest(chain, types.member);
        const typeNodes = chain.filter((n) => types.type.has(n.type));
        // The outer type node carries the complete expression (`list[Point]`,
        // `std::vector<T>`), while the innermost is often just one identifier.
        const typed = typeNodes.length > 0 ? typeNodes[typeNodes.length - 1] : undefined;
        const declaration = bindingDeclarationContaining(chain, selected);
        const assigned = assignmentContainingLeft(chain, selected);
        const definition = chain.find((n) => {
            if (!types.definition.has(n.type)) return false;
            const name = definitionName(n);
            return !!name && containsNode(name, selected);
        });

        let kind: ReferenceSyntaxContext["kind"] = "read";
        let syntaxNode = selected;
        if (call) {
            kind = "call";
            syntaxNode = outermostExpressionContaining(
                chain,
                call,
                types.completeStatement,
                types.structural,
                types.block,
                types.expression,
            );
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
            syntaxNode = nearest(chain, types.statement) ?? declaration;
        } else if (assigned) {
            // Assignment wins over member/type shape: `obj.field = value` is
            // semantically a write, not merely a member occurrence.
            kind = "write";
            syntaxNode = nearest(chain, types.statement) ?? assigned;
        } else if (typed) {
            kind = "type";
            syntaxNode = typed;
        } else if (member) {
            kind = "member";
            syntaxNode = outermostExpressionContaining(
                chain,
                member,
                types.completeStatement,
                types.structural,
                types.block,
                types.expression,
            );
        } else {
            // An identifier by itself is usually less useful than grep output.
            // Select the nearest complete expression (including a containing
            // call when this is a bare argument), and fall back to a statement
            // for constructs such as `return value`.
            syntaxNode =
                expressionContaining(chain, types.expression) ??
                nearest(chain, types.statement) ??
                selected;
        }

        let contextNode = syntaxNode;
        let renderedSource: string;
        if (mode === "enclosing") {
            // Select the nearest ancestor with control/scope meaning, skipping
            // plain blocks and try. Render a sparse AST-aware skeleton so a
            // huge function/loop does not hide the referenced statement.
            const structure = chain.find((node) => types.structural.has(node.type));
            if (structure) {
                contextNode = structure;
                renderedSource = renderStructuralSkeleton(
                    structure,
                    syntaxNode,
                    selected,
                    text,
                    types,
                );
            } else {
                const statement = completeContainingStatement(
                    syntaxNode,
                    types.completeStatement,
                    types.structural,
                    types.block,
                );
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
            enclosing: enclosingSymbol(
                chain,
                types.definition,
                profile.qualifierSeparator,
                sourceLines,
            ),
        };
    } finally {
        tree.delete();
        parser.delete();
    }
}
