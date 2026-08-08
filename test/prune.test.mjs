// pruneDocSymbolTree behavior — namespace lifting, keep/drop rules.
//
// Tests the core pruning logic of src/outline.ts with synthetic
// DocumentSymbol trees, so no LSP server is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

/** Build a minimal DocumentSymbol-like object for test trees. */
function sym(name, kind, children, extra) {
    return {
        name,
        kind,
        children: children ?? [],
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        ...extra,
    };
}

test("pruneDocSymbolTree: keeps Function(12) at top level", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("foo", 12)];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "foo");
});

test("pruneDocSymbolTree: drops Variable(13)", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("MAX_SIZE", 13)];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 0);
});

test("pruneDocSymbolTree: lifts children from Namespace(3) with :: prefix", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("diskann", 3, [sym("block_convert", 12), sym("normalize_data_file", 12)])];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "diskann::block_convert");
    assert.equal(result[1].name, "diskann::normalize_data_file");
});

test("pruneDocSymbolTree: lifts Struct(23) from Namespace(3) with :: prefix", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("diskann", 3, [sym("PivotContainer", 23)])];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "diskann::PivotContainer");
});

test("pruneDocSymbolTree: lifts children out of nested namespaces (ns1::ns2::fn)", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("ns1", 3, [sym("ns2", 3, [sym("doStuff", 12)])])];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "ns1::ns2::doStuff");
});

test("pruneDocSymbolTree: drops Variable(13) inside a Namespace(3)", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("diskann", 3, [sym("MAX_REQUEST_SIZE", 13), sym("block_convert", 12)])];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "diskann::block_convert");
});

test("pruneDocSymbolTree: Class(5) inside Namespace(3) gets prefix, children keep empty prefix", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("diskann", 3, [sym("Foo", 5, [sym("doStuff", 6), sym("Foo", 9)])])];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "diskann::Foo");
    // Children keep name as-is (no prefix inheritance past a kept boundary)
    const children = result[0].children;
    assert.equal(children.length, 2);
    assert.equal(children[0].name, "doStuff");
    assert.equal(children[0].kind, 6);
    assert.equal(children[1].name, "Foo");
    assert.equal(children[1].kind, 9);
});

test("pruneDocSymbolTree: interface, constructor, method all survive lift", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [
        sym("ns", 3, [
            sym("Iterable", 11), // Interface
            sym("Foo", 5, [
                sym("Foo", 9), // Constructor
                sym("run", 6), // Method
            ]),
        ]),
    ];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "ns::Iterable");
    assert.equal(result[0].kind, 11);
    assert.equal(result[1].name, "ns::Foo");
    assert.equal(result[1].kind, 5);
    // children of the class are unchanged
    assert.equal(result[1].children.length, 2);
    assert.equal(result[1].children[0].name, "Foo");
    assert.equal(result[1].children[0].kind, 9);
    assert.equal(result[1].children[1].name, "run");
    assert.equal(result[1].children[1].kind, 6);
});

test("pruneDocSymbolTree: keeps top-level Function alongside lifted namespace children", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("file_exists", 12), sym("diskann", 3, [sym("block_convert", 12)])];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, "file_exists");
    assert.equal(result[1].name, "diskann::block_convert");
});

test("pruneDocSymbolTree: empty top-level list returns []", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const result = pruneDocSymbolTree([], OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.deepEqual(result, []);
});

test("pruneDocSymbolTree: empty container with no children produces nothing", async () => {
    const { pruneDocSymbolTree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS } =
        await load("./src/outline.ts");
    const tree = [sym("empty_ns", 3, [])];
    const result = pruneDocSymbolTree(tree, OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
    assert.equal(result.length, 0);
});
