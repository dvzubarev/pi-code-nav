/**
 * Per-grammar `SyntaxLanguage` profiles — the registry that replaces the
 * shared, collision-prone node-type supersets in `reference-context.ts` and
 * `definition-context.ts`, and the source of truth for grammar↔LSP↔extension
 * routing.
 *
 * One profile declares ALL syntax-only policy for one tree-sitter grammar:
 *   - how to route a file path to the grammar (`extensions`);
 *   - which LSP language can answer for files of that grammar
 *     (`lspLanguage`) — the two layers are independent, so this is explicit
 *     rather than assumed (see `DESIGN.md` / `lsp.md`);
 *   - the identifier role classifier for `parseSymbols` (`classifyRole`);
 *   - the name qualifier separator for `enclosing` metadata;
 *   - the reference-context node taxonomies (`referenceNodes`);
 *   - the definition-recognition policy (`definitionPolicy`).
 *
 * A profile's node-type sets only name named node types ITS grammar actually
 * has. They must be manually audited for semantic meaning: identical names in
 * different grammars do not imply identical constructs. A node type that
 * another grammar added can no longer silently fire here, and a grammar's
 * structural name that didn't match the old shared superset can now be
 * included (e.g. cpp's `for_range_loop`).
 */

import type { Lang } from "../../languages/types";
import type { RoleClassifier } from "../types";
import { pythonLanguage } from "./python";
import { cppLanguage } from "./cpp";
import { bashLanguage } from "./bash";
import { typescriptLanguage } from "./typescript";
import { tsxLanguage } from "./tsx";

/**
 * Reference-context node taxonomies for one grammar. Every set must contain
 * ONLY named node types present in that grammar. Validate each with
 * `Language.idForNodeType(type, true)`: `Language.types` also lists anonymous
 * punctuation/keyword tokens, which must never be selected as AST context.
 */
export interface ReferenceNodeTaxonomy {
    /** Call-position constructs (`call`, `call_expression`, `new_expression`). */
    call: ReadonlySet<string>;
    /** Import/using/export constructs that bring a name into scope. */
    import: ReadonlySet<string>;
    /** Member access constructs (`attribute`, `field_expression`, …). */
    member: ReadonlySet<string>;
    /** Type-occurrence constructs. */
    type: ReadonlySet<string>;
    /** Definition constructs that can carry a name (for `enclosing`). */
    definition: ReadonlySet<string>;
    /** Expression constructs selected as syntax context. */
    expression: ReadonlySet<string>;
    /** Statement constructs (fallback context; declaration-narrowing). */
    statement: ReadonlySet<string>;
    /** Structural ancestors used by `context: "enclosing"`. */
    structural: ReadonlySet<string>;
    /** Plain block constructs that are transparent to `enclosing`. */
    block: ReadonlySet<string>;
    /** Complete executable/declaration statements. */
    completeStatement: ReadonlySet<string>;
}

/** Definition-context recognition policy for one grammar. */
export interface DefinitionPolicy {
    /**
     * Node types that can enclose a definition (walk-up targets in
     * `findEnclosingDefWithDoc`).
     */
    defNodes: ReadonlySet<string>;
    /**
     * Node types that carry a `{ … }`-style body, i.e. set `hasBody=true`
     * rather than being a bare prototype/declaration.
     */
    defBodyNodes: ReadonlySet<string>;
    /**
     * The subset of `defNodes` that are broad declarations and only count as
     * definitions when they contain a function declarator. Unchecked set for
     * languages where `defNodes` are already unambiguous (Python, TS, bash).
     */
    functionDeclarationCheck: ReadonlySet<string>;
}

/** A per-grammar profile composing all syntax-only policy. */
export interface SyntaxLanguage {
    /** The tree-sitter grammar key (`tree-sitter-wasm`'s `out/<grammar>/`). */
    grammar: string;
    /** The LSP language whose server answers for files of this grammar. */
    lspLanguage: Lang;
    /** Lowercased leading-dot file extensions routed to this grammar. */
    extensions: readonly string[];
    /** Identifier role classifier for `parseSymbols`. */
    classifyRole: RoleClassifier;
    /** Name-qualifier separator in rendered `enclosing:{name}` metadata. */
    qualifierSeparator: string;
    /** Reference-context node taxonomies. */
    referenceNodes: ReferenceNodeTaxonomy;
    /** Definition-node recognition policy. */
    definitionPolicy: DefinitionPolicy;
}

/** The ordered profile registry — one entry per tree-sitter grammar. */
export const SYNTAX_LANGUAGES = [
    pythonLanguage,
    cppLanguage,
    bashLanguage,
    typescriptLanguage,
    tsxLanguage,
] as const satisfies readonly SyntaxLanguage[];

/**
 * Tree-sitter language keys, derived from the registry. This REPLACES the
 * hand-written `TsLang = Lang | "tsx"` union in `runtime.ts`: the grammar
 * layer no longer assumes every LSP language has a grammar. `tsx` is a
 * distinct grammar key even though its LSP language is `typescript`.
 */
export type TsLang = (typeof SYNTAX_LANGUAGES)[number]["grammar"];

// Compile-time guard: do not widen the registry-derived grammar union by
// annotating either a profile or the registry as `SyntaxLanguage` /
// `SyntaxLanguage[]`.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _TsLangRejectsUnknownGrammar = Assert<
    Equal<"not-a-grammar" extends TsLang ? true : false, false>
>;

const BY_GRAMMAR = new Map(SYNTAX_LANGUAGES.map((l) => [l.grammar, l]));

const EXT_TO_GRAMMAR = new Map<string, TsLang>();
for (const l of SYNTAX_LANGUAGES) {
    for (const ext of l.extensions) EXT_TO_GRAMMAR.set(ext, l.grammar);
}

/** The syntax profile for a tree-sitter language key. */
export function syntaxLanguage(lang: TsLang): SyntaxLanguage {
    const profile = BY_GRAMMAR.get(lang);
    if (!profile) throw new Error(`no SyntaxLanguage profile for grammar ${lang}`);
    return profile;
}

/** The `RoleClassifier` for a tree-sitter language key. */
export function classifierFor(lang: TsLang): RoleClassifier {
    return syntaxLanguage(lang).classifyRole;
}

/**
 * Map a file path to a tree-sitter language key (grammar), or null if no
 * profile covers its extension. Previously `tsLangForFile`.
 */
export function tsLangForFile(path: string): TsLang | null {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    const ext = path.slice(dot).toLowerCase();
    return EXT_TO_GRAMMAR.get(ext) ?? null;
}

/**
 * Map a tree-sitter language key to the LSP `Lang` whose server can answer
 * for files of that grammar. The two layers are independent: `tsx` maps to
 * `typescript`, and a grammar key only exists because a profile declared it —
 * never by assuming `TsLang == Lang`.
 */
export function tsLangToLspLang(lang: TsLang): Lang {
    return syntaxLanguage(lang).lspLanguage;
}
