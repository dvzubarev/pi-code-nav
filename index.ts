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
 *                         (the third-party entry point; see docs/code_scan.md)
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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { LspClient, resolveConfig, type Lang, type ServerConfig } from "./src/lsp-client";
import * as nav from "./src/nav";
import { ALL_LANGS } from "./src/nav";

/** File extension → language (re-exported from src/render.ts for status reporting). */
// EXT_LANG and langForFile now live in src/render.ts; index.ts imports them.

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
                for (const lang of ALL_LANGS) {
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
    /**
     * Directory where per-server stderr log files are written (one file per
     * spawned server, named <lang>-<pid>.log, removed on shutdown). Under
     * ~/.pi/agent/logs/code-nav so the user can inspect server output without
     * access to the agent's temp files. Forwarded to each LspClient.
     */
    private logDir: string;

    constructor(
        cwd: string,
        overrides: Partial<Record<Lang, Partial<ServerConfig>>>,
        logDir: string,
    ) {
        this.cwd = cwd;
        this.overrides = overrides;
        this.logDir = logDir;
    }

    enabled(): boolean {
        return this.toolsEnabled;
    }

    async client(lang: Lang): Promise<LspClient> {
        let c = this.clients.get(lang);
        if (!c) {
            c = new LspClient(lang, this.cwd, resolveConfig(lang, this.overrides), this.logDir);
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
// Rendering + WorkspaceEdit helpers now live in src/render.ts (shared with the
// CLI harness and tests). The tool implementations live in src/<tool>.ts (one
// file per tool, re-exported by src/nav.ts); registerTools
// below is a thin shim that parses params, calls
// nav.<tool>(params, ctx.cwd, (lang) => state.pool.client(lang)), and wraps the
// returned string in text_result / err. index.ts no longer holds any rendering
// logic — the old "keep nav-cli.mjs in sync with index.ts by hand" landmine is
// gone (both import from src/render.ts + src/nav.ts).
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
            "Retrieve the structure of a source file: functions, classes, methods, with positions. Only structural kinds are kept (class, method, function, constructor, interface, struct) — constants, variables, and other leaf bindings are dropped. For signature-enriched, pattern-scoped results use code_tree. Example output:\n  Class Foo  :12:1\n    Method bar  [void bar(int x)]  :15:3",
        promptSnippet: "List functions/classes/methods in a file via LSP",
        promptGuidelines: [
            "Prefer code_outline for a quick structural overview; use code_tree for signatures filtered by name pattern, or code_scan for every identifier (calls/imports/members).",
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
            "Return a pruned view of a source file's DocumentSymbol tree, filtered to symbols whose name matches a regexp. Each row carries its kind, position, and signature. Unlike code_outline (a bloat-free structural overview of the whole file), code_tree is pattern-driven: pass a regexp matched against symbol names. DWYM: if the match is a class/interface/struct, it prints its direct children (methods/properties/fields) with a signature; if the match is anything else, it prints its ancestors for context. Example output for pattern `^Foo$`:\n  Class Foo  :12:1\n    Method bar  [void bar(int x)]  :15:3\n    Method baz  [int baz()]  :18:3",
        promptSnippet: "Prints source file as tree-like structure.",
        promptGuidelines: [
            "Use code_tree for a name-pattern-driven symbol tree with signatures (e.g. scan a class to see its methods with signatures, or `^get_|^set_` for getters/setters). Prefer code_outline for a full-file overview, code_scan for every identifier.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            pattern: Type.String({
                description: "A JavaScript case-sensitive regexp.",
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
            'Retrieve the source code of a function/class/method definition. Given a symbol position (path, line, column), resolves the definition and returns the full body — the complete function/class/method source, ready to copy into an edit. Output format: a header line `<defPath>:<sl>-<el>` (1-based inclusive line range) followed by the raw source lines (no code fence). The definition may live in a different file than the input position (including third-party trees). A position may resolve to several definition sites (overloads, header-vs-source in C++, re-exports): one block per site, separated by a blank line, with a trailing `# N definitions` count. Set list_symbols=true to also append a symbol table of the identifiers used inside the body.',
        promptSnippet: "Retrieve verbatim source code of a function/class/method.",
        promptGuidelines: [
            "Use code_definition to retrieve the FULL source body of a function/class/method — verbatim text ready to copy into an edit. You need a position first (from code_outline/code_tree/code_scan/code_search_symbol).",
            "Set list_symbols=true to also get a symbol table of identifiers used inside the body; each row is itself a position you can feed back into code_definition/code_hover/code_references (combine the header's defPath with the row's :line:col).",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Number({ description: "1-based line number of the symbol" }),
            column: Type.Number({ description: "1-based column number of the symbol" }),
            list_symbols: Type.Optional(
                Type.Boolean({
                    description:
                        'If true, append a symbol table for the returned body (default: false). The table lists identifiers with their position and syntactic role (type/call/member/import). Local-variable (var) are omitted by default to keep the output focused on external APIs; use code_scan with roles including "var" if you need locals.',
                }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.definition now throws on ANY failure (no fallbacks, no
            // soft-failure rows) — the tool's contract is "verbatim source
            // code or a hard error". Wrap in try/catch so err() sets
            // isError: true.
            try {
                return text_result(
                    await nav.definition(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },
    });

    // 3. code_references
    pi.registerTool({
        name: "code_references",
        label: "Code References",
        description:
            'Find all references to the symbol at the given position (path, line, column). Returns one reference location per line (`<path>:<line>:<col>`, grep-style) plus a trailing `# N references` count. An empty result (no references) is a parenthesized note, not an error. Usually reached via code_search_symbol\'s `info: ["references"]` (capped to 25 per match, with a note to use code_references for all); call directly for the full uncapped list.',
        promptSnippet: "Find all references to the symbol.",
        promptGuidelines: [
            "Use code_references before renaming or refactoring to find every call site. code_search_symbol(info:[\"references\"]) caps at 25 per match; call code_references directly for the full uncapped list.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Number({ description: "1-based line number of the symbol" }),
            column: Type.Number({ description: "1-based column number of the symbol" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.references emits a structured ERROR row on recoverable failures
            // (unknown language, cannot read, server unavailable); a clean empty
            // result is a parenthesized note. Never throws.
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
            'Symbol search by name across the workspace AND third-party/stdlib trees — the omni entry point for code navigation. Given a `query` (a bare name like `loads` or a qualified name like `typing.cast`, `cbor2.loads`, `std::vector::push_back`), return a ranked list of matching symbols (`[lang] <Kind> <name>  <path>:<line>:<col>`). Pass optional `info` to ALSO fan out per exact match: `["code"]` appends the verbatim source body, `["hover"]` the signature+docstring, `["references"]` up to 25 call sites. Pass optional `filter_by_kind` and `filter_by_regex` to narrow the result set (e.g. to one exact match, which then auto-fans-out). When `info` is non-empty, up to 5 exact matches are fanned out; over the cap the tool returns a row list + a "narrow with filters" note. `hover` is auto-dropped when `code` is present (code is a superset).',
        promptSnippet:
            "Search for a symbol by name (bare or qualified) across the workspace and third-party/stdlib; optionally fan out code/hover/references per match.",
        promptGuidelines: [
            "Use code_search_symbol as the PRIMARY entry point for code navigation — find a symbol by name and (optionally) get its code/hover/references in one call via `info`. Use a bare name for your project (workspace first, then third-party/stdlib); use a qualified name (`typing.cast`, `std::vector::push_back`) to pin a specific module.",
            "When a bare name matches more than 5 sites the fan-out cap kicks in (row list + a \"narrow with filters\" note); narrow with filter_by_kind / filter_by_regex (or a qualified query) to one match so the detail fans out automatically. See the code_search_symbol examples in the code-nav block.",
            "Ranking: a bare name with an exact workspace match returns ONLY that match; with no workspace match, third-party exact matches come first, then fuzzy. For cpp (ccls) the `name` is the full qualified signature, so a qualified query uses a token-level suffix match (`std::vector::push_back` matches, `std::my_vector::push_back` does not — the `_` token boundary is honored).",
        ],
        parameters: Type.Object({
            query: Type.String({
                description:
                    "Symbol name to search for. A bare name (e.g. `loads`, `TempC`) searches the workspace first, then third-party/stdlib. A qualified name (`typing.cast`, `cbor2.loads`, `std::vector::push_back`) pins a specific module/namespace.",
            }),
            language: Type.Optional(
                StringEnum(ALL_LANGS, {
                    description: "Optional: limit the search to one language.",
                }),
            ),
            info: Type.Optional(
                Type.Array(
                    StringEnum(["code", "hover", "references"] as const, {
                        description:
                            'Optional: detail to fan out per exact match. `code` → verbatim source body (head-snippeted to a shared 2000-line budget); `hover` → signature + docstring; `references` → up to 25 call sites (capped, with a note to use code_references for all). `hover` is auto-dropped when `code` is present. Up to 5 exact matches are fanned out; over the cap you get a row list + a "narrow with filters" note.',
                    }),
                ),
            ),
            filter_by_kind: Type.Optional(
                Type.Array(
                    StringEnum(
                        [
                            "file",
                            "module",
                            "namespace",
                            "package",
                            "class",
                            "method",
                            "property",
                            "field",
                            "constructor",
                            "enum",
                            "enummember",
                            "interface",
                            "function",
                            "variable",
                            "constant",
                            "struct",
                            "event",
                            "operator",
                            "typeparameter",
                        ] as const,
                        {
                            description:
                                "Optional: keep only matches whose LSP SymbolKind matches one of these friendly names (case-insensitive). Unknown names silently match nothing.",
                        },
                    ),
                ),
            ),
            filter_by_regex: Type.Optional(
                Type.String({
                    description:
                        "Optional: a case-insensitive regexp tested against each match's rendered name column (for cpp the full signature, for py/ts the bare identifier). Applied AFTER the tier filter; an invalid regexp is a hard error.",
                }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.symbol never throws on RECOVERABLE errors (unknown server,
            // failed workspace/symbol call — those become ERROR rows), but it
            // DOES throw on an invalid `language` value (a hard input-validation
            // error, same contract as code_scan's pattern/range validation) so
            // wrap in try/catch like the other validating tools.
            try {
                return text_result(
                    await nav.symbol(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
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
            'Retrieve hover/documentation for the symbol at the given position (path, line, column). Returns a signature-first line (`signature: <collapsed one-line signature>`) when one can be extracted, followed by the full hover markdown body (docstring, signature, type info). Accepts absolute paths, including third-party locations (nix store, site-packages, node_modules, system headers). Usually reached via code_search_symbol\'s `info: ["hover"]` (auto-dropped when `code` is also requested, since code is a superset); call directly when you already have a position.',
        promptSnippet: "Get signature and doc string of a given function.",
        promptGuidelines: [
            "Use code_hover when you need a signature or docstring. It emits a `signature:` first line (cheap structured info) before the full markdown body; accepts absolute third-party paths (nix store, site-packages, system headers).",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Number({ description: "1-based line number of the symbol" }),
            column: Type.Number({ description: "1-based column number of the symbol" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.hover emits a structured ERROR row on recoverable failures
            // (unknown language, cannot read, server unavailable). Never throws.
            return text_result(await nav.hover(params, ctx.cwd, (lang) => state.pool.client(lang)));
        },
    });

    // 7. code_scan (identifier scan of a file or line range)
    pi.registerTool({
        name: "code_scan",
        label: "Code Scan",
        description:
            "Scan a source file for identifiers — type names, calls, member accesses, imports — and return each with its position and syntactic role. Optionally filter by a name pattern and/or limit to a line range. Output has a header line, then one row per identifier: `<role> <name>  :<line>:<col>` (plus a trailing hover label if include_docs=true). Example:\n  Symbols in foo.py:1-40 (roles: type|call|member|import|var, 1-based, reusable as code_* input):\n    import  cbor2   :3:8\n    call    loads   :10:12",
        promptSnippet:
            "List identifiers (with positions + roles) in a file or range; optionally filter by name pattern",
        promptGuidelines: [
            "Use code_scan to list every identifier (type/call/member/import) in a file or line range — the primary entry point for third-party discovery via imports. Pass `pattern` to narrow by name and `startLine`/`endLine` to limit the range; roles default to [type,call,member,import] (omit `var`), pass `[\"var\"]` to include locals. Set include_docs=true to append a one-line hover label per symbol.",
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
            "Use code_diagnostics after editing a file to check it compiles/type-checks, or to find the exact location of a problem; an empty result means the server found no issues.",
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
        // Per-server stderr logs live under ~/.pi/agent/logs/code-nav so the
        // user can inspect language-server output without access to the agent's
        // temp files. One file per spawned server (<lang>-<pid>.log), removed on
        // shutdown/exit (see LspClient.closeLog). mkdirSync is idempotent and
        // cheap; created once per pool (i.e. once per /code-nav enable).
        const logDir = join(getAgentDir(), "logs", "code-nav");
        try {
            mkdirSync(logDir, { recursive: true });
        } catch (e) {
            // If we can't create the log dir (read-only home, etc.) proceed
            // without logging — LspClient tolerates a logDir that's missing or
            // unwritable (the write stream's error handler drops it). But we'd
            // rather pass the intended path and let per-file creation fail
            // gracefully than silently disable logging for everyone.
            console.error(`[code-nav] could not create log dir ${logDir}: ${e}`);
        }
        const pool = new ServerPool(ctx.cwd, overrides, logDir);
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
 *   3. Show concrete code_search_symbol filtering examples (narrowing bare
 *      names with many matches / overloads down to one fanned-out result).
 * Kept tight — this is appended to every system prompt while enabled.
 */
const CODE_NAV_PROMPT_BLOCK = `## code-nav tools (LSP-backed code navigation)

The code_* tools are backed by real language servers (ccls/ty/pyright/
bash-language-server/typescript-language-server) plus tree-sitter. They index
the workspace, so prefer them over grep/read/sed for code tasks — they are
faster, semantic, and return 1-based positions that round-trip between tools.

Two groups — ENTRY POINTS produce a position; DETAIL TOOLS consume one.

ENTRY POINTS (no precise position yet):
- code_search_symbol — OMNI entry point. Find a symbol by name (bare or
  qualified) across the workspace AND third-party/stdlib. Pass \`info\` to ALSO
  fetch per-match detail in the SAME call: \`["code"]\` = source body,
  \`["hover"]\` = signature+docstring, \`["references"]\` = up to 25 call sites.
  Pass \`filter_by_kind\` / \`filter_by_regex\` to narrow to one match.
- code_outline  — list functions/classes/methods in a file
- code_tree     — pattern-driven pruned symbol tree with signatures
- code_scan     — list every identifier (type/call/member/import) in a file or range

DETAIL TOOLS (take a position from an entry point):
- code_definition   — verbatim source body of a symbol's definition
- code_references   — all call sites of a symbol
- code_hover        — docstring / signature / type info
- code_rename       — rename a symbol across the workspace; edits applied to disk
- code_diagnostics  — errors/warnings a language server reports for a file

Positions are 1-based throughout; an entry point's printed line:col feeds
straight into a detail tool's line/column params — no conversion.

Prefer code_* over the grep/read reflex:
- find a symbol by name AND get its body/call sites in one call → code_search_symbol(query, info:["code","references"])
- read a function's source body   → code_outline then code_definition (not grep -n + read)
- list identifiers in a snippet   → code_scan (not rg -o)
- find all call sites of a symbol → code_references (not rg)
- rename a symbol                 → code_rename (not sed -i)
- check a file for errors         → code_diagnostics (not a hand-written checker)
- learn a symbol's type or docs   → code_hover (not eyeballing the file)
- read a third-party API's source → code_search_symbol(qualified name, info:["code"])

### code_search_symbol examples

Bare name → bodies + call sites in one call (workspace first, then third-party):
  code_search_symbol(query="parse", info=["code","references"])

Qualified name pins a specific module/namespace (third-party/stdlib):
  code_search_symbol(query="cbor2.loads", info=["code"])
  code_search_symbol(query="std::vector::push_back", info=["code","references"])

Narrowing a bare name with many matches (overloads, header/source, etc.).
A bare query can return >5 exact matches, which exceeds the fan-out cap —
you get a row list + a "narrow with filters" note. Re-call with filters to
get the fan-out. When the filters leave a single match AND \`info\` is set,
the detail is returned automatically (no third call).

  # many cpp matches across overloads + containers — no fan-out (over cap):
  code_search_symbol(query="push_back")
  # narrow to methods only:
  code_search_symbol(query="push_back", filter_by_kind=["method"], info=["code"])
  # or by a regexp on the rendered name (full signature for cpp):
  code_search_symbol(query="push_back", filter_by_regex="vector::push_back", info=["code"])
  # or pin one method on a specific class (kind + regexp together):
  code_search_symbol(query="push_back",
                     filter_by_regex="std::vector::push_back",
                     filter_by_kind=["method"], info=["code"])

  # Python: \`name\` is the bare identifier — narrow by module via a qualified
  # query, or by path/regex when several modules define the same name:
  code_search_symbol(query="loads")                       # many stdlib/site-packages hits
  code_search_symbol(query="cbor2.loads", info=["code"])   # pins the module
  code_search_symbol(query="loads", filter_by_kind=["function"],
                     filter_by_regex="cbor2", info=["code"])

Notes: \`hover\` is auto-dropped when \`code\` is present (code is a superset).
\`filter_by_regex\` is case-insensitive, applied to the rendered name column
(full qualified signature for cpp, bare identifier for py/ts).`;
