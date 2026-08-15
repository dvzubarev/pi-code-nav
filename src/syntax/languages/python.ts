/**
 * `python` syntax profile (tree-sitter-python grammar).
 *
 * Node-type taxonomies are scoped to THIS grammar only and contain only named
 * nodes, manually audited against the grammar. A node type that another
 * grammar added can never silently fire here (or vice versa). See
 * `./index.ts`.
 */

import type { SyntaxLanguage } from "./index";
import { classifyPythonRole } from "../classifiers/python";

export const pythonLanguage = {
    grammar: "python",
    lspLanguage: "python",
    extensions: [".py"],
    classifyRole: classifyPythonRole,
    qualifierSeparator: ".",
    referenceNodes: {
        call: new Set(["call"]),
        import: new Set(["import_statement", "import_from_statement"]),
        member: new Set(["attribute"]),
        type: new Set(["type", "generic_type"]),
        definition: new Set(["function_definition", "class_definition"]),
        expression: new Set([
            "call",
            "attribute",
            "subscript",
            "binary_operator",
            "boolean_operator",
            "comparison_operator",
            "conditional_expression",
            "unary_operator",
            "parenthesized_expression",
        ]),
        statement: new Set([
            "expression_statement",
            "return_statement",
            "assignment",
            "augmented_assignment",
            "if_statement",
            "for_statement",
            "while_statement",
            "try_statement",
            "with_statement",
        ]),
        structural: new Set([
            "if_statement",
            "elif_clause",
            "else_clause",
            "for_statement",
            "while_statement",
            "case_clause",
            "match_statement",
            "with_statement",
        ]),
        block: new Set(["block"]),
        completeStatement: new Set([
            "expression_statement",
            "return_statement",
            "raise_statement",
            "break_statement",
            "continue_statement",
            "assignment",
            "augmented_assignment",
            "import_statement",
            "import_from_statement",
        ]),
    },
    definitionPolicy: {
        defNodes: new Set(["function_definition", "class_definition"]),
        defBodyNodes: new Set(["function_definition", "class_definition"]),
        functionDeclarationCheck: new Set(),
    },
} as const satisfies SyntaxLanguage;
