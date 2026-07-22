/**
 * code_outline — paginated structural overview of a source file with
 * signatures, body line ranges, and a one-line doc snippet per entry.
 *
 * Merges the old code_tree's signature-enrichment (parallel LSP hover) into
 * code_outline's allowlist-scoped overview. The old split (outline = bare
 * overview, tree = pattern + signatures) is gone: one tool, paginated, with
 * everything the agent needs to decide whether to go deeper. The cap bounds
 * the hover cost (N parallel hovers per page ≈ N×4ms) that previously made
 * per-row hover unaffordable for a full-file overview. See docs/code_outline.md.
 *
 * Output row format (1-based, grep-style `:line:col` grammar so it is
 * directly reusable as input to code_hover/code_definition/code_references):
 *
 *   <pad><Kind> <name>  <signature>  :<sl>-<el>:<col>  docs: <summary>
 *
 *   - <sl>-<el> is the symbol's full body range (DocumentSymbol.range), so a
 *     function with a body shows `:15-42:3` and a flat declaration shows
 *     `:10-10:3`. <col> is the selectionRange (identifier) column on <sl>.
 *   - <signature> comes from the hover (collapsed to one line by
 *     `hoverSignature`); falls back to the server `detail` field when the
 *     hover yields no signature (ccls fills `detail` even when hover is bare).
 *   - docs: <summary> is the first sentence of the docstring prose following
 *     the signature fence (PEP 257 / Javadoc convention), via
 *     `hoverDocSnippet`. Omitted when empty.
 *
 * Pagination: `offset` (1-based, default 1) and `limit` (default 20) page by
 * RENDERED ROWS (every kept node in the pruned tree, flattened). When a page
 * opens mid-class (the previous page ended inside a class's members), the
 * orphaned rows get a re-emitted ancestor header marked `(cont.)` as context
 * — so the agent never sees indented members with no parent. The trailing
 * message `[N more entries in <path>. Use offset=<next> to continue.]` mirrors
 * pi's `read` tool idiom.
 */

import { readFile } from "node:fs/promises";
import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";
import { awaitReadyForQuery, ClientProvider, UnknownLanguageError } from "./nav-core";
import {
    hoverDocSnippet,
    hoverSignature,
    hoverText,
    langForFile,
    renderSymbolInfo,
    symbolKindName,
    toAbs,
    trunc,
} from "./render";

export interface OutlineParams {
    path: string;
    /** 1-based start entry (mirrors pi `read`'s offset). Default 1. */
    offset?: number;
    /** Max rendered content rows per page (ancestor context rows are extra).
     * Default 20 — bounds the parallel-hover cost. */
    limit?: number;
}

/** Default page size. Bounds N parallel hovers per call (≈ N×4ms). */
const DEFAULT_LIMIT = 20;

/** Absolute cap on `limit` — prevents an agent from requesting 10000 rows
 * and paying for 10000 hovers. */
const MAX_LIMIT = 200;

/**
 * LSP SymbolKind values `code_outline` keeps. The tool's stated purpose is
 * "functions, classes, methods" — an allowlist is more honest than a
 * denylist of noisy kinds: it says exactly what the overview shows rather
 * than what it happens to hide. Kept:
 *
 *   5  Class        9  Constructor  12 Function       23 Struct
 *   6  Method       11 Interface
 *
 * Property(7)/Field(8) are deliberately DROPPED. They sound structural but
 * aren't reliably so: tsserver emits `Property` for object-literal keys
 * (e.g. every field of a `registerTool({...})` call or a returned object
 * literal), which floods the outline with non-structural noise. ty/ccls use
 * Field(8) only for real class/struct fields, but even there a field list is
 * rarely what a "compact overview" wants — the agent can expand a class to
 * see its members. Dropping 7/8 keeps the outline to the callable/type-
 * declaration surface. Constructor is a kind of method. Dropped: Variable(13),
 * Constant(14), Property(7), Field(8), and everything else (Enum/Namespace/etc.
 * — none appear in practice for our servers; if one ever does, dropping it is
 * the safe default for a "compact overview"). See docs/code_outline.md.
 *
 * CONTAINER_KINDS: Namespace(3), Module(2), Package(4) — structural containers
 * whose children are lifted to the parent level with a `parent::` prefix when
 * the container itself is not in OUTLINE_KEEP_KINDS. This lets code_outline
 * show functions/classes inside `namespace diskann { }` as `diskann::block_convert`.
 */
export const OUTLINE_KEEP_KINDS = new Set([5, 6, 9, 11, 12, 23]);

/** Kinds whose children are lifted to parent level with a `parent::` prefix. */
export const CONTAINER_KINDS = new Set([2, 3, 4]); // Module, Namespace, Package

/**
 * Prune a DocumentSymbol tree to nodes whose kind is in `keep`, recursing
 * into kept nodes' children.
 *
 * Nodes with `CONTAINER_KINDS` (Namespace/Module/Package) are unwrapped:
 * their children are lifted to the parent level with a `name::` prefix on
 * the child's name. Nested containers accumulate the prefix
 * (`ns1::ns2::fn`). This lets code_outline show functions inside
 * `namespace diskann { }` as `diskann::block_convert` instead of silently
 * dropping them.
 *
 * Kept nodes (Class/Method/Function/…) have their name prefixed and their
 * children pruned recursively (with an empty prefix — the container prefix
 * is NOT inherited past a kept boundary, so a class inside a namespace
 * becomes `diskann::Foo` but its methods stay `method`, not `diskann::Foo::method`).
 */
export function pruneDocSymbolTree(
    syms: DocumentSymbol[],
    keep: Set<number>,
    containers: Set<number>,
    namePrefix = "",
): DocumentSymbol[] {
    const out: DocumentSymbol[] = [];
    for (const s of syms) {
        const kind = (s as unknown as { kind?: number }).kind ?? 0;
        const children = (s as unknown as { children?: DocumentSymbol[] }).children;

        if (keep.has(kind)) {
            // Keep this node with accumulated name prefix, reset prefix for children
            const n = namePrefix + s.name;
            const sym = { ...s, name: n } as DocumentSymbol;
            if (children && children.length > 0) {
                (sym as unknown as { children?: DocumentSymbol[] }).children = pruneDocSymbolTree(
                    children,
                    keep,
                    containers,
                    "",
                );
            }
            out.push(sym);
        } else if (containers.has(kind)) {
            // Lift children up with container prefix
            if (children && children.length > 0) {
                const lifted = pruneDocSymbolTree(
                    children,
                    keep,
                    containers,
                    namePrefix + s.name + "::",
                );
                out.push(...lifted);
            }
        }
        // else: drop entirely (Variable, Property, Field, …)
    }
    return out;
}

/** Keep only rows whose kind is in `keep` from a flat SymbolInformation[]. */
function filterSymbolInfoList(syms: SymbolInformation[], keep: Set<number>): SymbolInformation[] {
    return syms.filter((s) => keep.has(s.kind ?? 0));
}

/**
 * One flattened row of the pruned tree: the symbol, its depth (for
 * indentation), and its ancestor chain (for re-emission as context when a
 * page boundary cuts inside a class). `ancestors[0]` is the outermost.
 */
interface OutlineRow {
    sym: DocumentSymbol;
    depth: number;
    ancestors: DocumentSymbol[];
}

/** Flatten a pruned DocumentSymbol tree into pre-order rows with depth+ancestors. */
function flattenTree(
    syms: DocumentSymbol[],
    ancestors: DocumentSymbol[],
    out: OutlineRow[],
): void {
    for (const s of syms) {
        out.push({ sym: s, depth: ancestors.length, ancestors });
        const children = (s as unknown as { children?: DocumentSymbol[] }).children ?? [];
        if (children.length > 0) {
            flattenTree(children, [...ancestors, s], out);
        }
    }
}

/**
 * Render a content row: `<pad><Kind> <name>  <sig>  :<sl>-<el>:<col>  docs: <d>`.
 * `sig` is the hover signature (or server `detail` fallback); `docs` is the
 * one-line docstring summary. Both omitted when empty. The body range
 * `<sl>-<el>` is DocumentSymbol.range (1-based inclusive); `<col>` is the
 * selectionRange (identifier) column on <sl>, kept so the row is directly
 * reusable as input to code_hover/code_definition/code_references.
 */
function renderRow(row: OutlineRow, sig: string | undefined, docs: string | undefined): string {
    const pad = "  ".repeat(row.depth);
    const sym = row.sym;
    const kindName = symbolKindName((sym as unknown as { kind?: number }).kind);
    const r = sym.range;
    const sl = r?.start?.line;
    const el = r?.end?.line;
    const sel = sym.selectionRange?.start;
    const col = sel ? sel.character + 1 : 0;
    const rangeStr =
        sl != null && el != null ? `:${sl + 1}-${el + 1}:${col}` : col ? `:${col}` : "";
    // Join fields with two spaces so the range never butts against the
    // signature (`<sig>:sl-el` → `<sig>  :sl-el`). Mirrors renderDocSymbol's
    // `${name}${d}  :${pos}` two-space separator.
    const fields = [`${kindName} ${sym.name}`];
    if (sig) fields.push(sig);
    if (rangeStr) fields.push(rangeStr);
    if (docs) fields.push(`docs: ${docs}`);
    return `${pad}${fields.join("  ")}`;
}

/**
 * Render a re-emitted ancestor context row (page opened mid-class):
 * `<pad><Kind> <name>  (cont.)  :<sl>-<el>:<col>`. No signature/docs — the
 * ancestor was shown in full on a previous page; here it's just structural
 * context so orphaned members aren't dangling. The `(cont.)` marker
 * distinguishes it from a fresh content row.
 */
function renderContextRow(sym: DocumentSymbol, depth: number): string {
    const pad = "  ".repeat(depth);
    const kindName = symbolKindName((sym as unknown as { kind?: number }).kind);
    const r = sym.range;
    const sl = r?.start?.line;
    const el = r?.end?.line;
    const sel = sym.selectionRange?.start;
    const col = sel ? sel.character + 1 : 0;
    const rangeStr =
        sl != null && el != null ? `:${sl + 1}-${el + 1}:${col}` : col ? `:${col}` : "";
    return `${pad}${kindName} ${sym.name}  (cont.)${rangeStr ? `  ${rangeStr}` : ""}`;
}

/**
 * Resolve ancestor context rows for the start of a page: the ancestors of
 * `first` that are NOT themselves content rows on this page (i.e. whose own
 * row was on a previous page). Walks `first.ancestors` outermost-first and
 * stops at the first ancestor that IS on the page (everything above it is
 * also above, so also needs re-emitting; everything below it is on the page).
 * Returns the ancestor symbols and their depths.
 */
function contextAncestorsFor(first: OutlineRow, pageRows: OutlineRow[]): { sym: DocumentSymbol; depth: number }[] {
    const pageSyms = new Set(pageRows.map((r) => r.sym));
    const out: { sym: DocumentSymbol; depth: number }[] = [];
    for (let i = 0; i < first.ancestors.length; i++) {
        const a = first.ancestors[i];
        if (pageSyms.has(a)) break; // this ancestor is on the page itself
        out.push({ sym: a, depth: i });
    }
    return out;
}

/** Format a hover signature, preferring the hover body, falling back to `detail`. */
function signatureFor(body: string, detail: string | null | undefined): string {
    const fromHover = hoverSignature(body);
    if (fromHover) return fromHover;
    return detail ?? "";
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
        // Hard failure: cannot read the file. Throw so index.ts's err() sets
        // isError: true rather than returning an inline string that looks like
        // a (empty) result.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    // Pagination params (1-based offset mirrors pi `read`). Clamp limit to
     // MAX_LIMIT so an agent can't request 10000 rows and pay for 10000 hovers.
    const offset = Math.max(1, Math.floor(params.offset ?? 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(params.limit ?? DEFAULT_LIMIT)));
    const client = await clientOf(lang);
    // Wait for ccls to finish indexing this TU before querying documentSymbol.
    // On a cold cache, documentSymbol returns stale {0:0} ranges until the
    // file's preamble session is ready — wrong body ranges AND wrong hover
    // signatures. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const syms = await client.documentSymbols(abs, text);
    if (syms.length === 0) return `(no symbols found in ${params.path})`;
    // Hierarchical (DocumentSymbol[]) vs flat (SymbolInformation[]). The flat
    // path is a guard — no current server returns flat for documentSymbol,
     // but we handle it rather than crash. The flat path paginates too, but
     // has no nesting so no ancestor re-emission.
    const lines: string[] = [];
    if ("range" in syms[0] && "selectionRange" in syms[0]) {
        const tree = pruneDocSymbolTree(syms as DocumentSymbol[], OUTLINE_KEEP_KINDS, CONTAINER_KINDS);
        const allRows: OutlineRow[] = [];
        flattenTree(tree, [], allRows);
        if (allRows.length === 0) {
            return `(no structural symbols (class/method/function/...) kept in ${params.path})`;
        }
        const startIdx = offset - 1;
        if (startIdx >= allRows.length) {
            return `(offset ${offset} is past the end; ${allRows.length} entries in ${params.path})`;
        }
        const pageRows = allRows.slice(startIdx, startIdx + limit);
        // Ancestor context rows for the page boundary (only when the page
         // opens mid-tree — i.e. first row's ancestors aren't on the page).
         // These are NOT hovered and do NOT count against `limit`.
        const contextRows: { sym: DocumentSymbol; depth: number }[] =
            startIdx > 0 && pageRows.length > 0
                ? contextAncestorsFor(pageRows[0], pageRows)
                : [];
        // Hover every content row on the page in parallel (JSON-RPC over stdio
         // supports concurrent in-flight requests; ~4ms each). The hover gives
         // us BOTH the signature (via hoverSignature) AND the doc snippet
         // (via hoverDocSnippet). Server `detail` is the signature fallback.
        const hovers = await Promise.all(
            pageRows.map((r) => {
                const sel = r.sym.selectionRange?.start;
                if (!sel) return Promise.resolve(null);
                return client.hover(abs, sel.line, sel.character, text);
            }),
        );
        const renderedContext = contextRows.map((c) => renderContextRow(c.sym, c.depth));
        const renderedPage = pageRows.map((r, i) => {
            const body = hoverText(hovers[i]);
            const detail = (r.sym as unknown as { detail?: string | null }).detail;
            return renderRow(r, signatureFor(body, detail) || undefined, hoverDocSnippet(body) || undefined);
        });
        lines.push(...renderedContext, ...renderedPage);
        // Trailing pagination message — mirrors pi `read`'s idiom:
        //   [N more entries in <path>. Use offset=<next> to continue.]
        const remaining = allRows.length - (startIdx + pageRows.length);
        if (remaining > 0) {
            const nextOffset = offset + pageRows.length;
            lines.push(
                `[${remaining} more entries in ${params.path}. Use offset=${nextOffset} to continue.]`,
            );
        }
    } else {
        // Flat SymbolInformation[] — no nesting, no ancestor re-emission.
         // Paginate the same way; range comes from location.range; col from
         // range.start (imprecise on ty but the flat case never fires in
         // practice). Hover each page row for sig+docs.
        const flat = filterSymbolInfoList(syms as SymbolInformation[], OUTLINE_KEEP_KINDS);
        if (flat.length === 0) {
            return `(no structural symbols (class/method/function/...) kept in ${params.path})`;
        }
        const startIdx = offset - 1;
        if (startIdx >= flat.length) {
            return `(offset ${offset} is past the end; ${flat.length} entries in ${params.path})`;
        }
        const pageRows = flat.slice(startIdx, startIdx + limit);
        // Hover each flat row. location.range.start is column 0 of the line on
         // some servers (not resolvable for hover), so try the symbol name on
         // the start line as a col fallback. This path is a guard; keep it
         // simple — most servers return hierarchical documentSymbol.
        const hovers = await Promise.all(
            pageRows.map(async (s) => {
                const start = s.location.range?.start;
                if (!start) return null;
                return client.hover(abs, start.line, start.character, text);
            }),
        );
        // Render flat rows with the same shape as renderRow but depth 0 and no
         // ancestors; renderSymbolInfo is the existing flat renderer but
         // lacks the sig/docs/range columns, so render inline here.
        for (let i = 0; i < pageRows.length; i++) {
            const s = pageRows[i];
            const r = s.location.range;
            const sl = r?.start?.line;
            const el = r?.end?.line;
            const col = r?.start?.character ? r.start.character + 1 : 0;
            const rangeStr =
                sl != null && el != null ? `:${sl + 1}-${el + 1}:${col}` : col ? `:${col}` : "";
            const body = hoverText(hovers[i]);
            const sig = hoverSignature(body) || (s as { detail?: string }).detail || "";
            const docs = hoverDocSnippet(body);
            const fields = [`${symbolKindName(s.kind)} ${s.name}`];
            if (sig) fields.push(sig);
            if (rangeStr) fields.push(rangeStr);
            if (docs) fields.push(`docs: ${docs}`);
            lines.push(fields.join("  "));
        }
        const remaining = flat.length - (startIdx + pageRows.length);
        if (remaining > 0) {
            const nextOffset = offset + pageRows.length;
            lines.push(
                `[${remaining} more entries in ${params.path}. Use offset=${nextOffset} to continue.]`,
            );
        }
    }
    return lines.join("\n");
}
