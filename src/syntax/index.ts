/**
 * The syntax layer's public surface, slimmed to a barrel over the
 * per-grammar `SyntaxLanguage` registry (`./languages/`).
 *
 * The old hand-maintained `TsLang → RoleClassifier` dispatch table is gone.
 * Everything that was reachable through `classifierFor` now routes through the
 * `SyntaxLanguage` profile's `classifyRole`, and — unlike before — the SAME
 * profile also carries the reference/definition node-type taxonomies and the
 * grammar↔LSP↔extension maps, so adding a language is one profile + one
 * registry line, with no shared node-type supersets left to drift.
 *
 * To add a language's tree-sitter support: drop a profile in `languages/`
 * (reusing an existing `classifiers/*` file when the grammar shares vocabulary)
 * and add it to `SYNTAX_LANGUAGES`. That covers `parseSymbols`,
 * `referenceSyntaxContext`, and `findEnclosingDefWithDoc` together.
 */

export {
    SYNTAX_LANGUAGES,
    classifierFor,
    syntaxLanguage,
    tsLangForFile,
    tsLangToLspLang,
} from "./languages/index";
export type {
    DefinitionPolicy,
    ReferenceNodeTaxonomy,
    SyntaxLanguage,
    TsLang,
} from "./languages/index";
