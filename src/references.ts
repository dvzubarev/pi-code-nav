/**
 * code_references — all semantic references/usages of the symbol at
 * (path, line, column), including its declaration. By default each paginated
 * result includes AST-aware source context, its syntactic role, and the
 * enclosing symbol's reusable position. `context: "none"` preserves the
 * compact location-only survey format. A clean empty result is not an error;
 * operational failures throw. See docs/code_references.md.
 */

import { readFile } from "node:fs/promises";
import type { LspClient } from "./lsp-client";
import {
    awaitReadyForQuery,
    ClientProvider,
    UnknownLanguageError,
    validatePosition,
} from "./nav-core";
import { langForFile, renderLocation, toAbs, uriToPath } from "./render";
import {
    ALL_SYMBOL_ROLES,
    annotateNumberedSource,
    parseSymbols,
    referenceSyntaxContext,
    ReferenceContextMode,
    type SymbolEntry,
    type TsLang,
    tsLangForFile,
} from "./tree-sitter-parse";

export interface ReferencesParams {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
    /** Source context mode. Defaults to "syntax". */
    context?: "none" | ReferenceContextMode;
    /** 1-based reference offset. Defaults to 1. */
    offset?: number;
    /** Maximum references returned. Defaults to 25; hard cap 200. */
    limit?: number;
    /** Add compact name/column/role annotations below contextual source lines. */
    list_symbols?: boolean;
}

const DEFAULT_REFERENCE_LIMIT = 25;
const MAX_REFERENCE_LIMIT = 200;
/** Keep a default contextual page below pi's tool-output truncation threshold. */
const CONTEXT_PAGE_BUDGET_CHARS = 36_000;

/** Trim one pathological block without ever dropping the referenced line.
 * Structural skeletons can place that line between a signature and footer, so
 * a simple prefix cut would defeat the purpose of `context: "enclosing"`. */
function truncateContextBlock(block: string, budget: number, focusLine: number, focusColumn: number): string {
    if (block.length <= budget) return block;
    const lines = block.split("\n");
    const sourceStart = lines.findIndex((line) => /^\d+ \| /.test(line));
    const focus = lines.findIndex((line) => line.startsWith(`${focusLine} | `));
    if (sourceStart < 0 || focus < 0) {
        return `${block.slice(0, budget)}\n... | … context truncated for page budget …`;
    }

    const keep = new Set<number>();
    for (let i = 0; i < sourceStart; i++) keep.add(i); // location + metadata
    for (let i = Math.max(sourceStart, focus - 2); i <= Math.min(lines.length - 1, focus + 2); i++) keep.add(i);
    // Retain enough of the structural signature/footer to explain the sparse
    // middle when budget permits.
    for (let i = sourceStart; i < Math.min(lines.length, sourceStart + 3); i++) keep.add(i);
    for (let i = Math.max(sourceStart, lines.length - 2); i < lines.length; i++) keep.add(i);

    const renderKept = () => {
        const indexes = [...keep].sort((a, b) => a - b);
        const out: string[] = [];
        for (let i = 0; i < indexes.length; i++) {
            if (i > 0 && indexes[i] > indexes[i - 1] + 1) out.push("... | … context truncated for page budget …");
            out.push(lines[indexes[i]]);
        }
        return out.join("\n");
    };
    let out = renderKept();
    // Neighbouring context is optional; the location/metadata and exact
    // referenced source line are not.
    for (const index of [...keep]) {
        if (out.length <= budget) break;
        if (index >= sourceStart && index !== focus) {
            keep.delete(index);
            out = renderKept();
        }
    }
    if (out.length <= budget) return out;
    const prefix = lines.slice(0, sourceStart).join("\n");
    const marker = "... | … context truncated for page budget …";
    const fixed = `${prefix}\n${marker}\n`;
    const focusPrefix = `${focusLine} | `;
    const sourceLine = lines[focus].startsWith(focusPrefix)
        ? lines[focus].slice(focusPrefix.length)
        : lines[focus];
    const available = Math.max(80, budget - fixed.length - focusPrefix.length - 2);
    const start = Math.max(0, Math.min(focusColumn - Math.floor(available / 2), sourceLine.length - available));
    const excerpt = sourceLine.slice(start, start + available);
    return `${fixed}${focusPrefix}${start > 0 ? "…" : ""}${excerpt}${start + available < sourceLine.length ? "…" : ""}`;
}

function validatePagination(params: ReferencesParams): { offset: number; limit: number } {
    const offset = params.offset ?? 1;
    const limit = params.limit ?? DEFAULT_REFERENCE_LIMIT;
    if (!Number.isInteger(offset) || offset < 1) throw new Error("offset must be an integer >= 1");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REFERENCE_LIMIT) {
        throw new Error(`limit must be an integer between 1 and ${MAX_REFERENCE_LIMIT}`);
    }
    if (params.context !== undefined && !["none", "syntax", "enclosing"].includes(params.context)) {
        throw new Error('context must be one of: "none", "syntax", "enclosing"');
    }
    if (params.list_symbols && params.context === "none") {
        throw new Error('list_symbols requires context "syntax" or "enclosing"');
    }
    return { offset, limit };
}

/** Parse only source rows that survived contextual/skeleton rendering. */
async function symbolsForRenderedSource(
    lang: TsLang,
    text: string,
    numberedSource: string,
): Promise<SymbolEntry[]> {
    const rows = numberedSource
        .split("\n")
        .map((line) => /^(\d+) \| /.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => Number(match[1]));
    if (rows.length === 0) return [];
    const unique = [...new Set(rows)].sort((a, b) => a - b);
    const ranges: Array<{ start: number; end: number }> = [];
    for (const row of unique) {
        const last = ranges[ranges.length - 1];
        if (last && row === last.end + 1) last.end = row;
        else ranges.push({ start: row, end: row });
    }
    const discovered = (
        await Promise.all(
            ranges.map((range) =>
                parseSymbols(lang, {
                    text,
                    startLine: range.start,
                    endLine: range.end,
                    roles: ALL_SYMBOL_ROLES,
                }),
            ),
        )
    ).flatMap((entries) => entries ?? []);
    return discovered;
}

export async function references(
    params: ReferencesParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    validatePosition(params.line, params.column);
    const { offset, limit } = validatePagination(params);
    const context = params.context ?? "syntax";
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        throw new Error(`${lang}: server unavailable: ${e}`);
    }
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    // Wait for ccls to finish indexing this TU before querying references.
    // On a cold cache, cross-TU usages can be missing until indexing finishes.
    await awaitReadyForQuery(lang, client, abs, text);
    const refs = await client.references(abs, params.line - 1, params.column - 1, text);
    if (refs.length === 0) {
        // Clean empty result (the symbol has no references) — NOT a failure.
        // Kept as a parenthesized note (matching outline/diagnostics/scan's
        // empty-result convention) rather than an ERROR row, so an agent
        // checking the leading token doesn't mistake a legitimate "unused
        // symbol" for a failure.
        return `(no references found for ${params.path}:${params.line}:${params.column})`;
    }
    const page = refs.slice(offset - 1, offset - 1 + limit);
    if (page.length === 0) {
        return `(no references at offset ${offset}; ${refs.length} total references)`;
    }

    let rendered: string[];
    if (context === "none") {
        rendered = page.map((r) => renderLocation(r));
    } else {
        const fileCache = new Map<string, Promise<string>>();
        rendered = await Promise.all(
            page.map(async (ref) => {
                const location = renderLocation(ref);
                const refPath = uriToPath(ref.uri);
                const tsLang = tsLangForFile(refPath);
                if (!tsLang) return location;
                let source = fileCache.get(refPath);
                if (!source) {
                    source = readFile(refPath, "utf8");
                    fileCache.set(refPath, source);
                }
                try {
                    const sourceText = await source;
                    const ast = await referenceSyntaxContext(
                        tsLang,
                        sourceText,
                        ref.range.start.line,
                        ref.range.start.character,
                        context,
                    );
                    if (!ast) return location;
                    const metadata = ast.enclosing
                        ? `enclosing: ${ast.enclosing.name}  ${refPath}:${ast.enclosing.line}:${ast.enclosing.column}\n`
                        : "";
                    let renderedSource = ast.source;
                    if (params.list_symbols) {
                        try {
                            const entries = await symbolsForRenderedSource(
                                tsLang,
                                sourceText,
                                ast.source,
                            );
                            renderedSource = annotateNumberedSource(ast.source, sourceText, entries);
                        } catch (e) {
                            renderedSource += `\nsymbols: ERROR ${e}`;
                        }
                    }
                    return `${location}\n${metadata}kind: ${ast.kind}\n\n${renderedSource}`;
                } catch {
                    // A reference may point into a generated, deleted, or
                    // unsupported external file. Keep the semantically useful
                    // LSP location rather than failing every result.
                    return location;
                }
            }),
        );
        // A page of 25 pathological template expressions must not consume
        // 25 × the per-expression cap. Divide a page budget fairly while
        // leaving small/normal constructs untouched.
        const perResultBudget = Math.max(220, Math.floor(CONTEXT_PAGE_BUDGET_CHARS / page.length));
        rendered = rendered.map((block, index) =>
            truncateContextBlock(
                block,
                perResultBudget,
                page[index].range.start.line + 1,
                page[index].range.start.character,
            ),
        );
    }

    const end = offset + page.length - 1;
    const count =
        offset === 1 && end === refs.length
            ? `# ${refs.length} references`
            : `# showing references ${offset}-${end} of ${refs.length}`;
    return rendered.join(context === "none" ? "\n" : "\n\n") + `\n${count}`;
}
