/**
 * Compatibility barrel for the tree-sitter-backed symbol/context support.
 *
 * The subsystems used to all live in this one file; they are now split by
 * capability under `./syntax/`:
 *
 *   1. Grammar lifecycle/cache + language-key helpers → `syntax/runtime.ts`
 *   2. Symbol scanning and role classification            → `syntax/symbol-scan.ts`
 *   3. Reference context extraction                       → `syntax/reference-context.ts`
 *   4. Enclosing-definition/doc-comment resolution        → `syntax/definition-context.ts`
 *   5. Source and symbol-table rendering                  → `syntax/source-render.ts`
 *
 * This module re-exports the same public surface so existing importers
 * (`scan.ts`, `definition.ts`, `references.ts`, and the unit tests) keep
 * working unchanged. New code should import directly from `./syntax/…`.
 *
 * This module makes ZERO LSP calls. `include_docs` enrichment (hovering each
 * symbol) is done by the caller, so the common path is pure parsing — one
 * tree-sitter parse, no server round-trips. See code_scan.md "What it solves".
 */

export { getLanguage } from "./syntax/runtime";
export { tsLangForFile, tsLangToLspLang } from "./syntax/languages/index";
export type { TsLang } from "./syntax/languages/index";
export { DEFAULT_SYMBOL_ROLES, parseSymbols } from "./syntax/symbol-scan";
export type { ParseSymbolsOptions } from "./syntax/symbol-scan";
export { referenceSyntaxContext } from "./syntax/reference-context";
export type { ReferenceContextMode, ReferenceSyntaxContext } from "./syntax/reference-context";
export { findEnclosingDefWithDoc } from "./syntax/definition-context";
export type { EnclosingDef } from "./syntax/definition-context";
export {
    annotateNumberedSource,
    hoverFirstLine,
    renderNumberedSource,
    renderSymbolTable,
} from "./syntax/source-render";
export { SYNTAX_LANGUAGES, classifierFor, syntaxLanguage } from "./syntax/languages/index";
export type {
    DefinitionPolicy,
    ReferenceNodeTaxonomy,
    SyntaxLanguage,
} from "./syntax/languages/index";
