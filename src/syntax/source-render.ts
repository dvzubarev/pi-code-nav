/**
 * Source and symbol-table rendering (subsystem 5 of the tree-sitter support,
 * previously a section of `../tree-sitter-parse.ts`).
 */

import type { SymbolEntry } from "./types";

/** Render a contiguous 1-based line range with the shared source gutter. */
export function renderNumberedSource(
    text: string,
    startLine: number,
    endLine: number,
    entries: SymbolEntry[] = [],
): string {
    const sourceLines = text.split(/\r?\n/);
    const numbered = sourceLines
        .slice(startLine - 1, endLine)
        .map((line, index) => `${startLine + index} | ${line}`)
        .join("\n");
    return annotateNumberedSource(numbered, text, entries);
}

/**
 * Add compact, line-local navigation metadata without modifying source text.
 * `numberedSource` may be contiguous definition output or the sparse source
 * skeleton produced for references. Only symbols whose original token is
 * actually visible on a rendered line are included.
 *
 *   43 | return build(value);
 *      | symbols: build@12 call, value@18 var
 */
export function annotateNumberedSource(
    numberedSource: string,
    originalText: string,
    entries: SymbolEntry[],
): string {
    if (entries.length === 0) return numberedSource;
    const originalLines = originalText.split(/\r?\n/);
    const out: string[] = [];
    for (const rendered of numberedSource.split("\n")) {
        out.push(rendered);
        const match = /^(\d+) \| (.*)$/.exec(rendered);
        if (!match) continue;
        const line = Number(match[1]);
        const shown = match[2];
        const original = originalLines[line - 1];
        if (original === undefined || shown.length === 0) continue;
        const shownIndex = original.indexOf(shown);
        if (shownIndex < 0) continue; // truncated/marker line, not verbatim source
        const shownStartByte = Buffer.byteLength(original.slice(0, shownIndex), "utf8");
        const shownEndByte = shownStartByte + Buffer.byteLength(shown, "utf8");
        const visible = entries.filter((entry) => {
            if (entry.line !== line) return false;
            const startByte = entry.column - 1;
            const endByte = startByte + Buffer.byteLength(entry.name, "utf8");
            return startByte >= shownStartByte && endByte <= shownEndByte;
        });
        if (visible.length === 0) continue;
        const gutter = " ".repeat(match[1].length);
        out.push(
            `${gutter} | symbols: ${visible
                .map((entry) => `${entry.name}@${entry.column} ${entry.role}`)
                .join(", ")}`,
        );
    }
    return out.join("\n");
}

/**
 * Render the standalone code_scan symbol table. Definition/reference snippets
 * use line-local annotations instead, but code_scan keeps this compact survey
 * format because it has no source body to annotate.
 */
export function renderSymbolTable(
    path: string,
    startLine: number,
    endLine: number,
    entries: SymbolEntry[],
    docs?: Map<string, string>,
): string {
    if (entries.length === 0) {
        return `Symbols in ${path}:${startLine}-${endLine} (roles: type|call|member|import|var, 1-based, reusable as code_* input):\n  (no identifiers found)`;
    }
    const lines: string[] = [
        `Symbols in ${path}:${startLine}-${endLine} (roles: type|call|member|import|var, 1-based, reusable as code_* input):`,
    ];
    // Column widths for alignment: role is max 6 chars ("member"), name varies.
    // The path is NOT repeated per row — the header already states it, and the
    // row's `:line:col` plus the header path reconstructs the full position.
    // This matters for nix-store / site-packages paths, where repeating a long
    // absolute path on every row is pure context-window tax.
    const nameWidth = Math.max(...entries.map((e) => e.name.length));
    for (const e of entries) {
        // grep-style `:line:col` (no parens) — matches every other position
        // string in the toolset so a consumer splits on `:` uniformly. The path
        // is NOT repeated per row (header states it); `:line:col` + header path
        // reconstructs the full position.
        const loc = `${e.line}:${e.column}`;
        const doc = docs?.get(`${e.name}|${e.role}`);
        const label = doc ? `  ${doc}` : "";
        lines.push(`  ${e.role.padEnd(6)} ${e.name.padEnd(nameWidth)}  :${loc}${label}`);
    }
    return lines.join("\n");
}

/**
 * First substantive line of a hover text, for the optional include_docs label
 * column. Skips leading markdown code fences (```python / ```xml / ```) and
 * blank lines so the label is the actual signature/summary, not a fence line.
 * Returns "" for an empty hover so the caller can omit the label column.
 */
export function hoverFirstLine(hoverText: string): string {
    const lines = hoverText.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // Skip markdown code fences (```python, ```xml, ```, etc.).
        if (/^```/.test(line)) continue;
        return trunc(line, 80);
    }
    return "";
}

function trunc(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
}
