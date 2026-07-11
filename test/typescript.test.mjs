// TypeScript / TSX parseSymbols behavior.
//
// Asserts the role classification rules from tree-sitter-parse.ts
// (classifyRole, lang === "typescript" || lang === "tsx"):
//   - `type_identifier` → "type" (class name, interface, type alias, generic,
//     type annotation — every occurrence is hoverable, not just the def site)
//   - `property_identifier` / `shorthand_property_identifier` → "member"
//     (class field/method, interface member, enum member, JSX attribute, the
//     right of `.` in `obj.prop`)
//   - `identifier` under an import/export construct → "import" (named,
//     namespace, default, re-export, type-only imports)
//   - `identifier` field "function" of `call_expression` → "call"
//   - `identifier` field "constructor" of `new_expression` → "call"
//   - `identifier` field "object" of `member_expression` → "var" (base)
//   - everything else (declaration name, parameter, local) → "var"
//
// Also covers the tsx-specific grammar: JSX attributes are `member`, JSX
// element names parse correctly (no type_arguments confusion), and the
// `tsx` grammar (not `typescript`) must be used for .tsx/.jsx.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMap, assertEntry, assertNoEntry } from "./helpers.mjs";

test("tsLangForFile maps .ts/.tsx/.js/.jsx and module variants", async () => {
	const { tsLangForFile } = await (await import("./helpers.mjs")).loadParse();
	assert.equal(tsLangForFile("foo.ts"), "typescript");
	assert.equal(tsLangForFile("foo.mts"), "typescript");
	assert.equal(tsLangForFile("foo.cts"), "typescript");
	assert.equal(tsLangForFile("foo.tsx"), "tsx");
	assert.equal(tsLangForFile("foo.jsx"), "tsx");
	// JavaScript is a strict subset for role purposes — parse with the
	// typescript grammar (not the tsx grammar, unless JSX).
	assert.equal(tsLangForFile("foo.js"), "typescript");
	assert.equal(tsLangForFile("foo.mjs"), "typescript");
	assert.equal(tsLangForFile("foo.cjs"), "typescript");
	assert.equal(tsLangForFile("foo.py"), "python");
	assert.equal(tsLangForFile("foo.txt"), null);
});

test("tsLangToLspLang maps both typescript and tsx to the typescript LSP", async () => {
	const { tsLangToLspLang } = await (await import("./helpers.mjs")).loadParse();
	assert.equal(tsLangToLspLang("typescript"), "typescript");
	assert.equal(tsLangToLspLang("tsx"), "typescript");
	assert.equal(tsLangToLspLang("python"), "python");
	assert.equal(tsLangToLspLang("cpp"), "cpp");
	assert.equal(tsLangToLspLang("bash"), "bash");
});

test("named import specifier → import (import { readFile })", async () => {
	const m = await parseMap("typescript", `import { readFile } from "node:fs/promises";\n`, {
		startLine: 1,
		endLine: 1,
	});
	assertEntry(m, "import", "readFile", 1, 10);
});

test("type-only named import → import (import type { Lang })", async () => {
	const m = await parseMap("typescript", `import type { Lang } from "./lsp-client";\n`, {
		startLine: 1,
		endLine: 1,
	});
	assertEntry(m, "import", "Lang", 1, 15);
});

test("namespace import → import (import * as fs)", async () => {
	const m = await parseMap("typescript", `import * as fs from "node:fs";\n`, {
		startLine: 1,
		endLine: 1,
	});
	assertEntry(m, "import", "fs", 1, 13);
});

test("default import → import (import foo)", async () => {
	const m = await parseMap("typescript", `import foo from "./mod";\n`, {
		startLine: 1,
		endLine: 1,
	});
	assertEntry(m, "import", "foo", 1, 8);
});

test("re-export specifier → import (export { bar })", async () => {
	const m = await parseMap("typescript", `export { bar } from "./mod";\n`, {
		startLine: 1,
		endLine: 1,
	});
	assertEntry(m, "import", "bar", 1, 10);
});

test("class declaration name → type_identifier (every occurrence is type)", async () => {
	const text = `class LspClient {\n  private conn: MessageConnection | null = null;\n}\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 3 });
	// Declaration site: `LspClient` is a type_identifier → type.
	assertEntry(m, "type", "LspClient", 1, 7);
	// Annotation site: `MessageConnection` is also a type_identifier → type.
	assertEntry(m, "type", "MessageConnection", 2, 17);
});

test("generic type argument → type (Promise<Hover>)", async () => {
	const text = `async hover(): Promise<Hover | null> { return null; }\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "type", "Promise", 1, 16);
	assertEntry(m, "type", "Hover", 1, 24);
});

test("type alias and interface names → type", async () => {
	const text = `interface Config { port: number; }\ntype ID = string | number;\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 2 });
	assertEntry(m, "type", "Config", 1, 11);
	assertEntry(m, "type", "ID", 2, 6);
});

test("class field and method names → member", async () => {
	const text = `class C {\n  x: number = 0;\n  m(): void {}\n}\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 4 });
	assertEntry(m, "member", "x", 2, 3);
	assertEntry(m, "member", "m", 3, 3);
});

test("interface property signature → member", async () => {
	const text = `interface I { port: number; label?: string; }\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "member", "port", 1, 15);
	assertEntry(m, "member", "label", 1, 29);
});

test("enum member → member", async () => {
	const text = `enum Color { Red, Green, Blue }\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "member", "Red", 1, 14);
	assertEntry(m, "member", "Green", 1, 19);
	assertEntry(m, "member", "Blue", 1, 26);
});

test("bare identifier call → call (compute(42))", async () => {
	const m = await parseMap("typescript", `const x = compute(42);\n`, {
		startLine: 1,
		endLine: 1,
	});
	assertEntry(m, "call", "compute", 1, 11);
	// `x` is the declaration name → var (default drops it).
	assertNoEntry(m, "var", "x");
});

test("method call via member_expression → member for prop, var for base", async () => {
	const text = `arr.push(4);\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "member", "push", 1, 5);
	// `arr` is field "object" of member_expression → var (default drops it).
	assertNoEntry(m, "var", "arr");
});

test("optional chaining member access → member (obj?.maybe?.deep)", async () => {
	const text = `const m = obj?.maybe?.deep;\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "member", "maybe", 1, 16);
	assertEntry(m, "member", "deep", 1, 23);
});

test("new expression constructor → call (new Foo())", async () => {
	const m = await parseMap("typescript", `const t = new Foo();\n`, { startLine: 1, endLine: 1 });
	assertEntry(m, "call", "Foo", 1, 15);
});

test("default role set drops var (declaration names, params, locals)", async () => {
	const text = `function f(a: number): void { const b = a; }\n`;
	const def = await parseMap("typescript", text, { startLine: 1, endLine: 1 });
	// `number` is a predefined_type annotation → type (kept).
	assertEntry(def, "type", "number", 1, 15);
	// `void` is a predefined_type annotation → type (kept).
	assertEntry(def, "type", "void", 1, 24);
	// `f`, `a`, `b` are all var role → dropped from the default set.
	assertNoEntry(def, "var", "f");
	assertNoEntry(def, "var", "a");
	assertNoEntry(def, "var", "b");
	// With var explicitly included, the declaration name is at its position.
	const withVar = await parseMap("typescript", text, {
		startLine: 1,
		endLine: 1,
		roles: ["type", "call", "member", "import", "var"],
	});
	assertEntry(withVar, "var", "f", 1, 10);
});

// --- TSX-specific: the `tsx` grammar parses JSX correctly ---

test("tsx grammar parses JSX attributes as member", async () => {
	const text = `const el = <Card className="x" onClick={handler}>{value}</Card>;\n`;
	const m = await parseMap("tsx", text, { startLine: 1, endLine: 1 });
	assertEntry(m, "member", "className", 1, 18);
	assertEntry(m, "member", "onClick", 1, 32);
	// JSX element name `Card` and the `value` in `{value}` are `var` role
	// (filtered by default). They must NOT be misclassified as `type` (which
	// would happen if the `typescript` grammar mis-parsed `<Card>` as
	// type_arguments).
	assertNoEntry(m, "type", "Card");
});

test("tsx JSX element name is var (not type), includable via roles", async () => {
	const text = `const el = <Card>{value}</Card>;\n`;
	const withVar = await parseMap("tsx", text, {
		startLine: 1,
		endLine: 1,
		roles: ["type", "call", "member", "import", "var"],
	});
	assertEntry(withVar, "var", "Card", 1, 13);
	assertEntry(withVar, "var", "value", 1, 19);
	// And it is never a type.
	assertNoEntry(withVar, "type", "Card");
});

test("typescript grammar is NOT used for .tsx (would misclassify JSX)", async () => {
	// Same JSX snippet parsed with the `typescript` grammar: `<Card>` becomes
	// type_arguments and `Card` a type_identifier → wrongly classified as
	// `type`. This test documents WHY .tsx must use the `tsx` grammar.
	const text = `const el = <Card>{value}</Card>;\n`;
	const m = await parseMap("typescript", text, { startLine: 1, endLine: 1 });
	// Mis-parsed: Card shows up as a type (the bug the tsx grammar fixes).
	assertEntry(m, "type", "Card", 1, 13);
});
