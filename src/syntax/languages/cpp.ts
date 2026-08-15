/**
 * `cpp` syntax profile (tree-sitter-cpp grammar — the same grammar also
 * serves C and Objective-C files via the extension list).
 *
 * This profile absorbs the two C++-specific branches that used to live in the
 * shared context modules:
 *   - `qualifierSeparator: "::"` replaces the `lang === "cpp"` branch in
 *     `reference-context.ts`.
 *   - `definitionPolicy.functionDeclarationCheck` replaces the `lang !==
 *     "cpp"` gate + hardcoded `declaration`/`field_declaration` prototype
 *     recognition in `definition-context.ts`: those node types only count as
 *     a definition when they contain a `function_declarator` descendant.
 *
 * The structural set includes `for_range_loop` (the grammar's real name for a
 * C++ range-based `for`); the old shared superset's `range_based_for_statement`
 * name does not exist in this grammar.
 */

import type { SyntaxLanguage } from "./index";
import { classifyCppRole } from "../classifiers/cpp";

export const cppLanguage = {
    grammar: "cpp",
    lspLanguage: "cpp",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".m", ".mm"],
    classifyRole: classifyCppRole,
    qualifierSeparator: "::",
    referenceNodes: {
        call: new Set(["call_expression", "new_expression"]),
        import: new Set(["using_declaration"]),
        member: new Set(["field_expression"]),
        type: new Set(["type_identifier", "template_type"]),
        definition: new Set([
            "function_definition",
            "class_specifier",
            "struct_specifier",
            "union_specifier",
            "namespace_definition",
            "lambda_expression",
        ]),
        expression: new Set([
            "call_expression",
            "new_expression",
            "field_expression",
            "subscript_expression",
            "binary_expression",
            "conditional_expression",
            "unary_expression",
            "cast_expression",
            "parenthesized_expression",
            "condition_clause",
        ]),
        statement: new Set([
            "expression_statement",
            "return_statement",
            "assignment_expression",
            "declaration",
            "if_statement",
            "for_statement",
            "while_statement",
            "switch_statement",
            "try_statement",
        ]),
        structural: new Set([
            "if_statement",
            "else_clause",
            "for_statement",
            "for_range_loop",
            "while_statement",
            "do_statement",
            "switch_statement",
            "case_statement",
        ]),
        block: new Set(["compound_statement", "declaration_list"]),
        completeStatement: new Set([
            "expression_statement",
            "return_statement",
            "co_return_statement",
            "throw_statement",
            "break_statement",
            "continue_statement",
            "declaration",
            "field_declaration",
            "using_declaration",
        ]),
    },
    definitionPolicy: {
        defNodes: new Set([
            "function_definition",
            "class_specifier",
            "struct_specifier",
            "union_specifier",
            "enum_specifier",
            "declaration",
            "field_declaration",
        ]),
        defBodyNodes: new Set([
            "function_definition",
            "class_specifier",
            "struct_specifier",
            "union_specifier",
            "enum_specifier",
        ]),
        functionDeclarationCheck: new Set(["declaration", "field_declaration"]),
    },
} as const satisfies SyntaxLanguage;
