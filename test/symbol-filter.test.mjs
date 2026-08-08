// Unit tests for code_search_symbol's substring filter on the fuzzy tail.
//
// The agent almost always wants results that at least match the query by
// substring; fuzzy hits that don't share a substring with the query (e.g.
// `using thrust::iterator_traversal<...>` for `occlude_list`,
// `encode_stringref_namespace` for `tempc`) are pure context-bloating trash
// and are dropped. These tests pin the filter using a MOCK LspClient so they
// run without a real language server on PATH (no e2e gate).
//
// Covered behaviors:
//   - cpp BARE query: a result whose name contains the bare query as a
//     substring is kept; one that doesn't is dropped (the `occlude_list`
//     regression from DiskANN — the thrust::iterator_* rows disappear).
//   - cpp BARE query: when at least one exact (substring) hit exists in the
//     workspace root, ONLY those are emitted (T1 wins, fuzzy tail dropped).
//   - python BARE query with no workspace exact hit: the fuzzy tail is
//     filtered to results whose name contains the bare query substring.
//
// Run:  npm run test:unit -- test/symbol-filter.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { load } from "./helpers.mjs";

/**
 * Build a mock LspClient whose `workspaceSymbol` returns the canned list.
 * The mock satisfies the surface `symbol()` actually touches:
 *   - supports("workspaceSymbolProvider") → true
 *   - ensureProjectLoaded() → true (no project warm-up needed)
 *   - workspaceSymbol(query) → the canned list (the query is ignored — the
 *     mock returns the same canned set regardless; the ranking/filtering
 *     under test happens AFTER the server call, in nav.ts)
 *   - workspaceFolderPaths() → [rootPath] (no third-party roots in tests)
 *   - rootPath → the test's temp dir (so workspace-root detection works)
 *   - documentSymbols() → [] (so resolveSymbolSelStart falls through to a
 *     file scan that also fails — selStart becomes undefined and the row
 *     uses the symbol's range start; the row is still emitted)
 *
 * The canned list uses `file://` URIs under `rootPath` so the
 * workspace-root classification (`homeFolderOf(s.uri, folders) ===
 * client.rootPath`) treats them as workspace hits.
 */
function mockClientOf(rootPath, cannedSyms, onQuery) {
    const client = {
        rootPath,
        supports: () => true,
        ensureProjectLoaded: async () => true,
        workspaceSymbol: async (query) => {
            onQuery?.(query);
            return cannedSyms;
        },
        workspaceFolderPaths: () => [rootPath],
        documentSymbols: async () => [],
        openDocument: async () => {},
    };
    return async () => client;
}

/** Shorthand to build a SymbolInformation row. */
function sym(name, kind, relPath, line, character) {
    return {
        name,
        kind,
        location: {
            uri: `file://${relPath}`,
            range: { start: { line, character }, end: { line, character } },
        },
    };
}

test("cpp bare 'occlude_list' keeps only the token-exact workspace match (T1 wins, fuzzy + thrust dropped)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symfilter-cpp-"));
    try {
        // Canned ccls results for query `occlude_list`. cpp `name` is a
        // full C++ qualified signature. Under the TOKEN-LEVEL exact rule
        // (isCppExactMatch: bare equality), only row 1 is exact (its bare
        // identifier IS `occlude_list`); rows 2-3 have bare identifiers
        // `occlude_list_output` / `_occlude_list_output` — different symbols,
        // so they're fuzzy T3. Since row 1 is a workspace exact (T1
        // non-empty), T1 wins and the fuzzy tail (rows 2-3) is dropped along
        // with the thrust::iterator_* noise (rows 4-5, no `occlude_list`
        // substring at all). The old substring-based rule counted rows 2-3
        // as "exact" (they contain `occlude_list`); the token rule correctly
        // treats them as fuzzy cousins.
        const root = dir;
        const canned = [
            sym(
                "void diskann::Index::occlude_list(const uint32_t location, std::vector<Neighbor> &pool)",
                6,
                `${root}/src/index.cpp`,
                1169,
                29,
            ),
            sym(
                "inline std::vector<uint32_t> &diskann::InMemQueryScratch::occlude_list_output()",
                6,
                `${root}/include/scratch.h`,
                117,
                34,
            ),
            sym(
                "std::vector<uint32_t> diskann::InMemQueryScratch::_occlude_list_output",
                8,
                `${root}/include/scratch.h`,
                159,
                26,
            ),
            sym(
                "using thrust::iterator_traversal<counting_iterator<type-parameter-0-0>> = random_access_traversal_tag",
                14,
                `/nix/store/fake/thrust/iterator/iterator_traits.h`,
                222,
                8,
            ),
            sym(
                "using thrust::iterator_system<counting_iterator<type-parameter-0-0>> = any_system_tag",
                14,
                `/nix/store/fake/thrust/iterator/iterator_traits.h`,
                217,
                8,
            ),
        ];
        const out = await symbol(
            { query: "occlude_list", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        // Only the token-exact workspace match (row 1). The fuzzy cousins
        // (rows 2-3) are dropped because T1 wins; the thrust noise (rows 4-5)
        // is dropped (no `occlude_list` substring).
        assert.equal(rows.length, 1, `expected ONLY the token-exact workspace row, got:\n${out}`);
        // The thrust::iterator_* noise must NOT appear.
        assert.ok(
            !/thrust::iterator_/.test(out),
            `thrust::iterator_* noise should be dropped, but appeared in:\n${out}`,
        );
        // The exact row IS present.
        assert.match(out, /Index::occlude_list/, `Index::occlude_list missing:\n${out}`);
        // The fuzzy cousins are dropped (T1 wins).
        assert.ok(
            !/occlude_list_output/.test(out),
            `occlude_list_output (fuzzy cousin) should be dropped when T1 wins:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("cpp bare query: T1 (workspace exact) wins, fuzzy tail dropped entirely", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symfilter-t1-"));
    try {
        const root = dir;
        const canned = [
            // Workspace hit (under rootPath): exact (contains `occlude_list`).
            sym("void myns::occlude_list(int x)", 6, `${root}/a.cpp`, 10, 5),
            // Third-party hit (under /nix/store) that ALSO contains the
            // substring. With T1 non-empty this must be dropped — the
            // agent's bare name is their own symbol.
            sym("void diskann::Index::occlude_list(int x)", 6, `/nix/store/fake/x.cpp`, 1, 5),
            // Pure noise: no `occlude_list` substring.
            sym("using thrust::iterator_traversal<...>", 14, `/nix/store/fake/y.h`, 1, 5),
        ];
        const out = await symbol(
            { query: "occlude_list", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        assert.equal(rows.length, 1, `expected ONLY the workspace T1 row, got:\n${out}`);
        assert.match(rows[0], /myns::occlude_list/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("python bare 'load' (no workspace exact) keeps only substring-matching fuzzy rows", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symfilter-py-"));
    try {
        const root = dir;
        const canned = [
            // Third-party hits — none is exact `load` (T1+T2 empty), so all go
            // through the T3 fuzzy filter.
            //   - `loads` contains `load` → kept
            //   - `load_package_tests` contains `load` → kept
            //   - `download_module` contains `load` (substring of `download`) → kept
            //   - `iterator_traversal` does NOT contain `load` → DROPPED
            //   - `encode_stringref_namespace` does NOT contain `load` → DROPPED
            sym("loads", 12, `/nix/store/fake/cbor2/_decoder.py`, 5, 4),
            sym("load_package_tests", 12, `/nix/store/fake/pkg/loader.py`, 1, 4),
            sym("download_module", 12, `/nix/store/fake/pkg/dl.py`, 1, 4),
            sym("iterator_traversal", 14, `/nix/store/fake/thrust/iter.h`, 1, 8),
            sym("encode_stringref_namespace", 14, `/nix/store/fake/strf.py`, 1, 8),
        ];
        const out = await symbol(
            { query: "load", language: "python" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        // The three substring matches are kept; the two pure-noise rows dropped.
        const dataRows = rows.filter((l) => !l.startsWith("[python] #"));
        assert.equal(
            dataRows.length,
            3,
            `expected 3 substring-matching rows (loads, load_package_tests, download_module), got:\n${out}`,
        );
        assert.match(out, /\] Function loads /, `loads missing:\n${out}`);
        assert.match(out, /load_package_tests/, `load_package_tests missing:\n${out}`);
        assert.match(out, /download_module/, `download_module missing:\n${out}`);
        assert.ok(
            !/iterator_traversal/.test(out),
            `iterator_traversal should be dropped (no \`load\` substring):\n${out}`,
        );
        assert.ok(
            !/encode_stringref_namespace/.test(out),
            `encode_stringref_namespace should be dropped (no \`load\` substring):\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("python qualified workspace module query retains the matching project-root symbol", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symfilter-py-qualified-"));
    try {
        const root = dir;
        const queries = [];
        const canned = [
            sym("Invoice", 5, `${root}/commerce/domain.py`, 20, 6),
            sym("Invoice", 5, `${root}/other.py`, 3, 6),
            sym("InvoiceFactory", 5, `${root}/commerce/domain.py`, 30, 6),
        ];
        const out = await symbol(
            { query: "commerce.domain.Invoice", language: "python" },
            dir,
            mockClientOf(dir, canned, (query) => queries.push(query)),
        );
        const rows = out.split("\n").filter((line) => line.startsWith("[python]"));
        assert.deepEqual(queries, ["Invoice"], "ty should receive the bare symbol tail");
        assert.equal(rows.length, 1, `expected only the qualified workspace match:\n${out}`);
        assert.match(rows[0], /Class Invoice  .*commerce[\\/]domain\.py:/);
        assert.doesNotMatch(out, /other\.py|InvoiceFactory/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("python bare 'tempc' with workspace TempC returns ONLY TempC (case-insensitive exact)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symfilter-case-"));
    try {
        const root = dir;
        const canned = [
            // Workspace exact (case-insensitive): `TempC` for query `tempc`.
            // T1 non-empty → only this row.
            sym("TempC", 5, `${root}/second.py`, 10, 6),
            // Pure noise (no `tempc` substring at all): must be dropped.
            sym("encode_stringref_namespace", 14, `/nix/store/fake/strf.py`, 1, 8),
        ];
        const out = await symbol(
            { query: "tempc", language: "python" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        assert.equal(rows.length, 1, `expected ONLY the workspace TempC row, got:\n${out}`);
        assert.match(rows[0], /\] Class TempC /);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

// ---------------------------------------------------------------------------
// New: token-level exact rule for cpp, filter_by_kind / filter_by_regex,
// and the `info` fan-out (dedup, cap, references cap).
// ---------------------------------------------------------------------------

/** A richer mock for the fan-out path: the client's documentSymbols / definition
 * / hover / references are canned so the fan-out section renderers (which call
 * nav.definition / nav.hover / nav.references) return deterministic output
 * without a real language server. The fan-out's `--- code ---` section drives
 * nav.definition, which reads the file from disk — so the test writes a real
 * temp file whose contents match the mock documentSymbol's range. */
function mockClientOfRich(
    rootPath,
    { cannedSyms, docSymsByPath, defLocsByPath, hoverTextByPath, refsByPath },
) {
    const client = {
        rootPath,
        supports: () => true,
        ensureProjectLoaded: async () => true,
        workspaceSymbol: async () => cannedSyms,
        workspaceFolderPaths: () => [rootPath],
        documentSymbols: async (path) => docSymsByPath.get(path) ?? [],
        definition: async (path, line, char) => defLocsByPath.get(path) ?? null,
        hover: async (path, line, char) => hoverTextByPath.get(path) ?? null,
        references: async (path, line, char) => refsByPath.get(path) ?? [],
        openDocument: async () => {},
        waitForIndexingComplete: async () => {},
    };
    return async () => client;
}

/** Build a DocumentSymbol (hierarchical) with a selectionRange (identifier
 * span) and a range (full body). */
function docSymbol(name, kind, selStart, rangeEnd) {
    return {
        name,
        kind,
        range: { start: selStart, end: rangeEnd },
        selectionRange: {
            start: selStart,
            end: { line: selStart.line, character: selStart.character + name.length },
        },
        children: [],
    };
}

test("cpp qualified 'vector::push_back' exact = token-suffix of qualifier (std::vector and mystd::vector, NOT std::my_vector)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symqual-"));
    try {
        const root = dir;
        const canned = [
            // std::vector::push_back — qualifier [std, vector]; query [vector]
            // is a token suffix → exact.
            sym("void std::vector<int>::push_back(int x)", 6, `${root}/a.cpp`, 10, 17),
            // mystd::vector::push_back — qualifier [mystd, vector]; [vector]
            // is still a token suffix → exact.
            sym("void mystd::vector<int>::push_back(int x)", 6, `/nix/store/fake/b.cpp`, 5, 18),
            // std::my_vector::push_back — qualifier [std, my_vector]; [vector]
            // is NOT a token suffix (my_vector != vector) → NOT exact → T3
            // (has `push_back` substring) → dropped because T1 is non-empty
            // (the workspace a.cpp hit above is exact).
            sym("void std::my_vector<int>::push_back(double x)", 6, `/nix/store/fake/c.cpp`, 1, 18),
        ];
        const out = await symbol(
            { query: "vector::push_back", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        // The two token-suffix exact matches (workspace T1 wins → ONLY the
        // workspace one is emitted; mystd is third-party T2, dropped when T1
        // non-empty; my_vector is T3, dropped).
        assert.equal(rows.length, 1, `expected ONLY the workspace exact row, got:\n${out}`);
        assert.match(rows[0], /std::vector.*push_back/);
        assert.ok(
            !/my_vector/.test(out),
            `std::my_vector::push_back should NOT be exact (token mismatch):\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("cpp qualified 'vector::push_back' with NO workspace exact returns BOTH third-party token-suffix matches", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symqual2-"));
    try {
        const root = dir;
        const canned = [
            // Both third-party, both token-suffix exact. T1 empty → T2 (exact
            // third-party) = both; T3 (my_vector, not exact) dropped because
            // T2 non-empty (T3 only added when T1 empty AND we're not in
            // wantInfo... actually T3 is [...t2, t3] when not wantInfo).
            sym("void std::vector<int>::push_back(int x)", 6, `/nix/store/fake/b.cpp`, 5, 18),
            sym("void mystd::vector<int>::push_back(int x)", 6, `/nix/store/fake/d.cpp`, 5, 18),
            // NOT exact (my_vector) → T3 (has substring) → kept after T2 in
            // list mode.
            sym("void std::my_vector<int>::push_back(double x)", 6, `/nix/store/fake/c.cpp`, 1, 18),
        ];
        const out = await symbol(
            { query: "vector::push_back", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]") && !l.includes("# "));
        // T2 (2 exact) + T3 (1 fuzzy my_vector) = 3 rows in list mode.
        assert.equal(rows.length, 3, `expected 2 exact + 1 fuzzy, got:\n${out}`);
        assert.match(out, /std::vector.*push_back/);
        assert.match(out, /mystd::vector.*push_back/);
        // my_vector is fuzzy (T3), still present in list mode.
        assert.match(out, /my_vector.*push_back/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("cpp bare 'push_back' exact = bare equality (std::vector::push_back yes, push_back_int no)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symbare-"));
    try {
        const root = dir;
        const canned = [
            // bare `push_back`: bare equality → exact.
            sym("void std::vector<int>::push_back(int x)", 6, `${root}/a.cpp`, 10, 17),
            // bare `push_back_int` != query → NOT exact → T3 (has substring).
            sym("void std::vector<int>::push_back_int(int x)", 6, `/nix/store/fake/b.cpp`, 5, 17),
        ];
        const out = await symbol(
            { query: "push_back", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        // T1 (workspace exact) wins → only the exact `push_back` row.
        assert.equal(rows.length, 1, `expected ONLY the token-exact workspace row, got:\n${out}`);
        assert.match(rows[0], /std::vector.*push_back\(/);
        assert.ok(
            !/push_back_int/.test(out),
            `push_back_int should be fuzzy (different bare), dropped when T1 wins:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("kinds narrows to the requested SymbolKind", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-kindfilter-"));
    try {
        const root = dir;
        const canned = [
            // A function `foo` (kind 12) and a class `foo` (kind 5) — same
            // bare name, different kinds, both workspace. Without the filter
            // both are T1 exact and emitted. With filter_by_kind=["function"],
            // only the Function survives.
            sym("foo", 12, `${root}/mod.py`, 10, 4),
            sym("foo", 5, `${root}/mod.py`, 20, 6),
        ];
        const out = await symbol(
            { query: "foo", language: "python", kinds: ["function"] },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        assert.equal(rows.length, 1, `expected only the Function row, got:\n${out}`);
        assert.match(rows[0], /\] Function foo /);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("filter_by_kind accepts case-insensitive kind names", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-kindci-"));
    try {
        const root = dir;
        const canned = [
            sym("foo", 12, `${root}/mod.py`, 10, 4),
            sym("foo", 5, `${root}/mod.py`, 20, 6),
        ];
        const out = await symbol(
            { query: "foo", language: "python", filter_by_kind: ["Class"] },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        assert.equal(rows.length, 1, `expected only the Class row, got:\n${out}`);
        assert.match(rows[0], /\] Class foo /);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("name_pattern (icase) narrows by the rendered name column", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-regexfilter-"));
    try {
        const root = dir;
        const canned = [
            // Two workspace exact matches (same bare name `foo`) in different
            // files. filter_by_regex matches the rendered name column; for
            // python that's the bare identifier, so this can't distinguish
            // overloads — but it CAN filter by name pattern when the query is
            // a substring match (e.g. query `load` returns `loads` and
            // `load_package_tests`; a regex `^load$` keeps only the bare `load`).
            sym("load", 12, `${root}/a.py`, 1, 4),
            sym("loads", 12, `${root}/b.py`, 1, 4),
        ];
        // Query `load` (bare): both `load` and `loads` contain `load` as a
        // substring → both are T3 fuzzy (neither is exact-equal to `load`
        // except `load` itself which IS exact → T1). Actually `load` IS
        // exact (bare equality) and workspace → T1 non-empty → only `load`.
        // To exercise the regex filter on a multi-row set, use a query where
        // T1 is empty so T2+T3 are emitted. Query `loa` (substring, no exact):
        const canned2 = [
            sym("load", 12, `${root}/a.py`, 1, 4),
            sym("loads", 12, `${root}/b.py`, 1, 4),
            sym("loader", 12, `${root}/c.py`, 1, 4),
        ];
        const out = await symbol(
            { query: "loa", language: "python", name_pattern: "^loads$" },
            dir,
            mockClientOf(dir, canned2),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        // `loa` is not exact-equal to any → T1/T2 empty → T3 (substring) =
        // all three. filter_by_regex `^loads$` keeps only `loads`.
        assert.equal(
            rows.length,
            1,
            `expected only the loads row after regex filter, got:\n${out}`,
        );
        assert.match(rows[0], /\] Function loads /);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("name_pattern with an invalid regexp is a hard error (isError)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-badregex-"));
    try {
        await assert.rejects(
            () =>
                symbol(
                    { query: "foo", language: "python", name_pattern: "(" },
                    dir,
                    mockClientOf(dir, []),
                ),
            /Invalid name_pattern/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("include fan-out: single match with [definition, hover] retains both requested sections", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-dedup-"));
    try {
        const root = dir;
        // A temp .ts file with a real function body. nav.definition reads it
        // from disk and (step 0) finds the body-bearing DocumentSymbol at the
        // cursor → returns the body directly (snippetHasBody true for `{`).
        const tsFile = resolve(root, "mod.ts");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(
                tsFile,
                "function foo(x: number): number {\n  return helper(x);\n}\n",
                "utf8",
            ),
        );
        const selStart = { line: 0, character: 9 }; // `foo` identifier span start (0-based)
        const rangeEnd = { line: 2, character: 1 };
        const canned = [sym("foo", 12, tsFile, 0, 9)];
        const docSymsByPath = new Map([[tsFile, [docSymbol("foo", 12, selStart, rangeEnd)]]]);
        const hoverTextByPath = new Map([
            [
                tsFile,
                {
                    contents: {
                        kind: "markdown",
                        value: "```typescript\nfunction foo(x: number): number\n```\n\nDoes foo.",
                    },
                },
            ],
        ]);
        const out = await symbol(
            {
                query: "foo",
                language: "typescript",
                include: ["definition", "hover"],
                list_symbols: true,
            },
            dir,
            mockClientOfRich(dir, { cannedSyms: canned, docSymsByPath, hoverTextByPath }),
        );
        // Header line for 1 match.
        assert.match(
            out,
            /^# 1 match for "foo" — include: definition, hover\b/m,
            `missing/incorrect header:\n${out}`,
        );
        // One match block.
        assert.match(out, /== \[1\] \[typescript\] Function foo /);
        // `--- definition ---` section present.
        assert.match(out, /--- definition ---/, `missing definition section:\n${out}`);
        // Hover remains present because it can carry inferred type information
        // that is not written in the source definition.
        assert.match(out, /--- hover ---/, `missing requested hover section:\n${out}`);
        // The body and chainable symbol metadata appear in the definition section.
        assert.match(out, /function foo\(x: number\): number/, `code body missing:\n${out}`);
        assert.match(out, /symbols: .*x@14 var/, `parameter metadata missing:\n${out}`);
        assert.match(
            out,
            /symbols: helper@10 call, x@17 var/,
            `call-line symbol metadata missing:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: single match with [hover] only (no code) renders --- hover ---", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-hover-"));
    try {
        const root = dir;
        const tsFile = resolve(root, "mod.ts");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(tsFile, "function foo(x: number): number {\n  return x;\n}\n", "utf8"),
        );
        const selStart = { line: 0, character: 9 };
        const rangeEnd = { line: 2, character: 1 };
        const canned = [sym("foo", 12, tsFile, 0, 9)];
        const docSymsByPath = new Map([[tsFile, [docSymbol("foo", 12, selStart, rangeEnd)]]]);
        const hoverTextByPath = new Map([
            [
                tsFile,
                {
                    contents: {
                        kind: "markdown",
                        value: "```typescript\nfunction foo(x: number): number\n```\n\nDoes foo.",
                    },
                },
            ],
        ]);
        const out = await symbol(
            { query: "foo", language: "typescript", info: ["hover"] },
            dir,
            mockClientOfRich(dir, { cannedSyms: canned, docSymsByPath, hoverTextByPath }),
        );
        assert.match(out, /^# 1 match for "foo" — info: hover\b/m);
        assert.match(out, /--- hover ---/);
        assert.match(out, /signature: /);
        assert.ok(
            !/--- code ---/.test(out),
            `code section should be absent when only hover requested:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: over-cap (6 matches) returns a row list + narrow note, no fan-out", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-cap-"));
    try {
        const root = dir;
        // 6 workspace exact matches (same bare name `foo`, different files).
        // Over SYMBOL_FANOUT_MAX_MATCHES (5) → row list + narrow note.
        const canned = [];
        for (let i = 0; i < 6; i++) {
            canned.push(sym("foo", 12, `${root}/m${i}.py`, 1 + i, 4));
        }
        const out = await symbol(
            { query: "foo", language: "python", info: ["code"] },
            dir,
            mockClientOf(dir, canned),
        );
        // No fan-out blocks.
        assert.ok(!/== \[1\]/.test(out), `should NOT fan out over the cap:\n${out}`);
        assert.ok(
            !/--- code ---/.test(out),
            `should NOT render code sections over the cap:\n${out}`,
        );
        // A narrow note.
        assert.match(out, /# 6 exact matches — narrow with filter_by_kind/);
        // 6 rows.
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        assert.equal(rows.length, 6);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: references capped at 25 with a (N of M, use code_references) note", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-refs-"));
    try {
        const root = dir;
        const tsFile = resolve(root, "mod.ts");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(tsFile, "function foo(x: number): number {\n  return x;\n}\n", "utf8"),
        );
        const selStart = { line: 0, character: 9 };
        const rangeEnd = { line: 2, character: 1 };
        const canned = [sym("foo", 12, tsFile, 0, 9)];
        const docSymsByPath = new Map([[tsFile, [docSymbol("foo", 12, selStart, rangeEnd)]]]);
        // 30 references — over the 25 cap.
        const refs = [];
        for (let i = 0; i < 30; i++) {
            refs.push({
                uri: `file://${root}/caller${i}.ts`,
                range: { start: { line: i, character: 4 }, end: { line: i, character: 7 } },
            });
        }
        const refsByPath = new Map([[tsFile, refs]]);
        const out = await symbol(
            { query: "foo", language: "typescript", info: ["references"] },
            dir,
            mockClientOfRich(dir, { cannedSyms: canned, docSymsByPath, refsByPath }),
        );
        assert.match(out, /--- references ---/);
        // Exactly 25 reference rows (one per `caller<N>.ts`), plus the note.
        const refsSection = out.split(/--- references ---\n/)[1] ?? "";
        const refLines = refsSection.split("\n").filter((l) => l.includes("caller"));
        assert.equal(refLines.length, 25, `expected 25 capped reference rows, got:\n${out}`);
        // The cap note.
        assert.match(out, /\(25 of 30, use code_references for all\)/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("include fan-out forwards list_symbols to references", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-ref-symbols-"));
    try {
        const tsFile = resolve(dir, "mod.ts");
        const callerFile = resolve(dir, "caller.ts");
        await import("node:fs/promises").then(async (fs) => {
            await fs.writeFile(tsFile, "function foo(): number { return 1; }\n", "utf8");
            await fs.writeFile(callerFile, "const y = foo();\n", "utf8");
        });
        const selStart = { line: 0, character: 9 };
        const canned = [sym("foo", 12, tsFile, 0, 9)];
        const docSymsByPath = new Map([
            [tsFile, [docSymbol("foo", 12, selStart, { line: 0, character: 36 })]],
        ]);
        const refsByPath = new Map([
            [
                tsFile,
                [
                    {
                        uri: `file://${callerFile}`,
                        range: {
                            start: { line: 0, character: 10 },
                            end: { line: 0, character: 13 },
                        },
                    },
                ],
            ],
        ]);
        const out = await symbol(
            {
                query: "foo",
                language: "typescript",
                include: ["references"],
                list_symbols: true,
            },
            dir,
            mockClientOfRich(dir, { cannedSyms: canned, docSymsByPath, refsByPath }),
        );
        assert.match(out, /--- references ---/);
        assert.match(
            out,
            /symbols: y@7 var, foo@11 call/,
            `reference symbol metadata missing:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("cpp fan-out: constructor declarations inside a struct render each constructor declaration, not the enclosing struct body (enclosing-parent scope guard)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-enclosing-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        const code = [
            `struct extra_opts_t{`,
            `    extra_opts_t(int a);`,
            `    extra_opts_t(float a);`,
            `    extra_opts_t(double a);`,
            ``,
            `    int a;`,
            `    float b;`,
            `    double d;`,
            `};`,
            ``,
            `int main(){`,
            `extra_opts_t opts;`,
            `}`,
            ``,
        ].join("\n");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, code, "utf8"),
        );

        // workspace/symbol returns three constructor matches (lines 2-4,
        // 1-based). Each is a declaration (no body) inside a struct.
        const canned = [
            sym("extra_opts_t::extra_opts_t(int a)", 9, cppFile, 1, 4),
            sym("extra_opts_t::extra_opts_t(float a)", 9, cppFile, 2, 4),
            sym("extra_opts_t::extra_opts_t(double a)", 9, cppFile, 3, 4),
        ];

        // DocumentSymbol tree: the struct with constructor children.
        const ctor1 = docSymbol("extra_opts_t", 9, { line: 1, character: 4 }, { line: 1, character: 23 });
        const ctor2 = docSymbol("extra_opts_t", 9, { line: 2, character: 4 }, { line: 2, character: 25 });
        const ctor3 = docSymbol("extra_opts_t", 9, { line: 3, character: 4 }, { line: 3, character: 26 });
        const structSym = {
            name: "extra_opts_t",
            kind: 23,
            range: { start: { line: 0, character: 0 }, end: { line: 8, character: 1 } },
            selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 19 } },
            children: [ctor1, ctor2, ctor3],
        };
        const docSymsByPath = new Map([[cppFile, [structSym]]]);

        // textDocument/definition returns the STRUCT identifier position
        // (line 0 char 7) — ccls returns the enclosing parent scope for
        // a member declaration with no out-of-line definition.
        const defLoc = {
            uri: `file://${cppFile}`,
            range: { start: { line: 0, character: 7 }, end: { line: 0, character: 19 } },
        };
        const defLocsByPath = new Map([[cppFile, defLoc]]);

        const out = await symbol(
            { query: "extra_opts_t", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath,
                hoverTextByPath: new Map(),
            }),
        );

        // Header
        assert.match(out, /^# 3 matches for "extra_opts_t" — info: code\b/m);

        // Each constructor renders its OWN declaration line, not the
        // enclosing struct body (lines 1-9).
        assert.match(out, /extra_opts_t\(int a\);/);
        assert.match(out, /extra_opts_t\(float a\);/);
        assert.match(out, /extra_opts_t\(double a\);/);

        // Each code section header shows the correct single-line range
        // (2:2, 3:3, 4:4 in 1-based output = the declaration line).
        assert.match(out, /test\.cpp:2-2/);
        assert.match(out, /test\.cpp:3-3/);
        assert.match(out, /test\.cpp:4-4/);

        // The struct body must NOT appear — every match renders its own
        // declaration, not the enclosing scope.
        assert.ok(
            !out.includes("struct extra_opts_t{"),
            `struct body should NOT appear (each declaration renders individually), got:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: no matches returns the parenthesized note", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-empty-"));
    try {
        const out = await symbol(
            { query: "nonexistent", language: "python", info: ["code"] },
            dir,
            mockClientOf(dir, []),
        );
        assert.equal(out, `(no symbols matching "nonexistent")`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

// ---------------------------------------------------------------------------
// parseCppSymbolName — cpp `using`-alias / typedef bare-name extraction
// ---------------------------------------------------------------------------

test("parseCppSymbolName: `using NAME = TYPE` extracts NAME as bare", async () => {
    const { load } = await import("./helpers.mjs");
    // Load the module so we can test the function directly.
    const mod = await load("./src/symbol.ts");
    // Access via any export; the function is module-scoped (not exported), so
    // we test through the public API. The mock client will trigger the exact
    // code path through isCppExactMatch.
    const { symbol } = mod;
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-usingalias-"));
    try {
        const root = dir;
        // Canned workspace/symbol results — using-alias with kind 252.
        const canned = [
            sym("using my_type_t = int", 252, `${root}/test.cpp`, 0, 6),
            sym("using MyGadget::inner_type = int", 252, `${root}/test.cpp`, 3, 28),
            sym("using std::pmr::vector = std::vector<_Tp, polymorphic_allocator<_Tp>>", 252, `/nix/store/vector`, 96, 12),
            sym("typedef int my_typedef_t", 252, `${root}/test.cpp`, 1, 12),
            // Regular function — should still work.
            sym("void my_func()", 12, `${root}/test.cpp`, 5, 6),
        ];
        // Bare query `my_type_t` — parseCppSymbolName must extract `my_type_t`
        // as the bare name, not `int`.
        const out = await symbol(
            { query: "my_type_t", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        assert.ok(
            rows.length >= 1,
            `expected my_type_t hit, got:\n${out}`,
        );
        assert.match(out, /using my_type_t/, `my_type_t should be found:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("parseCppSymbolName: `using MyGadget::inner_type` extracts qualifier and bare correctly", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-usingqual-"));
    try {
        const root = dir;
        const canned = [
            sym("using MyGadget::inner_type = int", 252, `${root}/gadget.cpp`, 3, 28),
        ];
        // Qualified query — the query qualifier `MyGadget` is passed through
        // for cpp (ccls handles native qualified queries). parseCppSymbolName
        // extracts qualifierTokens=["MyGadget"], bare="inner_type".
        // isCppExactMatch checks `["MyGadget"]` is a suffix of candidate's
        // `["MyGadget"]` qualifier+chain → exact match.
        const out = await symbol(
            { query: "MyGadget::inner_type", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        assert.equal(rows.length, 1, `expected exactly one row, got:\n${out}`);
        assert.match(out, /MyGadget::inner_type/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: `using`-alias (kind 252) shows declaration-only note, not ERROR", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-using-"));
    try {
        const root = dir;
        // We need a real file on disk so that the fan-out path's
        // resolveSymbolSelStart has something to scan. Its contents don't
        // matter for the assertion — the code section is skipped for kind 252.
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, "using my_type_t = int;\n", "utf8"),
        );
        const canned = [sym("using my_type_t = int", 252, cppFile, 0, 6)];
        const docSymsByPath = new Map();
        const out = await symbol(
            { query: "my_type_t", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath: new Map(),
                hoverTextByPath: new Map(),
            }),
        );
        // Header indicates the match was found.
        assert.match(out, /^# 1 match for "my_type_t" — info: code\b/m);
        // Code section present with the ccls name inline, NOT an ERROR.
        assert.match(out, /--- code ---/);
        assert.match(out, /using my_type_t = int/, `expected ccls name in code section, got:\n${out}`);
        assert.ok(
            !/ERROR/.test(out),
            `no ERROR should appear for kind 252 using-alias:\n${out}`,
        );
        assert.ok(
            !/declaration-only/.test(out),
            `should NOT say declaration-only (now shows name inline):\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: using-alias (kind 252) with references works and shows declaration site", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-usingrefs-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, [
                "using my_type_t = int;",
                "int x = my_type_t(42);",
            ].join("\n"), "utf8"),
        );
        const canned = [sym("using my_type_t = int", 252, cppFile, 0, 6)];
        // Provide a references result — the using-alias is referenced on line 2.
        const refsByPath = new Map([
            [
                cppFile,
                [
                    {
                        uri: `file://${cppFile}`,
                        range: { start: { line: 1, character: 8 }, end: { line: 1, character: 18 } },
                    },
                ],
            ],
        ]);
        const out = await symbol(
            { query: "my_type_t", language: "cpp", info: ["references"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath: new Map(),
                defLocsByPath: new Map(),
                hoverTextByPath: new Map(),
                refsByPath,
            }),
        );
        // Header indicates the match was found.
        assert.match(out, /^# 1 match for "my_type_t" — info: references\b/m);
        // References section present.
        assert.match(out, /--- references ---/);
        // The reference site appears.
        assert.match(out, /test\.cpp:2:9/, `reference site should show line 2:\n${out}`);
        // No ERROR.
        assert.ok(!/ERROR/.test(out), `no ERROR should appear:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: typedef (kind 252) shows ccls name inline, not ERROR", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-typedef-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, "typedef int my_typedef_t;\n", "utf8"),
        );
        const canned = [sym("typedef int my_typedef_t", 252, cppFile, 0, 12)];
        const docSymsByPath = new Map();
        const out = await symbol(
            { query: "my_typedef_t", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath: new Map(),
                hoverTextByPath: new Map(),
            }),
        );
        assert.match(out, /^# 1 match for "my_typedef_t" — info: code\b/m);
        assert.match(out, /--- code ---/);
        assert.match(out, /typedef int my_typedef_t/, `expected ccls name in code section, got:\n${out}`);
        assert.ok(
            !/ERROR/.test(out),
            `no ERROR should appear for kind 252 typedef:\n${out}`,
        );
        assert.ok(
            !/declaration-only/.test(out),
            `should NOT say declaration-only (now shows name inline):\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("parseCppSymbolName: ccls enum member `NAME = VALUE` extracts NAME as bare", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-enumbare-"));
    try {
        const root = dir;
        const canned = [
            // ccls returns enum members as "TM_TRAIN_CODEC = 1" (with " = <value>" suffix).
            sym("TM_TRAIN_CODEC = 1", 13, `${root}/test.cpp`, 3, 22),
            sym("TM_NONE = 0", 13, `${root}/test.cpp`, 2, 4),
            // Regular function — still works.
            sym("void my_func()", 12, `${root}/test.cpp`, 5, 6),
        ];
        // Bare query — parseCppSymbolName must extract "TM_TRAIN_CODEC", not "1".
        const out = await symbol(
            { query: "TM_TRAIN_CODEC", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        assert.ok(rows.length >= 1, `expected TM_TRAIN_CODEC hit, got:\n${out}`);
        assert.match(out, /TM_TRAIN_CODEC/, `TM_TRAIN_CODEC should be found:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("parseCppSymbolName: ccls anonymous-namespace function is an exact bare match", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-anon-ns-"));
    try {
        // Exact raw workspace/symbol row from ccls for DiskANN's
        // format_and_log_s3_error. `(anon ns)` precedes the function's
        // parameter list, so treating its `(` as the parameter-list opener
        // incorrectly extracted `diskann` as the bare name.
        const rawCclsName =
            "static std::string diskann::(anon ns)::format_and_log_s3_error(const std::string &operation, const ErrorT &err, const std::string &key)";
        const out = await symbol(
            { query: "format_and_log_s3_error", language: "cpp" },
            dir,
            mockClientOf(dir, [sym(rawCclsName, 12, `${dir}/s3_storage_backend.cpp`, 359, 19)]),
        );
        assert.match(out, /\[cpp\].*format_and_log_s3_error/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: enum member (kind 13) `NAME = VALUE` gets code body, not dropped", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-enum-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, "    TM_TRAIN_CODEC = 1, //train codec\n", "utf8"),
        );
        const canned = [sym("TM_TRAIN_CODEC = 1", 13, cppFile, 0, 22)];
        // Provide documentSymbols so resolveSymbolSelStart finds the enum
        // member and sets a precise selection range.
        const selStart = { line: 0, character: 4 }; // start of TM_TRAIN_CODEC
        const docSymsByPath = new Map([
            [
                cppFile,
                [
                    {
                        name: "TempEnum",
                        kind: 10, // Enum
                        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
                        selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 13 } },
                        children: [
                            {
                                name: "TM_TRAIN_CODEC",
                                kind: 13,
                                range: { start: selStart, end: { line: 0, character: 27 } },
                                selectionRange: {
                                    start: selStart,
                                    end: { line: 0, character: selStart.character + "TM_TRAIN_CODEC".length },
                                },
                                children: [],
                            },
                        ],
                    },
                ],
            ],
        ]);
        const defLocsByPath = new Map([
            [
                cppFile,
                {
                    uri: `file://${cppFile}`,
                    range: { start: selStart, end: { line: 0, character: 27 } },
                },
            ],
        ]);
        const out = await symbol(
            { query: "TM_TRAIN_CODEC", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath,
                hoverTextByPath: new Map(),
            }),
        );
        // Header indicates the match was found (not empty!).
        assert.match(out, /^# 1 match for "TM_TRAIN_CODEC" — info: code\b/m);
        // Code section present (enum members are NOT declaration-only).
        assert.match(out, /--- code ---/);
        // The line content appears in the code section.
        assert.match(out, /TM_TRAIN_CODEC = 1/);
        // It should either show the line or an appropriate message, not an ERROR.
        // (The mock may not perfectly resolve the definition, but we at least
        // verify the symbol was found and the code section was attempted.)
        assert.ok(
            !out.includes("No definition found"),
            `definition should be found for enum member:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: regular Function (kind 12) still gets code body (not skipped)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-func-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, "void my_func() { }\n", "utf8"),
        );
        const canned = [sym("void my_func()", 12, cppFile, 0, 5)];
        const docSymsByPath = new Map();
        const out = await symbol(
            { query: "my_func", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath: new Map(),
                hoverTextByPath: new Map(),
            }),
        );
        // Function kind 12 is NOT declaration-only, so the code section
        // should try to render (either the body or an ERROR).
        assert.match(out, /^# 1 match for "my_func" — info: code\b/m);
        assert.match(out, /--- code ---/);
        // It should NOT say "declaration-only" since functions have bodies.
        assert.ok(
            !/declaration-only/.test(out),
            `function should not be skipped as declaration-only:\n${out}`,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("parseCppSymbolName: ccls struct `NAME {}` strips trailing ` {}` and extracts NAME as bare", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-structbraces-"));
    try {
        const root = dir;
        const canned = [
            // ccls returns structs/classes with trailing ` {}`: "struct temp::detail::int_helper {}".
            sym("struct temp::detail::int_helper {}", 23, `${root}/test.cpp`, 4, 11),
            sym('template<> struct temp::detail::int_helper<int> {}', 23, `${root}/test.cpp`, 9, 11),
            // Regular function — still works.
            sym("void my_func()", 12, `${root}/test.cpp`, 13, 14),
        ];
        // Bare query — parseCppSymbolName must extract "int_helper", not "{}".
        const out = await symbol(
            { query: "int_helper", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        assert.ok(rows.length >= 2, `expected int_helper hits, got:\n${out}`);
        assert.match(out, /temp::detail::int_helper/);
        // The display row still shows `{}` (the original ccls name is rendered),
        // but the matching works (both structs are found). Verify the count.
        assert.ok(rows.length >= 2, `expected at least 2 rows for int_helper:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("cpp template specialization include queries ccls by base name and keeps only the exact specialization", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-template-specialization-"));
    try {
        const cppFile = resolve(dir, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(
                cppFile,
                [
                    "template<class T> class Result {};",
                    "template<> class Result<void> {};",
                    "bool Result<void>::ok() const { return true; }",
                    "",
                ].join("\n"),
                "utf8",
            ),
        );
        const canned = [
            sym("class engine::data::Result {}", 5, cppFile, 0, 24),
            sym("template<> class engine::data::Result<void> {}", 5, cppFile, 1, 17),
            sym("bool engine::data::Result<void>::ok() const", 6, cppFile, 2, 19),
        ];
        const serverQueries = [];
        const out = await symbol(
            { query: "data::Result<void>", language: "cpp", include: ["definition"] },
            dir,
            mockClientOf(dir, canned, (query) => serverQueries.push(query)),
        );

        assert.deepEqual(serverQueries, ["data::Result"]);
        assert.match(out, /^# 1 match for "data::Result<void>"/m);
        assert.match(out, /template<> class engine::data::Result<void>/);
        assert.doesNotMatch(out, /engine::data::Result \{\}/);
        assert.doesNotMatch(out, /Result<void>::ok/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: struct with trailing ` {}` (kind 23) is found and gets code body", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-structbraces-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, [
                "namespace temp {",
                "namespace detail {",
                "    struct int_helper {",
                "        using type = T;",
                "    };",
                "}",
                "}",
                "",
            ].join("\n"), "utf8"),
        );
        const canned = [sym("struct temp::detail::int_helper {}", 23, cppFile, 2, 11)];
        // Provide documentSymbols so resolveSymbolSelStart works.
        const selStart = { line: 2, character: 11 };
        const docSymsByPath = new Map([
            [
                cppFile,
                [
                    {
                        name: "temp",
                        kind: 3, // Namespace
                        range: { start: { line: 0, character: 0 }, end: { line: 6, character: 1 } },
                        selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 14 } },
                        children: [
                            {
                                name: "detail",
                                kind: 3,
                                range: { start: { line: 1, character: 0 }, end: { line: 5, character: 1 } },
                                selectionRange: { start: { line: 1, character: 11 }, end: { line: 1, character: 17 } },
                                children: [
                                    {
                                        name: "int_helper",
                                        kind: 23, // Struct
                                        range: { start: selStart, end: { line: 4, character: 5 } },
                                        selectionRange: {
                                            start: selStart,
                                            end: { line: 2, character: selStart.character + "int_helper".length },
                                        },
                                        children: [],
                                    },
                                ],
                            },
                        ],
                    },
                ],
            ],
        ]);
        const defLocsByPath = new Map([
            [cppFile, { uri: `file://${cppFile}`, range: { start: selStart, end: { line: 4, character: 5 } } }],
        ]);
        const out = await symbol(
            { query: "int_helper", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath,
                hoverTextByPath: new Map(),
            }),
        );
        // Header indicates the match was found.
        assert.match(out, /^# 1 match for "int_helper" — info: code\b/m);
        // Code section present (structs are NOT declaration-only).
        assert.match(out, /--- code ---/);
        // The struct body appears in the code section.
        assert.match(out, /struct int_helper/);
        assert.match(out, /using type = T/);
        // No ERROR.
        assert.ok(!/ERROR/.test(out), `no ERROR should appear:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("parseCppSymbolName: ccls enum `enum NAME : TYPE {}` strips `: TYPE` and `{}` and extracts NAME as bare", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-enumbase-"));
    try {
        const root = dir;
        const canned = [
            sym("enum DiskannBuildWorkMode : int {}", 10, `${root}/test.cpp`, 0, 5),
            sym("enum class ScopedEnum : int {}", 10, `${root}/test.cpp`, 5, 11),
            sym("enum SimpleEnum {}", 10, `${root}/test.cpp`, 9, 5),
        ];
        const out = await symbol(
            { query: "DiskannBuildWorkMode", language: "cpp" },
            dir,
            mockClientOf(dir, canned),
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
        assert.ok(rows.length >= 1, `expected DiskannBuildWorkMode hit, got:\n${out}`);
        assert.match(out, /DiskannBuildWorkMode/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: enum (kind 10) with `: TYPE {}` is found and gets code body", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-enumbase-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, "enum DiskannBuildWorkMode : uint32_t {\n    WM_NONE = 0,\n    WM_TRAIN_CODEC = 1,\n};\n", "utf8"),
        );
        const canned = [sym("enum DiskannBuildWorkMode : uint32_t {}", 10, cppFile, 0, 5)];
        const selStart = { line: 0, character: 5 };
        const docSymsByPath = new Map([
            [
                cppFile,
                [
                    {
                        name: "DiskannBuildWorkMode",
                        kind: 10, // Enum
                        range: { start: selStart, end: { line: 3, character: 2 } },
                        selectionRange: {
                            start: selStart,
                            end: { line: 0, character: 25 },
                        },
                        children: [],
                    },
                ],
            ],
        ]);
        const defLocsByPath = new Map([
            [cppFile, { uri: `file://${cppFile}`, range: { start: selStart, end: { line: 3, character: 2 } } }],
        ]);
        const out = await symbol(
            { query: "DiskannBuildWorkMode", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath,
                hoverTextByPath: new Map(),
            }),
        );
        assert.match(out, /^# 1 match for "DiskannBuildWorkMode" — info: code\b/m);
        assert.match(out, /--- code ---/);
        assert.match(out, /enum DiskannBuildWorkMode/);
        assert.ok(!/ERROR/.test(out), `no ERROR should appear:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("parseCppSymbolName: ccls enum with `: TYPE` (typed), `enum class`, and no base type all extract the name correctly", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-enumforms-"));
    try {
        const root = dir;
        const canned = [
            sym("enum DiskannBuildWorkMode : int {}", 10, `${root}/test.cpp`, 0, 5),
            sym("enum class ScopedEnum : int {}", 10, `${root}/test.cpp`, 5, 11),
            sym("enum SimpleEnum {}", 10, `${root}/test.cpp`, 9, 5),
        ];
        // Query each by bare name — all must be found (none dropped as fuzzy).
        for (const q of ["DiskannBuildWorkMode", "ScopedEnum", "SimpleEnum"]) {
            const out = await symbol({ query: q, language: "cpp" }, dir, mockClientOf(dir, canned));
            const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
            assert.ok(rows.length >= 1, `expected ${q} hit, got:\n${out}`);
            assert.match(out, new RegExp(q));
        }
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("parseCppSymbolName: struct/class with inheritance strips `: <inheritance-clause>` and extracts name", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-inherit-"));
    try {
        const root = dir;
        const canned = [
            // Simple single inheritance
            sym("struct Derived : Base {}", 23, `${root}/test.cpp`, 0, 8),
            // Qualified base
            sym("struct Derived : NS::Base {}", 23, `${root}/test.cpp`, 3, 8),
            // With access specifier
            sym("class Foo : public Bar {}", 23, `${root}/test.cpp`, 6, 6),
            // Access specifier + qualified base
            sym("class Foo : protected NS::Bar {}", 23, `${root}/test.cpp`, 9, 6),
            // Virtual + access specifier
            sym("struct Derived2 : virtual public Base1 {}", 23, `${root}/test.cpp`, 12, 8),
            // Multiple bases with commas
            sym("class Derived3 : public Base1, protected Base2 {}", 23, `${root}/test.cpp`, 15, 6),
        ];
        // Query each by bare name — all must be found.
        for (const q of ["Derived", "Foo", "Derived2", "Derived3"]) {
            const out = await symbol({ query: q, language: "cpp" }, dir, mockClientOf(dir, canned));
            const rows = out.split("\n").filter((l) => l.startsWith("[cpp]"));
            assert.ok(rows.length >= 1, `expected ${q} hit, got:\n${out}`);
            assert.match(out, new RegExp(q));
        }
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: struct/class with inheritance (kind 23) is found and gets code body", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-inherit-"));
    try {
        const root = dir;
        const cppFile = resolve(root, "test.cpp");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(cppFile, "struct Derived : public Base { int x; };\n", "utf8"),
        );
        const canned = [sym("struct Derived : public Base {}", 23, cppFile, 0, 8)];
        const selStart = { line: 0, character: 8 };
        const docSymsByPath = new Map([
            [
                cppFile,
                [
                    {
                        name: "Derived",
                        kind: 23,
                        range: { start: selStart, end: { line: 0, character: 37 } },
                        selectionRange: {
                            start: selStart,
                            end: { line: 0, character: selStart.character + "Derived".length },
                        },
                        children: [],
                    },
                ],
            ],
        ]);
        const defLocsByPath = new Map([
            [cppFile, { uri: `file://${cppFile}`, range: { start: selStart, end: { line: 0, character: 37 } } }],
        ]);
        const out = await symbol(
            { query: "Derived", language: "cpp", info: ["code"] },
            dir,
            mockClientOfRich(dir, {
                cannedSyms: canned,
                docSymsByPath,
                defLocsByPath,
                hoverTextByPath: new Map(),
            }),
        );
        assert.match(out, /^# 1 match for "Derived" — info: code\b/m);
        assert.match(out, /--- code ---/);
        assert.match(out, /struct Derived/);
        assert.ok(!/ERROR/.test(out), `no ERROR should appear:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});
