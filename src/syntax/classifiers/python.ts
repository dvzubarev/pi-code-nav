/**
 * Python identifier role classification (tree-sitter-python grammar).
 *
 * Rules (pinned by test/python.test.mjs and the node-types table in
 * docs/code_scan.md):
 *   - `type` node (outermost annotation only) → "type"
 *   - `identifier` under `type` → skipped (covered by the type node)
 *   - `identifier` under `aliased_import` / `dotted_name`+import → "import"
 *   - `identifier` with field "attribute" under `attribute` → "member"
 *   - `identifier` under `call` → "call"
 *   - else `identifier` → "var"
 * Nested `type` nodes (generics/unions) emit only the OUTERMOST.
 */
import type { RoleClassifier, TSNode } from "../types";
import { fieldOf } from "../types";

export const classifyPythonRole: RoleClassifier = (node) => {
    const t = node.type;
    const parent = node.parent;
    const pt = parent?.type ?? null;
    const gp = parent?.parent?.type ?? null;
    const field = fieldOf(node);

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
            (gp === "import_statement" || gp === "import_from_statement" || gp === "aliased_import")
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
};
