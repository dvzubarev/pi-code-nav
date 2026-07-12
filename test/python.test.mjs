// Python parseSymbols behavior.
//
// Asserts the role classification rules from tree-sitter-parse.ts
// (classifyRole, lang === "python") and the node-types table in
// code_scan.md:
//   - `type` annotation node (outermost only) → role "type"
//   - `identifier` under `type` → skipped (covered by the type node)
//   - `identifier` under `aliased_import` / `dotted_name`+import → "import"
//   - `identifier` with field "attribute" under `attribute` → "member"
//   - `identifier` under `call` → "call"
//   - else `identifier` → "var"
// And: nested `type` nodes (generics/unions) emit only the OUTERMOST.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMap, parseList, assertEntry, assertNoEntry } from "./helpers.mjs";

test("import: module name (import cbor2)", async () => {
	const m = await parseMap("python", "import cbor2\n", { startLine: 1, endLine: 1 });
	assertEntry(m, "import", "cbor2", 1, 8);
});

test("import: from-import symbol (from cbor2 import CBOREncoder)", async () => {
	const m = await parseMap("python", "from cbor2 import CBOREncoder\n", {
		startLine: 1,
		endLine: 1,
	});
	assertEntry(m, "import", "cbor2", 1, 6);
	assertEntry(m, "import", "CBOREncoder", 1, 19);
});

test("import: alias (import numpy as np)", async () => {
	const m = await parseMap("python", "import numpy as np\n", { startLine: 1, endLine: 1 });
	assertEntry(m, "import", "numpy", 1, 8);
	assertEntry(m, "import", "np", 1, 17);
});

test("attribute access: base is var, member is the attribute (cbor2.load)", async () => {
	const m = await parseMap("python", "x = cbor2.load(data)\n", {
		startLine: 1,
		endLine: 1,
		roles: ["type", "call", "member", "import", "var"],
	});
	// cbor2 is the `object` field of the attribute → var; load is `attribute` → member.
	assertEntry(m, "var", "x", 1, 1);
	assertEntry(m, "var", "cbor2", 1, 5);
	assertEntry(m, "member", "load", 1, 11);
	// data is an argument → var.
	assertEntry(m, "var", "data", 1, 16);
});

test("bare-name call (compute(...)) → call", async () => {
	const m = await parseMap("python", "compute(a, b)\n", {
		startLine: 1,
		endLine: 1,
		roles: ["call", "var"],
	});
	assertEntry(m, "call", "compute", 1, 1);
	assertEntry(m, "var", "a", 1, 9);
	assertEntry(m, "var", "b", 1, 12);
});

test("type annotation emits the outermost type node only", async () => {
	// `y: int = 0` — `int` is the annotation. The `type` node is emitted; the
	// inner `identifier` "int" is skipped (covered by the type node).
	const m = await parseMap("python", "y: int = 0\n", { startLine: 1, endLine: 1 });
	assertEntry(m, "type", "int", 1, 4);
	// No duplicate "int" as var (the identifier-under-type is skipped).
	assertNoEntry(m, "var", "int");
});

test("type annotation: union/generic emits only the outermost type, inner names as var", async () => {
	// `Callable[[CBOREncoder, Any], None] | None` parses as 4 nested `type`
	// nodes. Only the outermost is emitted as `type`; the inner identifiers
	// (Callable, CBOREncoder, Any, None) are emitted as var.
	const text = "x: Callable[[CBOREncoder, Any], None] | None = None\n";
	const m = await parseMap("python", text, {
		startLine: 1,
		endLine: 1,
		roles: ["type", "var", "call", "member", "import"],
	});
	// Exactly ONE `type` row (the outermost) — the union type node whose text
	// is the whole annotation. We assert by name (the full annotation string).
	const typeRows = [...m.values()].filter((e) => e.role === "type");
	assert.equal(
		typeRows.length,
		1,
		`expected 1 type row, got ${typeRows.length}: ${typeRows.map((r) => r.name)}`,
	);
	// The inner identifiers still surface as var so they remain hoverable.
	assertEntry(m, "var", "Callable", 1, 4);
	assertEntry(m, "var", "CBOREncoder", 1, 14);
	assertEntry(m, "var", "Any", 1, 27);
	// `None` is absorbed into the wrapping `type` node's text (not emitted as a
	// standalone var) — the design's "inner identifiers still surface as var"
	// holds for Callable/CBOREncoder/Any (their parent is generic_type/list),
	// but None sits inside a child `type` node that the outermost-only rule
	// suppresses. Asserting its absence pins this subtlety.
	assertNoEntry(m, "var", "None");
});

test("assignment target is var; value is var", async () => {
	const m = await parseMap("python", "result = thing\n", {
		startLine: 1,
		endLine: 1,
		roles: ["var"],
	});
	assertEntry(m, "var", "result", 1, 1);
	assertEntry(m, "var", "thing", 1, 10);
});

test("dotted_name in expression is attribute access, not import", async () => {
	// `os.path.join(...)` — os is var (object), path is member, join is member.
	// The `dotted_name`-under-`attribute` shape must NOT be misread as an import
	// (the import classifier checks grandparent is import_statement etc.).
	const m = await parseMap("python", "x = os.path.join(a)\n", {
		startLine: 1,
		endLine: 1,
		roles: ["var", "member", "import"],
	});
	assertEntry(m, "var", "os", 1, 5);
	assertEntry(m, "member", "path", 1, 8);
	assertEntry(m, "member", "join", 1, 13);
	assertNoEntry(m, "import", "os");
});

test("default role set drops var, keeps imports/members/calls/types", async () => {
	const text = "import os\nx = os.path.join(data)\n";
	const m = await parseMap("python", text, { startLine: 1, endLine: 2 });
	assertEntry(m, "import", "os", 1, 8);
	assertEntry(m, "member", "path", 2, 8);
	assertEntry(m, "member", "join", 2, 13);
	// x and data are locals → dropped by default.
	assertNoEntry(m, "var", "x");
	assertNoEntry(m, "var", "data");
});
