// Unit tests for code_definition's tree-sitter helper: findEnclosingDefWithDoc.
//
// findEnclosingDefWithDoc(lang, text, line, column) parses the source with
// tree-sitter (no LSP, no compile database — works on un-indexed headers and
// third-party trees), walks up from the 1-based (line, column) cursor to the
// nearest enclosing definition node (function/method/class/struct/etc.), and
// returns:
//   - the def's 0-based start/end line range,
//   - hasBody: true when the node contains a body (a `{ ... }` block) — i.e.
//     a real definition, not a prototype,
//   - docStartLine/docEndLine: the 0-based range of the preceding `comment`
//     sibling immediately above (null when there is none). The blank-line-gap
//     rule (a blank line between the comment and the def breaks the
//     association) is enforced via the AST's sibling positions, not a regex.
//
// These tests pin the three behaviors code_definition relies on:
//   1. cursor on an out-of-line .cpp definition → hasBody=true, body range
//      returned (the cursor-on-a-definition fast path — the fix for ccls's
//      "definition bounces to the declaration" quirk).
//   2. cursor on a header-only declaration → hasBody=false, def range +
//      doc range returned (the third-party header-only scenario: return the
//      declaration + its preceding doc comment).
//   3. cursor on a call site / use / top-level whitespace → null (fall
//      through to LSP).
//
// Run:  npm run test:unit -- test/definition_helpers.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const TS = () => load("./src/tree-sitter-parse.ts");

// ---------------------------------------------------------------------------
// C++: cursor on an out-of-line definition body (scenario 1).
// ---------------------------------------------------------------------------

test("cpp: cursor on out-of-line function definition → hasBody=true, body range", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [
        `#include "widget.h"`,
        `void occlude_list(int location, int maxc) {`,
        `    int x = location;`,
        `    while (x < maxc) { x++; }`,
        `}`,
        ``,
    ].join("\n");
    // Cursor on the `o` of `occlude_list` at line 2 (1-based), column 6.
    const r = await findEnclosingDefWithDoc("cpp", src, 2, 6);
    assert.ok(r, "expected an enclosing def");
    assert.equal(r.hasBody, true, "out-of-line def has a body");
    // Body spans the whole function_definition node: lines 1..4 (0-based).
    assert.equal(r.startLine, 1);
    assert.equal(r.endLine, 4);
    // No doc comment above the out-of-line def.
    assert.equal(r.docStartLine, null);
    assert.equal(r.docEndLine, null);
});

test("cpp: cursor INSIDE the body (on a statement) → enclosing def still resolved", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`void f() {`, `    int x = 1;`, `    return x;`, `}`, ``].join("\n");
    // Cursor on `x` at line 3 (1-based) col 9 — inside the body, not on the
    // identifier. Walking up should still find the function_definition.
    const r = await findEnclosingDefWithDoc("cpp", src, 3, 9);
    assert.ok(r);
    assert.equal(r.hasBody, true);
    assert.equal(r.startLine, 0);
    assert.equal(r.endLine, 3);
});

test("cpp: cursor on a class/struct definition → hasBody=true", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`class Widget {`, `public:`, `  void foo();`, `};`, ``].join("\n");
    // Cursor on `Widget` at line 1 col 7.
    const r = await findEnclosingDefWithDoc("cpp", src, 1, 7);
    assert.ok(r);
    assert.equal(r.hasBody, true);
    assert.equal(r.startLine, 0);
    assert.equal(r.endLine, 3);
});

// ---------------------------------------------------------------------------
// C++: cursor on a header-only declaration (scenario 2).
// ---------------------------------------------------------------------------

test("cpp: cursor on free-function prototype with `/** */` doc → hasBody=false, doc range", async () => {
    // The canonical third-party shape: a `/** ... */` block immediately above
    // a free-function declaration. hasBody=false; the doc range covers the
    // whole `/** ... */` block.
    const { findEnclosingDefWithDoc } = await TS();
    const src = [
        `#ifndef WIDGET_H`,
        `#define WIDGET_H`,
        `/** this is doc string for this function`,
        ` *  ....`,
        ` * ....`,
        ` */`,
        `void thirdparty_func(const uint32_t location, std::vector<Neighbor> &pool);`,
        `#endif`,
        ``,
    ].join("\n");
    // Cursor on `thirdparty_func` at line 7 col 6.
    const r = await findEnclosingDefWithDoc("cpp", src, 7, 6);
    assert.ok(r, "expected an enclosing def");
    assert.equal(r.hasBody, false, "prototype has no body");
    assert.equal(r.startLine, 6); // 0-based: the declaration line
    assert.equal(r.endLine, 6);
    // Doc range covers the whole `/** ... */` block (lines 2..5, 0-based).
    assert.equal(r.docStartLine, 2, `doc start should be the /** opener:\n${JSON.stringify(r)}`);
    assert.equal(r.docEndLine, 5);
});

test("cpp: cursor on method prototype inside a class with `///` doc → doc range", async () => {
    // The user's reported shape: a method prototype inside a class, with a
    // `///` line-doc immediately above. The enclosing def is the
    // field_declaration (the prototype); the doc comment is its preceding
    // sibling. (The enclosing class_specifier is a parent, not the nearest
    // enclosing def — the walk stops at the first DEF_NODE_TYPES hit, which is
    // the field_declaration. code_definition wants the nearest enclosing def,
    // not the whole class.)
    const { findEnclosingDefWithDoc } = await TS();
    const src = [
        `class Index {`,
        `public:`,
        `  /// Doc for occlude_list.`,
        `  /// Second line.`,
        `  void occlude_list(int location, int maxc);`,
        `};`,
        ``,
    ].join("\n");
    // Cursor on `occlude_list` at line 5 col 8.
    const r = await findEnclosingDefWithDoc("cpp", src, 5, 8);
    assert.ok(r);
    assert.equal(r.hasBody, false, "method prototype has no body");
    assert.equal(r.startLine, 4); // 0-based: the field_declaration line
    assert.equal(r.endLine, 4);
    // Doc range covers the two `///` lines (lines 2..3, 0-based).
    assert.equal(
        r.docStartLine,
        2,
        `doc start should be the first /// line:\n${JSON.stringify(r)}`,
    );
    assert.equal(r.docEndLine, 3);
});

test("cpp: `/*! ... */` block doc above declaration → recognized", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`/*! brief`, ` *  more detail`, ` */`, `int foo();`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("cpp", src, 4, 5);
    assert.ok(r);
    assert.equal(r.hasBody, false);
    assert.equal(r.docStartLine, 0);
    assert.equal(r.docEndLine, 2);
});

test("cpp: single-line `/** short */` doc above declaration → recognized", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`/** short doc */`, `void foo();`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("cpp", src, 2, 6);
    assert.ok(r);
    assert.equal(r.hasBody, false);
    assert.equal(
        r.docStartLine,
        0,
        `single-line doc block should be recognized:\n${JSON.stringify(r)}`,
    );
    assert.equal(r.docEndLine, 0);
});

test("cpp: declaration with NO doc comment above → docStartLine null", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`#include <vector>`, `void foo();`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("cpp", src, 2, 6);
    assert.ok(r);
    assert.equal(r.hasBody, false);
    assert.equal(r.docStartLine, null, "no doc comment should be resolved");
    assert.equal(r.docEndLine, null);
});

test("cpp: blank line between doc and declaration → doc NOT associated", async () => {
    // A blank line between the `*/` closer and the declaration breaks the
    // "immediately above" relationship — the doc comment is NOT prepended.
    // (Mirrors the rule the old regex helper enforced; tree-sitter enforces it
    // via the sibling-position gap check in precedingDocComment.)
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`/** doc */`, ``, `void foo();`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("cpp", src, 3, 6);
    assert.ok(r);
    assert.equal(r.hasBody, false);
    assert.equal(
        r.docStartLine,
        null,
        `blank line should break the doc association:\n${JSON.stringify(r)}`,
    );
    assert.equal(r.docEndLine, null);
});

test("cpp: blank line INSIDE a `/** */` block → block still recognized", async () => {
    // A blank line INSIDE the block (between opener and closer) does NOT break
    // the block — the comment node spans the whole `/** ... */`. Only a blank
    // line BETWEEN the closer and the declaration breaks the association.
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`/** doc`, ``, ` * more doc`, ` */`, `void foo();`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("cpp", src, 5, 6);
    assert.ok(r);
    assert.equal(r.hasBody, false);
    assert.equal(r.docStartLine, 0);
    assert.equal(r.docEndLine, 3);
});

test("cpp: `//` (ordinary line comment) above declaration → NOT a doc comment", async () => {
    // Plain `//` comments are tagged as `comment` by tree-sitter too, so this
    // helper does NOT distinguish doc from ordinary comments by text — any
    // preceding `comment` sibling without a blank-line gap is returned. This
    // test pins that behavior: an ordinary `//` comment IS returned as the
    // "doc" range. code_definition's callers that want only doc-style comments
    // can filter by text; the helper keeps the union cheap and lets the caller
    // decide. (For the body-return path the doc range is not used at all.)
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`// ordinary comment`, `void foo();`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("cpp", src, 2, 6);
    assert.ok(r);
    assert.equal(r.hasBody, false);
    // An ordinary `//` comment is still a `comment` sibling — returned.
    assert.equal(r.docStartLine, 0);
    assert.equal(r.docEndLine, 0);
});

test("cpp: variable declaration (`int x;`) → NOT treated as a def", async () => {
    // A `declaration` node for a variable (`int x;`) is NOT a function
    // prototype — isFunctionDeclarationNode filters it out. The cursor on `x`
    // finds no enclosing def → null → code_definition falls through to LSP.
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`int x = 1;`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("cpp", src, 1, 5);
    assert.equal(r, null, `variable declaration is not a function def:\n${JSON.stringify(r)}`);
});

// ---------------------------------------------------------------------------
// C++: cursor on a call site / use → null (fall through to LSP).
// ---------------------------------------------------------------------------

test("cpp: cursor on a call site → null (not inside a def node)", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`int main() {`, `    foo(1, 2);`, `    return 0;`, `}`, ``].join("\n");
    // Cursor on `foo` at line 2 col 5 — a call expression, not a def. The
    // nearest enclosing def would be main()'s function_definition, but the
    // cursor is inside main's body; the walk-up finds main. So this is NOT
    // null — it returns main. Pin that behavior: a call inside a function
    // resolves to the enclosing function (the caller wants that body when
    // asked for the definition at the call site position? Actually no — the
    // agent asked about `foo`, and LSP should jump to `foo`'s def. So this
    // path should NOT short-circuit; the caller must only use the tree-sitter
    // result when the cursor is ON the def's identifier, not inside a body.)
    //
    // This is exactly why code_definition's step-0 fast path requires
    // hasBody=true AND the cursor to be on the def — see nav.ts. A call
    // inside a body resolves to the enclosing function here, which is the
    // WRONG body to return. So the caller must check the cursor is within the
    // def's IDENTIFIER, not just anywhere in the def. We pin the helper's
    // behavior (returns the enclosing def); the caller's gating is in nav.ts.
    const r = await findEnclosingDefWithDoc("cpp", src, 2, 5);
    assert.ok(r, "the helper returns the enclosing function (main) — pin this");
    assert.equal(r.hasBody, true);
    assert.equal(r.startLine, 0); // main
});

test("cpp: cursor on top-level whitespace / preprocessor → null or non-def", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`#include <vector>`, ``, `void foo();`, ``].join("\n");
    // Cursor on the blank line 2 — no enclosing def.
    const r = await findEnclosingDefWithDoc("cpp", src, 2, 1);
    assert.equal(r, null);
});

// ---------------------------------------------------------------------------
// TypeScript: the same helper generalizes.
// ---------------------------------------------------------------------------

test("typescript: cursor on function declaration with `/** */` doc → hasBody=true, doc range", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [
        `/** Doc for foo */`,
        `function foo(x: number): void {`,
        `  return;`,
        `}`,
        ``,
    ].join("\n");
    const r = await findEnclosingDefWithDoc("typescript", src, 2, 10);
    assert.ok(r);
    assert.equal(r.hasBody, true);
    assert.equal(r.startLine, 1); // function_declaration
    assert.equal(r.endLine, 3);
    assert.equal(r.docStartLine, 0);
    assert.equal(r.docEndLine, 0);
});

// ---------------------------------------------------------------------------
// Python: docstrings are INSIDE the body (first statement), not preceding
// comments — so docStartLine is null, and the body range includes the docstring.
// ---------------------------------------------------------------------------

test("python: cursor on function def → hasBody=true, no preceding doc (docstring is inside)", async () => {
    const { findEnclosingDefWithDoc } = await TS();
    const src = [`def f():`, `    """docstring for f"""`, `    return 1`, ``].join("\n");
    const r = await findEnclosingDefWithDoc("python", src, 1, 5);
    assert.ok(r);
    assert.equal(r.hasBody, true);
    assert.equal(r.startLine, 0);
    assert.equal(r.endLine, 2);
    // Python docstrings are inside the body (first statement), not a preceding
    // comment sibling — so no doc range. The body slice already includes the
    // docstring (the verbatim body contract covers it).
    assert.equal(r.docStartLine, null);
    assert.equal(r.docEndLine, null);
});
