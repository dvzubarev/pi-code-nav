/**
 * The eight code_* tool implementations as plain async functions.
 *
 * This module has NO dependency on pi. Each function takes:
 *   - the validated tool params (plain object),
 *   - a `cwd` (workspace root, for resolving relative paths),
 *   - a `ClientProvider` — `async (lang) => LspClient` — so the function can
 *     obtain a per-language LSP client without depending on ServerPool or the
 *     extension's state.
 * and returns the rendered text string the agent would see (the same string
 * index.ts wraps in `text_result`).
 *
 * On a recoverable error (unknown language, unreadable file, server
 * unavailable), the function pushes a human-readable message into the output
 * text and returns normally — matching the extension's contract of returning a
 * non-error result with the problem described inline. (The extension may still
 * return `isError: true` for top-level failures like "unknown language"; see
 * the `err()` helper in index.ts. The `ok`/`err` distinction lives there, not
 * here: this module just produces the text; the caller decides isError.)
 *
 * Both the extension (index.ts → registerTools) and the CLI harness
 * (scripts/nav-cli.mjs) import these functions, so the CLI and automated tests
 * exercise the EXACT same code path the agent uses. This replaces the old
 * "nav-cli.mjs must mirror index.ts by hand" landmine.
 *
 * All tool params are 1-based (line/column). The functions do `line - 1` /
 * `column - 1` before calling LSP. All output positions are 1-based.
 */

import { readFile } from "node:fs/promises";
import type {
	DocumentSymbol,
	SymbolInformation,
	Location,
	Diagnostic,
} from "vscode-languageserver-protocol";
import type { Lang, LspClient } from "./lsp-client";
import {
	parseSymbols,
	renderSymbolTable,
	hoverFirstLine,
	tsLangForFile,
	tsLangToLspLang,
} from "./tree-sitter-parse";
import {
	toAbs,
	uriToPath,
	hoverText,
	renderDocSymbol,
	renderSymbolInfo,
	renderLocation,
	renderDiagnostic,
	resolveSymbolSelStart,
	resolveDefBodyRange,
	applyWorkspaceEdit,
	langForFile,
} from "./render";

/** Provides a per-language LspClient on demand (mirrors ServerPool.client). */
export interface ClientProvider {
	(lang: Lang): Promise<LspClient>;
}

/** A position triple as accepted by the batched-position tools. */
export interface Position {
	path: string;
	line: number; // 1-based
	column: number; // 1-based
}

// ---------------------------------------------------------------------------
// 1. code_outline
// ---------------------------------------------------------------------------

export interface OutlineParams {
	path: string;
}

export async function outline(
	params: OutlineParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const lang = langForFile(params.path);
	if (lang === null) throw new UnknownLanguageError(params.path);
	const abs = toAbs(params.path, cwd);
	let text: string;
	try {
		text = await readFile(abs, "utf8");
	} catch (e) {
		return `Cannot read ${abs}: ${e}`;
	}
	const client = await clientOf(lang);
	const syms = await client.documentSymbols(abs, text);
	if (syms.length === 0) return `(no symbols found in ${params.path})`;
	const lines: string[] = [];
	// Hierarchical (DocumentSymbol[]) vs flat (SymbolInformation[]).
	if ("range" in syms[0] && "selectionRange" in syms[0]) {
		for (const s of syms as DocumentSymbol[]) renderDocSymbol(s, 0, lines);
	} else {
		for (const s of syms as SymbolInformation[]) lines.push(renderSymbolInfo(s));
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 2. code_definition
// ---------------------------------------------------------------------------

export interface DefinitionParams {
	positions: Position[];
	list_symbols?: boolean;
}

export async function definition(
	params: DefinitionParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const posList: Position[] = params.positions;
	const out: string[] = [];
	// One client per language; reuse across positions of the same lang.
	const clients = new Map<Lang, LspClient>();
	for (const pos of posList) {
		const lang = langForFile(pos.path);
		if (lang === null) {
			out.push(`(unknown language for file: ${pos.path})`);
			continue;
		}
		let client = clients.get(lang);
		if (!client) {
			try {
				client = await clientOf(lang);
			} catch (e) {
				out.push(`(${lang}: server unavailable: ${e})`);
				continue;
			}
			clients.set(lang, client);
		}
		const abs = toAbs(pos.path, cwd);
		let text: string;
		try {
			text = await readFile(abs, "utf8");
		} catch (e) {
			out.push(`(cannot read ${abs}: ${e})`);
			continue;
		}
		const def = await client.definition(abs, pos.line - 1, pos.column - 1, text);
		const locs = Array.isArray(def) ? def : def ? [def] : [];
		if (locs.length === 0) {
			out.push(`(no definition found for ${pos.path}:${pos.line}:${pos.column})`);
			continue;
		}
		// When batching multiple positions, label each block with its query so
		// the agent can tell which result belongs to which input.
		const block: string[] = [];
		if (posList.length > 1) block.push(`### ${pos.path}:${pos.line}:${pos.column}`);
		for (const loc of locs as Location[]) {
			block.push(renderLocation(loc));
			const lp = uriToPath(loc.uri);
			try {
				const src = await readFile(lp, "utf8");
				// The definition range from the server is usually just the identifier
				// span (e.g. the 9 chars of `punintend`). Resolve the enclosing
				// DocumentSymbol to extract the full function/class body.
				const body = await resolveDefBodyRange(client, loc);
				const sl = body ? body.startLine : (loc.range?.start?.line ?? 0);
				const el = body ? body.endLine : (loc.range?.end?.line ?? sl);
				const snippet = src
					.split(/\r?\n/)
					.slice(sl, el + 1)
					.join("\n");
				block.push("```");
				block.push(snippet);
				block.push("```");
				// Optional tree-sitter symbol table over the snippet. Reuses the
				// same parseSymbols helper as code_symbols_in. The snippet's
				// absolute line range is (sl+1 .. el+1) in 1-based coords (sl/el
				// are 0-based LSP line numbers). Only run when requested: default
				// false keeps code_definition's output focused and preserves its
				// contract (the do-not-break-round-trip guarantee in the README).
				if (params.list_symbols) {
					const tsLang = tsLangForFile(lp);
					if (tsLang) {
						try {
							const entries = await parseSymbols(tsLang, {
								text: src,
								startLine: sl + 1,
								endLine: el + 1,
							});
							if (entries && entries.length > 0) {
								block.push(renderSymbolTable(lp, sl + 1, el + 1, entries));
							}
						} catch (e) {
							block.push(`(symbol scan failed: ${e})`);
						}
					}
				}
			} catch {
				block.push("(could not read source file)");
			}
		}
		out.push(block.join("\n"));
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// 3. code_references
// ---------------------------------------------------------------------------

export interface ReferencesParams {
	positions: Position[];
}

export async function references(
	params: ReferencesParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const posList: Position[] = params.positions;
	const out: string[] = [];
	const clients = new Map<Lang, LspClient>();
	for (const pos of posList) {
		const lang = langForFile(pos.path);
		if (lang === null) {
			out.push(`(unknown language for file: ${pos.path})`);
			continue;
		}
		let client = clients.get(lang);
		if (!client) {
			try {
				client = await clientOf(lang);
			} catch (e) {
				out.push(`(${lang}: server unavailable: ${e})`);
				continue;
			}
			clients.set(lang, client);
		}
		const abs = toAbs(pos.path, cwd);
		let text: string;
		try {
			text = await readFile(abs, "utf8");
		} catch (e) {
			out.push(`(cannot read ${abs}: ${e})`);
			continue;
		}
		const refs = await client.references(abs, pos.line - 1, pos.column - 1, text);
		if (refs.length === 0) {
			out.push(
				posList.length > 1
					? `### ${pos.path}:${pos.line}:${pos.column}\n(no references)`
					: `(no references found for ${pos.path}:${pos.line}:${pos.column})`,
			);
			continue;
		}
		const rendered = refs.map((r) => renderLocation(r));
		const header = posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "";
		out.push(header + `${rendered.length} reference(s):\n` + rendered.join("\n"));
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// 4. code_symbol
// ---------------------------------------------------------------------------

export interface SymbolParams {
	query: string;
	language?: string;
}

export async function symbol(
	params: SymbolParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const langs: Lang[] = params.language
		? [params.language as Lang]
		: ["cpp", "python", "bash", "typescript"];
	const out: string[] = [];
	// Cache documentSymbol results per file so we don't re-fetch for every hit.
	const docCache = new Map<string, DocumentSymbol[]>();
	for (const lang of langs) {
		let client: LspClient;
		try {
			client = await clientOf(lang);
		} catch (e) {
			out.push(`(${lang}: server unavailable: ${e})`);
			continue;
		}
		if (
			!client.supports(
				"workspaceSymbolProvider" as keyof import("vscode-languageserver-protocol").ServerCapabilities,
			)
		)
			continue;
		// tsserver loads its project lazily on the first didOpen of a file in
		// that project; workspace/symbol throws "No Project." before then.
		// ensureProjectLoaded opens one source file (a no-op for other
		// servers, which index eagerly on initialize).
		await client.ensureProjectLoaded();
		const syms = await client.workspaceSymbol(params.query);
		for (const s of syms) {
			const selStart = await resolveSymbolSelStart(client, s, docCache);
			out.push(`[${lang}] ${renderSymbolInfo(s, selStart)}`);
		}
	}
	if (out.length === 0) return `(no symbols matching "${params.query}")`;
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// 5. code_rename
// ---------------------------------------------------------------------------

export interface RenameParams {
	path: string;
	line: number;
	column: number;
	newName: string;
}

export async function rename(
	params: RenameParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const lang = langForFile(params.path);
	if (lang === null) throw new UnknownLanguageError(params.path);
	const abs = toAbs(params.path, cwd);
	let text: string;
	try {
		text = await readFile(abs, "utf8");
	} catch (e) {
		return `Cannot read ${abs}: ${e}`;
	}
	const client = await clientOf(lang);
	const edit = await client.rename(abs, params.line - 1, params.column - 1, text, params.newName);
	const applied = await applyWorkspaceEdit(edit);
	if (applied.length === 0) return `(rename produced no edits)`;
	const lines = applied.map((f) => `${f.path}: ${f.edits} edit(s)`);
	return `Renamed to "${params.newName}". Applied:\n` + lines.join("\n");
}

// ---------------------------------------------------------------------------
// 6. code_hover
// ---------------------------------------------------------------------------

export interface HoverParams {
	positions: Position[];
}

export async function hover(
	params: HoverParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const posList: Position[] = params.positions;
	const out: string[] = [];
	const clients = new Map<Lang, LspClient>();
	for (const pos of posList) {
		const lang = langForFile(pos.path);
		if (lang === null) {
			out.push(`(unknown language for file: ${pos.path})`);
			continue;
		}
		let client = clients.get(lang);
		if (!client) {
			try {
				client = await clientOf(lang);
			} catch (e) {
				out.push(`(${lang}: server unavailable: ${e})`);
				continue;
			}
			clients.set(lang, client);
		}
		const abs = toAbs(pos.path, cwd);
		let text: string;
		try {
			text = await readFile(abs, "utf8");
		} catch (e) {
			out.push(`(cannot read ${abs}: ${e})`);
			continue;
		}
		const h = await client.hover(abs, pos.line - 1, pos.column - 1, text);
		const body = hoverText(h);
		const header = posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "";
		out.push(header + body);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// 7. code_symbols_in
// ---------------------------------------------------------------------------

export interface SymbolsInParams {
	path: string;
	startLine: number; // 1-based
	endLine: number; // 1-based
	roles?: string[];
	include_docs?: boolean;
}

export async function symbolsIn(
	params: SymbolsInParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const tsLang = tsLangForFile(params.path);
	if (!tsLang) throw new UnknownLanguageError(params.path);
	const abs = toAbs(params.path, cwd);
	let text: string;
	try {
		text = await readFile(abs, "utf8");
	} catch (e) {
		return `Cannot read ${abs}: ${e}`;
	}
	if (params.endLine < params.startLine)
		return `endLine (${params.endLine}) must be >= startLine (${params.startLine})`;
	let entries;
	try {
		entries = await parseSymbols(tsLang, {
			text,
			startLine: params.startLine,
			endLine: params.endLine,
			roles: params.roles as Parameters<typeof parseSymbols>[1]["roles"],
		});
	} catch (e) {
		return `tree-sitter parse failed: ${e}`;
	}
	if (entries === null) return `No tree-sitter grammar for ${params.path}`;
	// Optional hover enrichment. One LSP hover call per unique (name, role);
	// the LSP server for the file's language is spawned lazily here (and only
	// when include_docs is true — the default path makes zero LSP calls).
	let docs: Map<string, string> | undefined;
	if (params.include_docs && entries.length > 0) {
		const lang = tsLangToLspLang(tsLang);
		let client: LspClient;
		try {
			client = await clientOf(lang);
		} catch (e) {
			return `(${lang}: server unavailable: ${e})`;
		}
		docs = new Map();
		for (const e of entries) {
			const key = `${e.name}|${e.role}`;
			if (docs.has(key)) continue;
			const h = await client.hover(abs, e.line - 1, e.column - 1, text);
			const first = hoverFirstLine(hoverText(h));
			docs.set(key, first);
		}
	}
	return renderSymbolTable(params.path, params.startLine, params.endLine, entries, docs);
}

// ---------------------------------------------------------------------------
// 8. code_diagnostics
// ---------------------------------------------------------------------------

export interface DiagnosticsParams {
	path: string;
}

export async function diagnostics(
	params: DiagnosticsParams,
	cwd: string,
	clientOf: ClientProvider,
): Promise<string> {
	const lang = langForFile(params.path);
	if (lang === null) throw new UnknownLanguageError(params.path);
	const abs = toAbs(params.path, cwd);
	let text: string;
	try {
		text = await readFile(abs, "utf8");
	} catch (e) {
		return `Cannot read ${abs}: ${e}`;
	}
	let client: LspClient;
	try {
		client = await clientOf(lang);
	} catch (e) {
		return `${lang}: server unavailable: ${e}`;
	}
	// Open the document on the server. didOpen is required for the server
	// to analyze the file; both the pull model (textDocument/diagnostic) and
	// the push model (textDocument/publishDiagnostics) operate on opened
	// documents. Idempotent (openDocument dedupes by URI).
	await client.openDocument(abs, text);
	// Try the pull model first (LSP 3.17 textDocument/diagnostic). We do NOT
	// pre-gate on supportsPullDiagnostics(): pyright answers without
	// advertising diagnosticProvider, while bash-language-server rejects with
	// a JSON-RPC "Unhandled method" error. The request itself is the source
	// of truth: a server that can't answer returns an error we fall back
	// from (below) rather than trusting advertised capabilities.
	let diags: Diagnostic[] | null | undefined;
	let pullError: Error | null = null;
	try {
		diags = await client.pullDiagnostics(abs);
	} catch (e) {
		pullError = e instanceof Error ? e : new Error(String(e));
	}
	// FALLBACK: push model (textDocument/publishDiagnostics). Servers that reject
	// the pull model (typescript-language-server, bash-language-server, ccls)
	// still emit publishDiagnostics notifications after didOpen, but only if the
	// client advertised textDocument.publishDiagnostics in initialize (which
	// LspClient.start() now does). The notification handler in LspClient caches
	// the latest set per URI; we poll it for up to ~1.2s to let the server's
	// diagnostics delayer fire (tsserver delays 300-800ms by line count; ccls
	// publishes after indexing). The tool contract stays synchronous - this is
	// a bounded wait, not open-ended collection.
	if (pullError || diags === null) {
		const pushed = await pollPushedDiagnostics(client, abs);
		if (pushed !== undefined) {
			// Push succeeded. If the push cache is ALSO empty but pull rejected,
			// mention the pull failure so the user can tell a clean file from a
			// silent server.
			if (pushed.length === 0 && pullError) {
				return `(no diagnostics for ${params.path}; pull model rejected: ${pullError.message})`;
			}
			return renderDiagnostics(params.path, pushed);
		}
		// No push diagnostics arrived either - surface the pull error honestly.
		if (pullError) {
			return `${lang}: textDocument/diagnostic request failed: ${pullError.message}`;
		}
		return `(no diagnostics returned for ${params.path})`;
	}
	return renderDiagnostics(params.path, diags as Diagnostic[]);
}

/**
 * Poll the client's push-diagnostics cache for `absPath` until it has a value
 * or the budget (~1.2s) is exhausted. Returns undefined if nothing arrived.
 * Servers that push publishDiagnostics do so on their own schedule (tsserver:
 * a Delayer(300) + a 300-800ms computed delay after didOpen). The first poll
 * is immediate (the server may have already fired during initialize/didOpen
 * round-trips); later polls back off.
 */
async function pollPushedDiagnostics(
	client: LspClient,
	absPath: string,
): Promise<Diagnostic[] | undefined> {
	const waits = [0, 100, 200, 300, 600]; // ~1.2s total budget
	for (const w of waits) {
		if (w > 0) await new Promise((r) => setTimeout(r, w));
		const diags = client.getPushedDiagnostics(absPath);
		if (diags !== undefined) return diags;
	}
	return undefined;
}

/** Shared renderer for the diagnostic list (pull or push origin). */
function renderDiagnostics(path: string, diags: Diagnostic[]): string {
	if (diags.length === 0) {
		return `(no diagnostics for ${path})`;
	}
	const lines = diags.map((d) => renderDiagnostic(path, d));
	return `${diags.length} diagnostic(s) for ${path}:\n` + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Error type: the caller (index.ts) decides whether to return isError.
// Unknown-language is a top-level hard failure for the single-file tools
// (outline/rename/symbols_in/diagnostics); the batched tools (definition/
// references/hover) push it inline per-position. We throw here so index.ts can
// mark isError: true for the single-file case; the batched functions catch it
// themselves (they never let it escape — they check langForFile inline).
// ---------------------------------------------------------------------------

export class UnknownLanguageError extends Error {
	constructor(public readonly path: string) {
		super(`Unknown language for file: ${path}`);
		this.name = "UnknownLanguageError";
	}
}
