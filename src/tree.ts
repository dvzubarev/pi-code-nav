/**
 * code_tree — pattern-driven pruned DocumentSymbol tree with signatures.
 * Takes a regexp tested against symbol names and renders a tree, hovering
 * matched rows and direct class-member children for signatures. See
 * docs/code_tree.md.
 */

import { readFile } from "node:fs/promises";
import type { DocumentSymbol } from "vscode-languageserver-protocol";
import { awaitReadyForQuery, ClientProvider, UnknownLanguageError } from "./nav-core";
import { hoverSignature, hoverText, langForFile, symbolKindName, toAbs } from "./render";

export interface TreeParams {
    path: string;
    /** RegExp source tested against each symbol's name. */
    pattern: string;
}

/**
 * One row of the tree result: the symbol, its tree depth (for indentation),
 * whether this node itself matched the pattern, and whether it's a direct
 * child of a class/interface/struct match (in which case it's hovered for a
 * signature even though it isn't itself a match — see DWYM rule below).
 */
interface TreeRow {
    sym: DocumentSymbol;
    depth: number;
    matched: boolean;
    /** True for direct children of a class/interface/struct match. */
    directClassChild: boolean;
}

/** LSP SymbolKind values that trigger the class-match DWYM path. */
const CLASS_LIKE_KINDS = new Set([5, 11, 23]); // Class, Interface, Struct

/**
 * Prune a DocumentSymbol tree to matches, returning a flat list of rows
 * with depth + flags. Used by code_tree (pattern-driven). Semantics (DWYM —
 * do what the agent means):
 *
 *   1. A node whose name matches the pattern is a match. The matched node is
 *      always emitted (matched: true).
 *        a. If the match is a class/interface/struct, emit ONLY its DIRECT
 *           children (methods/properties/fields) as context rows with
 *           `directClassChild: true` — the agent asked about the class, so it
 *           wants the member list, not the deep locals of every method. Deep
 *           nesting (constants inside methods, properties inside those) is
 *           dropped; the agent can code_hover/code_definition a member to go
 *           deeper. Direct children are hovered for signatures (see tree).
 *        b. If the match is anything else (method/function/property/…), emit
 *           NOTHING from its subtree. The agent asked about this specific
 *           symbol; its body locals are noise. Ancestors still provide context.
 *   2. A node with a matching descendant is kept as an ancestor for context
 *      (so the agent sees where the match sits in the hierarchy), but its
 *      non-matching sibling subtrees are pruned.
 *
 * Output is in pre-order (parents before children) so indentation renders the
 * hierarchy correctly.
 */
function collectTreeRows(syms: DocumentSymbol[], re: RegExp): TreeRow[] {
    const out: TreeRow[] = [];
    const walk = (nodes: DocumentSymbol[], depth: number): boolean => {
        let anyMatchInSubtree = false;
        for (const s of nodes) {
            const selfMatch = re.test(s.name);
            const children = (s as unknown as { children?: DocumentSymbol[] }).children ?? [];
            const kind = (s as unknown as { kind?: number }).kind;
            if (selfMatch) {
                // Rule 1: self-match — emit (matched: true).
                out.push({ sym: s, depth, matched: true, directClassChild: false });
                if (CLASS_LIKE_KINDS.has(kind ?? 0)) {
                    // Rule 1a (class-like): emit ONLY direct children, flagged so the
                    // caller knows to hover them for signatures. Do NOT recurse —
                    // deep locals of each member are dropped (DWYM).
                    for (const ch of children) {
                        out.push({
                            sym: ch,
                            depth: depth + 1,
                            matched: false,
                            directClassChild: true,
                        });
                    }
                }
                // Rule 1b (non-class): emit nothing from the subtree.
                anyMatchInSubtree = true;
                continue;
            }
            // Rule 2: no self-match — keep this node only if a descendant matched.
            // We don't yet know whether a descendant matches, so reserve a slot now
            // (pre-order: parent before children) and fill/evict it after recursing.
            const slot = out.length;
            out.push({ sym: s, depth, matched: false, directClassChild: false }); // tentative
            const childMatch = walk(children, depth + 1);
            if (childMatch) {
                anyMatchInSubtree = true; // keep the slot
            } else {
                out.splice(slot, 1); // no match below — evict the tentative ancestor
            }
        }
        return anyMatchInSubtree;
    };
    walk(syms, 0);
    return out;
}

/**
 * Render one tree row as an indented line mirroring `renderDocSymbol`'s shape,
 * but with an appended signature label (from `detail` or a hover).
 * Format: `<pad><Kind> <name>  <signature>  :line:col` where the signature
 * is the server `detail` when present, otherwise the provided hover signature.
 */
function renderTreeRow(row: TreeRow, signature: string | undefined): string {
    const pad = "  ".repeat(row.depth);
    const sym = row.sym;
    const kind = (sym as unknown as { kind?: number }).kind;
    const kindName = symbolKindName(kind);
    const sel = sym.selectionRange?.start;
    const pos = sel ? `${sel.line + 1}:${sel.character + 1}` : "";
    // `detail` (server-provided, e.g. ccls declarations) takes precedence — it's
    // free and authoritative. The hover signature fills in where detail is empty
    // (tsserver/ty). Both never apply simultaneously.
    const detail = (sym as unknown as { detail?: string | null }).detail;
    const label = detail ? detail : (signature ?? "");
    const l = label ? `  ${label}` : "";
    // Position column is grep-style `:line:col` (no parens, no path — the path is
    // the outline's input file) so the row shares the `line:col` grammar every
    // other tool uses. Consistent with renderDocSymbol / renderSymbolInfo.
    return `${pad}${kindName} ${sym.name}${l}  :${pos}`;
}

export async function tree(
    params: TreeParams,
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
        // isError: true.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    // Compile the pattern as a regexp. No substring fallback — the agent is
    // told this is a regexp and can escape/anchor as needed. A bad pattern is
    // a hard error (isError) so the agent learns the syntax contract fast.
    let re: RegExp;
    try {
        re = new RegExp(params.pattern);
    } catch (e) {
        throw new Error(
            `Invalid regexp /${params.pattern}/: ${e instanceof Error ? e.message : e}`,
        );
    }
    const client = await clientOf(lang);
    // Wait for ccls to finish indexing this TU before querying documentSymbol.
    // On a cold cache, documentSymbol returns stale {0:0} ranges and the
    // tree's body ranges / hover signatures are wrong until the file's
    // preamble session is ready. No-op on a warm cache.
    await awaitReadyForQuery(lang, client, abs, text);
    const syms = await client.documentSymbols(abs, text);
    if (syms.length === 0) return `(no symbols found in ${params.path})`;
    // code_tree is pattern-driven and does NOT drop constants/variables — the
    // pattern scopes the candidate set, so noise filtering would only hide
    // symbols the agent explicitly asked for. Requires a hierarchical tree
    // (DocumentSymbol[]); the flat SymbolInformation[] case has no nesting to
    // prune and is reported as unsupported (no current server hits it for
    // documentSymbol, but we guard rather than crash).
    if (!("range" in syms[0] && "selectionRange" in syms[0])) {
        // Hard failure: code_tree's pruning semantics require a hierarchical
        // tree; a flat SymbolInformation[] has no nesting to prune. No current
        // server hits this for documentSymbol, but we guard rather than crash.
        throw new Error(
            `code_tree requires hierarchical documentSymbol; ${params.path} returned flat SymbolInformation`,
        );
    }
    const rows = collectTreeRows(syms as DocumentSymbol[], re);
    if (rows.length === 0) {
        return `(no symbols matching /${params.pattern}/ in ${params.path})`;
    }
    // Hover the rows whose `detail` is empty, in parallel (JSON-RPC over stdio
    // supports concurrent in-flight requests; measured ~4ms for 10 hovers):
    //   - matched rows (any kind) — the agent asked about these by name;
    //   - direct children of a class/interface/struct match (DWYM rule 1a) —
    //     the agent asked about the class, so its member list should carry
    //     signatures, not just bare names. This is where code_tree earns its
    //     "signature-enriched" promise for tsserver/ty (which leave `detail`
    //     empty); ccls fills `detail` for members, so they're skipped here.
    // Ancestors kept for context (rule 2) are NOT hovered — they're just the
    // path to the match; their own signature is rarely interesting and hovering
    // them would balloon the candidate set when the match is deep. Skip rows
    // that already have a non-empty `detail` — no point paying a hover to
    // duplicate the server's own declaration string.
    const hoverTargets = rows.filter(
        (r) =>
            (r.matched || r.directClassChild) &&
            !(r.sym as unknown as { detail?: string | null }).detail,
    );
    const signatures = new Map<DocumentSymbol, string>();
    if (hoverTargets.length > 0) {
        const hovers = await Promise.all(
            hoverTargets.map((r) => {
                const sel = r.sym.selectionRange?.start;
                if (!sel) return Promise.resolve(null);
                return client.hover(abs, sel.line, sel.character, text);
            }),
        );
        hoverTargets.forEach((r, i) => {
            const sig = hoverSignature(hoverText(hovers[i]));
            if (sig) signatures.set(r.sym, sig);
        });
    }
    const lines = rows.map((r) => renderTreeRow(r, signatures.get(r.sym)));
    return lines.join("\n");
}
