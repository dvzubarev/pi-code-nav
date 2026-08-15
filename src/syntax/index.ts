/**
 * The syntax layer's public surface: type + grammar dispatch table.
 *
 * To add a language: drop a classifier in `classifiers/` and add one line to
 * `classifiers` below. Everything else in the extension (parseSymbols,
 * code_scan, the definition/reference `list_symbols` integration) picks the
 * classifier up through `classifierFor`.
 */
import type { TsLang } from "../tree-sitter-parse";
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
