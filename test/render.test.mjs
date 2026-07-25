// Tests for render.ts helpers: hoverSignature, hoverDocSnippet.
//
// Run:  npm run test:unit -- test/render.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

async function loadRender() {
    return load("./src/render.ts");
}

// ---------------------------------------------------------------------------
// hoverSignature
// ---------------------------------------------------------------------------

test("hoverSignature extracts fenced code block", async () => {
    const { hoverSignature } = await loadRender();
    assert.equal(hoverSignature("```cpp\nbool foo()\n```"), "bool foo()");
});

test("hoverSignature collapses multi-line fence", async () => {
    const { hoverSignature } = await loadRender();
    assert.equal(
        hoverSignature("```python\ndef alpha(\n    a: int,\n    b: str\n) -> bool\n```"),
        "def alpha( a: int, b: str ) -> bool",
    );
});

test("hoverSignature returns first non-blank line when no fence", async () => {
    const { hoverSignature } = await loadRender();
    assert.equal(hoverSignature("some plain text\nmore"), "some plain text");
});

test("hoverSignature returns empty for empty input", async () => {
    const { hoverSignature } = await loadRender();
    assert.equal(hoverSignature(""), "");
});

// ---------------------------------------------------------------------------
// hoverDocSnippet
// ---------------------------------------------------------------------------

test("hoverDocSnippet extracts prose after fence", async () => {
    const { hoverDocSnippet } = await loadRender();
    const hover = "```cpp\nbool foo()\n```\n\nCheck if foo exists.";
    assert.equal(hoverDocSnippet(hover), "Check if foo exists.");
});

test("hoverDocSnippet skips horizontal rule after fence (ty style)", async () => {
    const { hoverDocSnippet } = await loadRender();
    const hover = "```python\ndef foo():\n```\n---\n\nDo the foo thing.";
    assert.equal(hoverDocSnippet(hover), "Do the foo thing.");
});

test("hoverDocSnippet returns empty when no prose after fence", async () => {
    const { hoverDocSnippet } = await loadRender();
    assert.equal(hoverDocSnippet("```cpp\nbool foo()\n```"), "");
});

// When ccls returns a bare signature with no fence and no docstring,
// hoverDocSnippet returns the signature as "doc". The dedup happens in
// renderRow (outline.ts) by comparing doc prefix with signature.
test("hoverDocSnippet returns bare C++ signature as-is (dedup is caller's job)", async () => {
    const { hoverDocSnippet } = await loadRender();
    const hover = "inline bool file_exists(const std::string &name)";
    assert.equal(hoverDocSnippet(hover), "inline bool file_exists(const std::string &name)");
});

test("hoverDocSnippet extracts actual docstring prose (no fence)", async () => {
    const { hoverDocSnippet } = await loadRender();
    assert.equal(hoverDocSnippet("Check if the file exists."), "Check if the file exists.");
});

test("hoverDocSnippet extracts prose after fence even when fence has signature", async () => {
    const { hoverDocSnippet } = await loadRender();
    const hover = "```cpp\ninline bool file_exists(const std::string &name)\n```\n\nCheck if the file exists on disk.";
    assert.equal(hoverDocSnippet(hover), "Check if the file exists on disk.");
});
