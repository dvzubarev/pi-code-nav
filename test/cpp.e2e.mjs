// End-to-end tests for the C++ language server (ccls), via nav.*.
//
// These call the SAME nav.* functions index.ts uses, against a real ccls
// server and a real fixture file — verifying the full pipeline (nav →
// LspClient → ccls → render.ts → text). Skipped when CODE_NAV_SKIP_E2E is
// set or ccls isn't on PATH.
//
// ccls uniquely populates DocumentSymbol.detail with declaration/signature
// strings (e.g. "int main()", "void Widget::method()"), so:
//   - code_outline shows an annotated structural overview for free (detail
//     rendered inline, no hover round-trips).
//   - code_tree uses detail directly and skips the hover for rows that have
//     it (no redundant round-trip to duplicate the server's own declaration).
// Both properties are asserted here. See docs/code_outline.md.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";

const skip = !SHOULD_RUN_E2E;
const cppOk = SHOULD_RUN_E2E ? await serverAvailable("cpp") : false;
const runOrSkip = (name, fn) => (skip || !cppOk ? test.skip(name, fn) : test(name, fn));

runOrSkip("code_outline on a .cpp file shows ccls detail signatures", async () => {
    // ccls populates DocumentSymbol.detail with the declaration/signature, and
    // renderDocSymbol renders it inline after the name. This is the
    // "include details by default" property: no extra LSP hover round-trips are
    // needed to get a signature line for C++ (unlike tsserver/ty, which leave
    // detail empty). Only structural kinds are kept; the Variable MAX (constexpr)
    // is dropped by the allowlist.
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "sample.cpp");
        await writeFile(
            file,
            [
                `constexpr int MAX = 64;`,
                `struct Widget {`,
                `  int field;`,
                `  void method();`,
                `};`,
                `int main() { return 0; }`,
                ``,
            ].join("\n"),
            "utf8",
        );
        const out = await nav.outline({ path: "sample.cpp" }, ws.root, ws.clientOf);
        // The allowlist drops the Variable MAX (constexpr). Confirm it is gone.
        assert.ok(!/MAX/.test(out), `MAX should be dropped (not a structural kind):\n${out}`);
        // The kept rows carry their ccls detail signatures inline.
        assert.match(out, /Function main  int main\(\)/, `main detail missing:\n${out}`);
        assert.match(
            out,
            /Method method  void Widget::method\(\)/,
            `method detail missing:\n${out}`,
        );
        assert.match(out, /Struct Widget  struct Widget \{\}/, `Widget detail missing:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_tree on a .cpp file uses ccls detail (no redundant hover)", async () => {
    // When detail is present (ccls), code_tree uses it directly and does NOT
    // hover — so a matched class shows its members (context) each carrying the
    // ccls declaration, with zero hover round-trips.
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "sample.cpp");
        await writeFile(
            file,
            [
                `constexpr int MAX = 64;`,
                `struct Widget {`,
                `  int field;`,
                `  void method();`,
                `};`,
                `int main() { return 0; }`,
                ``,
            ].join("\n"),
            "utf8",
        );
        const out = await nav.tree({ path: "sample.cpp", pattern: "Widget" }, ws.root, ws.clientOf);
        // Widget matched → its DIRECT children kept as context (DWYM: a
        // struct/class match emits only direct children, not deep locals), each
        // carrying the ccls declaration as detail. ccls fills detail, so no
        // hover round-trips happen here (the hover target filter skips rows
        // with non-empty detail).
        assert.match(out, /Struct Widget  struct Widget \{\}/, `Widget match missing:\n${out}`);
        assert.match(
            out,
            /Field field  int Widget::field/,
            `field (direct child) missing:\n${out}`,
        );
        assert.match(
            out,
            /Method method  void Widget::method\(\)/,
            `method (direct child) missing:\n${out}`,
        );
        // MAX (no match, not under a match) is pruned, and main (no match) too.
        assert.ok(!/MAX/.test(out), `MAX should be pruned:\n${out}`);
        assert.ok(!/Function main/.test(out), `main should be pruned:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

// ---------------------------------------------------------------------------
// code_diagnostics on ccls — the push-fallback + event-driven indexing wait.
// ---------------------------------------------------------------------------
//
// ccls rejects the LSP 3.17 pull model (textDocument/diagnostic -> "unknown
// request"), so code_diagnostics falls back to textDocument/publishDiagnostics.
// ccls publishes push diagnostics for a file only once its translation unit has
// compiled — which on a cold cache happens DURING whole-project indexing (ccls
// reports progress via $/progress begin/report/end on the "index" token).
// The old fixed-budget ~1.2s poll returned NOTHING mid-index and surfaced a
// misleading pull-error; the new flow waits for indexing to complete (event-
// driven via $/progress "end") and then waits event-drivenly for the actual
// publishDiagnostics notification. This reproduces the DiskANN report.

runOrSkip(
    "code_diagnostics on a .cpp file reports an error after whole-project indexing (push fallback)",
    async () => {
        // A TU with an obvious type error. We provide a compile_commands.json
        // so ccls indexes the TU at initialize (cold cache — fresh mkdtemp path),
        // exactly like the DiskANN scenario. The error must show up after the
        // indexing-driven publish, proving the event-driven push wait works.
        const ws = await withWorkspace([]);
        try {
            const root = ws.root;
            const file = resolve(root, "bad.cpp");
            await writeFile(
                file,
                [
                    `int main() {`,
                    `    int x = "not an int";`,
                    `    return x;`,
                    `}`,
                    ``,
                ].join("\n"),
                "utf8",
            );
            await mkdir(resolve(root, "build"), { recursive: true });
            await writeFile(
                resolve(root, "build", "compile_commands.json"),
                JSON.stringify(
                    [
                        {
                            directory: root,
                            command: `clang++ -std=c++17 bad.cpp`,
                            file,
                        },
                    ],
                    null,
                    2,
                ),
                "utf8",
            );

            const out = await nav.diagnostics({ path: "bad.cpp" }, root, ws.clientOf);
            // Must NOT be the misleading pull-error string the old code returned
            // mid-index. ccls doesn't implement the pull model, so the pull
            // request is expected to fail — the tool must reach the push path.
            assert.ok(
                !/textDocument\/diagnostic request failed/.test(out),
                `should not surface the pull error after the push fallback:\n${out}`,
            );
            // ccls (clang) reports the type mismatch. Wording can drift across
            // clang versions, so assert on the error category, not exact text.
            assert.match(
                out,
                /\d+ diagnostic\(s\) for bad\.cpp:/,
                `diagnostic header missing:\n${out}`,
            );
            assert.match(
                out,
                /(?:cannot initialize|no viable conversion|incompatible|not assignable)/i,
                `expected a type-mismatch diagnostic, got:\n${out}`,
            );
        } finally {
            await ws.cleanup();
        }
    },
);

runOrSkip(
    "code_diagnostics on a clean .cpp file reports no diagnostics (push fallback)",
    async () => {
        // A clean TU. After indexing + the event-driven push wait, ccls publishes
        // an empty set, and the tool reports "no diagnostics" — distinguishing a
        // clean file from a silent/broken server.
        const ws = await withWorkspace([]);
        try {
            const root = ws.root;
            const file = resolve(root, "good.cpp");
            await writeFile(
                file,
                [`int main() { return 0; }`, ``].join("\n"),
                "utf8",
            );
            await mkdir(resolve(root, "build"), { recursive: true });
            await writeFile(
                resolve(root, "build", "compile_commands.json"),
                JSON.stringify(
                    [
                        {
                            directory: root,
                            command: `clang++ -std=c++17 good.cpp`,
                            file,
                        },
                    ],
                    null,
                    2,
                ),
                "utf8",
            );

            const out = await nav.diagnostics({ path: "good.cpp" }, root, ws.clientOf);
            assert.match(
                out,
                /no diagnostics for good\.cpp/,
                `expected no diagnostics, got:\n${out}`,
            );
        } finally {
            await ws.cleanup();
        }
    },
);

// ---------------------------------------------------------------------------
// code_definition: the ccls "cursor on a cpp definition" bounce fix.
//
// ccls's textDocument/definition, when the cursor is ON a C++ function
// DEFINITION (out-of-line .cpp member, struct method, template specialization),
// bounces to the header DECLARATION instead of returning the def position.
// The editor "go to definition" does the same — it's a ccls quirk in
// getNonDefDeclarations (textDocument_definition.cc: on_def → returns the
// non-def declarations). This bounce means code_definition would render the
// header prototype, not the cpp body the agent asked for.
//
// Fix (definition() step 0): before calling textDocument/definition, fetch
// documentSymbol for the input file (ccls parses the opened file locally,
// equivalent to tree-sitter — no per-language grammar needed). Find the
// symbol whose selectionRange.start == cursor. If that symbol's source range
// has a body (contains `{`), return it directly and skip textDocument/definition
// entirely → no bounce. Verified against the user's minimal DiskANN-style
// fbin_file reproducer. This test pins that fix: a cold ccls cache, a real
// out-of-line struct method, and the assertion that code_definition returns
// the cpp body — NOT the header declaration.
// ---------------------------------------------------------------------------

runOrSkip(
    "code_definition on a cpp def returns the cpp body (not the header decl)",
    async () => {
        // Minimal reproducer of the ccls bounce: a struct with an out-of-line
        // method. Cursor on the cpp definition's method name must return the
        // cpp body, even though ccls's textDocument/definition bounces to the
        // header declaration.
        const ws = await withWorkspace([]);
        try {
            const root = ws.root;
            const hdr = resolve(root, "fbin_file.h");
            const cpp = resolve(root, "fbin_file.cpp");
            await writeFile(
                hdr,
                [
                    `#pragma once`,
                    ``,
                    `#include <string>`,
                    `#include <cstdint>`,
                    ``,
                    `namespace diskann{`,
                    ``,
                    `struct fbin_file_t{`,
                    `    std::string path;`,
                    `    size_t num_points;`,
                    `    size_t dim;`,
                    ``,
                    `private:`,
                    `    void assign(const fbin_file_t& f);`,
                    `};`,
                    ``,
                    `}  // namespace diskann`,
                    ``,
                ].join("\n"),
                "utf8",
            );
            await writeFile(
                cpp,
                [
                    `#include "fbin_file.h"`,
                    ``,
                    `namespace diskann{`,
                    ``,
                    ``,
                    `void fbin_file_t::assign(const fbin_file_t& f){`,
                    `    path = f.path;`,
                    `}`,
                    ``,
                    `}  // namespace diskann`,
                    ``,
                ].join("\n"),
                "utf8",
            );
            await mkdir(resolve(root, "build"), { recursive: true });
            await writeFile(
                resolve(root, "build", "compile_commands.json"),
                JSON.stringify(
                    [
                        {
                            directory: root,
                            command: `clang++ -std=c++17 -I. fbin_file.cpp`,
                            file: cpp,
                        },
                    ],
                    null,
                    2,
                ),
                "utf8",
            );

            // Cursor on the cpp definition's method name: fbin_file.cpp line 6
            // (1-based), column 19 — the `a` of `assign`. (verified by probing
            // ccls: workspace/symbol and documentSymbol both report the
            // identifier at 0-based 5:18, i.e. 1-based 6:19).
            const out = await nav.definition(
                { path: "fbin_file.cpp", line: 6, column: 19 },
                root,
                ws.clientOf,
            );
            const lines = out.split("\n");
            // The header must point at the cpp body range (starting line 6),
            // NOT the header declaration (which would be fbin_file.h:14).
            assert.match(
                lines[0],
                /(^|\/)fbin_file\.cpp:6-\d+$/,
                `should return the cpp body, not the header declaration:\n${out}`,
            );
            assert.match(out, /void fbin_file_t::assign/, `cpp def line missing:\n${out}`);
            assert.match(out, /path = f\.path/, `cpp body statement missing:\n${out}`);
            // Must NOT contain the header declaration line — that would mean
            // the bounce fired and we rendered the prototype instead.
            assert.ok(
                !/void assign\(const fbin_file_t& f\);/.test(out),
                `should not contain the header declaration (bounce fired?):\n${out}`,
            );
        } finally {
            await ws.cleanup();
        }
    },
);

// code_definition on a call site of a third-party HEADER-ONLY declaration
// must prepend the preceding doc comment. ccls's textDocument/definition
// jumps from the use in the .cpp to the prototype in the (un-indexed)
// header; resolveDefBodyRange narrows the Location to the declaration line,
// and renderSnippetBlock (when the snippet has NO body) extends the snippet
// upward via findEnclosingDefWithDoc to include the preceding `/** ... */` /
// `///` / `//!` doc comment. Without the doc prefix the agent loses the
// docstring for every header-only / stdlib / third-party API it asks about.
//
// This test pins Case B from docs/code_definition.md (LSP-resolved Location
// whose body resolves to a declaration): a .cpp uses a function declared in
// a header NOT in compile_commands.json, the cursor is on the call site in
// the .cpp, and the rendered output must contain BOTH the doc comment AND
// the prototype — with the header line reflecting the expanded (doc + decl)
// line range.
runOrSkip(
    "code_definition on a call site of a header-only decl prepends the doc comment",
    async () => {
        const ws = await withWorkspace([]);
        try {
            const root = ws.root;
            const hdr = resolve(root, "thirdparty.h");
            const cpp = resolve(root, "main.cpp");
            await writeFile(
                hdr,
                [
                    `#pragma once`,
                    ``,
                    `#include <cstdint>`,
                    `#include <vector>`,
                    ``,
                    `/** this is doc string for this function`,
                    ` *  line two of the doc string`,
                    ` *  line three of the doc string`,
                    ` */`,
                    `void thirdparty_func(const uint32_t location, std::vector<int> &pool);`,
                    ``,
                ].join("\n"),
                "utf8",
            );
            await writeFile(
                cpp,
                [
                    `#include "thirdparty.h"`,
                    ``,
                    `int main(){`,
                    `    std::vector<int> v;`,
                    `    thirdparty_func(0u, v);`,
                    `    return 0;`,
                    `}`,
                    ``,
                ].join("\n"),
                "utf8",
            );
            await mkdir(resolve(root, "build"), { recursive: true });
            await writeFile(
                resolve(root, "build", "compile_commands.json"),
                JSON.stringify(
                    [
                        {
                            directory: root,
                            command: `clang++ -std=c++17 -I. main.cpp`,
                            file: cpp,
                        },
                    ],
                    null,
                    2,
                ),
                "utf8",
            );

            // Cursor on the call site: main.cpp line 5 (1-based), column 5 —
            // the `t` of `thirdparty_func`. ccls's textDocument/definition
            // jumps to the header prototype at thirdparty.h line 10 (1-based).
            const out = await nav.definition(
                { path: "main.cpp", line: 5, column: 5 },
                root,
                ws.clientOf,
            );
            const lines = out.split("\n");
            // The header line must point at the third-party header, and its
            // line range must START at the doc comment opener (line 6, 1-based)
            // and END at the prototype (line 10, 1-based) — i.e. the doc prefix
            // was prepended and the reported range was extended upward.
            assert.match(
                lines[0],
                /(^|\/)thirdparty\.h:6-10$/,
                `header line should cover the doc comment + prototype (got:\n${out})`,
            );
            // The doc comment must be present verbatim.
            assert.match(
                out,
                /\/\*\* this is doc string for this function/,
                `doc comment opener missing:\n${out}`,
            );
            assert.match(
                out,
                /line three of the doc string/,
                `doc comment body line missing:\n${out}`,
            );
            // The prototype must still be present.
            assert.match(
                out,
                /void thirdparty_func\(const uint32_t location, std::vector<int> &pool\);/,
                `prototype line missing:\n${out}`,
            );
        } finally {
            await ws.cleanup();
        }
    },
);
