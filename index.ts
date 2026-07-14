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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
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
            "Retrieve the VERBATIM source code of a function/class/method definition. Given a symbol position (path, line, column), resolves the definition and returns the full body — the complete function/class/method source, ready to copy into an edit. Output format: a header line `<defPath>:<sl>-<el>` (1-based inclusive line range of the body) followed by the raw source lines (no code fence). The definition may live in a different file than the input position (including third-party trees).",
        promptSnippet: "Retrieve verbatim source code of a function/class.",
        promptGuidelines: [
            "Use code_definition when you need the FULL source body of a function/class/method — the verbatim text, ready to copy into an edit. You must know the symbol's position (path, line, column) to use this tool; get one from code_outline, code_tree, code_search_symbol, or code_scan.",
            "Output format: a header line `<defPath>:<sl>-<el>` (the path the definition lives in, plus its 1-based inclusive line range), then the raw source body with NO code fence. defPath may differ from your input path (the definition can be in another file, including third-party trees).",
            "It accepts absolute paths, including third-party locations (nix store, site-packages, node_modules, system headers).",
            "HARD ERROR: if the tool cannot return verbatim source code for ANY reason (unknown language, cannot read file, server unavailable, no definition found, multiple definitions, could not resolve body range) it throws an error — there are NO fallbacks. The tool's contract is source code or failure.",
            "Set list_symbols=true to also append a symbol table after the body (useful for discovering third-party/stdlib APIs used inside). Output row format `  <role> <name>  (<line>:<col>)`. Each row is itself a position you can feed back into code_definition / code_hover / code_references — combine the header's defPath with the row's `(line:col)`.",
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
            "Find all references to the symbol at the given position (path, line, column). Returns one reference location per line plus a trailing `# N references` count. An empty result (no references) is a parenthesized note, not an error.",
        promptSnippet: "Find all references to the symbol.",
        promptGuidelines: [
            "Use code_references before renaming or refactoring to find every call site of a symbol. The count is a trailing `# N references`.",
            "Output row format: `<path> (<line>:<col>)`. To drill into a reference, combine the row's path with its (line:col) and pass to code_definition / code_hover.",
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
            "Symbol search by name across the workspace AND third-party/stdlib trees. Given a query string (a bare name like `loads` or a qualified name like `typing.cast`, `cbor2.loads`, `std::vector::push_back`), return a ranked list of matching symbols (kind, name, <path> (<line>:<col>)). For Python (ty), third-party/stdlib roots are added as workspace folders (discovered from $propagatedBuildInputs / $PYTHONPATH) so the search covers site-packages and the stdlib; ccls already indexes third-parties via its compilation database. Results are ranked: for a bare name, workspace-root exact matches are returned alone; otherwise third-party exact matches come first, then fuzzy matches (trimmed). For a qualified name, only the exact bare-name match whose module/namespace matches the qualifier is kept.",
        promptSnippet: "Search for a symbol by name (bare or qualified) across the workspace and third-party/stdlib.",
        promptGuidelines: [
            "Use code_search_symbol to find a location of a symbol by name. Pass a BARE name (e.g. `loads`, `TempC`) to find symbols in your project first; if your project has no symbol by that name, third-party/stdlib exact matches are returned next. Pass a QUALIFIED name (`typing.cast`, `cbor2.loads`, `std::vector::push_back`) to pin a specific third-party/stdlib symbol — the tool strips the qualifier, searches the bare name, then keeps only the match in that module/namespace.",
            "Ranking: a bare name with an exact workspace match returns ONLY that match (the agent's bare name is their own symbol). A bare name with no workspace match returns third-party exact matches first, then fuzzy matches (the fuzzy tail is trimmed with a trailing `# N more result(s) trimmed` note — narrow with a qualified name to get fewer, exact hits).",
            "Output row format: `[lang] <Kind> <name>  <path> (<line>:<col>)`. Feed a row's path + (line:col) straight into code_definition / code_hover / code_references. The path may be a third-party location (nix store, site-packages, system headers) — those tools accept absolute paths.",
            "For C++ (ccls) the `name` column is a full qualified signature (`constexpr void std::vector::push_back(...)`), so qualified queries (`std::vector::push_back`) rank the exact matches first. For Python (ty) the `name` column is the bare name; use the path (or a qualified query) to disambiguate which module it comes from.",
        ],
        parameters: Type.Object({
            query: Type.String({
                description:
                    "Symbol name to search for. A bare name (e.g. `loads`, `TempC`) searches the workspace first, then third-party/stdlib. A qualified name (`typing.cast`, `cbor2.loads`, `std::vector::push_back`) pins a specific module/namespace — the tool strips the qualifier, searches the bare name, then keeps only the match in that module.",
            }),
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
            "Retrieve hover/documentation for the symbol at the given position (path, line, column). Returns a signature-first line (`signature: <collapsed one-line signature>`) when one can be extracted, followed by the full hover markdown body (docstring, signature, type info). Accepts absolute paths, including third-party locations (nix store, site-packages, node_modules, system headers).",
        promptSnippet: "Get signature and doc string of a given function.",
        promptGuidelines: [
            "Use code_hover when you need signature and docstring of a function. You must know the function position to use this tool.",
            "code_hover emits a signature of a method first line before the raw markdown body — pick the first line cheaply for structured signature info without parsing the markdown.",
            "It accepts absolute paths, including third-party locations.",
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
 * Kept tight — this is appended to every system prompt while enabled.
 */
const CODE_NAV_PROMPT_BLOCK = `## code-nav tools (LSP-backed code navigation)

The code_* tools are backed by real language servers (ccls/ty/pyright/
bash-language-server/typescript-language-server) plus tree-sitter. They index
the workspace, so prefer them over grep/read/sed for code tasks — they are
faster, semantic, and return 1-based positions that round-trip between tools.

Two groups — ENTRY POINTS produce a position; DETAIL TOOLS consume one.

ENTRY POINTS (you don't have a precise position yet):
- code_search_symbol — find a symbol by name across the workspace AND third-party/stdlib (bare or qualified name)
- code_outline       — list functions/classes/methods in a file
- code_tree          — pattern-driven pruned symbol tree with signatures
- code_scan          — list every identifier (with role: type/call/member/import) in a file or a range

DETAIL TOOLS (take a position — reuse one an entry point printed):
- code_definition    — retrieve the VERBATIM source body of a symbol's definition (header \`<defPath>:<sl>-<el>\` + raw source, no fence)
- code_references    — all call sites of a symbol
- code_hover         — docstring / signature / type info
- code_rename        — rename a symbol across the workspace; edits applied to disk
- code_diagnostics   — errors/warnings a language server reports for a file

Positions are 1-based throughout. An entry point's printed line:col feeds
straight into a detail tool's line/column params — no conversion.

Prefer code_* over the grep/read reflex:
- find a symbol by name (yours OR third-party/stdlib) → code_search_symbol then code_definition (not rg + read)
- read a function's source body   → code_outline to find it, then code_definition (not grep -n + read)
- list identifiers in a snippet   → code_scan (not rg -o '\b\w+\b' — code_scan gives roles + reusable positions)
- find all call sites of a symbol → code_references (not rg)
- rename a symbol                 → code_rename (not sed -i across files)
- check a file for errors         → code_diagnostics (not a hand-written paren/quote checker)
- learn a symbol's type or docs   → code_hover (not reading the file and eyeballing)
- read a third-party API's source → code_search_symbol (qualified name) then code_definition (not
  \`python -c "import inspect; inspect.getsource(...)"\` or other hacks for various languages)


You can chain tool calls to navigate the codebase quickly. The pattern is
ENTRY POINT → DETAIL TOOL → DETAIL TOOL, where each step's output literally
contains the positions the next step needs.

1. ENTRY POINT (you don't have a position yet). Call ONE of:
   - code_outline(path)                → "Kind name  (<line>:<col>)" per row
   - code_tree(path, pattern)          → "[pad]Kind name  [<sig>]  (<line>:<col>)" per row
   - code_search_symbol(query)         → "<lang> <Kind> <name> <path> (<line>:<col>)" per row
   - code_scan(path[, start, end])     → "  role name  (<line>:<col>)" per identifier
   Pick a row, copy its (line,col) — and the path, for search_symbol/scan.

2. DETAIL TOOL (you now have a position). Pass it as {path, line, column}.
   For code_definition, set list_symbols=true to ALSO get a symbol table of
   every identifier used inside the body. The tool returns a header line
   \`<defPath>:<sl>-<el>\` then the verbatim source body (no code fence) —
   ready to copy straight into an edit.

3. DRILL DOWN. With list_symbols=true, code_definition ALSO returns a symbol
   table of every identifier used inside the body, formatted as:
       role name  (<line>:<col>)
   Each row is itself a position you can feed straight back into
   code_definition / code_hover / code_references — no outline/scan needed.
   Combine the header's defPath with the row's (line:col). So the loop is:
   definition → read its symbol table → definition again, following
   identifiers into their definitions, as deep as you need.


Retrieving third-party docs/source (site-packages, nix store, system headers) workflows:
1. PREFERRED: code_search_symbol with a QUALIFIED name. Pass \`typing.cast\`,
   \`cbor2.loads\`, \`std::vector::push_back\` — the tool searches across the
   workspace AND third-party/stdlib (for Python it adds $propagatedBuildInputs /
   $PYTHONPATH roots as workspace folders so ty indexes site-packages + the
   stdlib; ccls already indexes third-parties via its compilation database).
   You get a position; feed it into code_definition / code_hover.
2. FALLBACK (symbol not found via search, or you only have a file in view):
   use the tool call chains above — code_scan the file you're looking at to
   find the symbol's position, then code_definition / code_hover at that
   position. code_definition / code_hover accept absolute third-party paths
   (nix store, site-packages, system headers).
3. LAST RESORT (symbol from a NAME only, no position, and search found nothing):
     (1). resolve the package root. If the project uses nix, every
          third-party path is exposed via an environment variable — grep the
          right one for your language:
          python: \`echo $PYTHONPATH | tr ':' '\\n' | grep <name>\`,
          C++: (cmake, the usual case) \`echo $CMAKE_INCLUDE_PATH | tr ':' '\\n' | grep <name>\`,
          C++: (no cmake) \`echo $NIX_CFLAGS_COMPILE | tr ' ' '\\n' | grep <name>\`;
     (2). \`rg -n --column <name> <root>\` — the output is \`line:column:content\`,
          and on ASCII lines the 1-based line and column match what
          code_definition/code_hover expect.
     (3). call code_definition/code_hover on that position.
    Do NOT rg the whole /nix/store (millions of entries, many versions) —
    always scope to one resolved package root.`;
