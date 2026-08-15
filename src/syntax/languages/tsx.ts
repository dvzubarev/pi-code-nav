/**
 * `tsx` syntax profile (tree-sitter-tsx grammar, which also serves `.jsx`).
 *
 * TSX reuses the TypeScript classifier (shared node-type vocabulary outside
 * JSX), but its reference/definition taxonomies are spelled out explicitly so
 * this profile stays self-contained. Verified against the grammar's
 * the grammar: the audited node-type sets are currently identical to
 * `typescript.ts`; keep them in sync when either grammar changes.
 */

import type { SyntaxLanguage } from "./index";
import { classifyTypeScriptRole } from "../classifiers/typescript";

export const tsxLanguage = {
    grammar: "tsx",
    lspLanguage: "typescript",
    extensions: [".tsx", ".jsx"],
    classifyRole: classifyTypeScriptRole,
    qualifierSeparator: ".",
    referenceNodes: {
        call: new Set(["call_expression", "new_expression"]),
        import: new Set(["import_statement", "export_statement"]),
        member: new Set(["member_expression"]),
        type: new Set([
            "type",
            "type_identifier",
            "generic_type",
            "template_type",
            "type_annotation",
            "predefined_type",
        ]),
        definition: new Set([
            "function_declaration",
            "generator_function_declaration",
            "method_definition",
            "class_declaration",
            "abstract_class_declaration",
            "interface_declaration",
            "function_expression",
            "arrow_function",
            "class",
        ]),
        expression: new Set([
            "call_expression",
            "new_expression",
            "member_expression",
            "subscript_expression",
            "binary_expression",
            "ternary_expression",
            "unary_expression",
            "await_expression",
            "parenthesized_expression",
        ]),
        statement: new Set([
            "expression_statement",
            "return_statement",
            "assignment_expression",
            "lexical_declaration",
            "variable_declaration",
            "if_statement",
            "for_statement",
            "for_in_statement",
            "while_statement",
            "switch_statement",
            "try_statement",
            "with_statement",
        ]),
        structural: new Set([
            "if_statement",
            "else_clause",
            "for_statement",
            "for_in_statement",
            "while_statement",
            "do_statement",
            "switch_statement",
            "switch_case",
            "switch_default",
            "with_statement",
        ]),
        block: new Set(["statement_block", "class_body"]),
        completeStatement: new Set([
            "expression_statement",
            "return_statement",
            "throw_statement",
            "break_statement",
            "continue_statement",
            "lexical_declaration",
            "variable_declaration",
            "import_statement",
            "export_statement",
        ]),
    },
    definitionPolicy: {
        defNodes: new Set([
            "function_declaration",
            "method_definition",
            "class_declaration",
            "class",
            "enum_declaration",
            "interface_declaration",
        ]),
        defBodyNodes: new Set([
            "function_declaration",
            "method_definition",
            "class_declaration",
            "class",
            "enum_declaration",
            "interface_declaration",
        ]),
        functionDeclarationCheck: new Set(),
    },
} as const satisfies SyntaxLanguage;
