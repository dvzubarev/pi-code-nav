// Per-grammar SyntaxLanguage registry contract (`src/syntax/languages/`).
//
// The registry replaces the shared node-type supersets in
// reference-context.ts / definition-context.ts and the hand-written
// TsLang/tsLangForFile/tsLangToLspLang in runtime.ts. These tests pin:
//   - TsLang is derived from the registry (one key per grammar);
//   - every registered grammar actually ships in tree-sitter-wasm (so
//     getLanguage can load it) — a profile naming a missing grammar is the
//     "silent degradation" this refactor exists to make impossible;
//   - referenceNodes/definitionPolicy sets only name NAMED node types the
//     grammar has (anonymous keyword/punctuation tokens are forbidden);
//   - tsLangForFile / tsLangToLspLang / classifierFor route through profiles.
//
// Load via jiti (same loader as production + the other unit tests). Pure
// tree-sitter + Language.types introspection — no language servers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { load, loadParse } from "./helpers.mjs";

async function loadRegistry() {
    return load("./src/syntax/languages/index.ts");
}

async function languageTypes(grammar) {
    const { getLanguage } = await loadParse();
    const language = await getLanguage(grammar);
    return new Set(language.types);
}

test("TsLang is exactly the registry's grammar keys (5 profiles)", async () => {
    const { SYNTAX_LANGUAGES } = await loadRegistry();
    assert.deepEqual(
        SYNTAX_LANGUAGES.map((l) => l.grammar),
        ["python", "cpp", "bash", "typescript", "tsx"],
    );
});

test("every registered grammar ships in tree-sitter-wasm and is loadable", async () => {
    const { SYNTAX_LANGUAGES } = await loadRegistry();
    for (const profile of SYNTAX_LANGUAGES) {
        const types = await languageTypes(profile.grammar);
        assert.ok(types.size > 0, `${profile.grammar} grammar loaded with node types`);
    }
});

test("every referenceNodes + definitionPolicy node type is named in its grammar", async () => {
    const { SYNTAX_LANGUAGES } = await loadRegistry();
    for (const profile of SYNTAX_LANGUAGES) {
        const { getLanguage } = await loadParse();
        const language = await getLanguage(profile.grammar);
        const allSets = [
            ...Object.values(profile.referenceNodes),
            ...Object.values(profile.definitionPolicy),
        ];
        const anonymousOrMissing = allSets.flatMap((set) =>
            [...set].filter((nodeType) => language.idForNodeType(nodeType, true) === null),
        );
        assert.deepEqual(
            anonymousOrMissing,
            [],
            `${profile.grammar} profile must only name named grammar node types`,
        );
    }
});

test("tsLangForFile and tsLangToLspLang route through profiles", async () => {
    const { tsLangForFile, tsLangToLspLang } = await loadRegistry();
    assert.equal(tsLangForFile("x.py"), "python");
    assert.equal(tsLangForFile("x.pyi"), "python");
    assert.equal(tsLangForFile("x.PYI"), "python");
    assert.equal(tsLangForFile("x.cpp"), "cpp");
    assert.equal(tsLangForFile("x.tsx"), "tsx");
    assert.equal(tsLangForFile("x.jsx"), "tsx");

    assert.equal(tsLangToLspLang("tsx"), "typescript");
    assert.equal(tsLangToLspLang("typescript"), "typescript");
    assert.equal(tsLangToLspLang("python"), "python");
});

test("qualifierSeparator is per-grammar (cpp '::', others '.')", async () => {
    const { SYNTAX_LANGUAGES } = await loadRegistry();
    const byGrammar = new Map(SYNTAX_LANGUAGES.map((l) => [l.grammar, l]));
    assert.equal(byGrammar.get("cpp").qualifierSeparator, "::");
    for (const lang of ["python", "bash", "typescript", "tsx"]) {
        assert.equal(byGrammar.get(lang).qualifierSeparator, ".");
    }
});

test("classifierFor returns each profile's classifyRole", async () => {
    const { SYNTAX_LANGUAGES, classifierFor } = await loadRegistry();
    for (const l of SYNTAX_LANGUAGES) {
        assert.equal(classifierFor(l.grammar), l.classifyRole);
    }
});

test("cpp attributes are not member-access or expression context", async () => {
    const { syntaxLanguage } = await loadRegistry();
    const nodes = syntaxLanguage("cpp").referenceNodes;
    assert.equal(nodes.member.has("attribute"), false);
    assert.equal(nodes.expression.has("attribute"), false);
});

test("only the cpp profile names broad declaration types for the function check", async () => {
    const { SYNTAX_LANGUAGES } = await loadRegistry();
    const byGrammar = new Map(SYNTAX_LANGUAGES.map((l) => [l.grammar, l]));
    const cppCheck = byGrammar.get("cpp").definitionPolicy.functionDeclarationCheck;
    assert.deepEqual([...cppCheck].sort(), ["declaration", "field_declaration"]);
    for (const lang of ["python", "bash", "typescript", "tsx"]) {
        assert.equal(byGrammar.get(lang).definitionPolicy.functionDeclarationCheck.size, 0);
    }
});
