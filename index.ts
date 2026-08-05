/**
 * code-nav extension
 *
 * Provides seven LLM-callable tools backed by real LSP servers (ccls for C++,
 * ty/pyright for Python, bash-language-server for bash, and
 * typescript-language-server for TypeScript/JavaScript). They split into three
 * workflow groups:
 *
 *   DISCOVERY TOOLS (produce a position):
 *   code_outline        — paginated file structure (functions, classes, methods)
 *                         with signatures, body line ranges, and doc snippets
 *   code_search_symbol  — ranked workspace-wide symbol lookup by name
 *
 *   POSITION-BASED TOOLS (consume path + 1-based line + column):
 *   code_definition     — location + full source body of a symbol's definition
 *   code_references     — list of references for a symbol
 *   code_hover          — hover/documentation for a symbol
 *   code_rename         — rename a symbol, edits applied to disk
 *
 *   FILE-ANALYSIS TOOL:
 *   code_diagnostics    — errors/warnings for a file (pull-first, push fallback)
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
            "Show the structural outline of a source file: classes, functions, methods, constructors, interfaces, and structs. Each entry includes its signature, reusable 1-based identifier position (`path:line:column`), body range, and an optional one-line documentation summary. Results are paginated (default 20 entries per page); use offset/limit to continue.",
        promptSnippet:
            "Show a file's structural outline with signatures and documentation summaries",
        promptGuidelines: [
            "Use code_outline to quickly understand a file's structure and obtain positions for symbol-based tools.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            offset: Type.Optional(
                Type.Integer({
                    minimum: 1,
                    description: "1-based start entry for pagination. Default 1.",
                }),
            ),
            limit: Type.Optional(
                Type.Integer({
                    minimum: 1,
                    maximum: 200,
                    description: "Maximum entries per page (default 20, hard cap 200).",
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
            "Return the source code for the definition of the symbol at a 1-based file position. For functions, methods, and classes, the result includes the complete source body. Multiple definition sites are returned as separate blocks. Each block starts with `<defPath>:<startLine>-<endLine>` followed by raw source text.",
        promptSnippet: "Return the source code for a symbol's definition",
        promptGuidelines: [
            "Use code_definition after a discovery tool to retrieve semantic source rather than locating it with grep and read.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Integer({ minimum: 1, description: "1-based line number of the symbol" }),
            column: Type.Integer({
                minimum: 1,
                description: "1-based column number of the symbol",
            }),
            list_symbols: Type.Optional(
                Type.Boolean({
                    description:
                        "If true, append a symbol table for the returned body (default: false). The table lists identifiers with their position and syntactic role (type/call/member/import).",
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
            "Find semantic references/usages, including declarations. Results are paginated (default 25) and include AST-aware source context, syntactic role, and enclosing symbol metadata. Use context='none' for compact locations.",
        promptSnippet: "Find all references and usages of a symbol",
        promptGuidelines: [
            "Use code_references after a discovery tool to find semantic usages rather than text matches from grep or rg.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Integer({ minimum: 1, description: "1-based line number of the symbol" }),
            column: Type.Integer({
                minimum: 1,
                description: "1-based column number of the symbol",
            }),
            context: Type.Optional(
                StringEnum(["none", "syntax", "enclosing"] as const, {
                    description:
                        "Context mode (default: syntax). none returns locations only; syntax returns the smallest useful AST construct; enclosing returns its containing statement/control construct.",
                }),
            ),
            offset: Type.Optional(
                Type.Integer({
                    minimum: 1,
                    description: "1-based start reference for pagination. Default 1.",
                }),
            ),
            limit: Type.Optional(
                Type.Integer({
                    minimum: 1,
                    maximum: 200,
                    description: "Maximum references per page (default 25, hard cap 200).",
                }),
            ),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                return text_result(
                    await nav.references(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },
    });

    // 4. code_search_symbol
    pi.registerTool({
        name: "code_search_symbol",
        label: "Code Symbol Search",
        description:
            "Search workspace and relevant third-party/standard-library symbols by bare or qualified name. Python direct dependencies are added as roots for ty; ccls can find included third-party headers and their transitive includes. Returns ranked `[lang] <Kind> <name>  <path>:<line>:<column>` rows. Use `include` to also retrieve details for exact matches.",
        promptSnippet: "Find workspace and indexed third-party symbols by bare or qualified name",
        promptGuidelines: [
            "Use code_search_symbol as the main name-based navigation entry point; `include` can retrieve definitions, hover information, and references in the same call.",
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
            include: Type.Optional(
                Type.Array(
                    StringEnum(["definition", "hover", "references"] as const, {
                        description:
                            "Details to retrieve for each exact match: `definition` returns source, `hover` returns signature/type/docs, and `references` returns up to 25 usages. Up to 5 exact matches are expanded.",
                    }),
                ),
            ),
            kinds: Type.Optional(
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
                                "Keep only matches whose LSP symbol kind is one of these values.",
                        },
                    ),
                ),
            ),
            name_pattern: Type.Optional(
                Type.String({
                    description:
                        "Optional case-insensitive regular expression tested against each rendered name (the full signature for C++, the bare identifier for Python/TypeScript).",
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
            "Rename the symbol at a 1-based file position across the workspace. The resulting edits are applied directly to disk. Returns each changed file and its edit count.",
        promptSnippet: "Rename a symbol semantically across the workspace",
        promptGuidelines: [
            "Use code_rename instead of sed or multiple text edits when renaming a symbol across the workspace.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Integer({ minimum: 1, description: "1-based line number of the symbol" }),
            column: Type.Integer({
                minimum: 1,
                description: "1-based column number of the symbol",
            }),
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
            "Show the signature, inferred type information, and documentation provided by the language server for the symbol at a 1-based file position. When available, a collapsed one-line `signature:` is followed by the remaining non-duplicate hover content.",
        promptSnippet: "Show a symbol's signature, type information, and documentation",
        promptGuidelines: [
            "Use code_hover after a discovery tool when you need a symbol's signature, inferred type, or documentation.",
        ],
        parameters: Type.Object({
            path: Type.String({ description: "File path (absolute or relative to cwd)" }),
            line: Type.Integer({ minimum: 1, description: "1-based line number of the symbol" }),
            column: Type.Integer({
                minimum: 1,
                description: "1-based column number of the symbol",
            }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            try {
                return text_result(
                    await nav.hover(params, ctx.cwd, (lang) => state.pool.client(lang)),
                );
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },
    });

    // 7. code_diagnostics
    // Pull diagnostics are attempted first. Servers that reject the pull model
    // fall back to a bounded, event-driven wait for publishDiagnostics. See
    // docs/code_diagnostics.md for the cross-server behavior.
    pi.registerTool({
        name: "code_diagnostics",
        label: "Code Diagnostics",
        description:
            "Report current language-server diagnostics for a source file, including severity, source, message, and reusable 1-based positions. An empty result means the server reported no problems.",
        promptSnippet: "Report current language-server diagnostics for a file",
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

    // Inject a grouped discovery / position / file-analysis overview into the
    // system prompt, but ONLY while code-nav tools are active. Per-tool
    // promptGuidelines are flat and cannot express this workflow.
    // This handler is always registered; it no-ops when /code-nav hasn't run.
    pi.on("before_agent_start", async (event) => {
        if (!state?.pool.enabled()) return {};
        const active = pi.getActiveTools();
        if (!active.some((t) => t.startsWith("code_"))) return {};
        const block = CODE_NAV_PROMPT_BLOCK;
        return { systemPrompt: event.systemPrompt + "\n\n" + block };
    });
}

/** Grouped workflow injected only while code-nav is enabled. */
const CODE_NAV_PROMPT_BLOCK = `## code-nav tools (semantic code navigation)

Prefer code_* tools over grep/read/sed when the task is semantic. All input and
output positions are 1-based, and every printed path:line:column can be passed
directly to a position-based tool.

DISCOVERY TOOLS (produce positions):
- code_search_symbol — search workspace and indexed third-party symbols by bare
  or qualified name; use include to retrieve details in the same call
- code_outline — show a file's classes/functions/methods with signatures,
  documentation summaries, identifier positions, and body ranges

POSITION-BASED TOOLS (consume path + line + column):
- code_definition — source code for a symbol's definition
- code_hover — signature, inferred type, and documentation
- code_references — paginated semantic usages with syntax context, role, and
  enclosing symbol metadata; context="none" gives compact locations
- code_rename — semantic workspace rename, applied directly to disk

FILE-ANALYSIS TOOL:
- code_diagnostics — current errors, warnings, and hints for a source file

code_search_symbol examples:
  code_search_symbol(query="parse", include=["definition","references"])
  code_search_symbol(query="cbor2.loads", include=["definition","hover"])
  code_search_symbol(query="vector::push_back", kinds=["method"],
                     name_pattern="int", include=["definition"])

At most 5 exact search matches are expanded. If more remain, narrow them with
a qualified name, kinds, or name_pattern.`;
