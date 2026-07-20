# `code_search_symbol` — workspace + third-party symbol lookup

> Implementation notes for the `workspace/symbol`-backed tool
> (`nav.ts` `symbol()`). Single entry point for finding a symbol by name,
> whether it lives in the workspace OR in third-party/stdlib trees. See also
> `code_scan.md` for the file-and-range entry point (a snippet, not a name).

## Two mechanisms

1. **Third-party/stdlib roots as extra workspace folders (Python / ty).**
   `discoverThirdPartyRoots(lang, cwd)` reads `$propagatedBuildInputs` (nix —
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
   `parseSymbolQuery` splits `typing.cast` -> `(qualifier="typing",
   bare="cast")` on the language's separator (`.` for python/typescript, `::`
   for cpp). For python/typescript the server is queried with the BARE name
   (ty only matches bare names — `typing.cast` returns 0), then results are
   tiered by how well the qualifier relates to each hit's defining module
   path (`modulePathOf`, derived from the file's path relative to its home
   workspace folder, longest-match-first). For cpp (ccls) the FULL query is
   passed (ccls handles `::` qualified natively) and the separator is used
   only to extract the bare tail for ranking.

## Why `containerName` can't be used

**No Python server populates `SymbolInformation.containerName`** (confirmed:
ty, pyrefly, pyright all leave it `null` — the data simply isn't on the
wire), so the filter cannot use the enclosing-class field. (ccls likewise
leaves it null but encodes the container into `name` as a full C++
qualified signature `std::vector::push_back`, which is why the cpp path
string-matches the qualifier against `name` instead.) The hierarchical
`documentSymbol` tree DOES carry the class container (the ancestor chain of
a method is its class), but `workspace/symbol` is flat and discards it.

## Tiered qualified-name filter (first non-empty tier wins)

A precise qualifier is never drowned by the broad fallback. The name match
for a QUALIFIED query is CASE-SENSITIVE (the agent spelled the exact symbol
— `Request`, not `request`); the bare-query path stays case-insensitive
(ty's fuzzy search returns case variants and a bare name is ambiguous).
Fuzzy/partial-name matches are ALWAYS dropped for a qualified query.

- **Q1** = exact name, third-party, module path matches the qualifier
  precisely (`mod === qualifier` or `mod.startsWith(qualifier + ".")`).
  Happy path: `typing.cast` -> `typing`, `cbor2.loads` -> `cbor2._decoder`.
- **Q2** = exact name, third-party, module path shares the qualifier's
  LEADING component (first `.`-segment). Graceful fallback for two cases a
  precise module-path match silently dropped before:
  * `aiohttp.StreamReader.iter_chunks` — the qualifier's `StreamReader` is a
    CLASS, not a module; the method lives in `aiohttp.streams`. Shared
    leading component `aiohttp` matches.
  * `aiohttp.web.Request` — `Request` is DEFINED in `aiohttp.web_request`
    (re-exported from `aiohttp.web`). `aiohttp.web_request` does NOT
    `.startsWith("aiohttp.web.")` (the `_` breaks the `.` boundary), but the
    leading component `aiohttp` matches.
- **Q3** = exact name, third-party, anything else (last resort so a
  qualified query never returns empty when exact-name third-party hits
  exist).

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

For qualified queries the tiered Q1/Q2/Q3 filter above applies; fuzzy/
partial-name matches are always dropped.

### cpp exact-match = token-level (bare equality + qualifier suffix)

For cpp (ccls) the workspace/symbol `name` is a full C++ qualified
signature (`void diskann::Index::occlude_list(...)`) rather than a bare
identifier, so the "exact name" check is a TOKEN-LEVEL rule
(`isCppExactMatch` in `nav.ts`), NOT a substring check. The rule:

  1. Parse the candidate `name` into `(qualifierTokens, bare)` via
     `parseCppSymbolName`: strip the parameter list (everything from the
     first `(`), take the last whitespace-separated token (the qualified
     declarator, after stripping leading `&`/`*`), drop one `<...>` template-arg
     group, then split on `::`. The last component is the bare identifier;
     the rest is the qualifier-token chain.
  2. The candidate is **exact** iff its `bare` equals the query's bare name
     AND, for a qualified query, the query's qualifier-token chain is a
     SUFFIX of the candidate's qualifier-token chain (token-level, so
     `vector` matches `std::vector` and `mystd::vector` but NOT
     `std::my_vector` — the `_` token boundary is honored). For a bare query
     (empty qualifier tokens), only bare equality is required.

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

This replaces the OLD substring check (`name.includes("::" + bare)`), which
ranked `std::my_vector::push_back` as exact for `vector::push_back` (the
`_` token boundary wasn't honored). The T3 substring filter (`nameHasBare`,
unchanged) still drops the rest of the ccls fuzzy noise (the
`using thrust::iterator_*` rows ccls's ranker surfaces for almost any query).

For Python/TypeScript (ty), the `name` is the bare identifier and "exact" is
case-insensitive bare equality (case-insensitive because ty's fuzzy search
returns case variants). Disambiguation across modules uses the Q1/Q2/Q3
tiered module-path filter above; disambiguation across overloads (identical
name columns) cannot be done with `filter_by_regex` — see the `info` fan-out
section below.

## `info` fan-out (the omni entry point)

`code_search_symbol` is the tool agents actually reach for. To close the
round-trip gap (search → pick a row → call `code_definition` by hand), the
optional `info` parameter makes the tool ALSO retrieve per-match detail in
the SAME call. When `info` is non-empty, the post-tier, post-filter,
post-dedupe exact-match set is fanned out: up to
`SYMBOL_FANOUT_MAX_MATCHES` (5) matches each get a `== [i] [lang] <row> ==`
block containing the requested `--- section ---` blocks.

Pipeline (when `info` is non-empty):

```
workspace/symbol → tier (Q1/Q2/Q3 or T1/T2/T3) → drop T3 fuzzy tail
  → filter_by_kind → filter_by_regex → dedupe
  → len==0 ? "(no symbols matching ...)"
  : len≤5 ? fan-out per match
  : row list + "narrow with filter_by_kind / filter_by_regex / a qualified name"
```

The T3 fuzzy tail is DROPPED entirely in fan-out mode — the agent asked
for detail on specific symbols, so fuzzy partial-name matches are noise that
would inflate the match count past the cap. Only exact matches fan out.

### Sections

- `--- code ---` — the verbatim source body via `nav.definition`,
  head-snippeted to `floor(SYMBOL_FANOUT_CODE_BUDGET_LINES / N)` lines per
  match (2000 split evenly across N matches). The header
  `<defPath>:<sl>-<el>` shows the FULL body range (not the snippet range) so
  the agent has the real position for a follow-up `code_definition`. A
  `# (showing X of Y lines; use code_definition for full body)` note marks
  truncation. Single match → full 2000-line budget (effectively the whole
  body — matches `code_definition`'s direct output). Per-match hard failures
  (no definition found, cannot resolve body) are caught and reported inline as
  `ERROR: ...` so one bad match doesn't abort the whole fan-out.
- `--- hover ---` — signature-first line + full hover markdown body via
  `nav.hover`, uncapped (docstrings are auxiliary; the 2000-line code budget
  is the single dominant knob).
- `--- references ---` — all call sites via `nav.references`, trimmed to
  `SYMBOL_FANOUT_REFS_CAP` (25) rows with a
  `(N of M, use code_references for all)` note.

### `hover` is auto-dropped when `code` is present

`code` is a superset of `hover` for the function/class/method case (which is
what `code` retrieves): the signature lives in the body, and the doc comment
is already prepended by `renderSnippetBlock`'s `findEnclosingDefWithDoc` path.
So `info: ["code", "hover"]` is normalized to `info: ["code"]` before
rendering — the `--- hover ---` section is omitted. The minor loss
tsserver/ty's inferred type annotation in the hover (e.g.
`: Promise<number>` on a bare `async function`) is acceptable; the agent can
still call `code_hover` directly if it needs it.

### Overloads and the cap

The cap (5) protects the common-name case (10 `__init__` methods, 15
`clone` functions) while serving the overload case (2-3 sites) the fan-out
was designed for. The tool cannot distinguish these, so over the cap the
agent gets a row list + a "narrow with filters" note. Filters run BEFORE the
cap check, so an agent narrows 10 → 3 with `filter_by_kind` /
`filter_by_regex` / a qualified name and gets the fan-out.

For Python/TypeScript (ty) the `name` column is the bare identifier, so two
overloads have identical name columns and `filter_by_regex` CANNOT separate
them — they fan out together (which is usually what the agent wants: every
overload's body). For cpp (ccls) the `name` is the full signature
(`void foo(int)` vs `void foo(double)`), so `filter_by_regex: "foo\\(int\\"` can
single out a specific overload.

## `filter_by_kind` and `filter_by_regex`

Two optional filters narrow the post-tier result set. Both run AFTER the
tier filter (so they narrow the exact-match set rather than re-introducing
fuzzy hits the tier dropped) and BEFORE dedupe + the fan-out/cap branch.

- `filter_by_kind` — array of friendly LSP SymbolKind names (case-
  insensitive): `function`, `method`, `class`, `interface`, `struct`,
  `constructor`, `property`, `field`, `variable`, `constant`, `enum`,
  `enummember`, `module`, `namespace`, `package`, `file`, `event`,
  `operator`, `typeparameter`. Reverse-mapped via `symbolKindFromName`
  (`render.ts`). Unknown names silently match nothing — the agent gets an
  empty result and notices, which is better than a hard error that blocks a
  partially-correct filter.
- `filter_by_regex` — a case-insensitive regexp tested against each match's
  RENDERED name column. For cpp that's the full signature
  (`void std::vector::push_back(int)`), so it can distinguish overloads; for
  py/ts it's the bare identifier, so it cannot (see the overloads note
  above). An invalid regexp is a hard error (`isError: true`), matching
  `code_tree` / `code_scan`'s pattern contract.

The intended workflow is: first call without `info` (or with `info` but over
the cap) → see the row list → add `filter_by_kind` / `filter_by_regex` to
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
