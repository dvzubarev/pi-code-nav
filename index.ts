/**
 * code-nav extension
 *
 * Provides seven LLM-callable tools backed by real LSP servers (ccls for C++,
 * ty/pyright for Python, bash-language-server for bash,
 * typescript-language-server for TypeScript & JavaScript) plus tree-sitter for
 * third-party symbol discovery. They split into two groups:
 *
 *   ENTRY POINTS (produce a position):
 *   code_outline        — paginated file structure (functions, classes, methods)
 *                         with signatures, body line ranges, and doc snippets
 *   code_search_symbol  — ranked workspace-wide symbol lookup by name
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
            "Retrieve the structure of a source file: functions, classes, methods, with signatures, body line ranges, and a one-line doc snippet per entry. Output row is `Class/Method/Function <name> <details> :sl-el:col`. It reports line range (sl-el) to use in read tool and you can reuse first line and column as an input to detail tools. Output is paginated (default 20 entries per page); use offset/limit to page further.",
        promptSnippet: "List functions/classes/methods in a file with signatures + doc snippets",
        promptGuidelines: [
            "Use code_outline when you need to get a quick grasp of a file code structure."
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            offset: Type.Optional(
                Type.Number({
                    description: "1-based start entry for pagination. Default 1.",
                }),
            ),
            limit: Type.Optional(
                Type.Number({
                    description: "Max entries per page (default 20, hard cap 200). Bounds the per-row hover cost.",
                }),
            ),
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

    // 2. code_definition
    pi.registerTool({
        name: "code_definition",
        label: "Code Definition",
        description:
            'Retrieve the source code of a function/class/method definition. Given a symbol position (path, line, column), resolves the definition and returns function/class/method source. Output format: a header line `<defPath>:<sl>-<el>` (1-based inclusive line range) followed by the raw source lines. A position may resolve to several definition sites (overloads, etc.): one block per site, separated by a blank line, with a trailing `# N definitions` count.',
        promptSnippet: "Retrieve source code of a function/class/method.",
        promptGuidelines: [
            "Call code_definition after entrypoint to obtain a source code of class/method/function from a file (prefer over grep -n + read)."
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Number({ description: "1-based line number of the symbol" }),
            column: Type.Number({ description: "1-based column number of the symbol" }),
            list_symbols: Type.Optional(
                Type.Boolean({
                    description:
                        'If true, append a symbol table for the returned body (default: false). The table lists identifiers with their position and syntactic role (type/call/member/import).',
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
            'Find all references to the symbol at the given position (path, line, column). Returns one reference location per line (`<path>:<line>:<col>`, grep-style) plus a trailing `# N references` count. An empty result (no references) is a parenthesized note, not an error.',
        promptSnippet: "Find all call sites of a symbol.",
        promptGuidelines: [
            "Call code_references after entrypoint to find every call site of method/function (prefer over grep/rg)."
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
            'Symbol search by name across the workspace AND third-party/stdlib trees. Given a `query` return a ranked list of matching symbols (`[lang] <Kind> <name>  <path>:<line>:<col>`). Pass optional `info` to ALSO fan out per exact match.',
        promptSnippet:
            "Find a symbol by name (bare or qualified) across the workspace AND third-party/stdlib.",
        promptGuidelines: [
            "Use code_search_symbol for code navigation — find a location of symbol by name and (optionally) get its code/hover/references in one call via `info`."
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
                            'Optional: detail to fan out per exact match. `code` → verbatim source body; `hover` → signature + docstring; `references` → up to 25 call sites. `hover` is auto-dropped when `code` is present. Up to 5 exact matches are fanned out.',
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
                        "Optional: a case-insensitive regexp tested against each match's rendered name column (for cpp the full signature, for py/ts the bare identifier).",
                }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            // nav.symbol never throws on RECOVERABLE errors (unknown server,
            // failed workspace/symbol call — those become ERROR rows), but it
            // DOES throw on an invalid `language` value (a hard input-validation
            // error, same contract as other validating tools) so
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
            "Use code_rename to rename symbol across the whole workspace (prefer over sed -i or multiple edit calls).",
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
            'Retrieve hover/documentation for the symbol at the given position (path, line, column). Returns a signature-first line (`signature: <collapsed one-line signature>`) when one can be extracted, followed by the full hover markdown body (docstring, signature, type info).',
        promptSnippet: "Get signature and doc string of a given symbol.",
        promptGuidelines: [
            "Call code_hover after entrypoint to obtain signature and docstring of method/functon."
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

    // 7. code_diagnostics
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
            "code-nav enabled — tools: code_outline, code_definition, code_references, code_search_symbol, code_rename, code_hover, code_diagnostics",
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
            "Enable LSP-backed code navigation tools (code_outline, code_definition, code_references, code_search_symbol, code_rename, code_hover, code_diagnostics)",
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
 *   1. Group the seven tools into ENTRY POINTS (produce positions) vs DETAIL
 *      TOOLS (consume positions), making the round-trip obvious.
 *   2. Reframe common grep/read/sed reflexes as code_* calls.
 *   3. Show concrete code_search_symbol filtering examples (narrowing bare
 *      names with many matches / overloads down to one fanned-out result).
 * Kept tight — this is appended to every system prompt while enabled.
 */
const CODE_NAV_PROMPT_BLOCK = `## code-nav tools (LSP-backed code navigation)

The code_* tools are backed by real language servers (ccls/ty/pyright). They index
the workspace, so prefer them over grep/read/sed for code tasks.

Two groups:
1. ENTRYPOINTS: code_outline/code_search_symbol and code_definition(...,list_symbols=true): produce a list of symbols with position.
2. DETAIL TOOLS: all other code_*: consume path + position (line and column).
   Positions are 1-based throughout;
   an entry point's printed line:col feeds straight into a detail tool's line/column params.

### code_search_symbol examples

Bare name → bodies + call sites in one call (workspace first, then third-party):
  code_search_symbol(query="parse", info=["code","references"])

Qualified name pins a specific module/namespace:
  code_search_symbol(query="vector::push_back", info=["code","references"])
  code_search_symbol(query="cbor2.loads", info=["code"])
  code_search_symbol(query="json.loads", info=["hover"])

When a query matches more than 5 sites the fan-out cap kicks in:
you get a row list + a "narrow with filters" note.
Re-call with filters to get the fan-out.
When the filters leave a single match AND \`info\` is set, the detail is returned automatically (no third call).

  # many cpp matches across overloads + containers — no fan-out (over cap):
  code_search_symbol(query="push_back")
  # narrow to methods only:
  code_search_symbol(query="push_back", filter_by_kind=["method"], info=["code"])
  # or by a regexp on the rendered name (filter overload by argument type):
  code_search_symbol(query="std::to_string", filter_by_regex="long", info=["code"])
  # or pin one method on a specific class (kind + regexp together):
  code_search_symbol(query="std::hash", filter_by_regex="string_view", filter_by_kind=["class"], info=["code"])`;
