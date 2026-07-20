// End-to-end tests for the C++ language server (ccls), via nav.*.
//
// These call the SAME nav.* functions index.ts uses, against a real ccls
// server and a real fixture file — verifying the full pipeline (nav →
// LspClient → ccls → render.ts → text). Skipped when CODE_NAV_SKIP_E2E is
// set or ccls isn't on PATH.
//
// ccls uniquely populates DocumentSymbol.detail with declaration/signature
// strings (e.g. "int main()", "void Widget::method()"), so:
// code_outline shows an annotated structural overview (detail
// rendered inline as the signature fallback when hover yields no signature).
// Only structural kinds are kept; constants/variables/fields are dropped.
// See docs/code_outline.md.
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

runOrSkip("code_outline on a .cpp file shows ccls detail signatures + body ranges", async () => {
    // ccls populates DocumentSymbol.detail with the signature. code_outline
    // now hovers every row for signature+docs, but signatureFor falls back to
    // detail when the hover yields no signature — so the ccls declarations
    // still appear. Only structural kinds are kept.
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
        // MAX and field dropped by allowlist.
        assert.ok(!/MAX/.test(out), `MAX should be dropped:\n${out}`);
        assert.ok(!/Field field/.test(out), `field should be dropped:\n${out}`);
        // Each kept row carries its ccls detail inline AND a body range.
        assert.match(out, /Function main  int main\(\)  :\d+-\d+:\d+/, `main row missing:\n${out}`);
        assert.match(
            out,
            /  Method method  void Widget::method\(\)  :\d+-\d+:\d+/,
            `method row missing:\n${out}`,
        );
        assert.match(out, /Struct Widget  struct Widget \{\}  :\d+-\d+:\d+/, `Widget row missing:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

