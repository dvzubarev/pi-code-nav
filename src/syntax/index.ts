/**
 * The syntax layer's public surface: type + grammar dispatch table.
 *
 * To add a language's SYMBOL-SCAN role mapping: drop a classifier in
 * `classifiers/` and add one line to `classifiers` below. Everything that
 * routes through `classifierFor` (`parseSymbols`, code_scan, the
 * definition/reference `list_symbols` integration) picks the classifier up
 * automatically. This covers symbol scanning only — the reference/definition
 * support has its own language-sensitive node-type sets
 * (`reference-context.ts` / `definition-context.ts`), which are NOT
 * reachable through this table. See adding-a-language.md step 8.
 */
import type { TsLang } from "./runtime";
import type { RoleClassifier } from "./types";
import { classifyPythonRole } from "./classifiers/python";
import { classifyCppRole } from "./classifiers/cpp";
import { classifyBashRole } from "./classifiers/bash";
import { classifyTypeScriptRole } from "./classifiers/typescript";

/** Strategy dispatch: tree-sitter language → role classifier. */
const classifiers: Record<TsLang, RoleClassifier> = {
    python: classifyPythonRole,
    cpp: classifyCppRole,
    bash: classifyBashRole,
    typescript: classifyTypeScriptRole,
    tsx: classifyTypeScriptRole, // TSX reuses the TS classifier (shared grammar vocabulary)
};

/** Get the role classifier for a tree-sitter language. */
export function classifierFor(lang: TsLang): RoleClassifier {
    return classifiers[lang];
}
