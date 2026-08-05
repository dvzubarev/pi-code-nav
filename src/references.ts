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
import { referenceSyntaxContext, ReferenceContextMode, tsLangForFile } from "./tree-sitter-parse";

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
}

const DEFAULT_REFERENCE_LIMIT = 25;
const MAX_REFERENCE_LIMIT = 200;
/** Keep a default contextual page below pi's tool-output truncation threshold. */
const CONTEXT_PAGE_BUDGET_CHARS = 36_000;

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
    return { offset, limit };
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
                    return `${location}\n${metadata}kind: ${ast.kind}\n\n${ast.source}`;
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
        rendered = rendered.map((block) => {
            if (block.length <= perResultBudget) return block;
            const cut = block.lastIndexOf("\n", perResultBudget);
            return `${block.slice(0, cut > 0 ? cut : perResultBudget)}\n... | … context truncated for page budget …`;
        });
    }

    const end = offset + page.length - 1;
    const count =
        offset === 1 && end === refs.length
            ? `# ${refs.length} references`
            : `# showing references ${offset}-${end} of ${refs.length}`;
    return rendered.join(context === "none" ? "\n" : "\n\n") + `\n${count}`;
}
