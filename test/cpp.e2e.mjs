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
// Both properties are asserted here. See docs/outline-constants.md.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
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
