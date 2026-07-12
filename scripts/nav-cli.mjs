#!/usr/bin/env node
// nav-cli.mjs — exercise the code-nav tool implementations directly (no pi, no LLM).
//
// This CLI is a THIN argv-parser around the real tool implementations in
// nav.ts (which index.ts also uses). It does NOT re-implement any rendering
// or tool logic — the old "keep this file in sync with index.ts by hand"
// landmine is gone. Both the extension and this CLI import from render.ts +
// nav.ts, so they produce byte-identical output by construction.
//
// We load the .ts modules through jiti — the same loader pi uses to load
// extensions — so bare-specifier resolution (web-tree-sitter,
// vscode-languageserver-protocol, etc.) matches production and works without
// the install symlink. The jiti binary comes from pi's own node_modules.
//
// The workspace root defaults to the current working directory. Override with
// the CODE_NAV_ROOT env var. The root matters for ccls (needs
// compile_commands.json under <root>/build/) and for pyright project detection.
//
// Usage:
//   node nav-cli.mjs outline <file>
//   node nav-cli.mjs tree <file> <pattern>
//   node nav-cli.mjs hover <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
//   node nav-cli.mjs definition <file> <line:1-based> <col:1-based> [<file> <line> <col> ...] [--list-symbols]
//   node nav-cli.mjs references <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
//   node nav-cli.mjs rename <file> <line:1-based> <col:1-based> <newName>
//   node nav-cli.mjs symbol <query> [python|cpp|bash|typescript]
//   node nav-cli.mjs scan <file> [<startLine:1-based> <endLine:1-based>] [--pattern <regexp>] [--docs] [--roles type,call,member,import,var]
//   node nav-cli.mjs diagnostics <file>
//
// hover/definition/references accept one or more (file line col) triples; the
// extra triples are batched through one LSP client per language, mirroring the
// required `positions` array parameter the code_definition/code_hover/
// code_references tools accept in index.ts (the argv triples are collected
// into that array internally).
//
// Examples:
//   node nav-cli.mjs outline temp.py
//   node nav-cli.mjs tree temp.py "TempC"
//   node nav-cli.mjs scan temp.py                  # whole file
//   node nav-cli.mjs scan temp.py --pattern load   # filter by name
//   node nav-cli.mjs hover temp.py 5 5
//   node nav-cli.mjs definition second.py 16 7 second.py 10 7
//   node nav-cli.mjs references temp.py 5 5
//   node nav-cli.mjs rename temp.py 5 5 new_name
//   node nav-cli.mjs symbol "parse" python
//   node nav-cli.mjs diagnostics temp.py

import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// EXT_DIR is the extension root (parent of scripts/). jiti resolves modules
// relative to it — same as the unit tests (test/helpers.mjs) and as pi at
// runtime. This means the CLI exercises the EXACT .ts source, not a copy.
const EXT_DIR = resolve(__dirname, "..");

const jiti = createJiti(EXT_DIR, { cache: false, interopDefault: true });
const { LspClient, resolveConfig } = await jiti.import("./lsp-client.ts");
const nav = await jiti.import("./nav.ts");

const ROOT = process.env.CODE_NAV_ROOT ?? process.cwd();
const [cmd, ...rest] = process.argv.slice(2);

function usage() {
	console.error(`usage (root: ${ROOT}):
  node nav-cli.mjs outline <file>
  node nav-cli.mjs tree <file> <pattern>
  node nav-cli.mjs hover <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
  node nav-cli.mjs definition <file> <line:1-based> <col:1-based> [<file> <line> <col> ...] [--list-symbols]
  node nav-cli.mjs references <file> <line:1-based> <col:1-based> [<file> <line> <col> ...]
  node nav-cli.mjs rename <file> <line:1-based> <col:1-based> <newName>
  node nav-cli.mjs symbol <query> [python|cpp|bash|typescript]
  node nav-cli.mjs scan <file> [<startLine:1-based> <endLine:1-based>] [--pattern <regexp>] [--docs] [--roles type,call,member,import,var]
  node nav-cli.mjs diagnostics <file>

hover/definition/references accept one or more (file line col) triples.
outline prints a bloat-free structural overview (classes, methods, functions,
  properties/fields) — constants/variables are dropped, no arguments.
tree takes a regexp matched against symbol names. DWYM: a class/interface/struct
  match prints ONLY its direct children (methods/properties/fields), each
  enriched with a hover signature when the server detail is empty (tsserver/ty);
  any other match prints NO subtree (just the node + ancestors for context).
  No constant/variable filtering — the pattern scopes the candidate set.
definition accepts --list-symbols to also append a symbol table
  per returned snippet (mirrors code_definition's list_symbols parameter).
scan lists identifiers with their absolute 1-based position and syntactic role
  (type/call/member/import/var). With no line range it scans the whole file.
  --pattern filters symbols by name regexp. --docs enriches each row with a
  one-line hover label (LSP round-trips). --roles limits which roles to emit
  (default: type,call,member,import — i.e. all except var, which are noisy
  locals). Pass e.g. --roles var to see only locals, or
  --roles type,call,member,import,var to see everything.
diagnostics fetches errors/warnings for a file via the LSP pull model
  (textDocument/diagnostic, request/response — no push notifications). Output
  positions are 1-based and reusable as (file line col) input to the others.

env:
  CODE_NAV_ROOT  workspace root (default: cwd)`);
	process.exit(2);
}

// One LSP client per language, spawned lazily and reused across calls in one
// invocation (so a batched `symbol` over 4 languages opens 4 clients, not 4×N).
// All spawned clients are shut down on exit (success or error).
const clients = new Map();
const clientOf = async (lang) => {
	let c = clients.get(lang);
	if (!c) {
		c = new LspClient(lang, ROOT, resolveConfig(lang));
		clients.set(lang, c);
	}
	await c.ensureReady();
	return c;
};
async function shutdownAll() {
	await Promise.allSettled([...clients.values()].map((c) => c.shutdown()));
	clients.clear();
}

async function main() {
	if (!cmd) usage();
	if (cmd === "outline") {
		const [path] = rest;
		if (!path) usage();
		console.log(await nav.outline({ path }, ROOT, clientOf));
	} else if (cmd === "tree") {
		// tree <file> <pattern> — pattern is a regexp tested against symbol names.
		const [path, pattern] = rest;
		if (!path || !pattern) usage();
		console.log(await nav.tree({ path, pattern }, ROOT, clientOf));
	} else if (cmd === "hover" || cmd === "definition" || cmd === "references") {
		// Accept one or more (file line col) triples. Each triple is batched
		// through one LSP client per language (mirroring the `positions` array
		// the code_definition/code_hover/code_references tools accept in nav.ts).
		// `definition` also accepts a trailing --list-symbols flag (mirrors the
		// list_symbols parameter of the code_definition tool).
		const listSymbols = rest.includes("--list-symbols");
		const positional = rest.filter((a) => a !== "--list-symbols");
		if (positional.length < 3 || positional.length % 3 !== 0) usage();
		const positions = [];
		for (let i = 0; i + 2 < positional.length; i += 3) {
			positions.push({
				path: positional[i],
				line: parseInt(positional[i + 1], 10),
				column: parseInt(positional[i + 2], 10),
			});
		}
		if (positions.length === 0) usage();
		if (cmd === "hover") console.log(await nav.hover({ positions }, ROOT, clientOf));
		else if (cmd === "definition")
			console.log(
				await nav.definition({ positions, list_symbols: listSymbols }, ROOT, clientOf),
			);
		else console.log(await nav.references({ positions }, ROOT, clientOf));
	} else if (cmd === "rename") {
		const [path, lineStr, colStr, newName] = rest;
		if (!path || !lineStr || !colStr || !newName) usage();
		const line = parseInt(lineStr, 10),
			column = parseInt(colStr, 10);
		console.log(await nav.rename({ path, line, column, newName }, ROOT, clientOf));
	} else if (cmd === "symbol") {
		const [query, langArg] = rest;
		if (!query) usage();
		const params = { query };
		if (langArg) params.language = langArg;
		console.log(await nav.symbol(params, ROOT, clientOf));
	} else if (cmd === "scan") {
		// scan <file> [<startLine> <endLine>] [--pattern <re>] [--docs] [--roles ...]
		// With no line range, scan the whole file. --pattern filters by name.
		const wantDocs = rest.includes("--docs");
		const rolesArg = rest.find((a) => a.startsWith("--roles"));
		let roles;
		if (rolesArg) {
			const val = rolesArg.includes("=") ? rolesArg.slice(rolesArg.indexOf("=") + 1) : "";
			const list = val
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const valid = ["type", "call", "member", "import", "var"];
			roles = list.filter((r) => valid.includes(r));
			if (roles.length === 0)
				throw new Error(`--roles: expected a comma list from ${valid.join(",")}`);
		}
		let pattern;
		const patIdx = rest.indexOf("--pattern");
		if (patIdx >= 0) {
			pattern = rest[patIdx + 1];
			if (!pattern) throw new Error("--pattern requires a regexp argument");
		}
		// Positional args: path, optionally startLine + endLine. Strip flags and
		// the --pattern value from the positional set so they aren't parsed as
		// path/line numbers.
		const isFlaglike = (a) => a === "--docs" || a.startsWith("--roles") || a === "--pattern";
		const positional = rest.filter((a, i) => {
			if (a === "--pattern") return false;
			if (i > 0 && rest[i - 1] === "--pattern") return false;
			return !isFlaglike(a);
		});
		if (positional.length !== 1 && positional.length !== 3) usage();
		const [path, startStr, endStr] = positional;
		const params = { path, roles, include_docs: wantDocs, pattern };
		if (positional.length === 3) {
			const startLine = parseInt(startStr, 10),
				endLine = parseInt(endStr, 10);
			if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) usage();
			params.startLine = startLine;
			params.endLine = endLine;
		}
		console.log(await nav.scan(params, ROOT, clientOf));
	} else if (cmd === "diagnostics") {
		const [path] = rest;
		if (!path) usage();
		console.log(await nav.diagnostics({ path }, ROOT, clientOf));
	} else {
		usage();
	}
}

try {
	await main();
} catch (e) {
	console.error("FAILED:", e);
	process.exitCode = 1;
} finally {
	await shutdownAll();
}
