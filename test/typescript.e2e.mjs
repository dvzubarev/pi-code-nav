// End-to-end tests for the TypeScript language server (typescript-language-
// server wrapping tsserver), via nav.*.
//
// These call the SAME nav.* functions index.ts uses, against a real tsserver
// and real fixture files — verifying the full pipeline (nav -> LspClient ->
// tsserver -> render.ts -> text). Skipped when CODE_NAV_SKIP_E2E is set or
// typescript-language-server isn't on PATH.
//
// The diagnostics test here specifically exercises the PUSH fallback: tsserver
// rejects the LSP 3.17 textDocument/diagnostic pull request ("Unhandled
// method"), so code_diagnostics falls back to the textDocument/publishDiagnostics
// notification cache. This only works because LspClient.start() advertises
// textDocument.publishDiagnostics in client capabilities — without that cap,
// tsserver gates its whole diagnostics flow off and sends zero notifications.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";

const skip = !SHOULD_RUN_E2E;
const tsOk = SHOULD_RUN_E2E ? await serverAvailable("typescript") : false;
const runOrSkip = (name, fn) => (skip || !tsOk ? test.skip(name, fn) : test(name, fn));

runOrSkip(
	"code_diagnostics on a .ts file with type errors reports them (push fallback)",
	async () => {
		// tsserver does NOT implement the LSP 3.17 pull model — it rejects
		// textDocument/diagnostic with "Unhandled method". code_diagnostics must
		// fall back to the publishDiagnostics push cache. This test verifies that
		// fallback works end-to-end: the two real type errors below must appear.
		const ws = await withWorkspace([]);
		try {
			const bad = resolve(ws.root, "bad.ts");
			await writeFile(
				bad,
				[
					`const x: number = "string";`,
					`console.log(x.notReal);`,
					``, // trailing newline
				].join("\n"),
				"utf8",
			);
			const out = await nav.diagnostics({ path: "bad.ts" }, ws.root, ws.clientOf);
			// We expect a header line plus at least one diagnostic row. We do NOT
			// assert the exact error text (tsserver wording can drift across
			// versions); we assert the two distinct errors are both reported.
			assert.match(
				out,
				/\d+ diagnostic\(s\) for bad\.ts:/,
				`diagnostic header missing:\n${out}`,
			);
			// Type 'string' is not assignable to type 'number' (line 0).
			assert.match(
				out,
				/string['"s]? is not assignable to type ['"n]?number/i,
				`type-assignability diagnostic missing:\n${out}`,
			);
			// Property 'notReal' does not exist on type 'number' (line 1).
			assert.match(
				out,
				/Property ['"]?notReal['"]? does not exist on type/i,
				`nonexistent-property diagnostic missing:\n${out}`,
			);
		} finally {
			await ws.cleanup();
		}
	},
);

runOrSkip(
	"code_diagnostics on a clean .ts file reports no diagnostics (push fallback)",
	async () => {
		// A clean file: the push cache should contain an empty array (the server
		// publishes an empty set), and the tool reports "no diagnostics". This
		// distinguishes a clean file from a silent/broken server.
		const ws = await withWorkspace([]);
		try {
			const good = resolve(ws.root, "good.ts");
			await writeFile(good, `const x: number = 42;\nconsole.log(x);\n`, "utf8");
			const out = await nav.diagnostics({ path: "good.ts" }, ws.root, ws.clientOf);
			assert.match(
				out,
				/no diagnostics for good\.ts/,
				`expected no diagnostics, got:\n${out}`,
			);
		} finally {
			await ws.cleanup();
		}
	},
);
