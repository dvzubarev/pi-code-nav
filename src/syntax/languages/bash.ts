/**
 * `bash` syntax profile (tree-sitter-bash grammar).
 *
 * Scope is deliberately conservative — bare `word` arguments are left out at
 * the classifier level (see `../classifiers/bash.ts`), and the reference/
 * definition taxonomies only name node types this grammar really has. See
 * `./index.ts`.
 */

import type { SyntaxLanguage } from "./index";
import { classifyBashRole } from "../classifiers/bash";

export const bashLanguage = {
    grammar: "bash",
    lspLanguage: "bash",
    extensions: [".sh", ".bash"],
    classifyRole: classifyBashRole,
    qualifierSeparator: ".",
    referenceNodes: {
        call: new Set(),
        import: new Set(),
        member: new Set(),
        type: new Set(),
        definition: new Set(["function_definition"]),
        expression: new Set([
            "subscript",
            "binary_expression",
            "ternary_expression",
            "unary_expression",
            "parenthesized_expression",
        ]),
        statement: new Set(["if_statement", "for_statement", "while_statement"]),
        structural: new Set([
            "if_statement",
            "elif_clause",
            "else_clause",
            "for_statement",
            "while_statement",
            "case_statement",
        ]),
        block: new Set(["compound_statement"]),
        completeStatement: new Set(["command", "redirected_statement"]),
    },
    definitionPolicy: {
        defNodes: new Set(["function_definition"]),
        defBodyNodes: new Set(["function_definition"]),
        functionDeclarationCheck: new Set(),
    },
} as const satisfies SyntaxLanguage;
