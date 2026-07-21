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
function mockClientOf(rootPath, cannedSyms) {
    const client = {
        rootPath,
        supports: () => true,
        ensureProjectLoaded: async () => true,
        workspaceSymbol: async () => cannedSyms,
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

test("filter_by_kind narrows to the requested SymbolKind", async () => {
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
            { query: "foo", language: "python", filter_by_kind: ["function"] },
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

test("filter_by_regex (icase) narrows by the rendered name column", async () => {
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
            { query: "loa", language: "python", filter_by_regex: "^loads$" },
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

test("filter_by_regex with an invalid regexp is a hard error (isError)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-badregex-"));
    try {
        await assert.rejects(
            () =>
                symbol(
                    { query: "foo", language: "python", filter_by_regex: "(" },
                    dir,
                    mockClientOf(dir, []),
                ),
            /Invalid filter_by_regex/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("info fan-out: single match with [code, hover] dedups hover (only --- code ---)", async () => {
    const { symbol } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-fanout-dedup-"));
    try {
        const root = dir;
        // A temp .ts file with a real function body. nav.definition reads it
        // from disk and (step 0) finds the body-bearing DocumentSymbol at the
        // cursor → returns the body directly (snippetHasBody true for `{`).
        const tsFile = resolve(root, "mod.ts");
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(tsFile, "function foo(x: number): number {\n  return x;\n}\n", "utf8"),
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
            { query: "foo", language: "typescript", info: ["code", "hover"] },
            dir,
            mockClientOfRich(dir, { cannedSyms: canned, docSymsByPath, hoverTextByPath }),
        );
        // Header line for 1 match.
        assert.match(
            out,
            /^# 1 match for "foo" — info: code\b/m,
            `missing/incorrect header:\n${out}`,
        );
        // One match block.
        assert.match(out, /== \[1\] \[typescript\] Function foo /);
        // `--- code ---` section present.
        assert.match(out, /--- code ---/, `missing code section:\n${out}`);
        // `--- hover ---` MUST be absent (deduped because code is present).
        assert.ok(
            !/--- hover ---/.test(out),
            `hover should be deduped when code is present:\n${out}`,
        );
        // The body appears in the code section.
        assert.match(out, /function foo\(x: number\): number/, `code body missing:\n${out}`);
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
