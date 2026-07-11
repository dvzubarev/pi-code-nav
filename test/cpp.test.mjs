// C++ parseSymbols behavior.
//
// Asserts the role classification rules from tree-sitter-parse.ts
// (classifyRole, lang === "cpp") and the cpp row of the node-types table in
// code_symbols_in.md:
//   - `type_identifier` → "type"
//   - `field_identifier` → "member"
//   - `namespace_identifier` → null (the `std` in `std::sort`; the meaningful
//     name is the identifier child)
//   - `identifier` in `qualified_identifier` field "name" → "call" if the
//     qualified id is under a call_expression, else "type"
//   - `identifier` under `call_expression` → "call"
//   - `identifier` under declaration/parameter contexts → "var"
//   - `identifier` in `field_expression` argument position → "var",
//     non-argument → null (the base object, covered by field_identifier)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMap, assertEntry, assertNoEntry } from "./helpers.mjs";

test("type_identifier → type (std::vector v)", async () => {
	const m = await parseMap("cpp", "std::vector<int> v;\n", { startLine: 1, endLine: 1 });
	// `vector` is the type_identifier inside the qualified id `std::vector`.
	assertEntry(m, "type", "vector", 1, 6);
	// `std` is a namespace_identifier → skipped (no row).
	assertNoEntry(m, "type", "std");
	assertNoEntry(m, "var", "std");
	// `v` is the declaration name → var (default drops it, so request var).
	const withVar = await parseMap("cpp", "std::vector<int> v;\n", {
		startLine: 1,
		endLine: 1,
		roles: ["type", "var"],
	});
	assertEntry(withVar, "var", "v", 1, 18);
});

test("qualified identifier in call expression → call (std::sort(...))", async () => {
	const text = "std::sort(v.begin(), v.end());\n";
	const m = await parseMap("cpp", text, { startLine: 1, endLine: 1 });
	// `sort` is the `name` field of `qualified_identifier` whose grandparent
	// is a call_expression → role "call".
	assertEntry(m, "call", "sort", 1, 6);
	// `begin` and `end` are field_identifiers (members of v).
	assertEntry(m, "member", "begin", 1, 13);
	assertEntry(m, "member", "end", 1, 24);
	// `v` is the base object of a field_expression (non-argument position) →
	// skipped (the field_identifier child is the row).
	assertNoEntry(m, "var", "v");
});

test("qualified identifier NOT called → type (using alias = std::less<T>)", async () => {
	// `using alias = std::less<int>;` — both `alias` (the alias name) and
	// `less` are type_identifiers; `std` is a namespace_identifier (skipped).
	// This exercises the qualified-id-not-called branch indirectly via the
	// type_identifier classification (the grammar uses type_identifier, not a
	// plain identifier, for type names inside qualified ids).
	const text = "using alias = std::less<int>;\n";
	const m = await parseMap("cpp", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "type", "alias", 1, 7);
	assertEntry(m, "type", "less", 1, 20);
	assertNoEntry(m, "type", "std");
	assertNoEntry(m, "var", "std");
});

test("bare identifier call → call (foo())", async () => {
	const m = await parseMap("cpp", "foo();\n", { startLine: 1, endLine: 1 });
	assertEntry(m, "call", "foo", 1, 1);
});

test("field_expression member access (.push_back) → member", async () => {
	const text = "v.push_back(42);\n";
	const m = await parseMap("cpp", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "member", "push_back", 1, 3);
	// `v` is the base (non-argument field_expression child) → skipped.
	assertNoEntry(m, "var", "v");
	// `42` is a literal — no identifier row at all.
	assertNoEntry(m, "var", "42");
});

test("declaration names are var (filtered by default)", async () => {
	const text = "int x = 0;\n";
	const def = await parseMap("cpp", text, { startLine: 1, endLine: 1 });
	const withVar = await parseMap("cpp", text, { startLine: 1, endLine: 1, roles: ["var"] });
	// `int` is a primitive_type, not an identifier — no row.
	// `x` is the declaration name → var.
	assertNoEntry(def, "var", "x");
	assertEntry(withVar, "var", "x", 1, 5);
});

test("argument passed by identifier name → var", async () => {
	const text = "f(other);\n";
	const m = await parseMap("cpp", text, {
		startLine: 1,
		endLine: 1,
		roles: ["call", "var"],
	});
	assertEntry(m, "call", "f", 1, 1);
	assertEntry(m, "var", "other", 1, 3);
});

test("namespace_identifier is skipped (std in std::sort)", async () => {
	const text = "std::sort(v.begin(), v.end());\n";
	const m = await parseMap("cpp", text, {
		startLine: 1,
		endLine: 1,
		roles: ["type", "call", "member", "var"],
	});
	// No row for `std` at all — neither type, var, nor call.
	for (const e of m.values()) assert.notEqual(e.name, "std");
});

test("default role set: types/calls/members kept, declarations dropped", async () => {
	const text = "std::vector<int> v;\nstd::sort(v.begin(), v.end());\n";
	const m = await parseMap("cpp", text, { startLine: 1, endLine: 2 });
	assertEntry(m, "type", "vector", 1, 6);
	assertEntry(m, "call", "sort", 2, 6);
	assertEntry(m, "member", "begin", 2, 13);
	assertEntry(m, "member", "end", 2, 24);
	// `v` (declaration name on line 1) is var → dropped.
	assertNoEntry(m, "var", "v");
});

test("C++ statement fragment parses without wrapping (un-indented)", async () => {
	// The design doc's load-bearing snippet-parse guarantee: a raw C++ statement
	// list (no enclosing function / #include) parses without error and still
	// classifies identifiers. We pad blank lines so the fragment genuinely sits
	// at line 10 of a multi-line translation unit (parseSymbols slices the text
	// by startLine/endLine, so startLine must refer to the line within `text`).
	const text = "\n".repeat(9) + "v.push_back(x);\nreturn v.size();\n";
	const m = await parseMap("cpp", text, {
		startLine: 10,
		endLine: 11,
		roles: ["member", "var"],
	});
	assertEntry(m, "member", "push_back", 10, 3);
	assertEntry(m, "member", "size", 11, 10);
});

test("C++ INDENTED fragment also parses (dedented method body)", async () => {
	// Confirms the doc's snippet guarantee extends to indented fragments (the
	// real shape code_definition returns for a C++ method body: leading
	// whitespace preserved). The C++ grammar's error-recovery handles it. Pinned
	// because it would be a real regression if a grammar bump broke it.
	const text = "\n".repeat(9) + "    v.push_back(x);\n    return v.size();\n";
	const m = await parseMap("cpp", text, {
		startLine: 10,
		endLine: 11,
		roles: ["member", "var"],
	});
	assertEntry(m, "member", "push_back", 10, 7);
	assertEntry(m, "member", "size", 11, 14);
});
