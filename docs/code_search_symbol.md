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

### cpp bare-query "exact" = substring

For cpp (ccls) the workspace/symbol `name` is a full C++ qualified
signature (`void diskann::Index::occlude_list(...)`) rather than a bare
identifier, so the "exact name" check used by the T1/T2/T3 tiering is a
SUBSTRING match against the bare query, not equality. For a QUALIFIED
query (`std::vector::push_back`) the `::<bare>` boundary is required
(`::push_back`) so the qualifier's scope is honored and `push_back`
doesn't rank `push_back_v2`-style cousins as exact; for a BARE query
(`occlude_list`) a plain substring match suffices — the agent asked for
any symbol containing this name. Before the substring match was added
for bare cpp queries, every cpp result fell through to the unfiltered T3
fuzzy tail and the `using thrust::iterator_*` rows (which ccls's fuzzy
ranker surfaces for almost any query) drowned the actual hits. The T3
substring filter above then drops the rest of the noise.

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
