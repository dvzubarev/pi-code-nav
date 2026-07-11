/**
 * code-nav extension
 *
 * Provides eight LLM-callable tools backed by real LSP servers (ccls for C++,
 * ty/pyright for Python, bash-language-server for bash,
 * typescript-language-server for TypeScript & JavaScript) plus tree-sitter for
 * third-party symbol discovery:
 *
 *   code_outline     — file structure (functions, classes, methods, signatures)
 *   code_definition  — location + source of a symbol's definition
 *   code_references  — list of references for a symbol
 *   code_symbol      — ranked workspace-wide symbol lookup by name
 *   code_rename      — rename a symbol, edits applied to disk
 *   code_hover       — hover/documentation for a symbol
 *   code_symbols_in  — tree-sitter symbol table for a line range of a file
 *                     (the third-party entry point; see MAINTAINER.md)
 *   code_diagnostics — errors/warnings for a file (LSP pull model, on demand)
 *
 * Servers are scoped by (ctx.cwd, language): one server per language per
 * workspace, spawned lazily on first tool call, shut down on session close.
 * tree-sitter (for code_symbols_in) runs in-process via WASM — no LSP server.
 *
 * The tools are NOT registered at session_start. Run `/code-nav` to enable
 * them for the current session; `/code-nav:off` disables them and stops all
 * servers.
 *
 * Per-project overrides live in .pi/lsp.json; see loadConfig().
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LspClient, resolveConfig, type Lang, type ServerConfig } from "./lsp-client";
import * as nav from "./nav";

/** File extension → language (re-exported from render.ts for status reporting). */
// EXT_LANG and langForFile now live in render.ts; index.ts imports them.

/** Load .pi/lsp.json (project) then ~/.pi/lsp.json (global); merge per-lang. */
async function loadConfig(
	ctx: ExtensionContext,
): Promise<Partial<Record<Lang, Partial<ServerConfig>>>> {
	const candidates = [
		resolve(ctx.cwd, ".pi", "lsp.json"),
		resolve(process.env.HOME ?? "", ".pi", "lsp.json"),
	];
	const merged: Partial<Record<Lang, Partial<ServerConfig>>> = {};
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const raw = await readFile(p, "utf8");
			const data = JSON.parse(raw);
			if (data && typeof data === "object") {
				for (const lang of ["cpp", "python", "bash", "typescript"] as Lang[]) {
					const ov = (data as Record<string, unknown>)[lang];
					if (ov && typeof ov === "object") {
						merged[lang] = { ...merged[lang], ...(ov as Partial<ServerConfig>) };
					}
				}
			}
		} catch (e) {
			console.error(`[code-nav] failed to parse ${p}: ${e}`);
		}
	}
	return merged;
}

// ---------------------------------------------------------------------------
// ServerPool: one LspClient per (cwd, language), spawned lazily.
// ---------------------------------------------------------------------------

class ServerPool {
	private clients = new Map<Lang, LspClient>();
	private cwd: string;
	private overrides: Partial<Record<Lang, Partial<ServerConfig>>>;
	private toolsEnabled = false;

	constructor(cwd: string, overrides: Partial<Record<Lang, Partial<ServerConfig>>>) {
		this.cwd = cwd;
		this.overrides = overrides;
	}

	enabled(): boolean {
		return this.toolsEnabled;
	}

	async client(lang: Lang): Promise<LspClient> {
		let c = this.clients.get(lang);
		if (!c) {
			c = new LspClient(lang, this.cwd, resolveConfig(lang, this.overrides));
			this.clients.set(lang, c);
		}
		await c.ensureReady();
		return c;
	}

	async shutdownAll(): Promise<void> {
		const all = Array.from(this.clients.values());
		this.clients.clear();
		await Promise.allSettled(all.map((c) => c.shutdown()));
	}

	setEnabled(on: boolean): void {
		this.toolsEnabled = on;
	}
}

// ---------------------------------------------------------------------------
// Rendering + WorkspaceEdit helpers now live in render.ts (shared with the
// CLI harness and tests). The tool implementations live in nav.ts; registerTools
// below is a thin shim that parses params, calls
// nav.<tool>(params, ctx.cwd, (lang) => state.pool.client(lang)), and wraps the
// returned string in text_result / err. index.ts no longer holds any rendering
// logic — the old "keep nav-cli.mjs in sync with index.ts by hand" landmine is
// gone (both import from render.ts + nav.ts).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool registration — only called when /code-nav is invoked.
// ---------------------------------------------------------------------------

interface State {
	pool: ServerPool;
}

function registerTools(pi: ExtensionAPI, state: State): void {
	// 1. code_outline
	pi.registerTool({
		name: "code_outline",
		label: "Code Outline",
		description:
			"Retrieve the structure of a source file: functions, classes, methods, with signatures and positions. Use for a compact overview before reading full files.",
		promptSnippet: "List functions/classes/methods (with signatures) in a file via LSP",
		promptGuidelines: [
			"Use code_outline to get a compact structure of a file (functions, classes, methods, signatures) before reading the full file.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				return text_result(
					await nav.outline(params, ctx.cwd, (lang) => state.pool.client(lang)),
				);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	});

	// 2. code_definition
	pi.registerTool({
		name: "code_definition",
		label: "Code Definition",
		description:
			"Find the definition of the symbol(s) at the given (path, line, column) position(s). Lines/columns are 1-based. Pass one or more positions to look up (batching multiple in one call is cheaper than N separate calls). Returns each definition's location and its source code. Accepts absolute paths, including third-party locations (nix store, site-packages, node_modules, system headers). Set list_symbols=true to also append a tree-sitter symbol table for each returned snippet (so you can discover third-party/stdlib symbols used inside the body and pass their coordinates to code_hover/code_definition/code_references).",
		promptGuidelines: [
			"Use code_definition with 1-based line and column to jump to a symbol's definition and read its source. Pass an array of positions to batch several lookups in one call. It accepts absolute paths, so positions in third-party trees (nix store, site-packages, node_modules, system headers) work. Set list_symbols=true to also list the symbols used inside each returned snippet (useful for discovering third-party/stdlib APIs in the body); pass a snippet symbol-table row straight into code_hover/code_definition. For third-party symbols you only have a NAME for, see code_symbols_in's guidelines for the rg workflow.",
		],
		parameters: Type.Object({
			positions: Type.Array(
				Type.Object({
					path: Type.String({
						description: "File path (absolute or relative to cwd)",
					}),
					line: Type.Number({ description: "1-based line number" }),
					column: Type.Number({ description: "1-based column number" }),
				}),
				{
					description:
						"One or more (path, line, column) positions to look up. Lines/columns are 1-based.",
				},
			),
			list_symbols: Type.Optional(
				Type.Boolean({
					description:
						'If true, append a tree-sitter symbol table for each returned snippet (default: false). The table lists identifiers with their absolute 1-based position and syntactic role (type/call/member/import), reusable as input to code_hover/code_definition/code_references. Local-variable rows (var) are omitted by default to keep the output focused on external APIs; use code_symbols_in with roles including "var" if you need locals.',
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// nav.definition handles the full batched-position logic, per-position
			// error messages, source-snippet extraction, and optional tree-sitter
			// symbol table. It never throws on recoverable errors (it pushes them
			// inline), so no try/catch wrapper is needed here.
			return text_result(
				await nav.definition(params, ctx.cwd, (lang) => state.pool.client(lang)),
			);
		},
	});

	// 3. code_references
	pi.registerTool({
		name: "code_references",
		label: "Code References",
		description:
			"Find all references to the symbol(s) at the given (path, line, column) position(s). Lines/columns are 1-based. Pass one or more positions to look up (batching multiple in one call is cheaper than N separate calls). Returns a list of locations (file:line:col - line:col).",
		promptGuidelines: [
			"Use code_references with 1-based line and column to find all usages of a symbol before renaming or refactoring. Pass multiple positions to batch several lookups in one call.",
		],
		parameters: Type.Object({
			positions: Type.Array(
				Type.Object({
					path: Type.String({
						description: "File path (absolute or relative to cwd)",
					}),
					line: Type.Number({ description: "1-based line number" }),
					column: Type.Number({ description: "1-based column number" }),
				}),
				{
					description:
						"One or more (path, line, column) positions to look up. Lines/columns are 1-based.",
				},
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// nav.references handles batched positions, per-position error
			// messages, and the ### headers when batching. Never throws on
			// recoverable errors.
			return text_result(
				await nav.references(params, ctx.cwd, (lang) => state.pool.client(lang)),
			);
		},
	});

	// 4. code_symbol
	pi.registerTool({
		name: "code_symbol",
		label: "Code Symbol Lookup",
		description:
			"Workspace-wide symbol search by name. Given a query string, return a ranked list of matching symbols (kind, name, file:line:col). Scoped to the workspace root only — cannot find symbols in third-party trees (site-packages, nix store, node_modules, system headers) even though the LSP server resolves them; see code_symbols_in's guidelines for the third-party workflow (resolve package root, rg, then code_definition/code_hover).",
		promptGuidelines: [
			"Use code_symbol to find symbols by name across the workspace when you don't know which file they live in. It is workspace-scoped only: it will NOT find symbols in third-party trees (site-packages, nix store, node_modules, system headers) even though code_definition/code_hover DO resolve such symbols at a known position. For a third-party symbol you only have a NAME for (from docs or an error), see code_symbols_in's guidelines for the full workflow (resolve the package root via the project env, rg the root, then feed the hit into code_definition) including a best-effort synthesis fallback.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name (or prefix) to search for" }),
			language: Type.Optional(
				Type.String({
					description: "Optional: 'cpp' | 'python' | 'bash' to limit to one language",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// nav.symbol iterates the enabled languages, resolves identifier
			// selStarts via documentSymbol, and never throws on recoverable errors.
			return text_result(
				await nav.symbol(params, ctx.cwd, (lang) => state.pool.client(lang)),
			);
		},
	});

	// 5. code_rename
	pi.registerTool({
		name: "code_rename",
		label: "Code Rename",
		description:
			"Rename the symbol at (path, line, column) to newName. Edits are applied directly to disk. Lines/columns are 1-based. Returns the list of files changed and edit count per file.",
		promptGuidelines: [
			"Use code_rename with 1-based line and column to rename a symbol across the workspace; edits are applied to disk automatically.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
			line: Type.Number({ description: "1-based line number" }),
			column: Type.Number({ description: "1-based column number" }),
			newName: Type.String({ description: "New name for the symbol" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				return text_result(
					await nav.rename(params, ctx.cwd, (lang) => state.pool.client(lang)),
				);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	});

	// 6. code_hover
	pi.registerTool({
		name: "code_hover",
		label: "Code Hover / Docs",
		description:
			"Retrieve hover/documentation for the symbol(s) at the given (path, line, column) position(s). Lines/columns are 1-based. Pass one or more positions to look up (batching multiple in one call is cheaper than N separate calls). Returns docstring, signature, and type info when available.",
		promptGuidelines: [
			"Use code_hover with 1-based line and column to read a symbol's documentation, docstring, or type signature. Pass multiple positions to batch several lookups in one call. It accepts absolute paths, so positions in third-party trees (nix store, site-packages, node_modules, system headers) work. For third-party symbols you only have a NAME for, see code_symbols_in's guidelines for the rg workflow.",
		],
		parameters: Type.Object({
			positions: Type.Array(
				Type.Object({
					path: Type.String({
						description: "File path (absolute or relative to cwd)",
					}),
					line: Type.Number({ description: "1-based line number" }),
					column: Type.Number({ description: "1-based column number" }),
				}),
				{
					description:
						"One or more (path, line, column) positions to look up. Lines/columns are 1-based.",
				},
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// nav.hover handles batched positions, per-position error messages,
			// and the ### headers when batching. Never throws on recoverable errors.
			return text_result(await nav.hover(params, ctx.cwd, (lang) => state.pool.client(lang)));
		},
	});

	// 7. code_symbols_in
	pi.registerTool({
		name: "code_symbols_in",
		label: "Code Symbols In Range",
		description:
			"List every identifier in a line range of a file with its absolute 1-based (path, line, column) and syntactic role (type/call/member/import/var), parsed by tree-sitter. The output is a table whose rows can be passed directly as (path, line, column) into code_hover / code_definition / code_references. This is the entry point for discovering third-party, stdlib, or system symbols (which code_symbol/workspace-symbol cannot find, since workspace/symbol is workspace-scoped). Set include_docs=true to also hover each symbol and append a one-line label. For third-party symbols you only have a NAME for (from docs or an error) and have no position, see the workflow in the guidelines below (rg over the resolved package root, then feed the hit into code_definition).",
		promptSnippet: "List identifiers (with positions + roles) in a file range via tree-sitter",
		promptGuidelines: [
			"Use code_symbols_in to discover identifiers in a code snippet or line range when you have a file path but not a precise position — e.g. after code_definition returns a snippet containing a third-party/stdlib symbol you want to learn about. Read the table, pick a row's (path, line, column), and pass it to code_hover / code_definition / code_references.",
			"The default path (include_docs=false) makes no LSP calls — it is a pure tree-sitter parse, fast and cheap. Use it first; only set include_docs=true when you need hover labels and are willing to pay the LSP round-trips.",
			'Roles: type (a type name), call (a function/method being called), member (a field/attribute access like .push_back / .encode), import (a name brought into scope by an import — module names and imported symbols, the primary entry points for third-party discovery), var (a local variable, parameter, or assignment target — hoverable but rarely worth learning about). By default `var` is omitted (noisy locals); pass roles including "var" to include them. The table dedupes by (name, role) and keeps the first occurrence; pass a tighter startLine/endLine to reach a later occurrence.',
			"Third-party symbol from a NAME only (no position): code_symbol is workspace-scoped and will NOT find it, but code_definition/code_hover DO resolve third-party at a known position. The workflow is: (1) resolve the package root via the project env — python: `python -c \"import cbor2; print(cbor2.__file__)\"`, node: `node -e \"console.log(require.resolve('typescript'))\"`, C++ stdlib: `g++ -E -Wp,-v - </dev/null` (prints the include search list), C++ project deps: the -I flags from compile_commands.json; (2) `rg -n --column <name> <root>` — the output is `line:column:content`, and on ASCII lines the 1-based line and column match what code_definition/code_hover expect, so pass the hit straight in as (path, line, column); (3) call code_definition/code_hover on that position (they accept absolute paths, including nix store / site-packages / node_modules / system headers). Do NOT rg the whole /nix/store (millions of entries, many versions) — always scope to one resolved package root.",
			"If rg finds nothing and you have a NAME plus enough context to write a one-line use, you may try synthesis as a best-effort last resort: write a temp file inside the cwd containing a single line that names the symbol in-scope (e.g. `diagnosticsSupport` as a bare reference, or `import { Foo } from \"bar\"; Foo` when the docs give the module), open it on the server by calling code_hover/code_definition at that line, then delete the temp file. This works only when your one-liner resolves (the docs gave you the module/qualifier); it fails (returns \"no definition\"/unresolved) when it can't — then give up. It is a fallback for the name-from-docs case where rg failed, not a primary path.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
			startLine: Type.Number({
				description: "1-based inclusive start line of the range to scan",
			}),
			endLine: Type.Number({
				description: "1-based inclusive end line of the range to scan",
			}),
			roles: Type.Optional(
				Type.Array(
					StringEnum(["type", "call", "member", "import", "var"] as const, {
						description:
							'Which roles to emit. Default: [type, call, member, import] (all except var, which are noisy locals). Pass e.g. ["var"] to see only locals, or the full ["type","call","member","import","var"] to see everything.',
					}),
				),
			),
			include_docs: Type.Optional(
				Type.Boolean({
					description:
						"If true, hover each symbol and append the first line of the hover as a label column (default: false). Makes one LSP hover call per unique symbol.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				return text_result(
					await nav.symbolsIn(params, ctx.cwd, (lang) => state.pool.client(lang)),
				);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	});

	// 8. code_diagnostics
	//
	// Pure request/response: the tool opens the document on the server (didOpen
	// is required for the server to analyze it) and then sends a single
	// textDocument/diagnostic request (the LSP 3.17 pull model). The server
	// returns the diagnostic set for that document synchronously. NO
	// publishDiagnostics notification collection — that would be async (the
	// server publishes whenever it finishes, and the client would have to wait
	// on a notification) and the user-facing tool contract must be: agent calls
	// the tool, waits, gets the result back. The pull model is exactly that.
	//
	// Capability advertisement is unreliable here: pyright implements
	// textDocument/diagnostic but does NOT advertise diagnosticProvider, while
	// bash-language-server rejects the method with a JSON-RPC error. So we do
	// NOT gate on supportsPullDiagnostics() — we send the request and let the
	// server's actual response (or error) decide. A server that can't answer
	// returns a method-not-found error, which we surface honestly. This is
	// more accurate than trusting advertised capabilities.
	pi.registerTool({
		name: "code_diagnostics",
		label: "Code Diagnostics",
		description:
			"Report diagnostics (errors, warnings, hints) for a source file, fetched on demand from the language server. Lines/columns are 1-based. The diagnostic positions in the output are directly reusable as input to code_hover / code_definition / code_references. Returns the list of diagnostics with severity, source, and message; an empty result means the server reported no problems.",
		promptGuidelines: [
			"Use code_diagnostics to list errors and warnings the language server reports for a file — e.g. after editing a file to check it compiles/type-checks, or to find the exact location of a problem before calling code_hover/code_definition. The output positions are 1-based and reusable as (path, line, column) input to the other code_* tools.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			try {
				return text_result(
					await nav.diagnostics(params, ctx.cwd, (lang) => state.pool.client(lang)),
				);
			} catch (e) {
				return err(e instanceof Error ? e.message : String(e));
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function text_result(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}
function err(msg: string) {
	return { content: [{ type: "text" as const, text: msg }], details: {}, isError: true };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function codeNavExtension(pi: ExtensionAPI) {
	let state: State | null = null;

	async function ensureState(ctx: ExtensionContext): Promise<State> {
		if (state) return state;
		const overrides = await loadConfig(ctx);
		const pool = new ServerPool(ctx.cwd, overrides);
		state = { pool };
		return state;
	}

	async function enable(ctx: ExtensionContext): Promise<void> {
		const s = await ensureState(ctx);
		if (s.pool.enabled()) {
			ctx.ui.notify("code-nav already enabled", "info");
			return;
		}
		registerTools(pi, s);
		s.pool.setEnabled(true);
		ctx.ui.notify(
			"code-nav enabled — tools: code_outline, code_definition, code_references, code_symbol, code_rename, code_hover, code_symbols_in, code_diagnostics",
			"info",
		);
	}

	async function disable(ctx: ExtensionContext): Promise<void> {
		if (!state) return;
		const active = pi.getActiveTools().filter((t) => t.startsWith("code_"));
		if (active.length > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((t) => !t.startsWith("code_")));
		}
		await state.pool.shutdownAll();
		state.pool.setEnabled(false);
		state = null;
		ctx.ui.notify("code-nav disabled — servers stopped", "info");
	}

	pi.registerCommand("code-nav", {
		description:
			"Enable LSP-backed code navigation tools (code_outline, code_definition, code_references, code_symbol, code_rename, code_hover, code_symbols_in, code_diagnostics)",
		handler: async (_args, ctx) => {
			await enable(ctx);
		},
	});

	pi.registerCommand("code-nav:off", {
		description: "Disable code navigation tools and shut down all LSP servers",
		handler: async (_args, ctx) => {
			await disable(ctx);
		},
	});

	pi.registerCommand("code-nav:status", {
		description: "Show which LSP servers are running and their commands",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("code-nav is not enabled", "info");
				return;
			}
			const clients = (state.pool as unknown as { clients: Map<Lang, LspClient> }).clients;
			if (clients.size === 0) {
				ctx.ui.notify("code-nav enabled, no servers spawned yet", "info");
				return;
			}
			const lines: string[] = [];
			for (const [lang, client] of clients) {
				const cfg = resolveConfig(
					lang,
					state!.pool["overrides" as keyof typeof state.pool] as Partial<
						Record<Lang, Partial<ServerConfig>>
					>,
				);
				lines.push(`${lang}: ${cfg.command} ${cfg.args.join(" ")}`.trim());
			}
			ctx.ui.notify(`code-nav servers:\n  - ${lines.join("\n  - ")}`, "info");
		},
	});

	// Shutdown servers when the session closes — covers /new, /resume, /reload, quit.
	pi.on("session_shutdown", async () => {
		if (state) {
			await state.pool.shutdownAll();
			state = null;
		}
	});
}
