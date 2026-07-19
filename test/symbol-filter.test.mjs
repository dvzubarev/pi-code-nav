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

test("cpp bare 'occlude_list' drops fuzzy rows with no shared substring", async () => {
    const { symbol } = await load("./nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-symfilter-cpp-"));
    try {
        // Canned ccls results for query `occlude_list`. cpp `name` is a
        // full C++ qualified signature.
        //   - rows 1-3: contain `occlude_list` as a substring → kept
        //   - rows 4-5: the thrust::iterator_* noise that motivated the fix
        //     (no `occlude_list` substring at all) → must be dropped
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
        // Exactly the three substring-matching rows; the two thrust rows
        // (no `occlude_list` substring) must be dropped.
        assert.equal(
            rows.length,
            3,
            `expected 3 substring-matching rows, got:\n${out}`,
        );
        // The thrust::iterator_* noise must NOT appear.
        assert.ok(
            !/thrust::iterator_/.test(out),
            `thrust::iterator_* noise should be dropped, but appeared in:\n${out}`,
        );
        // The good rows ARE present.
        assert.match(out, /Index::occlude_list/, `Index::occlude_list missing:\n${out}`);
        assert.match(out, /occlude_list_output/, `occlude_list_output missing:\n${out}`);
        assert.match(out, /_occlude_list_output/, `_occlude_list_output missing:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("cpp bare query: T1 (workspace exact) wins, fuzzy tail dropped entirely", async () => {
    const { symbol } = await load("./nav.ts");
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
    const { symbol } = await load("./nav.ts");
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
    const { symbol } = await load("./nav.ts");
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
