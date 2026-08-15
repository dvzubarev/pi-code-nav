/**
 * Bash identifier role classification (tree-sitter-bash grammar).
 *
 * Deliberately conservative (see the "bash" section of docs/code_scan.md):
 * `variable_name` → var, the `word` child of a `command_name` → call,
 * everything else (bare `word` arguments, `string`s, `subscript` indices) →
 * skipped. Bare `word` nodes are mostly arguments/literals and too noisy; the
 * design doc explicitly deferred bash polish — do not block on it.
 */
import type { RoleClassifier, TSNode } from "../types";

export const classifyBashRole: RoleClassifier = (node) => {
    const t = node.type;
    const parent = node.parent;

    if (t === "variable_name") return "var";
    if (t === "word" && parent?.type === "command_name") return "call";
    return null;
};
