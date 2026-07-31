/**
 * code_definition — retrieve the verbatim source body of a symbol's
 * definition, ready to copy into an edit. Output format (single site):
 *
 *   <defPath>:<sl>-<el>
 *   <body verbatim from source code>
 *   <optional sym table when list_symbols=true>
 *
 * A position may resolve to MULTIPLE definition sites (overloads,
 * multi-definition symbols, header-vs-source in C++, re-exports); the tool
 * reports every site, one block per site, separated by a blank line with a
 * trailing `# N definitions` count.
 *
 * Error contract: HARD failures THROW (index.ts's err() sets isError: true).
 * There are NO fallbacks and NO soft-failure rows — if we cannot return
 * verbatim source code for any reason, the tool fails loudly. See
 * docs/code_definition.md.
 */

import { readFile } from "node:fs/promises";
import type { DocumentSymbol, Location } from "vscode-languageserver-protocol";
import type { LspClient } from "./lsp-client";
import {
    awaitReadyForQuery,
    ClientProvider,
    UnknownLanguageError,
    validatePosition,
} from "./nav-core";
import {
    findDocSymbolBySelStart,
    langForFile,
    resolveDefBodyRange,
    snippetHasBody,
    toAbs,
    uriToPath,
} from "./render";
import {
    findEnclosingDefWithDoc,
    parseSymbols,
    renderSymbolTable,
    tsLangForFile,
} from "./tree-sitter-parse";

export interface DefinitionParams {
    path: string;
    line: number; // 1-based
    column: number; // 1-based
    list_symbols?: boolean;
}

export async function definition(
    params: DefinitionParams,
    cwd: string,
    clientOf: ClientProvider,
): Promise<string> {
    validatePosition(params.line, params.column);
    const lang = langForFile(params.path);
    if (lang === null) throw new UnknownLanguageError(params.path);
    const abs = toAbs(params.path, cwd);
    let text: string;
    try {
        text = await readFile(abs, "utf8");
    } catch (e) {
        // Hard failure: cannot read the input file. Throw so index.ts's err()
        // sets isError: true — no fallback, no partial result.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        // Hard failure: the language server could not be spawned. No source
        // code can be retrieved without it.
        throw new Error(`${lang}: server unavailable: ${e}`);
    }
    // Wait for ccls to finish indexing this TU before querying. On a cold
    // cache, textDocument/definition bounces to the declaration and
    // documentSymbol returns stale {0:0} ranges because ccls's preamble
    // session for this file isn't ready yet. diagnostics() does the same.
    await awaitReadyForQuery(lang, client, abs, text);
    // STEP 0 — documentSymbol fast path (the ccls bounce fix).
    //
    // ccls's textDocument/definition, when the cursor is ON a C++ function
    // DEFINITION (out-of-line .cpp member, template specialization, etc.),
    // bounces to the header DECLARATION instead of returning the def position.
    // The editor "go to definition" does the same — it's a ccls quirk in
    // getNonDefDeclarations (textDocument_definition.cc: on_def → returns
    // the non-def declarations). This bounce means we'd render the header
    // prototype, not the cpp body the agent asked for.
    //
    // Fix: before calling textDocument/definition, fetch documentSymbol for
    // THIS file (ccls parses the opened file locally — equivalent to
    // tree-sitter, no per-language grammar needed) and find the symbol whose
    // selectionRange.start == cursor. If that symbol's source range has a body
    // (contains `{` — a real definition, not a prototype), return it directly
    // and skip textDocument/definition entirely → no bounce. If the symbol at
    // the cursor is a declaration (no body), fall through to
    // textDocument/definition, which correctly jumps declaration→definition.
    // If the cursor isn't on any symbol in this file (e.g. a call site, or
    // whitespace), also fall through to textDocument/definition.
    const cursor = { line: params.line - 1, character: params.column - 1 };
    // When step 0 finds a DECLARATION (no body) at the cursor, remember its
    // range in the input file. If textDocument/definition then returns empty
    // (ccls only resolves use→def, never decl→decl — so a cursor ON a
    // header-only third-party declaration yields `[]`), we fall back to
    // rendering that declaration + its preceding doc comment from the input
    // file instead of throwing "No definition found". The doc comment is
    // resolved by findEnclosingDefWithDoc inside renderSnippetBlock.
    let declInInput: { sl: number; el: number } | null = null;
    try {
        const syms = await client.documentSymbols(abs, text);
        const flat =
            syms.length > 0 && "selectionRange" in syms[0] ? (syms as DocumentSymbol[]) : [];
        const atCursor = findDocSymbolBySelStart(flat, cursor);
        if (atCursor?.range?.start && atCursor?.range?.end) {
            const sl = atCursor.range.start.line;
            const el = atCursor.range.end.line;
            const srcLines = text.split(/\r?\n/);
            const snippet = srcLines.slice(sl, el + 1).join("\n");
            if (snippetHasBody(snippet)) {
                // Cursor is on a body-bearing symbol in this file → it IS the
                // definition. Render it directly; skip textDocument/definition
                // (which would bounce to the declaration for ccls).
                return renderSnippetBlock(client, abs, sl, el, text, params.list_symbols ?? false);
            }
            // Declaration (no body): remember it for the empty-locs fallback.
            declInInput = { sl, el };
        }
    } catch {
        // documentSymbol failed (e.g. ccls "not indexed" on an un-indexed
        // header — deferred to a future session's tree-sitter fallback).
        // Fall through to textDocument/definition.
    }
    const def = await client.definition(abs, params.line - 1, params.column - 1, text);
    const locs = (Array.isArray(def) ? def : def ? [def] : []) as Location[];
    if (locs.length === 0) {
        // ccls's textDocument/definition only resolves use→def, never
        // decl→decl: a cursor ON a header-only declaration (no out-of-line
        // definition exists — third-party / stdlib / header-only library)
        // returns `[]`. Step 0 already located the declaration in the input
        // file in that case (declInInput). Fall back to rendering that
        // declaration + its preceding doc comment from the input file so the
        // agent gets the docstring instead of a hard "No definition found"
        // error. renderSnippetBlock prepends the doc comment via
        // findEnclosingDefWithDoc (tree-sitter, no LSP round-trip).
        if (declInInput) {
            return renderSnippetBlock(
                client,
                abs,
                declInInput.sl,
                declInInput.el,
                text,
                params.list_symbols ?? false,
                { line: params.line, column: params.column },
            );
        }
        // Hard failure: no definition found and the cursor isn't on a
        // declaration in this file either (e.g. a use of a built-in, or
        // whitespace). The tool's contract is "returns verbatim source code";
        // the absence of a definition means we cannot fulfill it. No
        // parenthesized-note fallback — throw so the agent knows it got
        // nothing reusable and can try another approach (code_hover,
        // code_search_symbol, etc.).
        throw new Error(`No definition found for ${params.path}:${params.line}:${params.column}`);
    }
    // ccls enclosing-parent scope guard: when the cursor is on a C++
    // declaration that has no out-of-line definition (e.g. a constructor
    // declaration inside a struct, with no {}-body), textDocument/definition
    // returns the enclosing struct/class identifier position (the nearest
    // "definition" ancestor) instead of the declaration itself. The locs are
    // non-empty but point to the parent scope in the same file — returning
    // the parent body (the whole struct) for a member declaration is wrong.
    //
    // Detection: if step 0 found a declInInput (declaration at cursor, no
    // body) AND every loc is in the same file AND its start line is strictly
    // BEFORE declInInput.sl, the locs point to an enclosing parent scope.
    // Fall back to rendering the declaration itself (declInInput). A loc at
    // or after declInInput.sl is a genuine cross-declaration jump (e.g.
    // forward declaration → out-of-line definition later in the same file)
    // and is kept as-is.
    if (declInInput && locs.length > 0) {
        const allEnclosingParent = locs.every((loc) => {
            const p = uriToPath(loc.uri);
            return (
                p === abs &&
                loc.range?.start?.line != null &&
                loc.range.start.line < declInInput!.sl
            );
        });
        if (allEnclosingParent) {
            return renderSnippetBlock(
                client,
                abs,
                declInInput.sl,
                declInInput.el,
                text,
                params.list_symbols ?? false,
                { line: params.line, column: params.column },
            );
        }
    }
    // A position may resolve to multiple definition sites (overloads,
    // multi-definition symbols, header-vs-source in C++, re-exports). This is
    // a legitimate, common LSP outcome — `textDocument/definition` returns a
    // Location[] and we report every site rather than refusing the call.
    //
    // Output is ONE block per site, each using the SAME header grammar as
    // the single-site case (`<defPath>:<sl>-<el>\n<body>`), so a single-site result
    // is byte-identical to today. Blocks are separated by a blank line, and a
    // trailing `# N definitions` count follows the last block (mirroring
    // code_references' trailing-count convention). The agent gets every body
    // and can pick the one it meant.
    const blocks: string[] = [];
    for (const loc of locs) {
        const block = await renderDefinitionBlock(client, loc, params.list_symbols ?? false);
        blocks.push(block);
    }
    // Single site: no separator, no count — byte-identical to the old contract.
    // Multiple sites: blank-line-separated blocks + trailing count.
    if (blocks.length === 1) return blocks[0];
    return (
        blocks.join("\n\n") +
        `\n# ${blocks.length} definitions for ${params.path}:${params.line}:${params.column}`
    );
}

/**
 * Render a definition snippet as `<defPath>:<sl>-<el>\n<body>[\n\n<sym table>]`.
 *
 * Shared by the documentSymbol fast path (step 0, which already has the
 * body range) and renderDefinitionBlock (which resolves the range from a
 * textDocument/definition Location). `sl`/`el` are 0-based LSP line numbers
 * of the body range; `src` is the source text of the file the body lives in;
 * `defPath` is that file's path (for the header line and the symbol table).
 * Throws a hard error on a symbol-scan failure (list_symbols only) — there
 * are no fallbacks, since the tool's contract is verbatim source code or
 * failure.
 *
 * Doc-comment prefix: when the snippet has NO body (it's a declaration /
 * prototype, e.g. a third-party header-only API), prepend the preceding doc
 * comment (slash-star star, triple-slash, or bang-slash-slash) so the agent
 * gets the docstring. Resolved with findEnclosingDefWithDoc (tree-sitter,
 * local parse — works on un-indexed headers without an LSP round-trip).
 * `docAnchor` is a 1-based position inside the declaration used to anchor
 * the tree-sitter lookup (the identifier column when known from the LSP
 * Location, else the cursor position from the tool input, else the start of
 * the snippet line). Bodies are returned verbatim — the snippetHasBody gate
 * stays.
 */
async function renderSnippetBlock(
    client: LspClient,
    defPath: string,
    sl: number,
    el: number,
    src: string,
    listSymbols: boolean,
    docAnchor?: { line: number; column: number }, // 1-based, inside the declaration
): Promise<string> {
    const srcLines = src.split(/\r?\n/);
    let snippet = srcLines.slice(sl, el + 1).join("\n");
    let renderSl = sl; // start line actually rendered (0-based) — may move up
    // to include a preceding doc comment.
    if (!snippetHasBody(snippet)) {
        // Declaration (prototype): try to prepend the preceding doc comment.
        // findEnclosingDefWithDoc parses the file locally with tree-sitter so
        // it works on un-indexed third-party headers (no LSP round-trip). On
        // any failure (no grammar, parse error, no preceding comment) we
        // return the bare declaration — strictly better than throwing.
        const tsLang = tsLangForFile(defPath);
        if (tsLang) {
            try {
                const anchor = docAnchor ?? { line: sl + 1, column: 1 };
                const enc = await findEnclosingDefWithDoc(tsLang, src, anchor.line, anchor.column);
                if (
                    enc &&
                    enc.docStartLine != null &&
                    enc.docEndLine != null &&
                    enc.docStartLine < sl
                ) {
                    // Extend the snippet UPWARD to include the doc comment.
                    // Keep LSP's `el` as the declaration's end (the doc range
                    // and LSP range come from different parses; only the
                    // upward extension is safe — overlapping downward risks
                    // pulling in trailing lines LSP didn't intend).
                    renderSl = enc.docStartLine;
                    snippet = srcLines.slice(renderSl, el + 1).join("\n");
                }
            } catch {
                // tree-sitter parse failed — fall through with the bare
                // declaration (renderSl == sl, snippet unchanged).
            }
        }
    }
    const out: string[] = [];
    // Header: <defPath>:<sl>-<el> (1-based inclusive line range of the body).
    // defPath is the path the definition lives in — relative or absolute as
    // the server returned it (the agent can feed it back into code_* tools).
    out.push(`${defPath}:${renderSl + 1}-${el + 1}`);
    out.push(snippet);
    // Optional tree-sitter symbol table over the snippet. Reuses the same
    // parseSymbols helper as code_scan. The snippet's absolute line range is
    // (renderSl+1 .. el+1) in 1-based coords. Only run when requested: default
    // false keeps code_definition's output focused on the verbatim body.
    if (listSymbols) {
        const tsLang = tsLangForFile(defPath);
        if (tsLang) {
            try {
                const entries = await parseSymbols(tsLang, {
                    text: src,
                    startLine: renderSl + 1,
                    endLine: el + 1,
                });
                if (entries && entries.length > 0) {
                    // Blank line separates the verbatim body from the symbol
                    // table so an agent can unambiguously tell where the body
                    // ends and the table begins (the body itself may contain
                    // lines that look table-like).
                    out.push("");
                    out.push(renderSymbolTable(defPath, renderSl + 1, el + 1, entries));
                }
            } catch (e) {
                // Hard failure: the symbol scan failed. The verbatim body was
                // already retrieved (the primary contract), but list_symbols
                // is an explicit request the agent is relying on — surface the
                // failure rather than silently omitting the table.
                throw new Error(
                    `symbol scan failed for ${defPath}:${renderSl + 1}-${el + 1}: ${e}`,
                );
            }
        }
    }
    return out.join("\n");
}

/**
 * Render one definition site as `<defPath>:<sl>-<el>\n<body>[\n\n<sym table>]`.
 *
 * Reads the definition's source file, resolves the enclosing DocumentSymbol to
 * the full body range (the server's Location is usually just the identifier
 * span), slices the raw source, and optionally appends a tree-sitter symbol
 * table over the body. Throws a hard error on any per-site failure (cannot
 * read source, cannot resolve body, symbol scan failed) — there are no
 * fallbacks, since the tool's contract is verbatim source code or failure.
 */
async function renderDefinitionBlock(
    client: LspClient,
    loc: Location,
    listSymbols: boolean,
): Promise<string> {
    const defPath = uriToPath(loc.uri);
    let src: string;
    try {
        src = await readFile(defPath, "utf8");
    } catch (e) {
        // Hard failure: the definition's source file can't be read (e.g. a
        // server pointed at a stale or unreadable path). No fallback.
        throw new Error(`Cannot read definition source ${defPath}: ${e}`);
    }
    // The definition range from the server is usually just the identifier
    // span (e.g. the 9 chars of `punintend`). Resolve the enclosing
    // DocumentSymbol to extract the full function/class body range.
    const body = await resolveDefBodyRange(client, loc);
    if (!body) {
        // Hard failure: could not resolve the enclosing symbol's body range.
        // Without it we'd return only the identifier span, which is NOT the
        // verbatim source body the tool promises — so fail rather than return
        // a misleading snippet.
        throw new Error(`Could not resolve definition body for ${defPath}`);
    }
    return renderSnippetBlock(
        client,
        defPath,
        body.startLine,
        body.endLine,
        src,
        listSymbols,
        // Anchor the doc-comment lookup at the definition's identifier
        // position (1-based) so tree-sitter walks up from the right token.
        { line: body.startLine + 1, column: (loc.range?.start?.character ?? 0) + 1 },
    );
}
