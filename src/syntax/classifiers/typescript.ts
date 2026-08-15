/**
 * TypeScript / JavaScript identifier role classification.
 *
 * One classifier serves BOTH the `typescript` and `tsx` grammars: the two
 * dialects share the node-type vocabulary for everything except JSX, and JSX
 * attribute names are `property_identifier` nodes (→ `member`) in both, so no
 * branch on the language is needed.
 *
 * Node types of interest:
 *   type_identifier        — a type occurrence (class name, interface,
 *                             type alias, generic type, type annotation).
 *                             NOT the definition site only — every use is a
 *                             `type` so the agent can hover any of them.
 *   property_identifier     — the right of `.` in `obj.prop`, a class
 *                             field/method name, an interface member, an
 *                             enum member, a JSX attribute. → `member`.
 *   identifier              — everything else: the imported name, the called
 *                             name, the constructed class, the base of a
 *                             member expression, a declaration / parameter /
 *                             local. Classified by parent + field below.
 *
 * Rules (pinned by test/typescript.test.mjs and the node-types table in
 * docs/code_scan.md):
 *   - `type_identifier` / `predefined_type` → "type"
 *   - `property_identifier` / `shorthand_property_identifier` → "member"
 *   - `identifier` under an import/export construct → "import" (named,
 *     namespace, default, re-export, type-only imports)
 *   - `identifier` field "function" of `call_expression` → "call"
 *   - `identifier` field "constructor" of `new_expression` → "call"
 *   - `identifier` field "object" of `member_expression` → "var" (base)
 *   - everything else (declaration name, parameter, local) → "var"
 */
import type { RoleClassifier, TSNode } from "../types";
import { fieldOf } from "../types";

export const classifyTypeScriptRole: RoleClassifier = (node) => {
    const t = node.type;
    const parent = node.parent;
    const pt = parent?.type ?? null;
    const field = fieldOf(node);

    if (t === "type_identifier") return "type";
    // Primitive type annotations (number, string, boolean, void, any, ...) are
    // `predefined_type` nodes, not `type_identifier`. Treat them as `type` so
    // hover/definition works on them too — they are real type references.
    if (t === "predefined_type") return "type";
    if (t === "property_identifier" || t === "shorthand_property_identifier") {
        return "member";
    }
    if (t === "identifier") {
        // Imports — the names brought into scope. The TS grammar puts every
        // imported/aliased identifier under an import/export construct; these
        // are the third-party entry points `code_scan` exists to find.
        //   import { readFile } from "..."   → import_specifier (field name)
        //   import * as fs from "..."         → namespace_import
        //   import foo from "..."             → import_clause (default)
        //   export { bar } from "..."         → export_specifier (re-export)
        //   import type { Lang } from "..."   → same import_specifier path
        if (
            pt === "import_specifier" ||
            pt === "namespace_import" ||
            pt === "import_clause" ||
            pt === "export_specifier" ||
            pt === "aliased_export" ||
            pt === "aliased_import"
        ) {
            return "import";
        }
        // A name being called: `compute(...)`. field `function` of a
        // call_expression. Also covers `obj.method()` because the callee is
        // the whole member_expression (its property_identifier child becomes
        // a `member` above); the bare-identifier call path is just `f()`.
        if (pt === "call_expression" && field === "function") return "call";
        // `new Foo()` — Foo is a constructor reference; treat as a call site.
        if (pt === "new_expression" && field === "constructor") return "call";
        // Right of `.` in a member_expression is a property_identifier (above).
        // The LEFT (field `object`) is the base — a local/var like `obj`, or
        // another member_expression in a chain (`a.b.c`): the outer base is a
        // member_expression whose own property_identifier is emitted as
        // `member`, so this `identifier` base is just `var`.
        if (pt === "member_expression" && field === "object") return "var";
        // Everything else is a declaration name, parameter, or local. Match
        // Python's convention (def name → var) so declaration names are
        // omitted from the default role set and don't clutter the table.
        return "var";
    }
    return null;
};
