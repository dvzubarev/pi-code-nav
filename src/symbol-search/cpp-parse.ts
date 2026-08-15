/**
 * C++ (ccls) symbol-search PARSING — the pure string-classification helpers.
 *
 * Moved verbatim out of `src/symbol.ts` (stage 1 of the strategy extraction).
 * These functions have no LSP/pi/fs dependency: they only classify strings, so
 * they are independently unit-testable. The cpp STRATEGY
 * (`src/symbol-search/strategies/cpp.ts`) wires them into the
 * `SymbolSearchStrategy` interface; the orchestration pipeline stays in
 * `src/symbol.ts`.
 *
 * The ccls workspace/symbol `name` is a FULL C++ qualified signature
 * (`void diskann::Index::occlude_list(const uint32_t location, ...)`), which is
 * why this file exists: plain bare-name equality (used for python/typescript/
 * bash) is wrong for cpp.
 */

/**
 * Find the LAST top-level `::` separator in a (possibly template-argument
 * carrying) C++ scope string. A C++ template argument may itself be qualified
 * (`Result<std::string>`), so only split on a top-level `::` rather than
 * blindly taking the last one.
 */
export function lastCppScopeSeparator(query: string): number {
    let angleDepth = 0;
    let last = -1;
    for (let i = 0; i + 1 < query.length; i++) {
        if (query[i] === "<") angleDepth++;
        else if (query[i] === ">" && angleDepth > 0) angleDepth--;
        else if (angleDepth === 0 && query[i] === ":" && query[i + 1] === ":") {
            last = i;
            i++;
        }
    }
    return last;
}

/** Remove balanced C++ template-argument groups for ccls's fuzzy query. ccls
 * does not return a specialization declaration for `Result<void>`, but does
 * return it for `Result`; exact post-filtering restores the requested args. */
export function stripCppTemplateArguments(query: string): string {
    // `<`, `<<`, and `<=>` are operator names, not template argument lists.
    if (query.includes("operator<")) return query;
    let depth = 0;
    let out = "";
    for (const ch of query) {
        if (ch === "<") {
            depth++;
            continue;
        }
        if (ch === ">" && depth > 0) {
            depth--;
            continue;
        }
        if (depth === 0) out += ch;
    }
    // An unmatched `<` is more likely an operator name than a template-id.
    return depth === 0 ? out : query;
}

/**
 * Tokenize a (possibly qualified) C++ qualifier string on top-level `::`.
 * `std::vector<T>` -> ["std", "vector<T>"], `vector` -> ["vector"].
 * Used to build the query's qualifier-token chain for the token-suffix
 * exact-match rule.
 */
export function tokenizeCppQualifier(qualifier: string): string[] {
    const tokens: string[] = [];
    let rest = qualifier;
    while (rest) {
        const idx = lastCppScopeSeparator(rest);
        if (idx < 0) {
            tokens.unshift(rest);
            break;
        }
        tokens.unshift(rest.slice(idx + 2));
        rest = rest.slice(0, idx);
    }
    return tokens;
}

/** Parse a cpp workspace/symbol `name` (a full C++ qualified signature like
 * `void diskann::Index::occlude_list(const uint32_t location, ...)`) into its
 * qualifier-token chain and bare identifier. Used by code_search_symbol's
 * token-level exact-match rule for cpp, replacing the old substring check
 * (`name.includes("::" + bare)`) which incorrectly ranked
 * `std::my_vector::push_back` as an exact match for `vector::push_back` — the
 * `_` token boundary wasn't honored.
 *
 * The ccls `name` is a declarator + return type + parameter list — except for
 * `using`-alias and `typedef` declarations, where ccls formats the name as
 * `using <qual>::<name> = <type>` or `typedef <type> <qual>::<name>`. We detect
 * these by the first token: `using`-alias (name starts with "using" and
 * contains "=") extracts the name from between "using " and "=";
 * `using`-declarations ("using <qual>::<member>", no "=") and `typedef` both
 * parse via the general last-token rule (correct because the defined name is
 * the last qualified identifier). For all other forms we strip the parameter
 * list (everything from the first `(`), take the last whitespace-separated
 * token (the qualified declarator, after stripping leading `&`/`*` ref/pointer
 * qualifiers), then split on top-level `::`. Template arguments are retained
 * so an explicit specialization query can distinguish `Result<void>` from
 * the primary `Result`; matching ignores candidate arguments only when the
 * corresponding query component has none.
 *
 * Examples:
 *   `void diskann::Index::occlude_list(...)`
 *     → qual=["diskann","Index"], bare="occlude_list"
 *   `std::vector<uint32_t> diskann::InMemQueryScratch::_occlude_list_output`
 *     → qual=["diskann","InMemQueryScratch"], bare="_occlude_list_output"
 *   `struct AlphaGadget` → qual=[], bare="AlphaGadget"
 *   `push_back`           → qual=[], bare="push_back"
 *   `using my_type_t = int`
 *     → qual=[], bare="my_type_t"
 *   `using MyGadget::inner_type = int`
 *     → qual=["MyGadget"], bare="inner_type"
 *   `using std::pmr::vector = std::vector<_Tp, polymorphic_allocator<_Tp>>`
 *     → qual=["std","pmr"], bare="vector"
 *   `typedef _Vector_base<_Tp, _Alloc> std::vector::_Base`
 *     → qual=["std","vector"], bare="_Base"
 *   `using _Base::_M_allocate`
 *     → qual=["_Base"], bare="_M_allocate"
 *   `TM_TRAIN_CODEC = 1` (ccls enum member)
 *     → qual=[], bare="TM_TRAIN_CODEC"
 *   `struct temp::detail::int_helper {}` (ccls struct with trailing ` {}`)
 *     → qual=["temp","detail"], bare="int_helper"
 *   `template<> struct temp::detail::int_helper<int> {}`
 *     → qual=["temp","detail"], bare="int_helper<int>" */
export function parseCppSymbolName(name: string): {
    qualifierTokens: string[];
    bare: string;
} {
    let s = name;
    // ccls renders anonymous namespace scope as `(anon ns)`, before the
    // function parameter list. Normalize that scope component first, or the
    // first `(` below would truncate the declarator at `diskann::` and make
    // the actual function name fail the exact-match filter.
    s = s.replace(/::\((?:anon ns|anonymous namespace)\)::/g, "::__anon_scope__::");
    // Strip the parameter list: everything from the first `(`. ccls's
    // workspace/symbol `name` has at most one remaining top-level `(...)`
    // (the function's); return types don't contain `(` for the cases we handle.
    // Exception: C++ operator() where the first () is the operator NAME, not
    // the parameter list. In that case, skip past operator() and find the real
    // parameter list.
    let parenIdx = s.indexOf("(");
    if (parenIdx >= 0) {
        if (
            s.slice(0, parenIdx).endsWith("operator") &&
            parenIdx + 1 < s.length &&
            s[parenIdx + 1] === ")"
        ) {
            // operator() found — the () is part of the name.
            const nextParen = s.indexOf("(", parenIdx + 2);
            s = nextParen >= 0 ? s.slice(0, nextParen) : s;
        } else {
            s = s.slice(0, parenIdx);
        }
    }
    s = s.trim();

    // Handle `using NAME = TYPE` (ccls name: `using <qual>::<name> = <type>`).
    // We detect this by the first token being "using" AND the name containing
    // "=". `using`-declarations ("using _Base::_M_allocate", no "=") fall
    // through to the general last-token rule, which correctly picks up the
    // member name. `typedef <type> <qual>::<name>` also falls through — the
    // last qualified identifier IS the defined name.
    if (s.startsWith("using ") && s.includes("=")) {
        // Extract the substring between "using " and " =" (or "=").
        // The equal sign is always on the top level (not inside <> template
        // args) because ccls formats these names with a top-level " = ".
        const eqIdx = s.indexOf("=");
        const between = s.slice(6, eqIdx).trim(); // 6 = "using ".length
        // `between` is a (possibly qualified) name like `my_type_t` or
        // `MyGadget::inner_type` or `std::pmr::vector`. Split on `::`.
        const parts = between.split("::").filter((p) => p.length > 0);
        if (parts.length === 0) return { qualifierTokens: [], bare: "" };
        return { qualifierTokens: parts.slice(0, -1), bare: parts[parts.length - 1] };
    }

    // Strip ` = VALUE` suffix (ccls appends e.g. ` = 1` for enum members).
    // This handles all non-`using` forms where ccls appends " = <value>".
    // Look for a top-level ` = ` (not inside `<>`) — the `=` is always at the
    // top level in ccls's name formatting for enum members.
    const eqIdx = s.indexOf(" = ");
    if (eqIdx >= 0 && !s.includes("<") && !s.includes(">")) {
        // No angle brackets — safe to strip from " = " onward.
        s = s.slice(0, eqIdx);
    } else if (eqIdx >= 0) {
        // Angle brackets present — verify the `=` is at the top level by
        // counting angle-bracket depth up to eqIdx.
        let depth = 0;
        let topLevelEq = -1;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === "<") depth++;
            else if (ch === ">") depth--;
            else if (ch === "=" && depth === 0) {
                // Found a top-level `=`. Check it starts with " = ".
                if (i > 0 && s[i - 1] === " " && i + 1 < s.length && s[i + 1] === " ") {
                    topLevelEq = i;
                    break;
                }
            }
        }
        if (topLevelEq >= 0) {
            s = s.slice(0, topLevelEq).trim();
        }
    }

    // Strip trailing ` {}` — ccls appends ` {}` (empty braces) to the end of
    // struct/class/interface definitions (e.g. `struct Foo {}`). The braces
    // are always empty; ccls never includes the body in the name.
    if (s.endsWith("}")) {
        const braceIdx = s.lastIndexOf("{");
        if (braceIdx >= 0 && s.slice(braceIdx + 1).trim() === "}") {
            s = s.slice(0, braceIdx).trim();
        }
    }

    // Strip trailing ` : <inheritance-clause>` suffix — ccls appends this
    // for typed enums (`enum Foo : int {}`) and struct/class inheritances
    // (`struct Derived : Base {}`, `struct Derived : NS::Base {}`,
    // `class Foo : public Bar {}`). After `{}` stripping above, find the
    // last ` : ` (space-colon-space) and strip everything from it onward.
    const lastColonSpace = s.lastIndexOf(" : ");
    if (lastColonSpace >= 0) {
        s = s.slice(0, lastColonSpace).trim();
    }

    // General case: the last whitespace-separated token is the qualified
    // declarator (after return type). Strip leading `&`/`*` (ref/pointer
    // qualifiers on the decl).
    const tokens = s.split(/\s+/).filter(Boolean);
    let last = tokens.length > 0 ? tokens[tokens.length - 1] : "";
    last = last.replace(/^[&*]+\s*/, "");
    const parts: string[] = [];
    let componentStart = 0;
    let angleDepth = 0;
    for (let i = 0; i + 1 < last.length; i++) {
        if (last[i] === "<") angleDepth++;
        else if (last[i] === ">" && angleDepth > 0) angleDepth--;
        else if (angleDepth === 0 && last[i] === ":" && last[i + 1] === ":") {
            const component = last.slice(componentStart, i);
            if (component) parts.push(component);
            componentStart = i + 2;
            i++;
        }
    }
    const finalComponent = last.slice(componentStart);
    if (finalComponent) parts.push(finalComponent);
    if (parts.length === 0) return { qualifierTokens: [], bare: "" };
    return { qualifierTokens: parts.slice(0, -1), bare: parts[parts.length - 1] };
}

/** Match a single C++ name component against a query component. Explicit
 * template arguments pin the specialization; without them a base-name query
 * also finds specializations (`Result` matches `Result<void>`). */
function cppNameComponentMatches(query: string, candidate: string): boolean {
    return query.includes("<")
        ? candidate === query
        : stripCppTemplateArguments(candidate) === query;
}

/** Token-level exact-match test for cpp. A candidate is "exact" iff:
 *   - the candidate's bare identifier equals the query's bare name, AND
 *   - for a qualified query, the query's qualifier-token chain is a SUFFIX of
 *     the candidate's qualifier-token chain (token-level, so `vector` matches
 *     `std::vector` and `mystd::vector` but NOT `std::my_vector` — the `_`
 *     token boundary is honored).
 * For a bare query (empty qualifier tokens), only bare equality is required.
 *
 * Replaces the old substring check, which ranked
 * `std::my_vector::push_back` as exact for `vector::push_back`. See
 * docs/code_search_symbol.md. */
export function isCppExactMatch(
    queryQualifierTokens: string[],
    queryBare: string,
    candidateName: string,
): boolean {
    const { qualifierTokens, bare } = parseCppSymbolName(candidateName);
    if (!cppNameComponentMatches(queryBare, bare)) return false;
    if (queryQualifierTokens.length === 0) return true; // bare query
    if (qualifierTokens.length < queryQualifierTokens.length) return false;
    const offset = qualifierTokens.length - queryQualifierTokens.length;
    for (let i = 0; i < queryQualifierTokens.length; i++) {
        if (!cppNameComponentMatches(queryQualifierTokens[i], qualifierTokens[offset + i])) {
            return false;
        }
    }
    return true;
}
