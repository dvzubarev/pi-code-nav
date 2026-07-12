/**
 * code-nav extension
 *
 * Provides eight LLM-callable tools backed by real LSP servers (ccls for C++,
 * ty/pyright for Python, bash-language-server for bash,
 * typescript-language-server for TypeScript & JavaScript) plus tree-sitter for
 * third-party symbol discovery. They split into two groups:
 *
 *   ENTRY POINTS (produce a position):
 *   code_outline        — file structure (functions, classes, methods, signatures)
 *   code_tree           — pattern-driven pruned DocumentSymbol tree with signatures (parallel hover)
 *   code_search_symbol  — ranked workspace-wide symbol lookup by name
 *   code_scan           — identifier scan of a file or line range (positions + roles)
 *                         (the third-party entry point; see MAINTAINER.md)
 *
 *   DETAIL TOOLS (consume path + 1-based line + column):
 *   code_definition     — location + full source body of a symbol's definition
 *   code_references     — list of references for a symbol
 *   code_hover          — hover/documentation for a symbol
 *   code_rename         — rename a symbol, edits applied to disk
 *   code_diagnostics    — errors/warnings for a file (LSP pull model, on demand)
 *
 * Servers are scoped by (ctx.cwd, language): one server per language per
 * workspace, spawned lazily on first tool call, shut down on session close.
 * code_scan parses syntax in-process — no LSP server required for its default path.
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
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LspClient, resolveConfig, type Lang, type ServerConfig } from "./lsp-client";
import * as nav from "./nav";

/** File extension → language (re-exported from render.ts for status reporting). */
// EXT_LANG and langForFile now live in render.ts; index.ts imports them.

/** Load .pi/lsp.json (project) then ~/.pi/lsp.json (global); merge per-lang. */
async function loadConfig(
    ctx: ExtensionContext,
): Promise<Partial<Record<Lang, Partial<ServerConfig>>>> {
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
                for (const lang of ["cpp", "python", "bash", "typescript"] as Lang[]) {
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
// Rendering + WorkspaceEdit helpers now live in render.ts (shared with the
// CLI harness and tests). The tool implementations live in nav.ts; registerTools
// below is a thin shim that parses params, calls
// nav.<tool>(params, ctx.cwd, (lang) => state.pool.client(lang)), and wraps the
// returned string in text_result / err. index.ts no longer holds any rendering
// logic — the old "keep nav-cli.mjs in sync with index.ts by hand" landmine is
// gone (both import from render.ts + nav.ts).
// ---------------------------------------------------------------------------

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
            "Retrieve the structure of a source file: functions, classes, methods, with positions. Only structural kinds are kept (class, method, function, constructor, interface, struct) — constants, variables, and other leaf bindings are dropped. For signature-enriched, pattern-scoped results use code_tree.",
        promptSnippet: "List functions/classes/methods in a file via LSP",
        promptGuidelines: [
            "Use code_outline when you need quick overwiev of source code structure. It returns list of class/method/interface.",
            "Output row format: `<Kind> <name>  [<detail>]  (<line>:<col>)`. To feed a row into code_hover/code_definition/code_references, combine your input path with the row's `(line:col)`.",
            "When you need signatures for a specific subset of symbols (by name pattern), use code_tree instead. For a full identifier scan (calls, imports, members — not just declarations), use code_scan.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                return text_result(
                    await nav.outline(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },
    });

    // 1b. code_tree (LSP documentSymbol tree, pattern-driven)
    pi.registerTool({
        name: "code_tree",
        label: "Code Tree",
        description:
            "Return a pruned view of a source file's DocumentSymbol tree, filtered to symbols whose name matches a regexp. Each row carries its kind, position, and signature. Unlike code_outline (a bloat-free structural overview of the whole file), code_tree is pattern-driven: pass a regexp matched against symbol names. DWYM: if the match is a class/interface/struct, it prints its direct children (methods/properties/fields) with a signature; if the match is anything else, it prints its ancestors for context.",
        promptSnippet: "Prints source file as tree-like structure.",
        promptGuidelines: [
            "Use code_tree when you need pattern-driven symbol tree with signatures. It takes a regexp that is tested against symbol names — e.g. scan a class name to see it and all its members with signatures, or scan `^get_|^set_` to list getters/setters and their ancestor classes.",
            "Output row format: `[<pad>]<Kind> <name>  [<signature>]  (<line>:<col>)`.",
            "Prefer code_outline for a full-file structural overview. Use code_tree for a targeted, signature-enriched view of specific symbols by name. For a full identifier scan (including calls, imports, members) use code_scan.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            pattern: Type.String({
                description:
                    "A JavaScript case-sensitive regexp.",
            }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                return text_result(
                    await nav.tree(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },
    });

    // 2. code_definition
    pi.registerTool({
        name: "code_definition",
        label: "Code Definition",
        description:
            "Returns each definition's location and the FULL source body of the definition (the complete function/class/method body, not just the identifier). You must know the symbol position to use this tool.",
        promptSnippet: "Retrieve class/function source code.",
        promptGuidelines: [
            "Use code_definition when you need FULL source body of a function/class. You must know the function/class position to use this tool.",
            "When input array contains multiple entries, each is delimited with a `### <path>:<line>:<col>` sub-header.",
            "When a position resolves to MULTIPLE definition sites (overloads, multi-definition symbols), each site is delimited with a `#### def N of M  <path>:<line>:<col>` sub-header",
            "It accepts absolute paths.",
            "Set list_symbols=true to also list the identifiers used inside each returned body (useful for discovering third-party/stdlib APIs in the body). Output row format `<role> <name> (<line>:<col>)`. To feed a symbol into code_definition, combine header path with row's `(line:col)`",
        ],
        parameters: Type.Object({
            positions: Type.Array(
                Type.Object({
                    path: Type.String({
                        description: "File path (absolute or relative to cwd)",
                    }),
                    line: Type.Number({ description: "1-based line number" }),
                    column: Type.Number({ description: "1-based column number" }),
                }),
                {
                    description:
                        "One or more (path, line, column) positions to look up.",
                },
            ),
            list_symbols: Type.Optional(
                Type.Boolean({
                    description:
                        'If true, append a symbol table for each returned body (default: false). The table lists identifiers their position and syntactic role (type/call/member/import). Local-variable (var) are omitted by default to keep the output focused on external APIs; use code_scan with roles including "var" if you need locals.',
                }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.definition handles the full batched-position logic, per-position
            // structured ERROR rows for soft failures, source-body extraction,
            // #### def N of M sub-headers for multi-loc results, and the optional
            // tree-sitter symbol table. It never throws (soft failures are
            // per-position ERROR rows), so no try/catch wrapper is needed here.
            return text_result(
                await nav.definition(params, ctx.cwd, (lang) => state.pool.client(lang)),
            );
        },
    });

    // 3. code_references
    pi.registerTool({
        name: "code_references",
        label: "Code References",
        description:
            "Find all references to the symbol(s) at the given position(s).",
        promptSnippet: "Find all references to the symbol.",
        promptGuidelines: [
            "Use code_references before renaming or refactoring to find every call site of a symbol. The count is a trailing `# N references`.",
        ],
        parameters: Type.Object({
            positions: Type.Array(
                Type.Object({
                    path: Type.String({
                        description: "File path (absolute or relative to cwd)",
                    }),
                    line: Type.Number({ description: "1-based line number" }),
                    column: Type.Number({ description: "1-based column number" }),
                }),
                {
                    description:
                        "One or more (path, line, column) positions to look up.",
                },
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.references handles batched positions, per-position structured
            // ERROR rows, the ### headers when batching, and the trailing
            // `# N references` count comment. Never throws (soft failures are
            // per-position ERROR rows).
            return text_result(
                await nav.references(params, ctx.cwd, (lang) => state.pool.client(lang)),
            );
        },
    });

    // 4. code_search_symbol
    pi.registerTool({
        name: "code_search_symbol",
        label: "Code Symbol Search",
        description:
            "Workspace-wide symbol search by name. Given a query string, return a ranked list of matching symbols (kind, name, <path> (<line>:<col>)). Scoped to the workspace root only — cannot find symbols in third-party trees (site-packages, nix store, node_modules, system headers) even though the LSP server resolves them; see the third-party workflow in the system-prompt block.",
        promptSnippet: "Fuzzy search for a given symbol in the current workspace.",
        promptGuidelines: [
            "Use code_search_symbol to find a location of a symbol in the current project. It returns a ranked list of matching symbols. It doesn't support regexps, but some servers support fuzzy searching.",
            "Output row format: <lang> <Kind> <name> <path> (<line>:<col>)",
            "code_search_symbol is workspace-scoped: it will NOT find symbols in third-party trees (site-packages, nix store, system headers).",
        ],
        parameters: Type.Object({
            query: Type.String({ description: "Symbol name (or prefix) to search for" }),
            language: Type.Optional(
                Type.String({
                    description: "Optional: 'cpp' | 'python' | 'bash' to limit to one language",
                }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.symbol iterates the enabled languages, resolves identifier
            // selStarts via documentSymbol, and never throws on recoverable errors.
            return text_result(
                await nav.symbol(params, ctx.cwd, (lang) => state.pool.client(lang)),
            );
        },
    });

    // 5. code_rename
    pi.registerTool({
        name: "code_rename",
        label: "Code Rename",
        description:
            "Rename the symbol at (path, line, column) to newName. Edits are applied directly to disk. Returns the list of files changed and edit count per file.",
        promptSnippet: "Rename symbols across the workspace.",
        promptGuidelines: [
            "code_rename applies edits to disk automatically across the whole workspace.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Number({ description: "1-based line number" }),
            column: Type.Number({ description: "1-based column number" }),
            newName: Type.String({ description: "New name for the symbol" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                return text_result(
                    await nav.rename(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },
    });

    // 6. code_hover
    pi.registerTool({
        name: "code_hover",
        label: "Code Hover / Docs",
        description:
            "Retrieve hover/documentation for the symbol(s) at the given position(s). Returns a signature-first line (`signature: <collapsed one-line signature>`) when one can be extracted, followed by the full hover markdown body (docstring, signature, type info). Accepts absolute paths, including third-party locations (nix store, site-packages, node_modules, system headers).",
        promptSnippet: "Get signature and doc string of a given function.",
        promptGuidelines: [
            "Use code_hover when you need signature and docstring of a function. You must know the function position to use this tool.",
            "code_hover emits a signature of a method first line before the raw markdown body — pick the first line cheaply for structured signature info without parsing the markdown.",
            "When input array contains multiple entries, each is delimited with a `### <path>:<line>:<col>` sub-header.",
            "It accepts absolute paths, including third-party locations.",
        ],
        parameters: Type.Object({
            positions: Type.Array(
                Type.Object({
                    path: Type.String({
                        description: "File path (absolute or relative to cwd)",
                    }),
                    line: Type.Number({ description: "1-based line number" }),
                    column: Type.Number({ description: "1-based column number" }),
                }),
                {
                    description:
                        "One or more (path, line, column) positions to look up.",
                },
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.hover handles batched positions, per-position structured ERROR
            // rows, the ### headers when batching, and the signature-first line.
            // Never throws (soft failures are per-position ERROR rows).
            return text_result(await nav.hover(params, ctx.cwd, (lang) => state.pool.client(lang)));
        },
    });

    // 7. code_scan (identifier scan of a file or line range)
    pi.registerTool({
        name: "code_scan",
        label: "Code Scan",
        description:
            "Scan a source file for identifiers — type names, calls, member accesses, imports — and return each with its position and syntactic role. Optionally filter by a name pattern and/or limit to a line range.",
        promptSnippet:
            "List identifiers (with positions + roles) in a file or range; optionally filter by name pattern",
        promptGuidelines: [
            "Use code_scan for listing all identifier in a given range.",
            "Pass only `path` to scan the whole file. Add `pattern` (a regexp tested against symbol names) to narrow to e.g. a specific imported module or a method called in a body. Add `startLine`/`endLine` (1-based inclusive) to limit the range — useful for large files where a whole-file scan would be noisy.",
            "Output row format: `  <role> <name>  (<line>:<col>) [<details>]`. To feed a row into code_hover/code_definition/code_references, combine your input path with the row's `(line:col)`",
            'Roles: type (a type name), call (a function/method being called), member (a field/attribute access like .push_back / .encode), import (a name brought into scope by an import — module names and imported symbols, the primary entry points for third-party discovery), var (a local variable, parameter, or assignment target — hoverable but rarely worth learning about). By default `var` is omitted (noisy locals); pass roles including "var" to include them. The table dedupes by (name, role) and keeps the first occurrence; pass a tighter startLine/endLine to reach a later occurrence.',
            "Use include_docs=true when you need signature returned by code_hover command (note that it will be truncated).",

        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            startLine: Type.Optional(
                Type.Number({
                    description:
                        "1-based inclusive start line of the range to scan. Omit to scan from the start of the file.",
                }),
            ),
            endLine: Type.Optional(
                Type.Number({
                    description:
                        "1-based inclusive end line of the range to scan. Omit to scan to the end of the file.",
                }),
            ),
            pattern: Type.Optional(
                Type.String({
                    description:
                        "Optional JavaScript case-sensitive regexp. When set, only symbols whose name matches are kept. An invalid regexp is a hard error — escape/anchor as needed.",
                }),
            ),
            roles: Type.Optional(
                Type.Array(
                    StringEnum(["type", "call", "member", "import", "var"] as const, {
                        description:
                            'Which roles to emit. Default: [type, call, member, import] (all except var, which are noisy locals). Pass e.g. ["var"] to see only locals, or the full ["type","call","member","import","var"] to see everything.',
                    }),
                ),
            ),
            include_docs: Type.Optional(
                Type.Boolean({
                    description:
                        "If true, hover each symbol and append the first line of the hover as a label column (default: false). Makes one LSP hover call per unique symbol.",
                }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                return text_result(
                    await nav.scan(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
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
            "Report diagnostics (errors, warnings, hints) for a source file, fetched on demand from the language server. Returns the list of diagnostics with severity, source, and message; an empty result means the server reported no problems.",
        promptSnippet: "Report diagnostic information for a given file.",
        promptGuidelines: [
            "code_diagnostics lists errors/warnings the language server reports for a file — e.g. after editing a file to check it compiles/type-checks, or to find the exact location of a problem. An empty result means the server found no problems.",
            "Output row format: `<path>:<line>:<col>  <severity>  <source>  <message>`."
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                return text_result(
                    await nav.diagnostics(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
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
        ctx.ui.notify(
            "code-nav enabled — tools: code_outline, code_tree, code_definition, code_references, code_search_symbol, code_rename, code_hover, code_scan, code_diagnostics",
            "info",
        );
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
        description:
            "Enable LSP-backed code navigation tools (code_outline, code_tree, code_definition, code_references, code_search_symbol, code_rename, code_hover, code_scan, code_diagnostics)",
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
                const cfg = resolveConfig(
                    lang,
                    state!.pool["overrides" as keyof typeof state.pool] as Partial<
                        Record<Lang, Partial<ServerConfig>>
                    >,
                );
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

    // Inject a grouped "entry points vs detail tools" overview + old-vs-new
    // pattern table into the system prompt, but ONLY while code-nav tools are
    // active. promptGuidelines (per-tool) are flat with no grouping, so they
    // cannot express the two-group framing or the "prefer code_* over grep/read"
    // reframing that steers the agent away from its default grep/read reflex.
    // This handler is always registered; it no-ops when /code-nav hasn't run.
    pi.on("before_agent_start", async (event) => {
        if (!state?.pool.enabled()) return {};
        const active = pi.getActiveTools();
        if (!active.some((t) => t.startsWith("code_"))) return {};
        const block = CODE_NAV_PROMPT_BLOCK;
        return { systemPrompt: event.systemPrompt + "\n\n" + block };
    });
}

/**
 * The grouped tool overview injected into the system prompt while code-nav is
 * active. Two purposes the flat per-tool promptGuidelines cannot serve:
 *   1. Group the nine tools into ENTRY POINTS (produce positions) vs DETAIL
 *      TOOLS (consume positions), making the round-trip obvious.
 *   2. Reframe common grep/read/sed reflexes as code_* calls.
 * Kept tight — this is appended to every system prompt while enabled.
 */
const CODE_NAV_PROMPT_BLOCK = `## code-nav tools (LSP-backed code navigation)

The code_* tools are backed by real language servers (ccls/ty/pyright/
bash-language-server/typescript-language-server) plus tree-sitter. They index
the workspace, so prefer them over grep/read/sed for code tasks — they are
faster, semantic, and return 1-based positions that round-trip between tools.

Two groups — ENTRY POINTS produce a position; DETAIL TOOLS consume one.

ENTRY POINTS (you don't have a precise position yet):
- code_search_symbol — find a symbol by name across the workspace
- code_outline       — list functions/classes/methods in a file
- code_tree          — pattern-driven pruned symbol tree with signatures
- code_scan          — list every identifier (with role: type/call/member/import) in a file or a range

DETAIL TOOLS (take a position — reuse one an entry point printed):
- code_definition    — jump to a symbol's definition; returns the FULL source body
- code_references    — all call sites of a symbol
- code_hover         — docstring / signature / type info
- code_rename        — rename a symbol across the workspace; edits applied to disk
- code_diagnostics   — errors/warnings a language server reports for a file

Positions are 1-based throughout. An entry point's printed line:col feeds
straight into a detail tool's line/column params — no conversion.

Prefer code_* over the grep/read reflex:
- find a symbol by name           → code_search_symbol then code_definition (not rg + read)
- read a function's source body   → code_outline to find it, then code_definition (not grep -n + read)
- list identifiers in a snippet   → code_scan (not rg -o '\b\w+\b' — code_scan gives roles + reusable positions)
- find all call sites of a symbol → code_references (not rg)
- rename a symbol                 → code_rename (not sed -i across files)
- check a file for errors         → code_diagnostics (not a hand-written paren/quote checker)
- learn a symbol's type or docs   → code_hover (not reading the file and eyeballing)
- read a third-party API's source → code_definition at its position (not
  \`python -c "import inspect; inspect.getsource(...)"\` or other hacks for various languages)


You can effectively chain tool calls for quickly navigating code base, for example:
1. code_outline <file> OR code_tree <file> <regexp> OR code_search_symbol <query> OR code_scan <file> <start> <end>.
   Response will contain position (line, col) for each entry.
2. Select entry and call code_definition([{path: <file>, line: <line>, column: <col>}], list_symbols=true)
3. The returned body comes with its OWN symbol table, so you drill down further.
   call code_definition([{path: <file-from-symbol-table-header>, line: <line>, column: <col>}], list_symbols=true)


Retrieving third-party docs/source (site-packages, node_modules, nix store, system headers) workflows:
1. Use tool call chains described above.
2. Third-party symbol from a NAME only (no position):
     (1). resolve the package root.
        If the project uses nix (the common case), every third-party path is exposed via an environment variable — grep the right one for your language:
        python: \`echo $PYTHONPATH | tr ':' '\\n' | grep <name>\`,
        C++: (cmake, the usual case) \`echo $CMAKE_INCLUDE_PATH | tr ':' '\\n' | grep <name>\`,
        C++: (no cmake) \`echo $NIX_CFLAGS_COMPILE | tr ' ' '\\n' | grep <name>\`;
     (2). \`rg -n --column <name> <root>\` — the output is \`line:column:content\`, and on ASCII lines the 1-based line and column match what code_definition/code_hover expect.
     (3). call code_definition/code_hover on that position (they accept absolute paths, including nix store / site-packages / node_modules / system headers).
    Do NOT rg the whole /nix/store (millions of entries, many versions) — always scope to one resolved package root.`;
