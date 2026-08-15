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
 *
 * The LSP-assisted symbol/body resolution and the WorkspaceEdit filesystem
 * application that used to live here were split out into `lsp-resolution.ts`
 * and `workspace-edit.ts` respectively (see docs/MAINTAINER.md); this module
 * is now purely output formatting.
 */

import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { DocumentSymbol, SymbolInformation, Location, Hover, Diagnostic } from "vscode-languageserver-protocol";
// The extension→language routing table now lives in the neutral catalog
// (src/languages/catalog.ts). These re-exports preserve `render.ts`'s public
// surface for existing consumers (the tool implementations, index.ts, the CLI,
// and tests) while keeping the source of truth transport-neutral.
export { EXT_LANG, langForFile } from "./languages/catalog";

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
        // When ccls returns an array with both plain strings (comments) and
        // MarkedStrings (signatures), put signatures first so hoverSignature
        // picks up the actual signature, not the comment.
        const plainStrings: string[] = [];
        const markedStrings: string[] = [];
        for (const it of c) {
            if (typeof it === "string") {
                plainStrings.push(it);
            } else {
                markedStrings.push(it.value ?? "");
            }
        }
        // Signatures first, then comments.
        return [...markedStrings, ...plainStrings].join("\n\n").trim();
    }
    // MarkupContent
    return (c as { value?: string }).value?.trim() ?? "(empty hover)";
}

/**
 * Collapse a hover body into a one-line "signature". Handles the multi-line
 * fenced signatures servers return (ty wraps function signatures across
 * several lines inside a ```python block):
 *
 *   ```python
 *   def alpha(
 *       a: int,
 *       b: str
 *   ) -> bool
 *   ```
 *
 * becomes `def alpha(a: int, b: str) -> bool`. The rule: take the first
 * fenced code block (or, if there's no fence, the first non-blank line), join
 * its inner lines collapsing runs of whitespace into single spaces. Returns
 * "" for an empty hover so the caller can omit the label.
 *
 * NOTE: this helper is now used only as the fallback (when the server's
 * `detail` field is absent). For code_outline, `detail` is preferred (ccls
 * fills it, tsserver does not).
 */
export function hoverSignature(hoverText: string): string {
    const lines = hoverText.split(/\r?\n/);
    let inFence = false;
    const buf: string[] = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (/^```/.test(line)) {
            if (inFence) break; // closing fence → signature complete
            inFence = true; // opening fence → start collecting
            continue;
        }
        if (inFence) {
            if (line) buf.push(line);
            continue;
        }
        // No fence: take the first non-blank line as the signature.
        if (line) {
            return line;
        }
    }
    if (buf.length === 0) return "";
    return buf.join(" ").replace(/\s+/g, " ").trim();
}

/** Compare signature-shaped text while ignoring line wrapping and whitespace. */
function sameSignatureText(a: string, b: string): boolean {
    return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
}

/**
 * Remove a leading signature from a hover body after it has been promoted to
 * the labelled `signature:` line. Handles both a bare first line (ccls) and a
 * fenced first code block (ty/tsserver). The rest of the hover—documentation,
 * inferred-type notes, and additional blocks—is preserved.
 */
export function hoverBodyWithoutSignature(body: string, signature: string): string {
    if (!signature) return body;
    const lines = body.split(/\r?\n/);
    const first = lines.findIndex((line) => line.trim().length > 0);
    if (first < 0) return body;

    let remainderStart: number;
    if (/^```/.test(lines[first].trim())) {
        const closeOffset = lines.slice(first + 1).findIndex((line) => /^```/.test(line.trim()));
        if (closeOffset < 0) return body;
        const close = first + 1 + closeOffset;
        const fencedSignature = hoverSignature(lines.slice(first, close + 1).join("\n"));
        if (!sameSignatureText(fencedSignature, signature)) return body;
        remainderStart = close + 1;
    } else {
        if (!sameSignatureText(lines[first], signature)) return body;
        remainderStart = first + 1;
    }

    let remainder = lines.slice(remainderStart).join("\n").trim();
    // Language servers commonly put a markdown rule between the signature
    // block and docs. It is only a separator, so do not leave it orphaned.
    remainder = remainder.replace(/^([-*_])\1{2,}\s*(?:\r?\n|$)/, "").trim();
    return remainder;
}

/**
 * Extract a one-line doc snippet from a hover body — the first sentence of
 * the prose that FOLLOWS the signature fence. Mirrors the Emacs / PEP 257 /
 * Javadoc convention: the first line/sentence of a docstring is a short
 * summary.
 *
 * When the hover HAS a fenced code block (like ty/tsserver), `hoverSignature`
 * consumes the fenced block, and this helper takes the first non-blank prose
 * line after that fence closes. With no fence, the first non-blank line is the
 * doc unless an optional canonical `signature` matches it; a matching line is
 * skipped and a following real comment can become the summary.
 *
 * Cut at the first sentence boundary (`. ` / `! ` / `? `) and length-capped.
 * Returns "" when there's no prose after the fence (or no prose at all).
 */
export function hoverDocSnippet(hoverText: string, maxLen = 100, signature?: string): string {
    const lines = hoverText.split(/\r?\n/);
    let inFence = false;
    let fenceSeen = false;
    for (const raw of lines) {
        const line = raw.trim();
        if (/^```/.test(line)) {
            if (inFence) {
                inFence = false;
                fenceSeen = true;
                continue;
            }
            inFence = true;
            fenceSeen = true;
            continue;
        }
        if (inFence) continue; // inside the signature fence
        if (!line) continue;
        // Skip markdown horizontal rules (--- / *** / ___) — ty separates the
        // signature fence from the docstring prose with a `---` HR. Without
        // this guard the snippet would be `---` instead of the docstring.
        if (/^([-*_])\1{2,}$/.test(line)) continue;
        if (fenceSeen) {
            // First prose line after the signature fence → the summary.
            return trunc(firstSentence(line), maxLen);
        }
        // In the no-fence ccls form, the first line may be the same signature
        // already supplied by DocumentSymbol.detail. Skip it and keep looking
        // so a following comment is retained instead of being lost.
        if (signature && sameSignatureText(line, signature)) continue;
        return trunc(firstSentence(line), maxLen);
    }
    return "";
}

/** Cut `line` at the first sentence boundary (`. ` / `! ` / `? ` or end). */
function firstSentence(line: string): string {
    const m = line.match(/^(.+?[.!?])(?:\s|$)/);
    return m ? m[1] : line;
}

// ---------------------------------------------------------------------------
// Symbol kind naming + DocumentSymbol / SymbolInformation rendering
// ---------------------------------------------------------------------------

/** LSP SymbolKind (1-based) → short label. Index 0 is unused by the spec;
 * padded so names[kind] resolves correctly. Single source of truth for kind
 * naming AND the reverse lookup (`symbolKindFromName`, used by
 * code_search_symbol's public `kinds` filter). */
export const LSP_SYMBOL_KIND_NAMES: readonly string[] = [
    "",
    "File",
    "Module",
    "Namespace",
    "Package",
    "Class",
    "Method",
    "Property",
    "Field",
    "Constructor",
    "Enum",
    "Interface",
    "Function",
    "Variable",
    "Constant",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Key",
    "Null",
    "EnumMember",
    "Struct",
    "Event",
    "Operator",
    "TypeParameter",
];

/** LSP SymbolKind (1-based) → short label. */
export function symbolKindName(kind: number | undefined): string {
    if (kind == null || kind === 0) return "Symbol";
    return LSP_SYMBOL_KIND_NAMES[kind] ?? "Symbol";
}

/**
 * Reverse of `symbolKindName`: a friendly kind name (case-insensitive) → the
 * LSP SymbolKind number. Returns `undefined` for an unknown name. Used by
 * `code_search_symbol`'s public `kinds` parameter to map the agent's
 * kind strings (e.g. `"function"`, `"Method"`) back to LSP kind numbers so
 * they can be matched against `SymbolInformation.kind`.
 */
export function symbolKindFromName(name: string): number | undefined {
    const lower = name.toLowerCase();
    for (let i = 1; i < LSP_SYMBOL_KIND_NAMES.length; i++) {
        if (LSP_SYMBOL_KIND_NAMES[i].toLowerCase() === lower) return i;
    }
    return undefined;
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
    // Position column is grep-style `:line:col` (no parens) so the whole row
    // parses like a jump-target string — consistent with code_references rows,
    // diagnostics, and rg --column output. The leading `:` (no path, since the
    // path is implied by the outline's input file) keeps it visually a trailing
    // column while sharing the `line:col` grammar every other tool uses.
    lines.push(`${pad}${kindName} ${sym.name}${d}  :${pos}`);
    const children = (sym as unknown as { children?: DocumentSymbol[] }).children ?? [];
    for (const ch of children) renderDocSymbol(ch, depth + 1, lines);
}

/** Render a flat SymbolInformation (from workspace/symbol) as one line. */
export function renderSymbolInfo(
    s: SymbolInformation,
    selStart?: { line: number; character: number },
): string {
    const loc = s.location;
    const path = uriToPath(loc.uri);
    // selStart is the resolved identifier position (0-based LSP coords) when
    // available; falls back to the symbol range start otherwise. We print 1-based
    // so the output is directly reusable as input to code_hover/code_definition/
    // code_references (which expect 1-based and subtract 1 internally).
    const p = selStart ?? loc.range?.start;
    const pos = p ? `${p.line + 1}:${p.character + 1}` : "";
    // grep-style `path:line:col` — matches code_references rows, diagnostics,
    // error rows, and rg --column. The agent can split on `:` and feed the
    // position straight into code_hover/code_definition/code_references.
    return `${symbolKindName(s.kind)} ${s.name}  ${path}:${pos}`;
}

/**
 * Does a source snippet look like a definition BODY (as opposed to a bare
 * declaration/prototype)?
 *
 * Heuristic: the snippet contains an open-brace character. A function/method
 * body, a class/struct definition, and an inline header definition all contain
 * an open brace. A prototype, a forward declaration, and a using/typedef do
 * NOT. Used by code_definition to decide whether the resolved snippet is a
 * body (returned verbatim) or a declaration (prepend the preceding doc
 * comment, resolved separately via tree-sitter — see findEnclosingDefWithDoc).
 *
 * The check is deliberately simple: an open brace anywhere in the snippet.
 * Declarations of function-pointer parameters and templates contain no open
 * brace, so they correctly read as declarations. A lambda capture list only
 * appears inside a body, which already has one. Good enough for the cases this
 * tool serves.
 */
export function snippetHasBody(snippet: string): boolean {
    return snippet.includes("{");
}

// ---------------------------------------------------------------------------
// Location + Diagnostic rendering
// ---------------------------------------------------------------------------

/** Render a Location as `<path>:<line>:<col>` (1-based, grep-style).
 *
 * Matches the grammar of rg --column, compiler diagnostics, and every other
 * position string in the toolset, so a consumer splits on `:` uniformly. */
export function renderLocation(loc: Location): string {
    const start = loc.range?.start;
    const path = uriToPath(loc.uri);
    if (start) {
        // +1 to convert 0-based LSP coords to 1-based output (matches tool input contract).
        return `${path}:${start.line + 1}:${start.character + 1}`;
    }
    return path;
}

/**
 * Render a structured per-position soft-failure row. Format mirrors a data
 * row's column grammar so a consumer can split rows on `\n` and distinguish
 * data from error by the leading token (`ERROR` kind has no name column):
 *
 *   ERROR  <path>:<line>:<col>  <reason>
 *
 * `line`/`column` are 1-based (the tool's input contract). Use this ONLY for
 * actual failures: unknown language, cannot read, server unavailable, could
 * not read source, symbol scan failed. Do NOT use it for clean empty results
 * (no definition found, no references found) — those are legitimate outcomes,
 * not errors, and should be a parenthesized note like `(no references found
 * for …)` so an agent checking the leading token doesn't mistake "unused
 * symbol" for a failure. Top-level hard failures (scan/diagnostics: no
 * grammar, parse failed, cannot read, bad params, server unavailable) THROW
 * instead — index.ts's err() sets isError: true on those.
 */
export function renderErrorRow(path: string, line: number, column: number, reason: string): string {
    return `ERROR  ${path}:${line}:${column}  ${reason}`;
}

/** LSP DiagnosticSeverity (1-based) → short label. */
export function severityName(sev: number | undefined): string {
    switch (sev) {
        case 1:
            return "error";
        case 2:
            return "warning";
        case 3:
            return "info";
        case 4:
            return "hint";
        default:
            return "message";
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
// File extension → language
// ---------------------------------------------------------------------------
//
// Lives in the neutral catalog (src/languages/catalog.ts), which derives
// `EXT_LANG` and `langForFile` from `LANGUAGES.sourceExts`. Re-exported at
// the top of this file so existing consumers keep importing them from here.
