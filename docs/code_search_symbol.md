# `code_search_symbol` — workspace + third-party symbol lookup

> Implementation notes for the `workspace/symbol`-backed tool
> (`src/symbol.ts` `symbol()`; per-language strategy policy in `src/symbol-search/`).
> Single agent entry point for finding a symbol by name,
> whether it lives in the workspace or indexed third-party/stdlib trees. See
> `code_scan.md` for the internal file-and-range implementation.

## Two mechanisms

1. **Third-party/stdlib roots as extra workspace folders (Python / ty).**
   `discoverThirdPartyRoots(lang, cwd)` — a compatibility wrapper in
   `src/symbol.ts` that delegates to `discoverPythonRoots(cwd)` (in
   `src/symbol-search/roots/python.ts`) only for Python and returns `[]` for
   every other language — reads `$propagatedBuildInputs` (nix —
   each package prefix yields `lib/pythonX.Y` (stdlib) AND
   `lib/pythonX.Y/site-packages` (installed packages)). `$PYTHONPATH` is ONLY
   consulted when `$propagatedBuildInputs` is absent — in a nix shell
   `$PYTHONPATH` carries the full transitive dependency closure (deep,
   rarely-queried, costly for ty to index, and inflates the bare-name fuzzy
   tail), whereas `$propagatedBuildInputs` is the project's direct deps (the
   targeted set the agent actually searches). In a regular venv/conda (no
   `$propagatedBuildInputs`) `$PYTHONPATH` is the venv's own small
   site-packages and is the only source. `LspClient.addWorkspaceFolders`
   sends `workspace/didChangeWorkspaceFolders` to add them. `ty` advertises
   `workspace.workspaceFolders.supported` with `changeNotifications: true`
   and INDEXES those folders once added — verified `typing.cast` and
   `cbor2.loads` become findable. ccls is NOT touched (it already indexes
   third-parties via its compilation database's `-isystem` flags; adding
   folders would just re-parse them as source for no benefit), so
   `discoverThirdPartyRoots` returns `[]` for non-python. Added once per
   client (WeakSet `clientsWithRoots`); failures are silent — the query
   still runs against the workspace root.

2. **Qualified-name parsing + tiered module-path filtering.**
   `parseQuery` (the dotted/python+typescript strategy, `src/symbol-search/strategies/dotted.ts`)
   splits `typing.cast` -> `(qualifier="typing",
bare="cast")` on the language's separator (`.` for python/typescript, `::`
   for cpp in `src/symbol-search/strategies/cpp.ts`). For python/typescript the server is queried with the BARE name
   (ty only matches bare names — `typing.cast` returns 0), then results are
   tiered by the defining module path AND lexical container ancestry.
   `modulePathOf` (`src/symbol-search/paths.ts`) derives the module from the
   file's path relative to its home workspace folder, longest-match-first;
   hierarchical `documentSymbol` trees recover enclosing classes/functions.
   For cpp (ccls) the FULL query is
   passed (ccls handles `::` qualified natively) and the separator is used
   only to extract the bare tail for ranking.

## Recovering containers from `documentSymbol`

**No Python server populates `SymbolInformation.containerName`** (confirmed:
ty, pyrefly, pyright all leave it `null` — the data simply isn't on the
wire), so the filter cannot use the enclosing-class field. (ccls likewise
leaves it null but encodes the container into `name` as a full C++
qualified signature `std::vector::push_back`, which is why the cpp path
string-matches the qualifier against `name` instead.) The hierarchical
`documentSymbol` tree DOES carry the class container (the ancestor chain of
a method is its class), but `workspace/symbol` is flat and discards it.
Qualified dotted queries first narrow candidate files with a second
`workspace/symbol` lookup (see below). The survivors are located in their
file's `documentSymbol` tree, matching **name AND range**, then recovering the
ancestor names. This separates same-named methods in sibling classes and
retains each overload declaration. The tree is cached per file per search
call and shared with identifier-position resolution (`cachedDocumentSymbols`
in `src/lsp-resolution.ts`); failed/flat responses cache an empty tree rather
than inventing ancestry. Bare queries do not need this extra ranking step.

### Container prefilter: intersect before reading files

For `LazyRecords.items`, the strategy searches bare `items`, then (unless a
module match already settled the query) bare `LazyRecords`. Keeping the
member query first preserves the single-query fast path for `typing.cast`
and other module-qualified names.

- Container results must have the exact, case-sensitive name and a container
  kind (class/interface/struct/enum, namespace/module, or function/method).
  Fuzzy names and variable/import-binding hits do not constrain the search.
- Intersect member candidates with container hits by source URI. With a
  multi-line container range, also require it to contain the member range.
  Single-line ranges may be identifier-only (e.g. tsserver), so they narrow
  by file only; ancestry verification still decides the match.
- Only the surviving files are read/opened for `documentSymbol`. Merely
  sharing a file/range is NOT sufficient to accept a result: the full lexical
  ancestry is verified afterward, including module prefixes and nested names.
- For `Outer.Inner.items`, search bare `Inner`, then verify `Outer.Inner`.
  All exact container declarations participate, including dependency files;
  do not apply workspace-first ranking to this internal container search.
- If the extra request fails or has no usable exact container declarations,
  use the original ancestry-verification path. This avoids false negatives
  for servers that omit containers or return import bindings. A known
  container with no member candidates in its files can return empty without
  opening any candidate files.

This is a best-effort optimization over the server's index. A server that
returns only a subset of multiple same-named container declarations can also
limit the result set; the LSP response provides no completeness indicator.
Inherited members/import aliases remain outside lexical qualification.

Verified on `ppllib` with ty 0.0.56 and 0.0.91: `items` yields 19 exact rows
across 16 files; `LazyRecords` yields one container, and only
`lazy_records.py` needs a document-symbol request. All three overload/
implementation declarations still expand references.

## Tiered qualified-name filter (first non-empty tier wins)

A precise qualifier is never drowned by the broad fallback. The name match
for a QUALIFIED query is CASE-SENSITIVE (the agent spelled the exact symbol
— `Request`, not `request`); the bare-query path stays case-insensitive
(ty's fuzzy search returns case variants and a bare name is ambiguous).
Fuzzy/partial-name matches are ALWAYS dropped for a qualified query.

All workspace folders participate in every tier: the project root as well as
added dependency/stdlib roots. A qualified name identifies a module or
container; it does **not** imply that the symbol is third-party.

1. **Module match** = exact name, module path matches the qualifier precisely
   (`mod === qualifier` or `mod.startsWith(qualifier + ".")`). Happy paths:
   workspace `commerce.domain.Invoice` -> `commerce.domain`, `typing.cast` ->
   `typing`, and `cbor2.loads` -> `cbor2._decoder`. Return immediately without
   fetching ancestry for unrelated files. Module-only queries may intentionally
   return multiple same-named members from that module.
2. **Lexical match** = exact name, qualifier is a token-boundary suffix of
   the enclosing-name chain or of `module + enclosing-name chain`.
   `LazyRecords.items`, `Outer.Inner.items`, and
   `ppllib.core.lazy_records.LazyRecords.items` all work. Names are
   case-sensitive; `MyLazyRecords` does not match `LazyRecords`.
3. **Constrained package re-export fallback** = exact name, defining module
   shares the qualifier's leading component, with verified ancestry:
   - For a member, some module-prefix/container-suffix split of the qualifier
     must match the module prefix and enclosing names. Thus
     `aiohttp.StreamReader.iter_chunks` finds `StreamReader` in
     `aiohttp.streams`, but not another class's `iter_chunks`.
   - Verified top-level symbols retain the package-level fallback for
     `aiohttp.web.Request` -> `aiohttp.web_request.Request`. This remains an
     approximation: it does not prove that the requested module re-exports
     the name, and can return multiple top-level definitions in the package.

There is **no unqualified exact-name fallback** for qualified queries. The old
Q3 returned every `items` in the workspace AND stdlib for `LazyRecords.items`,
then misleadingly called them all exact matches and blocked `include` fan-out.
If no tier matches, return no symbols rather than discarding the qualifier.

This is lexical qualification, not expression evaluation: inherited members
and arbitrary import aliases are not resolved through class/import graphs.
Without hierarchical document symbols, module matching still works, but
container matching and the re-export fallback cannot be verified.

## Ranking (workspace-first tiering)

ty's `workspace/symbol` is case-insensitive FUZZY — a bare `cast` returns
~400 results and the exact `typing.cast` is buried. So results are tiered:

- **T1** = exact-name (case-insensitive for py/ts) matches in the WORKSPACE
  ROOT. When non-empty, emit ONLY T1 — a bare name almost always means the
  agent's own symbol, and third-party fuzzy hits (e.g.
  `encode_stringref_namespace` for `tempc`) are pure noise.
- **T2** = exact-name matches in third-party/stdlib (e.g. bare `loads` with
  no workspace `loads` -> `cbor2.loads`, `json.loads`, ...).
- **T3** = fuzzy matches whose name CONTAINS the bare query as a
  substring. Emitted only when T1 is empty, after T2, and trimmed at
  `SYMBOL_MAX_ROWS_PER_LANG` (50) with a trailing note. Fuzzy hits that
  don't even share a substring with the query (e.g.
  `using thrust::iterator_traversal<...>` for `occlude_list`,
  `encode_stringref_namespace` for `tempc`) are pure noise that bloats
  context — they are dropped. The agent almost always wants results that
  at least match by substring; this filter enforces that without losing
  ty's loose matching for legitimate prefix/extension hits (`TempC` for
  `tempc`, `load_package_tests` for `load`, `occlude_list_v2` for
  `occlude_list`).

For qualified Python/TypeScript queries the module/container tiers above
apply; fuzzy/partial-name matches are always dropped. Qualified C++ list
mode may retain a T3 fuzzy tail because ccls searches full signatures. C++
`include` mode keeps exact matches only.

### cpp exact-match = token-level (bare equality + qualifier suffix)

For cpp (ccls) the workspace/symbol `name` is a full C++ qualified
signature (`void diskann::Index::occlude_list(...)`) rather than a bare
identifier, so the "exact name" check is a TOKEN-LEVEL rule
(`isCppExactMatch` in `src/symbol-search/cpp-parse.ts`), NOT a substring
check. The rule:

1. Parse the candidate `name` into `(qualifierTokens, bare)` via
   `parseCppSymbolName` (also `src/symbol-search/cpp-parse.ts`): strip the
   parameter list (everything from the
   first `(`), take the last whitespace-separated token (the qualified
   declarator, after stripping leading `&`/`*`), then split on top-level
   `::`. The last component is the bare identifier; the rest is the
   qualifier-token chain. Template arguments are retained.
2. The candidate is **exact** iff its bare component matches the query's
   bare component AND, for a qualified query, the query's qualifier-token
   chain is a SUFFIX of the candidate's qualifier-token chain (token-level, so
   `vector` matches `std::vector` and `mystd::vector` but NOT
   `std::my_vector` — the `_` token boundary is honored). For a bare query
   (empty qualifier tokens), only the bare component is required. A query
   component with explicit template arguments must equal the candidate
   component exactly; a component without arguments also matches candidate
   specializations (`Result` matches `Result<void>`).

For a template-id query, code-nav strips balanced template arguments from the
query sent to ccls, then restores precision through this exact post-filter.
This is necessary because ccls returns the `Result<void>` declaration for a
`Result` workspace query but returns only its members for `Result<void>`.

Examples:

- `vector::push_back` (qual=[vector], bare=push_back):
    - `std::vector::push_back(int)` → qual=[std,vector], `[vector]` is a
      token suffix → **exact**.
    - `mystd::vector::push_back(int)` → qual=[mystd,vector], `[vector]` is
      a token suffix → **exact**.
    - `std::my_vector::push_back(double)` → qual=[std,my_vector],
      `[vector]` is NOT a token suffix (`my_vector` != `vector`) → **not
      exact** → T3 fuzzy (has `push_back` substring) → dropped when T1/T2
      non-empty.
- `push_back` (bare, qual=[]):
    - `std::vector::push_back(int)` → bare=push_back → **exact**.
    - `std::vector::push_back_int(int)` → bare=push_back_int != push_back
      → **not exact** → T3 fuzzy → dropped when T1 non-empty.
- `data::Result<void>`:
    - `template<> class engine::data::Result<void> {}` → **exact**.
    - `class engine::data::Result {}` → **not exact** (explicit arguments pin
      the specialization).
    - `bool engine::data::Result<void>::ok() const` → **not exact** (its bare
      component is `ok`).

This replaces the OLD substring check (`name.includes("::" + bare)`), which
ranked `std::my_vector::push_back` as exact for `vector::push_back` (the
`_` token boundary wasn't honored). The T3 substring filter (`nameHasBare`,
unchanged) still drops the rest of the ccls fuzzy noise (the
`using thrust::iterator_*` rows ccls's ranker surfaces for almost any query).

For Python/TypeScript (ty), the `name` is the bare identifier and "exact" is
case-insensitive bare equality (case-insensitive because ty's fuzzy search
returns case variants). Disambiguation across modules and containers uses the qualified-name tiers
above; disambiguation across overloads (identical
name columns) cannot be done with `name_pattern`—see the `include` fan-out
section below.

## `include` fan-out (the omni entry point)

`code_search_symbol` is the tool agents actually reach for. To close the
round-trip gap (search → pick a row → call `code_definition` by hand), the
optional public `include` parameter retrieves per-match detail in the same
call. `index.ts` maps `definition` to the implementation's internal `code`
section name. When `include` is non-empty, the post-tier, post-filter,
post-dedupe exact-match set is fanned out: up to
`SYMBOL_FANOUT_MAX_MATCHES` (5) matches each get a `== [i] [lang] <row> ==`
block containing the requested `--- section ---` blocks.

Pipeline (when `include` is non-empty):

```
workspace/symbol → tier (module/container/re-export or T1/T2/T3) → drop T3 fuzzy tail
  → kinds → name_pattern → dedupe
  → len==0 ? "(no symbols matching ...)"
  : len≤5 ? fan-out per match
  : row list + "narrow with kinds / name_pattern / a qualified name"
```

The T3 fuzzy tail is DROPPED entirely in fan-out mode — the agent asked
for detail on specific symbols, so fuzzy partial-name matches are noise that
would inflate the match count past the cap. Only exact matches fan out.

### Sections

- `--- definition ---` — the public section name for the verbatim source body
  returned via `nav.definition`,
  head-snippeted to `floor(SYMBOL_FANOUT_CODE_BUDGET_LINES / N)` lines per
  match (2000 split evenly across N matches). The header
  `<defPath>:<sl>-<el>` shows the FULL body range (not the snippet range) so
  the agent has the real position for a follow-up `code_definition`. A
  `# (showing X of Y lines; use code_definition for full body)` note marks
  truncation. Single match → full 2000-line budget (effectively the whole
  body — matches `code_definition`'s direct output). Per-match hard failures
  (no definition found, cannot resolve body) are caught and reported inline as
  `ERROR: ...` so one bad match doesn't abort the whole fan-out.
- `--- hover ---` — signature-first line + the remaining hover content via
  `nav.hover`; the promoted bare line or fenced signature block is removed so
  it is not duplicated. Output is uncapped (docstrings are auxiliary; the
  2000-line code budget is the single dominant knob).
- `--- references ---` — the first 25 semantic references/usages via
  `nav.references`, with the same AST-aware syntax context, role, enclosing
  symbol metadata, pagination count, and per-expression truncation as the
  standalone tool. See `code_references.md`. A compatibility note directs the
  agent to `code_references` when more results remain.

When `list_symbols` contains one or more roles, included definitions and
references add line-local `name@column role` metadata for every occurrence of
those roles. Available roles are `type`, `call`, `member`, `import`, and `var`.
Each rendered line is independently navigable through follow-up tools. The
option has no effect on hover sections or plain row-list results.

### Explicit hover requests are retained

Definition source often duplicates hover information, but hover can contain
inferred types that are absent from source. Therefore
`include: ["definition", "hover"]` returns both sections rather than silently
changing the request.

### Overloads and the cap

The cap (5) protects the common-name case (10 `__init__` methods, 15
`clone` functions) while serving the overload case (2-3 sites) the fan-out
was designed for. The tool cannot distinguish these, so over the cap the
agent gets a row list + a "narrow with filters" note. Filters run BEFORE the
cap check, so an agent narrows 10 → 3 with `kinds`, `name_pattern`, or a
qualified name and gets the fan-out.

For Python/TypeScript (ty) the `name` column is the bare identifier, so two
overloads have identical name columns and `name_pattern` CANNOT separate
them — they fan out together (which is usually what the agent wants: every
overload's body). For C++ (ccls) the `name` is the full signature
(`void foo(int)` vs `void foo(double)`), so `name_pattern: "foo\\(int\\"` can
single out a specific overload.

## `kinds` and `name_pattern`

Two optional filters narrow the post-tier result set. Both run AFTER the
tier filter (so they narrow the exact-match set rather than re-introducing
fuzzy hits the tier dropped) and BEFORE dedupe + the fan-out/cap branch.

- `kinds` — array of friendly LSP SymbolKind names (case-
  insensitive): `function`, `method`, `class`, `interface`, `struct`,
  `constructor`, `property`, `field`, `variable`, `constant`, `enum`,
  `enummember`, `module`, `namespace`, `package`, `file`, `event`,
  `operator`, `typeparameter`. Reverse-mapped via `symbolKindFromName`
  (`render.ts`). The public schema restricts values to this enum.
- `name_pattern` — a case-insensitive regexp tested against each match's
  RENDERED name column. For cpp that's the full signature
  (`void std::vector::push_back(int)`), so it can distinguish overloads; for
  py/ts it's the bare identifier, so it cannot (see the overloads note
  above). An invalid regexp is a hard error (`isError: true`), matching
  `code_scan`'s pattern contract.

The intended workflow is: first call without `include` (or with `include` but
over the cap) → see the row list → add `kinds` / `name_pattern` to
narrow to ≤5 (ideally 1) exact matches → the fan-out fires automatically.

## Caveats

- `$propagatedBuildInputs` is nix-specific. In a regular venv/conda,
  `$PYTHONPATH` is the fallback (consulted ONLY when
  `$propagatedBuildInputs` is absent, so the nix-shell transitive-closure
  `$PYTHONPATH` doesn't flood the index). When neither is set, third-party
  search silently degrades to workspace-only — the tool still works for the
  agent's own symbols. Do NOT add roots for ccls (see above) and do NOT make
  folder addition blocking on its success.
- pyright does NOT implement `workspace/symbol` (returns `[]`), which broke
  this tool for Python until ty was added — see "Python server
  auto-detection" in `DESIGN.md`.
