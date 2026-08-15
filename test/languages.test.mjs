// Unit tests for the neutral language catalog (src/languages/catalog.ts).
//
// Pins the routing invariants the catalog exists to guarantee:
//   - ALL_LANGS is the exhaustive member set (adding a language without a
//     registry entry, or an entry the union doesn't know, fails tsc — here we
//     pin the runtime shape).
//   - EXT_LANG and SOURCE_EXTS derive from ONE list, so extension routing and
//     project detection cannot drift (including the .m/.mm → cpp fix).
//   - langForFile matches the LSP routing key, case-insensitively.
//   - ROOT_MARKERS is exhaustive (no language silently lacks a detection tier).
//   - the neutral Lang type does NOT depend on lsp-client.ts (it must type
//     only, or the transport-neutral invariant is broken).
//
// Run:  npm run test:unit -- test/languages.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

async function loadCatalog() {
    return load("./src/languages/catalog.ts");
}

test("ALL_LANGS is the canonical, exhaustive language set", async () => {
    const { ALL_LANGS } = await loadCatalog();
    assert.deepEqual([...ALL_LANGS].sort(), ["bash", "cpp", "python", "typescript"]);
});

test("SOURCE_EXTS and EXT_LANG are exhaustive and mutually consistent", async () => {
    const { ALL_LANGS, SOURCE_EXTS, EXT_LANG } = await loadCatalog();
    // Every language has a non-empty source-extension list.
    for (const lang of ALL_LANGS) {
        assert.ok(Array.isArray(SOURCE_EXTS[lang]), `SOURCE_EXTS missing entry for ${lang}`);
        assert.ok(SOURCE_EXTS[lang].length > 0, `SOURCE_EXTS[${lang}] is empty`);
    }
    // Every EXT_LANG extension maps to a language whose SOURCE_EXTS contains it,
    // and every SOURCE_EXTS extension maps back to the same language in EXT_LANG.
    // This is the "extension routing and project detection cannot drift" invariant.
    for (const [ext, lang] of Object.entries(EXT_LANG)) {
        assert.ok(
            SOURCE_EXTS[lang].includes(ext),
            `EXT_LANG maps ${ext} → ${lang}, but SOURCE_EXTS[${lang}] does not include it`,
        );
    }
    for (const lang of ALL_LANGS) {
        for (const ext of SOURCE_EXTS[lang]) {
            assert.equal(
                EXT_LANG[ext],
                lang,
                `SOURCE_EXTS[${lang}] contains ${ext}, but EXT_LANG maps it to ${EXT_LANG[ext]}`,
            );
        }
    }
});

test(".m and .mm route to cpp in BOTH EXT_LANG and SOURCE_EXTS (the fix)", async () => {
    const { SOURCE_EXTS, EXT_LANG, langForFile } = await loadCatalog();
    // This was the pre-existing inconsistency: EXT_LANG had .m/.mm → cpp, but
    // SOURCE_EXTS.cpp lacked them, so a lone .m file was routable to ccls but
    // invisible to the source-file bootstrap/detection scan.
    assert.equal(EXT_LANG[".m"], "cpp");
    assert.equal(EXT_LANG[".mm"], "cpp");
    assert.ok(SOURCE_EXTS.cpp.includes(".m"), "SOURCE_EXTS.cpp should include .m");
    assert.ok(SOURCE_EXTS.cpp.includes(".mm"), "SOURCE_EXTS.cpp should include .mm");
    assert.equal(langForFile("Thing.m"), "cpp");
    assert.equal(langForFile("Thing.mm"), "cpp");
});

test("langForFile is case-insensitive and returns null for unknown/extensionless", async () => {
    const { langForFile } = await loadCatalog();
    assert.equal(langForFile("app.PY"), "python");
    assert.equal(langForFile("app.TSX"), "typescript");
    assert.equal(langForFile("Makefile"), null);
    assert.equal(langForFile("README"), null);
    assert.equal(langForFile("trailing.dot."), null);
});

test("ROOT_MARKERS is exhaustive for every language (empty allowed)", async () => {
    const { ALL_LANGS, ROOT_MARKERS } = await loadCatalog();
    for (const lang of ALL_LANGS) {
        assert.ok(Array.isArray(ROOT_MARKERS[lang]), `ROOT_MARKERS missing entry for ${lang}`);
        // A language with no reliable root-level project marker is allowed:
        // the source-extension scan is the detection fallback. The registry
        // must still HAVE the key (empty array) so detection is exhaustive.
    }
});

test("DISPLAY_NAMES covers every language", async () => {
    const { ALL_LANGS, DISPLAY_NAMES } = await loadCatalog();
    for (const lang of ALL_LANGS) {
        assert.ok(
            typeof DISPLAY_NAMES[lang] === "string" && DISPLAY_NAMES[lang].length > 0,
            `DISPLAY_NAMES missing/label-less for ${lang}`,
        );
    }
});

test("catalog.ts does not import lsp-client.ts (transport-neutral invariant)", async () => {
    // The neutral catalog must not depend on the transport layer: importing it
    // (via jiti) is fine here, but the SOURCE must not reference lsp-client.
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(
        resolve(dirname(fileURLToPath(import.meta.url)), "../src/languages/catalog.ts"),
        "utf8",
    );
    // The invariant is about IMPORTS: the catalog may name lsp-client.ts in
    // doc comments, but it must not statically depend on the transport layer.
    const importLine = /(?:^|\n)\s*import\b[^\n]*lsp-client/.test(src);
    const reexportLine = /(?:^|\n)\s*export[^\n]*from[^\n]*lsp-client/.test(src);
    assert.ok(
        !importLine && !reexportLine,
        "catalog.ts must not import or re-export lsp-client.ts (transport neutrality)",
    );
});
