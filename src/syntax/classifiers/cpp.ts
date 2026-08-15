/**
 * C/C++ identifier role classification (tree-sitter-cpp grammar — the same
 * grammar serves C, C++, and Objective-C files).
 *
 * Rules (pinned by test/cpp.test.mjs and the node-types table in
 * docs/code_scan.md):
 *   - `type_identifier` → "type"
 *   - `field_identifier` → "member" (`data.begin` → `begin`)
 *   - `namespace_identifier` → skipped (`std` in `std::sort`; the meaningful
 *     name is the identifier child)
 *   - `identifier` in `qualified_identifier` field "name" → "call" if the
 *     qualified id is under a call_expression, else "type"
 *   - `identifier` under `call_expression` → "call"
 *   - `identifier` under declaration/parameter contexts → "var"
 *   - `identifier` in `field_expression` argument position → "var",
 *     non-argument → skipped (the base object, covered by field_identifier)
 *   - else `identifier` → "var"
 */
import type { RoleClassifier, TSNode } from "../types";
import { fieldOf } from "../types";

export const classifyCppRole: RoleClassifier = (node) => {
    const t = node.type;
    const parent = node.parent;
    const pt = parent?.type ?? null;
    const gp = parent?.parent?.type ?? null;
    const field = fieldOf(node);

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
};
