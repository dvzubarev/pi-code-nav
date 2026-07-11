/**
 * code-nav extension
 *
 * Provides eight LLM-callable tools backed by real LSP servers (ccls for C++,
 * ty/pyright for Python, bash-language-server for bash) plus tree-sitter for
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
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	LspClient,
	resolveConfig,
	type Lang,
	type ServerConfig,
} from "./lsp-client";
import {
	parseSymbols,
	renderSymbolTable,
	hoverFirstLine,
	tsLangForFile,
} from "./tree-sitter-parse";
import type {
	DocumentSymbol,
	SymbolInformation,
	Location,
	Hover,
	WorkspaceEdit,
	Diagnostic,
} from "vscode-languageserver-protocol";

/** File extension → language. */
const EXT_LANG: Record<string, Lang> = {
	".py": "python",
	".c": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
	".h": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp",
	".m": "cpp", ".mm": "cpp",
	".sh": "bash", ".bash": "bash",
};

function langForFile(path: string): Lang | null {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return null;
	const ext = path.slice(dot).toLowerCase();
	return EXT_LANG[ext] ?? null;
}

/** Load .pi/lsp.json (project) then ~/.pi/lsp.json (global); merge per-lang. */
async function loadConfig(ctx: ExtensionContext): Promise<Partial<Record<Lang, Partial<ServerConfig>>>> {
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
				for (const lang of ["cpp", "python", "bash"] as Lang[]) {
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
// Helpers: 0-based LSP coords <-> 1-based agent coords, URI/path, rendering.
// ---------------------------------------------------------------------------

function toAbs(p: string, cwd: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

function uriToPath(uri: string): string {
	try {
		if (uri.startsWith("file://")) return fileURLToPath(uri);
		return uri;
	} catch {
		return uri;
	}
}

/** Truncate a string to n chars with ellipsis. */
function trunc(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1) + "…";
}

/** Extract plain text/markdown from a Hover result. */
function hoverText(h: Hover | null): string {
	if (!h) return "(no hover information)";
	const c = h.contents;
	if (typeof c === "string") return c.trim();
	if (Array.isArray(c)) {
		return c
			.map((it) => (typeof it === "string" ? it : it.value))
			.join("\n\n")
			.trim();
	}
	// MarkupContent
	return (c as { value?: string }).value?.trim() ?? "(empty hover)";
}

/** Render a DocumentSymbol tree (hierarchical) as an indented outline. */
function renderDocSymbol(sym: DocumentSymbol, depth: number, lines: string[]): void {
	const pad = "  ".repeat(depth);
	const kind = (sym as unknown as { kind?: number }).kind;
	const kindName = symbolKindName(kind);
	// Use the selectionRange (the identifier span) — NOT range.start (the whole
	// symbol extent, which begins at column 0 of the enclosing line and does NOT
	// resolve in hover/definition/references on servers like ty). This makes
	// outline output directly reusable as input to the other code_* tools.
	// Output is 1-based (LSP returns 0-based; we add 1 here).
	const sel = sym.selectionRange?.start;
	const pos = sel ? `${sel.line + 1}:${sel.character + 1}` : "";
	const detail = (sym as unknown as { detail?: string | null }).detail;
	const d = detail ? `  ${detail}` : "";
	lines.push(`${pad}${kindName} ${sym.name}${d}  (${pos})`);
	const children = (sym as unknown as { children?: DocumentSymbol[] }).children ?? [];
	for (const ch of children) renderDocSymbol(ch, depth + 1, lines);
}

function symbolKindName(kind: number | undefined): string {
	// LSP SymbolKind is 1-based (File=1, Class=5, Method=6, Function=12, Variable=13, …).
	// Index 0 is unused by the spec; pad so names[kind] resolves correctly.
	const names = [
		"", "File","Module","Namespace","Package","Class","Method","Property",
		"Field","Constructor","Enum","Interface","Function","Variable","Constant",
		"String","Number","Boolean","Array","Object","Key","Null","EnumMember",
		"Struct","Event","Operator","TypeParameter",
	];
	if (kind == null || kind === 0) return "Symbol";
	return names[kind] ?? "Symbol";
}

function renderSymbolInfo(s: SymbolInformation, selStart?: { line: number; character: number }): string {
	const loc = s.location;
	const path = uriToPath(loc.uri);
	// selStart is the resolved identifier position (0-based LSP coords) when
	// available; falls back to the symbol range start otherwise. We print 1-based
	// so the output is directly reusable as input to code_hover/code_definition/
	// code_references (which expect 1-based and subtract 1 internally).
	const p = selStart ?? loc.range?.start;
	const pos = p ? `${p.line + 1}:${p.character + 1}` : "";
	return `${symbolKindName(s.kind)} ${s.name}  ${path}:${pos}`;
}

/**
 * Resolve the identifier (selectionRange) start for a SymbolInformation.
 *
 * SymbolInformation (from workspace/symbol) only carries `location.range` —
 * the full symbol extent, whose start is column 0 of the enclosing line and
 * does NOT resolve in hover/definition/references on servers like ty. We need
 * the identifier position so code_symbol output is directly reusable as input
 * to the other code_* tools.
 *
 * We fetch documentSymbol for the result's file (cached per uri within a
 * single code_symbol call) and find the child whose name matches and whose
 * range contains the SymbolInformation's range. If no match, fall back to
 * scanning the source line for the symbol name. Returns 0-based LSP coords.
 */
async function resolveSymbolSelStart(
	client: LspClient,
	sym: SymbolInformation,
	docCache: Map<string, DocumentSymbol[]>,
): Promise<{ line: number; character: number } | undefined> {
	const path = uriToPath(sym.location.uri);
	const rangeStart = sym.location.range?.start;
	if (!rangeStart) return undefined;
	// Try documentSymbol lookup for an exact selectionRange.
	try {
		let syms = docCache.get(path);
		if (!syms) {
			let text: string;
			try {
				text = await readFile(path, "utf8");
			} catch {
				text = "";
			}
			const got = await client.documentSymbols(path, text);
			syms = got as DocumentSymbol[];
			docCache.set(path, syms);
		}
		const match = findDocSymbolByNameRange(syms, sym.name, sym.location.range);
		if (match?.selectionRange?.start) {
			return { line: match.selectionRange.start.line, character: match.selectionRange.start.character };
		}
	} catch {
		// Fall through to source-line scan.
	}
	// Fallback: scan the source line for the symbol name.
	try {
		const text = await readFile(path, "utf8");
		const lineText = text.split(/\r?\n/)[rangeStart.line] ?? "";
		const idx = lineText.indexOf(sym.name);
		if (idx >= 0) return { line: rangeStart.line, character: idx };
	} catch {}
	return undefined;
}

/** Recursively find a DocumentSymbol by name whose range contains `within`. */
function findDocSymbolByNameRange(
	syms: DocumentSymbol[],
	name: string,
	within: { start?: { line: number; character: number }; end?: { line: number; character: number } },
): DocumentSymbol | undefined {
	for (const s of syms) {
		if (s.name === name && rangeContains(s.range, within)) return s;
		const children = (s as unknown as { children?: DocumentSymbol[] }).children ?? [];
		const m = findDocSymbolByNameRange(children, name, within);
		if (m) return m;
	}
	return undefined;
}

function rangeContains(
	outer: { start?: { line: number; character: number }; end?: { line: number; character: number } } | undefined,
	inner: { start?: { line: number; character: number }; end?: { line: number; character: number } },
): boolean {
	if (!outer?.start || !outer?.end || !inner?.start || !inner?.end) return false;
	const a = posKey(outer.start), b = posKey(outer.end);
	const c = posKey(inner.start), d = posKey(inner.end);
	return a <= c && b >= d;
}
function posKey(p: { line: number; character: number }): number {
	return p.line * 1_000_000 + p.character;
}

function renderLocation(loc: Location): string {
	const start = loc.range?.start;
	const end = loc.range?.end;
	const path = uriToPath(loc.uri);
	if (start && end) {
		// +1 to convert 0-based LSP coords to 1-based output (matches tool input contract).
		return `${path}:${start.line + 1}:${start.character + 1} - ${end.line + 1}:${end.character + 1}`;
	}
	return path;
}

/** LSP DiagnosticSeverity (1-based) → short label. */
function severityName(sev: number | undefined): string {
	switch (sev) {
		case 1: return "error";
		case 2: return "warning";
		case 3: return "info";
		case 4: return "hint";
		default: return "message";
	}
}

/** Extract a plain string message from a Diagnostic (message may be MarkupContent). */
function diagnosticMessage(d: Diagnostic): string {
	const m = d.message;
	if (typeof m === "string") return m;
	// MarkupContent
	return (m as { value?: string }).value ?? "";
}

/**
 * Render one Diagnostic as a single line. Output positions are 1-based (LSP is
 * 0-based; +1) so they are directly reusable as input to code_hover /
 * code_definition / code_references (the same contract as the other tools).
 * Format: `<path>:<line>:<col>  <severity>  <source>  <message>` (source
 * omitted when absent). The line:col points at the diagnostic's range start.
 */
function renderDiagnostic(path: string, d: Diagnostic): string {
	const start = d.range?.start;
	const line = start ? start.line + 1 : 1;
	const col = start ? start.character + 1 : 1;
	const sev = severityName(d.severity);
	const src = d.source ? `  ${d.source}` : "";
	const code = d.code != null ? ` (${d.code})` : "";
	return `${path}:${line}:${col}  ${sev}${src}${code}  ${diagnosticMessage(d)}`;
}

/**
 * Resolve the full definition body range for a Location returned by
 * textDocument/definition. LSP servers (pyright/ty/ccls) typically return only
 * the identifier span (e.g. the 9 chars of `punintend`), not the whole
 * function/class body. We fetch documentSymbol for the target file and find the
 * child whose selectionRange.start equals the definition's identifier position;
 * we then return that child's full `range` (the enclosing extent) so callers can
 * slice the actual definition source. Returns 0-based LSP line coords or null.
 */
async function resolveDefBodyRange(
	client: LspClient,
	loc: Location,
): Promise<{ startLine: number; endLine: number } | null> {
	const path = uriToPath(loc.uri);
	const idStart = loc.range?.start;
	if (!idStart) return null;
	try {
		let text = "";
		try {
			text = await readFile(path, "utf8");
		} catch {}
		const syms = await client.documentSymbols(path, text);
		// Hierarchical DocumentSymbol[] has selectionRange; flat SymbolInformation[]
		// does not — bail (no enclosing extent to resolve).
		const flat = syms.length > 0 && "selectionRange" in syms[0] ? (syms as DocumentSymbol[]) : [];
		const m = findDocSymbolBySelStart(flat, idStart);
		if (m?.range?.start && m?.range?.end) {
			return { startLine: m.range.start.line, endLine: m.range.end.line };
		}
	} catch {}
	return null;
}

/** Recursively find a DocumentSymbol whose selectionRange.start equals `pos`. */
function findDocSymbolBySelStart(
	syms: DocumentSymbol[],
	pos: { line: number; character: number },
): DocumentSymbol | undefined {
	for (const s of syms) {
		const sel = s.selectionRange?.start;
		if (sel && sel.line === pos.line && sel.character === pos.character) return s;
		const children = (s as unknown as { children?: DocumentSymbol[] }).children ?? [];
		const m = findDocSymbolBySelStart(children, pos);
		if (m) return m;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Apply a WorkspaceEdit to disk. Returns per-file summary of applied edits.
// ---------------------------------------------------------------------------

interface AppliedFile {
	path: string;
	edits: number;
}

async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<AppliedFile[]> {
	const applied: AppliedFile[] = [];
	// documentChanges (preferred) — may contain TextDocumentEdit / CreateFile / etc.
	const docChanges = (edit as { documentChanges?: unknown[] }).documentChanges;
	if (Array.isArray(docChanges)) {
		for (const ch of docChanges) {
			const tde = ch as {
				textDocument?: { uri?: string };
				edits?: { range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }; newText?: string }[];
				kind?: string;
			};
			if (tde.textDocument && Array.isArray(tde.edits)) {
				const path = uriToPath(tde.textDocument.uri ?? "");
				const edits = await applyTextEdits(path, tde.edits);
				if (edits > 0) applied.push({ path, edits });
			}
			// CreateFile / DeleteFile / RenameFile are reported but not auto-applied.
		}
	}
	// changes (legacy) — { uri: TextEdit[] }
	const changes = (edit as { changes?: Record<string, unknown[]> }).changes;
	if (changes) {
		for (const [uri, edits] of Object.entries(changes)) {
			const path = uriToPath(uri);
			const n = await applyTextEdits(path, edits as TextEditShape[]);
			if (n > 0) applied.push({ path, edits: n });
		}
	}
	return applied;
}

type TextEditShape = {
	range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
	newText?: string;
};

/** Apply TextEdits to a file on disk. LSP lines are 0-based. */
async function applyTextEdits(path: string, edits: TextEditShape[]): Promise<number> {
	if (edits.length === 0) return 0;
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return 0;
	}
	// Split preserving line endings; use a flat line array for offset math.
	const lines = text.split(/\r?\n/);
	// Sort edits in reverse so earlier offsets stay valid.
	const sorted = [...edits].sort((a, b) => {
		const al = a.range?.start?.line ?? 0;
		const bl = b.range?.start?.line ?? 0;
		return bl - al;
	});
	let count = 0;
	for (const e of sorted) {
		const sr = e.range?.start?.line ?? 0;
		const sc = e.range?.start?.character ?? 0;
		const er = e.range?.end?.line ?? 0;
		const ec = e.range?.end?.character ?? 0;
		const before = lines.slice(0, sr);
		const after = lines.slice(er + 1);
		const line = (lines[sr] ?? "") + "";
		const head = line.slice(0, sc);
		const tailLine = lines[er] ?? "";
		const tail = tailLine.slice(ec);
		const replacement = (e.newText ?? "").split(/\r?\n/);
		const merged = [...before, head + replacement[0], ...replacement.slice(1, -1)];
		if (replacement.length > 1) {
			merged[merged.length - 1] = (merged[merged.length - 1] ?? "") + tail;
		} else {
			merged[merged.length - 1] = head + replacement[0] + tail;
		}
		lines.length = 0;
		lines.push(...merged, ...after);
		count++;
	}
	await writeFile(path, lines.join("\n"), "utf8");
	return count;
}

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
			const lang = langForFile(params.path);
			if (!lang) return err(`Unknown language for file: ${params.path}`);
			const abs = toAbs(params.path, ctx.cwd);
			let text: string;
			try {
				text = await readFile(abs, "utf8");
			} catch (e) {
				return err(`Cannot read ${abs}: ${e}`);
			}
			const client = await state.pool.client(lang);
			const syms = await client.documentSymbols(abs, text);
			const lines: string[] = [];
			if (syms.length === 0) {
				return text_result(`(no symbols found in ${params.path})`);
			}
			// Hierarchical (DocumentSymbol[]) vs flat (SymbolInformation[]).
			if ("range" in syms[0] && "selectionRange" in syms[0]) {
				for (const s of syms as DocumentSymbol[]) renderDocSymbol(s, 0, lines);
			} else {
				for (const s of syms as SymbolInformation[]) lines.push(renderSymbolInfo(s));
			}
			return text_result(lines.join("\n"));
		},
	});

	// 2. code_definition
	pi.registerTool({
		name: "code_definition",
		label: "Code Definition",
		description:
			"Find the definition of the symbol(s) at the given (path, line, column) position(s). Lines/columns are 1-based. Accepts a single position or an array of positions to batch multiple lookups in one call. Returns each definition's location and its source code. Set list_symbols=true to also append a tree-sitter symbol table for each returned snippet (so you can discover third-party/stdlib symbols used inside the body and pass their coordinates to code_hover/code_definition/code_references).",
		promptGuidelines: [
			"Use code_definition with 1-based line and column to jump to a symbol's definition and read its source. Pass an array of positions to batch several lookups in one call. Set list_symbols=true to also list the symbols used inside each returned snippet (useful for discovering third-party/stdlib APIs in the body).",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
			line: Type.Number({ description: "1-based line number" }),
			column: Type.Number({ description: "1-based column number" }),
			positions: Type.Optional(Type.Array(Type.Object({
				path: Type.String({ description: "File path (absolute or relative to cwd)" }),
				line: Type.Number({ description: "1-based line number" }),
				column: Type.Number({ description: "1-based column number" }),
			}))),
			list_symbols: Type.Optional(Type.Boolean({ description: "If true, append a tree-sitter symbol table for each returned snippet (default: false). The table lists identifiers with their absolute 1-based position and syntactic role (type/call/member/import), reusable as input to code_hover/code_definition/code_references. Local-variable rows (var) are omitted by default to keep the output focused on external APIs; use code_symbols_in with roles including \"var\" if you need locals." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Normalize to a list of positions. The single (path, line, column) form is
			// the common case; `positions` lets the agent batch several lookups in one
			// call to save round-trips.
			const posList: { path: string; line: number; column: number }[] = params.positions && params.positions.length > 0
				? params.positions
				: [{ path: params.path, line: params.line, column: params.column }];
			const out: string[] = [];
			// One client per language; reuse across positions of the same lang.
			const clients = new Map<Lang, LspClient>();
			for (const pos of posList) {
				const lang = langForFile(pos.path);
				if (!lang) { out.push(`(unknown language for file: ${pos.path})`); continue; }
				let client = clients.get(lang);
				if (!client) {
					try { client = await state.pool.client(lang); } catch (e) { out.push(`(${lang}: server unavailable: ${e})`); continue; }
					clients.set(lang, client);
				}
				const abs = toAbs(pos.path, ctx.cwd);
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
						const snippet = src.split(/\r?\n/).slice(sl, el + 1).join("\n");
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
			return text_result(out.join("\n"));
		},
	});

	// 3. code_references
	pi.registerTool({
		name: "code_references",
		label: "Code References",
		description:
			"Find all references to the symbol(s) at the given (path, line, column) position(s). Lines/columns are 1-based. Accepts a single position or an array of positions to batch multiple lookups in one call. Returns a list of locations (file:line:col - line:col).",
		promptGuidelines: [
			"Use code_references with 1-based line and column to find all usages of a symbol before renaming or refactoring. Pass an array of positions to batch several lookups in one call.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
			line: Type.Number({ description: "1-based line number" }),
			column: Type.Number({ description: "1-based column number" }),
			positions: Type.Optional(Type.Array(Type.Object({
				path: Type.String({ description: "File path (absolute or relative to cwd)" }),
				line: Type.Number({ description: "1-based line number" }),
				column: Type.Number({ description: "1-based column number" }),
			}))),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const posList: { path: string; line: number; column: number }[] = params.positions && params.positions.length > 0
				? params.positions
				: [{ path: params.path, line: params.line, column: params.column }];
			const out: string[] = [];
			const clients = new Map<Lang, LspClient>();
			for (const pos of posList) {
				const lang = langForFile(pos.path);
				if (!lang) { out.push(`(unknown language for file: ${pos.path})`); continue; }
				let client = clients.get(lang);
				if (!client) {
					try { client = await state.pool.client(lang); } catch (e) { out.push(`(${lang}: server unavailable: ${e})`); continue; }
					clients.set(lang, client);
				}
				const abs = toAbs(pos.path, ctx.cwd);
				let text: string;
				try {
					text = await readFile(abs, "utf8");
				} catch (e) {
					out.push(`(cannot read ${abs}: ${e})`);
					continue;
				}
				const refs = await client.references(abs, pos.line - 1, pos.column - 1, text);
				if (refs.length === 0) {
					out.push(posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n(no references)` : `(no references found for ${pos.path}:${pos.line}:${pos.column})`);
					continue;
				}
				const rendered = refs.map((r) => renderLocation(r));
				const header = posList.length > 1 ? `### ${pos.path}:${pos.line}:${pos.column}\n` : "";
				out.push(header + `${rendered.length} reference(s):\n` + rendered.join("\n"));
			}
			return text_result(out.join("\n"));
		},
	});

	// 4. code_symbol
	pi.registerTool({
		name: "code_symbol",
		label: "Code Symbol Lookup",
		description:
			"Workspace-wide symbol search by name. Given a query string, return a ranked list of matching symbols (kind, name, file:line:col).",
		promptGuidelines: [
			"Use code_symbol to find symbols by name across the workspace when you don't know which file they live in.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Symbol name (or prefix) to search for" }),
			language: Type.Optional(Type.String({ description: "Optional: 'cpp' | 'python' | 'bash' to limit to one language" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const langs: Lang[] = params.language
				? [params.language as Lang]
				: ["cpp", "python", "bash"];
			const out: string[] = [];
			// Cache documentSymbol results per file so we don't re-fetch for every hit.
			const docCache = new Map<string, DocumentSymbol[]>();
			for (const lang of langs) {
				let client: LspClient;
				try {
					client = await state.pool.client(lang);
				} catch (e) {
					out.push(`(${lang}: server unavailable: ${e})`);
					continue;
				}
				if (!client.supports("workspaceSymbolProvider" as keyof import("vscode-languageserver-protocol").ServerCapabilities)) continue;
				const syms = await client.workspaceSymbol(params.query);
				for (const s of syms) {
					const selStart = await resolveSymbolSelStart(client, s, docCache);
					out.push(`[${lang}] ${renderSymbolInfo(s, selStart)}`);
				}
			}
			if (out.length === 0) return text_result(`(no symbols matching "${params.query}")`);
			return text_result(out.join("\n"));
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
			const lang = langForFile(params.path);
			if (!lang) return err(`Unknown language for file: ${params.path}`);
			const abs = toAbs(params.path, ctx.cwd);
			let text: string;
			try {
				text = await readFile(abs, "utf8");
			} catch (e) {
				return err(`Cannot read ${abs}: ${e}`);
			}
			const client = await state.pool.client(lang);
			const edit = await client.rename(abs, params.line - 1, params.column - 1, text, params.newName);
			const applied = await applyWorkspaceEdit(edit);
			if (applied.length === 0) return text_result(`(rename produced no edits)`);
			const lines = applied.map((f) => `${f.path}: ${f.edits} edit(s)`);
			return text_result(`Renamed to "${params.newName}". Applied:\n` + lines.join("\n"));
		},
	});

	// 6. code_hover
	// 6. code_hover
	pi.registerTool({
		name: "code_hover",
		label: "Code Hover / Docs",
		description:
			"Retrieve hover/documentation for the symbol(s) at the given (path, line, column) position(s). Lines/columns are 1-based. Accepts a single position or an array of positions to batch multiple lookups in one call. Returns docstring, signature, and type info when available.",
		promptGuidelines: [
			"Use code_hover with 1-based line and column to read a symbol's documentation, docstring, or type signature. Pass an array of positions to batch several lookups in one call.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
			line: Type.Number({ description: "1-based line number" }),
			column: Type.Number({ description: "1-based column number" }),
			positions: Type.Optional(Type.Array(Type.Object({
				path: Type.String({ description: "File path (absolute or relative to cwd)" }),
				line: Type.Number({ description: "1-based line number" }),
				column: Type.Number({ description: "1-based column number" }),
			}))),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const posList: { path: string; line: number; column: number }[] = params.positions && params.positions.length > 0
				? params.positions
				: [{ path: params.path, line: params.line, column: params.column }];
			const out: string[] = [];
			const clients = new Map<Lang, LspClient>();
			for (const pos of posList) {
				const lang = langForFile(pos.path);
				if (!lang) { out.push(`(unknown language for file: ${pos.path})`); continue; }
				let client = clients.get(lang);
				if (!client) {
					try { client = await state.pool.client(lang); } catch (e) { out.push(`(${lang}: server unavailable: ${e})`); continue; }
					clients.set(lang, client);
				}
				const abs = toAbs(pos.path, ctx.cwd);
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
			return text_result(out.join("\n"));
		},
	});

	// 7. code_symbols_in
	pi.registerTool({
		name: "code_symbols_in",
		label: "Code Symbols In Range",
		description:
			"List every identifier in a line range of a file with its absolute 1-based (path, line, column) and syntactic role (type/call/member/import/var), parsed by tree-sitter. The output is a table whose rows can be passed directly as (path, line, column) into code_hover / code_definition / code_references. This is the entry point for discovering third-party, stdlib, or system symbols (which code_symbol/workspace-symbol cannot find, since workspace/symbol is workspace-scoped). Set include_docs=true to also hover each symbol and append a one-line label.",
		promptSnippet: "List identifiers (with positions + roles) in a file range via tree-sitter",
		promptGuidelines: [
			"Use code_symbols_in to discover identifiers in a code snippet or line range when you have a file path but not a precise position — e.g. after code_definition returns a snippet containing a third-party/stdlib symbol you want to learn about. Read the table, pick a row's (path, line, column), and pass it to code_hover / code_definition / code_references.",
			"The default path (include_docs=false) makes no LSP calls — it is a pure tree-sitter parse, fast and cheap. Use it first; only set include_docs=true when you need hover labels and are willing to pay the LSP round-trips.",
			"Roles: type (a type name), call (a function/method being called), member (a field/attribute access like .push_back / .encode), import (a name brought into scope by an import — module names and imported symbols, the primary entry points for third-party discovery), var (a local variable, parameter, or assignment target — hoverable but rarely worth learning about). By default `var` is omitted (noisy locals); pass roles including \"var\" to include them. The table dedupes by (name, role) and keeps the first occurrence; pass a tighter startLine/endLine to reach a later occurrence.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "File path (absolute or relative to cwd)" }),
			startLine: Type.Number({ description: "1-based inclusive start line of the range to scan" }),
			endLine: Type.Number({ description: "1-based inclusive end line of the range to scan" }),
			roles: Type.Optional(Type.Array(StringEnum(["type", "call", "member", "import", "var"] as const, { description: "Which roles to emit. Default: [type, call, member, import] (all except var, which are noisy locals). Pass e.g. [\"var\"] to see only locals, or the full [\"type\",\"call\",\"member\",\"import\",\"var\"] to see everything." }))),
			include_docs: Type.Optional(Type.Boolean({ description: "If true, hover each symbol and append the first line of the hover as a label column (default: false). Makes one LSP hover call per unique symbol." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const tsLang = tsLangForFile(params.path);
			if (!tsLang) return err(`Unknown language for file: ${params.path}`);
			const abs = toAbs(params.path, ctx.cwd);
			let text: string;
			try {
				text = await readFile(abs, "utf8");
			} catch (e) {
				return err(`Cannot read ${abs}: ${e}`);
			}
			if (params.endLine < params.startLine) return err(`endLine (${params.endLine}) must be >= startLine (${params.startLine})`);
			let entries;
			try {
				entries = await parseSymbols(tsLang, {
					text,
					startLine: params.startLine,
					endLine: params.endLine,
					roles: params.roles,
				});
			} catch (e) {
				return err(`tree-sitter parse failed: ${e}`);
			}
			if (entries === null) return err(`No tree-sitter grammar for ${params.path}`);
			// Optional hover enrichment. One LSP hover call per unique (name, role);
			// the LSP server for the file's language is spawned lazily here (and only
			// when include_docs is true — the default path makes zero LSP calls).
			let docs: Map<string, string> | undefined;
			if (params.include_docs && entries.length > 0) {
				const lang = tsLang as unknown as Lang;
				let client: LspClient;
				try { client = await state.pool.client(lang); } catch (e) { return err(`(${lang}: server unavailable: ${e})`); }
				docs = new Map();
				for (const e of entries) {
					const key = `${e.name}|${e.role}`;
					if (docs.has(key)) continue;
					const h = await client.hover(abs, e.line - 1, e.column - 1, text);
					const first = hoverFirstLine(hoverText(h));
					docs.set(key, first);
				}
			}
			return text_result(renderSymbolTable(params.path, params.startLine, params.endLine, entries, docs));
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
			const lang = langForFile(params.path);
			if (!lang) return err(`Unknown language for file: ${params.path}`);
			const abs = toAbs(params.path, ctx.cwd);
			let text: string;
			try {
				text = await readFile(abs, "utf8");
			} catch (e) {
				return err(`Cannot read ${abs}: ${e}`);
			}
			let client: LspClient;
			try {
				client = await state.pool.client(lang);
			} catch (e) {
				return err(`${lang}: server unavailable: ${e}`);
			}
			// Open the document on the server. didOpen is required for the server
			// to analyze the file; the pull model (textDocument/diagnostic)
			// operates on opened documents. Idempotent (openDocument dedupes by URI).
			await client.openDocument(abs, text);
			// Send the pull request. We do NOT pre-gate on
			// supportsPullDiagnostics(): pyright answers textDocument/diagnostic
			// without advertising diagnosticProvider, while bash-language-server
			// rejects it with a JSON-RPC "Unhandled method" error. The request
			// itself is the source of truth — a server that can't answer returns
			// an error we surface honestly (no silent empty/stale results).
			let diags: Diagnostic[] | null;
			try {
				diags = await client.pullDiagnostics(abs);
			} catch (e) {
				return err(`${lang}: textDocument/diagnostic request failed: ${e instanceof Error ? e.message : e}`);
			}
			if (diags === null) {
				return text_result(`(no diagnostics returned for ${params.path})`);
			}
			if (diags.length === 0) {
				return text_result(`(no diagnostics for ${params.path})`);
			}
			const lines = diags.map((d) => renderDiagnostic(params.path, d));
			return text_result(`${diags.length} diagnostic(s) for ${params.path}:\n` + lines.join("\n"));
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
		ctx.ui.notify("code-nav enabled — tools: code_outline, code_definition, code_references, code_symbol, code_rename, code_hover, code_symbols_in, code_diagnostics", "info");
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
		description: "Enable LSP-backed code navigation tools (code_outline, code_definition, code_references, code_symbol, code_rename, code_hover, code_symbols_in, code_diagnostics)",
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
				const cfg = resolveConfig(lang, state!.pool["overrides" as keyof typeof state.pool] as Partial<Record<Lang, Partial<ServerConfig>>>);
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
