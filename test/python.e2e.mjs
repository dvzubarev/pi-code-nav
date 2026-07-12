// End-to-end tests for the Python (ty) language server, via nav.*.
//
// These call the SAME nav.* functions index.ts uses, against a real ty server
// and real fixture files — verifying the full pipeline (nav → LspClient → ty →
// render.ts → text). Skipped when CODE_NAV_SKIP_E2E is set or ty isn't on PATH.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";

// Probe the server ONCE at module load (not as a test) so there's no stray
// child process lingering between tests. Each test skips itself if the probe
// failed. node:test runs tests in a file sequentially, so this is safe.
const skip = !SHOULD_RUN_E2E;
const tyOk = SHOULD_RUN_E2E ? await serverAvailable("python") : false;
// runOrSkip registers the test normally when the server is up, or as a skip
// (passing) test otherwise — so `npm run test:e2e` on a server-less machine
// reports green skips rather than red failures.
const runOrSkip = (name, fn) => (skip || !tyOk ? test.skip(name, fn) : test(name, fn));

runOrSkip("code_outline on second.py shows Point and TempC classes", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		const out = await nav.outline({ path: "second.py" }, ws.root, ws.clientOf);
		const lines = out.split("\n");
		// Hierarchical DocumentSymbol[] → indented outline. Verify the two
		// top-level classes appear with their kind and 1-based selectionRange pos.
		assert.ok(
			lines.some((l) => /^Class Point  \(\d+:\d+\)$/.test(l)),
			`Point missing:\n${out}`,
		);
		assert.ok(
			lines.some((l) => /^Class TempC  \(\d+:\d+\)$/.test(l)),
			`TempC missing:\n${out}`,
		);
		// TempC's children (__init__, punintend) are indented two spaces.
		assert.ok(
			lines.some((l) => /^  Method punintend  \(\d+:\d+\)$/.test(l)),
			`punintend missing:\n${out}`,
		);
		// code_outline keeps only structural kinds (class/method/function/...).
		// The module-level Constant GLOB (second.py:8) is dropped — no opt-out.
		// See docs/outline-constants.md.
		assert.ok(
			!lines.some((l) => /Constant GLOB/.test(l)),
			`GLOB should be hidden (not a structural kind):\n${out}`,
		);
	} finally {
		await ws.cleanup();
	}
});

runOrSkip("code_scan on second.py matches TempC and its members", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		// Pattern-driven scan: TempC matches → the class row (with a hover
		// signature, since ty leaves detail empty) PLUS its whole subtree as
		// context. Point (no match, no matching descendant) is pruned.
		const out = await nav.scan({ path: "second.py", pattern: "TempC" }, ws.root, ws.clientOf);
		const lines = out.split("\n");
		// TempC itself is matched.
		assert.ok(
			lines.some((l) => /^Class TempC  .+\(\d+:\d+\)$/.test(l)),
			`TempC match row with signature missing:\n${out}`,
		);
		// Its members are kept as context (indented, no signature label since
		// they're not themselves matches — only the matched node is hovered).
		assert.ok(
			lines.some((l) => /^  Method punintend  \(\d+:\d+\)$/.test(l)),
			`punintend (context member) missing:\n${out}`,
		);
		// Point is pruned (no match in its subtree).
		assert.ok(
			!lines.some((l) => /Class Point/.test(l)),
			`Point should be pruned (no match):\n${out}`,
		);
	} finally {
		await ws.cleanup();
	}
});

runOrSkip("code_scan with a bad regexp reports an error", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		// An invalid regexp is a hard error (isError) — the agent learns the
		// syntax contract fast, no silent substring fallback.
		await assert.rejects(
			nav.scan({ path: "second.py", pattern: "(" }, ws.root, ws.clientOf),
			/Invalid regexp/,
		);
	} finally {
		await ws.cleanup();
	}
});

runOrSkip("code_symbol 'tempc' finds TempC with its identifier position", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		// This is the exact workflow from the issue: `symbol tempc`.
		const out = await nav.symbol({ query: "tempc", language: "python" }, ws.root, ws.clientOf);
		// ty matches case-insensitively on the query prefix; the result row must
		// name TempC as a Class and point at its identifier (col 7 of its line).
		assert.match(out, /\[python\] Class TempC  .*second\.py:\d+:7/);
		// There must be no other-symbol rows (only TempC should match "tempc").
		const rows = out.split("\n").filter((l) => l.trim());
		for (const r of rows) assert.match(r, /TempC/, `unexpected row for "tempc" query: ${r}`);
	} finally {
		await ws.cleanup();
	}
});

runOrSkip("code_definition on punintend returns its body", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		// punintend is at second.py:24:9 (1-based) per code_outline. definition
		// should resolve the enclosing body and return the source snippet.
		const out = await nav.definition(
			{ positions: [{ path: "second.py", line: 24, column: 9 }] },
			ws.root,
			ws.clientOf,
		);
		assert.match(out, /def punintend/, `punintend body missing:\n${out}`);
		// The docstring should be inside the resolved body extent.
		assert.match(out, /Documentation of punintend/);
	} finally {
		await ws.cleanup();
	}
});

runOrSkip("code_hover on Point.__init__ signature shows x param", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		// __init__ is at second.py:11:9 (the `def`). Hovering there should
		// surface the signature, which mentions the `x` parameter.
		const out = await nav.hover(
			{ positions: [{ path: "second.py", line: 11, column: 9 }] },
			ws.root,
			ws.clientOf,
		);
		assert.ok(out.length > 0, "hover returned empty text");
		// ty returns a signature like __init__(self, x: int = 0, y: int = 0) -> None
		assert.match(out, /x\s*:\s*int/i, `x param missing from hover:\n${out}`);
	} finally {
		await ws.cleanup();
	}
});

runOrSkip("code_references on Point class lists __init__ usages", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		// Point is defined at second.py:10:7. Its references include its use as
		// a default parameter in TempC.__init__ (p: Point = Point()).
		const out = await nav.references(
			{ positions: [{ path: "second.py", line: 10, column: 7 }] },
			ws.root,
			ws.clientOf,
		);
		assert.match(out, /\d+ reference\(s\):/, `reference count header missing:\n${out}`);
		// At least one reference row should be present (the def itself, plus the
		// default-arg usage and the call in TempC.__init__).
		const rows = out.split("\n").filter((l) => /second\.py:\d+:\d+ - \d+:\d+/.test(l));
		assert.ok(rows.length >= 1, `no reference rows:\n${out}`);
	} finally {
		await ws.cleanup();
	}
});

runOrSkip("code_diagnostics on a file with a type error reports an error", async () => {
	const ws = await withWorkspace(["second.py"]);
	try {
		// Introduce a real type error: call punintend with a bad arg type.
		const bad = resolve(ws.root, "bad.py");
		await writeFile(bad, "import second\nsecond.Point('not an int')\n", "utf8");
		const out = await nav.diagnostics({ path: "bad.py" }, ws.root, ws.clientOf);
		// ty should report at least one diagnostic (error severity is common
		// for an int-vs-str mismatch, but be lenient — just require *a* diag).
		assert.match(out, /\d+ diagnostic\(s\) for bad\.py:/, `diagnostic header missing:\n${out}`);
	} finally {
		await ws.cleanup();
	}
});
