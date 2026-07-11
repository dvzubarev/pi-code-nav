/**
 * Pure rendering + small helpers extracted from index.ts.
 *
 * This module has NO dependency on pi, NO dependency on LspClient, and NO
 * filesystem access. It is shared verbatim by:
 *   - index.ts (the extension's tool wrappers)
 *   - scripts/nav-cli.mjs (the manual CLI harness)
 *   - test/*.test.mjs (automated tests)
 *
 * Keeping these functions in one place is what lets the CLI and tests produce
 * byte-identical output to the extension without a fragile "keep this file in
 * sync by hand" landmine (see MAINTAINER.md). If you change a render function
 * here, every consumer sees the change automatically.
 *
 * All output positions are 1-based (LSP is 0-based; convert on the way out).
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type {
	DocumentSymbol,
	SymbolInformation,
	Location,
	Hover,
	WorkspaceEdit,
	Diagnostic,
} from "vscode-languageserver-protocol";
import type { Lang, LspClient } from "./lsp-client";

// ---------------------------------------------------------------------------
// Path / URI / truncation helpers
// ---------------------------------------------------------------------------

/** Resolve a (possibly relative) path against cwd. */
export function toAbs(p: string, cwd: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Convert a file:// URI to a plain filesystem path (passthrough if not a URI). */
export function uriToPath(uri: string): string {
	try {
		if (uri.startsWith("file://")) return fileURLToPath(uri);
		return uri;
	} catch {
		return uri;
	}
}

/** Truncate a string to n chars with ellipsis. */
export function trunc(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------------------
// Hover text extraction
// ---------------------------------------------------------------------------

/** Extract plain text/markdown from a Hover result. */
export function hoverText(h: Hover | null): string {
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

// ---------------------------------------------------------------------------
// Symbol kind naming + DocumentSymbol / SymbolInformation rendering
// ---------------------------------------------------------------------------

/** LSP SymbolKind (1-based) → short label. */
export function symbolKindName(kind: number | undefined): string {
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

/** Render a DocumentSymbol tree (hierarchical) as an indented outline. */
export function renderDocSymbol(sym: DocumentSymbol, depth: number, lines: string[]): void {
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

/** Render a flat SymbolInformation (from workspace/symbol) as one line. */
export function renderSymbolInfo(s: SymbolInformation, selStart?: { line: number; character: number }): string {
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

// ---------------------------------------------------------------------------
// DocumentSymbol tree searches (sel-start resolution, body-range resolution)
// ---------------------------------------------------------------------------

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
export async function resolveSymbolSelStart(
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
export function findDocSymbolByNameRange(
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

/** Recursively find a DocumentSymbol whose selectionRange.start equals `pos`. */
export function findDocSymbolBySelStart(
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

export function rangeContains(
	outer: { start?: { line: number; character: number }; end?: { line: number; character: number } } | undefined,
	inner: { start?: { line: number; character: number }; end?: { line: number; character: number } },
): boolean {
	if (!outer?.start || !outer?.end || !inner?.start || !inner?.end) return false;
	const a = posKey(outer.start), b = posKey(outer.end);
	const c = posKey(inner.start), d = posKey(inner.end);
	return a <= c && b >= d;
}

export function posKey(p: { line: number; character: number }): number {
	return p.line * 1_000_000 + p.character;
}

// ---------------------------------------------------------------------------
// Location + Diagnostic rendering
// ---------------------------------------------------------------------------

/** Render a Location as `<path>:<startLine>:<startCol> - <endLine>:<endCol>` (1-based). */
export function renderLocation(loc: Location): string {
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
export function severityName(sev: number | undefined): string {
	switch (sev) {
		case 1: return "error";
		case 2: return "warning";
		case 3: return "info";
		case 4: return "hint";
		default: return "message";
	}
}

/** Extract a plain string message from a Diagnostic (message may be MarkupContent). */
export function diagnosticMessage(d: Diagnostic): string {
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
export function renderDiagnostic(path: string, d: Diagnostic): string {
	const start = d.range?.start;
	const line = start ? start.line + 1 : 1;
	const col = start ? start.character + 1 : 1;
	const sev = severityName(d.severity);
	const src = d.source ? `  ${d.source}` : "";
	const code = d.code != null ? ` (${d.code})` : "";
	return `${path}:${line}:${col}  ${sev}${src}${code}  ${diagnosticMessage(d)}`;
}

// ---------------------------------------------------------------------------
// Definition body-range resolution (needs an LspClient for documentSymbols)
// ---------------------------------------------------------------------------

/**
 * Resolve the full definition body range for a Location returned by
 * textDocument/definition. LSP servers (pyright/ty/ccls) typically return only
 * the identifier span (e.g. the 9 chars of `punintend`), not the whole
 * function/class body. We fetch documentSymbol for the target file and find the
 * child whose selectionRange.start equals the definition's identifier position;
 * we then return that child's full `range` (the enclosing extent) so callers can
 * slice the actual definition source. Returns 0-based LSP line coords or null.
 */
export async function resolveDefBodyRange(
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

// ---------------------------------------------------------------------------
// WorkspaceEdit application (writes to disk)
// ---------------------------------------------------------------------------

export interface AppliedFile {
	path: string;
	edits: number;
}

export type TextEditShape = {
	range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
	newText?: string;
};

export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<AppliedFile[]> {
	const applied: AppliedFile[] = [];
	// documentChanges (preferred) — may contain TextDocumentEdit / CreateFile / etc.
	const docChanges = (edit as { documentChanges?: unknown[] }).documentChanges;
	if (Array.isArray(docChanges)) {
		for (const ch of docChanges) {
			const tde = ch as {
				textDocument?: { uri?: string };
				edits?: TextEditShape[];
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

/** Apply TextEdits to a file on disk. LSP lines are 0-based. */
export async function applyTextEdits(path: string, edits: TextEditShape[]): Promise<number> {
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
// File extension → language
// ---------------------------------------------------------------------------

/** File extension → language. Shared by index.ts and the CLI. */
export const EXT_LANG: Record<string, Lang> = {
	".py": "python",
	".c": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
	".h": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp",
	".m": "cpp", ".mm": "cpp",
	".sh": "bash", ".bash": "bash",
	// TypeScript/JavaScript — one LSP server (typescript-language-server)
	// serves all of these; tree-sitter uses distinct grammars for the JSX
	// variants (see tsLangForFile). .mts/.cts/.mjs/.cjs are TS/JS module
	// variants that parse identically for our role-classification purposes.
	".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
	".tsx": "typescript", ".jsx": "typescript", ".js": "typescript",
	".mjs": "typescript", ".cjs": "typescript",
};

/** Map a file path to its LSP language, or null if unknown. */
export function langForFile(path: string): Lang | null {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return null;
	const ext = path.slice(dot).toLowerCase();
	return EXT_LANG[ext] ?? null;
}
