#!/usr/bin/env node
// lsp-trace.mjs — reusable debug harness for tracing LSP server traffic.
//
// Spawns a real language server (ccls/pyright/ty/typescript-language-server),
// performs the full initialize handshake (mirroring LspClient's capabilities
// and init options), and logs every JSON-RPC message with timestamps and
// elapsed-ms from t0. Uses vscode-jsonrpc's built-in Trace.Verbose so no
// message is silently dropped.
//
// Supports chaining: positional args are consumed in order as commands.
//   node scripts/lsp-trace.mjs <lang> [--root <dir>] <cmd1> [args...] <cmd2> [args...] ...
//
// Commands:
//   open <file>                        didOpen + wait for $/progress "end" (15s max)
//   symbol <query>                     workspace/symbol
//   workspaceSymbol <query>            alias for symbol
//   hover <file> <line:1> <col:1>      textDocument/hover
//   definition <file> <line:1> <col:1> textDocument/definition
//   references <file> <line:1> <col:1> textDocument/references
//   idle <ms>                          Wait, observing background traffic
//   initOptions                        Print resolved initializationOptions and exit
//
// Examples:
//   # What does ccls send during cold indexing of blackjack.cpp?
//   node scripts/lsp-trace.mjs cpp --root /tmp/foo open blackjack.cpp
//
//   # Same but then query workspace/symbol:
//   node scripts/lsp-trace.mjs cpp --root /tmp/foo open blackjack.cpp symbol drawCard
//
//   # Just observe background traffic for 5s after handshake:
//   node scripts/lsp-trace.mjs cpp --root /tmp/foo idle 5000
//
// Env:
//   CODE_NAV_ROOT  default workspace root (overridden by --root)

import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    Trace,
} from "vscode-jsonrpc";

// ---------------------------------------------------------------------------
// Resolve real config from lsp-client.ts so the handshake matches production.
// ---------------------------------------------------------------------------

const EXT_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const jiti = createJiti(EXT_DIR, { cache: false, interopDefault: true });
const { resolveConfig } = await jiti.import("./src/lsp-client.ts");

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let lang = null;
let root = process.env.CODE_NAV_ROOT ?? process.cwd();
const positional = [];

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root") {
        root = args[++i];
        continue;
    }
    positional.push(args[i]);
}

lang = positional.shift();
if (!lang || !["cpp", "python", "bash", "typescript"].includes(lang)) {
    process.stderr.write(`usage: lsp-trace.mjs <lang> [--root <dir>] <command> [args...] ...

Commands:
  open <file>                            didOpen + wait for $/progress "end" (15s max)
  symbol <query>                         workspace/symbol
  hover <file> <line:1> <col:1>          textDocument/hover
  definition <file> <line:1> <col:1>     textDocument/definition
  references <file> <line:1> <col:1>     textDocument/references
  idle <ms>                              Wait, observing background traffic
  initOptions                            Print resolved initializationOptions and exit

Chain multiple commands:
  lsp-trace.mjs cpp --root /tmp/foo open blackjack.cpp symbol drawCard

Env:
  CODE_NAV_ROOT  default workspace root (overridden by --root)
`);
    process.exit(2);
}

if (positional.length === 0) {
    process.stderr.write("error: no command given\n");
    process.exit(2);
}

const cfg = resolveConfig(lang);
const t0 = Date.now();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const elapsed = () => `${Date.now() - t0}ms`;
const shortPath = (p) => (typeof p === "string" ? basename(p) : String(p));

function compact(obj, max = 200) {
    try {
        const s = JSON.stringify(obj);
        return s.length > max ? s.slice(0, max) + "…" : s;
    } catch {
        return String(obj);
    }
}

function languageIdFor(absPath) {
    const dot = absPath.lastIndexOf(".");
    const ext = dot < 0 ? "" : absPath.slice(dot).toLowerCase();
    if (lang === "typescript") {
        if (ext === ".tsx") return "typescriptreact";
        if (ext === ".jsx") return "javascriptreact";
        if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
        return "typescript";
    }
    if (lang === "cpp") return "cpp";
    return lang;
}

const log = (tag, ...rest) => console.log(`[${elapsed()}] ${tag}`, ...rest);

// ---------------------------------------------------------------------------
// Spawn server, create traced connection, do handshake
// ---------------------------------------------------------------------------

log("spawn", `${cfg.command} ${cfg.args.join(" ")}`, "in", root);

const proc = spawn(cfg.command, cfg.args, { stdio: ["pipe", "pipe", "pipe"] });
proc.on("error", (e) => {
    log("SPAWN-ERR", e.message);
});
proc.on("exit", (c, sig) => {
    log("EXIT", `code=${c} sig=${sig}`);
});
proc.stderr.on("data", (d) => {
    // ccls logs info/warn/error to stderr — surface it.
    for (const line of d.toString().split("\n").filter(Boolean)) {
        console.error(`[ccls] ${line}`);
    }
});

const reader = new StreamMessageReader(proc.stdout);
const writer = new StreamMessageWriter(proc.stdin);
const conn = createMessageConnection(reader, writer, {
    error: (m) => log("RPC-ERR", m),
    warn: (m) => log("RPC-WARN", m),
    info: () => {},
    log: () => {},
});

// ---------------------------------------------------------------------------
// Enable built-in tracing — logs every sent/received message
// ---------------------------------------------------------------------------

await conn.trace(Trace.Verbose, {
    log: (msg, data) => {
        if (typeof msg === "string") {
            log("TRACE", msg);
            if (data) {
                const lines = data.split("\n").filter(Boolean);
                for (const l of lines.slice(0, 3)) log("TRACE", " ", l);
                if (lines.length > 3) log("TRACE", " ", `… (${lines.length - 3} more lines)`);
            }
        } else if (msg?.isLSPMessage) {
            const method = msg.message?.method ?? msg.message?.id ?? "?";
            log(
                "TRACE",
                `${msg.type} ${method}`,
                compact(msg.message?.params ?? msg.message?.result ?? msg.message?.error, 150),
            );
        } else {
            log("TRACE", compact(msg, 150));
        }
    },
});

// ---------------------------------------------------------------------------
// Register handlers — same as LspClient — to keep server behavior identical
// ---------------------------------------------------------------------------

conn.onNotification("textDocument/publishDiagnostics", (p) => {
    log("PUSH-DIAG", `${shortPath(p.uri)} n=${p.diagnostics?.length ?? 0}`);
});

conn.onRequest("window/workDoneProgress/create", (params) => {
    log("PROGRESS-CREATE", compact(params));
    return null; // void — must answer so ccls emits $/progress
});

conn.onNotification("$/progress", (params) => {
    log(
        "PROGRESS",
        `token=${params?.token} kind=${params?.value?.kind} msg=${params?.value?.message ?? ""}`,
    );
});

conn.listen();

// Auto-generate build/compile_commands.json before initialize — ccls reads
// it during init and starts project-wide indexing. Without it, ccls only
// indexes the file opened via didOpen (no $/progress notifications).
const compileDb = resolve(root, "build", "compile_commands.json");
let autoCreated = false;
try {
    await import("node:fs/promises").then((fs) => fs.access(compileDb));
} catch {
    const dir = resolve(root, "build");
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    // Scan root for .cpp files and create entries for them.
    const files = await import("node:fs/promises").then((fs) => fs.readdir(root));
    const cppFiles = files.filter((f) => /\.(cpp|cc|cxx|c)$/.test(f));
    if (cppFiles.length > 0) {
        const entries = cppFiles.map((f) => ({
            directory: root,
            command: `clang++ -std=c++17 ${f}`,
            file: resolve(root, f),
        }));
        await import("node:fs/promises").then((fs) =>
            fs.writeFile(compileDb, JSON.stringify(entries, null, 2), "utf8"),
        );
        autoCreated = true;
        log("AUTO", `created ${compileDb} (${cppFiles.length} files)`);
    }
}

// ---------------------------------------------------------------------------
// initialize + initialized handshake (mirrors LspClient.ensureReady)
// Source of truth: src/lsp-client.ts lines ~716-814
// ---------------------------------------------------------------------------

const rootUri = pathToFileURL(root).href;
const initParams = {
    processId: process.pid,
    rootUri,
    capabilities: {
        textDocument: {
            synchronization: { didSave: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: false },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: false },
            publishDiagnostics: { versionSupport: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        },
        workspace: { symbol: {} },
        window: { workDoneProgress: true },
    },
    initializationOptions: cfg.initOptions,
    workspaceFolders: [{ uri: rootUri, name: "root" }],
};

log("SEND", "initialize");
const initResult = await conn.sendRequest("initialize", initParams);
log("INIT-RESULT", `capabilities keys: ${Object.keys(initResult?.capabilities ?? {}).join(", ")}`);

log("SEND", "initialized");
await conn.sendNotification("initialized", {});
log("HANDSHAKE-INIT", "done");

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

let docVersion = 0;

function waitForIndexEnd(timeoutMs = 15000) {
    // Subscribe to $/progress on the "index" token. Resolve when "end" arrives
    // or after timeout. This is the same signal LspClient.waitForIndexingComplete
    // gates on. If the progress events already fired before this subscribe,
    // we'll just hit the timeout.
    return new Promise((resolve) => {
        const t = Date.now();
        let started = false;
        const disposable = conn.onNotification("$/progress", (params) => {
            if (params?.token !== "index") return;
            const kind = params?.value?.kind;
            if (kind === "begin") {
                started = true;
                log("WAIT-PROGRESS", `begin — indexing started`);
            } else if (kind === "end") {
                log("WAIT-PROGRESS", `end — indexing complete (${Date.now() - t}ms)`);
                disposable.dispose();
                clearTimeout(timer);
                resolve();
            } else if (kind === "report") {
                log("WAIT-PROGRESS", `report ${params?.value?.message ?? ""}`);
            }
        });
        const timer = setTimeout(() => {
            disposable.dispose();
            log("WAIT-PROGRESS", `timeout (${timeoutMs}ms), started=${started}`);
            resolve();
        }, timeoutMs);
    });
}

async function doOpen(filePath) {
    const absPath = resolve(root, filePath);
    const text = await readFile(absPath, "utf8");
    const uri = pathToFileURL(absPath).href;
    docVersion++;
    log("CMD", `open ${basename(absPath)} (${text.length} chars, v${docVersion})`);
    await conn.sendNotification("textDocument/didOpen", {
        textDocument: {
            uri,
            languageId: languageIdFor(absPath),
            version: docVersion,
            text,
        },
    });
    // Wait for $/progress "end" or timeout — mirrors LspClient.ensureProjectLoaded.
    await waitForIndexEnd(15000);
}

async function doSymbol(query) {
    log("CMD", `symbol query=${compact(query, 50)}`);
    const syms = await conn.sendRequest("workspace/symbol", { query });
    const list = Array.isArray(syms) ? syms : [];
    log("CMD", `symbol → ${list.length} results`);
    for (const s of list.slice(0, 15)) {
        const loc = s.location?.uri
            ? `${shortPath(s.location.uri)}:${(s.location.range?.start?.line ?? 0) + 1}`
            : "?";
        log("  RESULT", `[kind=${s.kind}] ${s.name} @ ${loc}`);
    }
    if (list.length > 15) log("  RESULT", `… (${list.length - 15} more)`);
    return list;
}

function consumeLineCol() {
    const file = positional.shift();
    const lineStr = positional.shift();
    const colStr = positional.shift();
    const line = parseInt(lineStr, 10) - 1;
    const col = parseInt(colStr, 10) - 1;
    if (!file || isNaN(line) || isNaN(col)) {
        console.error("error: expected <file> <line:1-based> <col:1-based>");
        process.exit(2);
    }
    return { file, line, col };
}

async function doHover(file, line, col) {
    const absPath = resolve(root, file);
    const uri = pathToFileURL(absPath).href;
    log("CMD", `hover ${basename(absPath)}:${line + 1}:${col + 1}`);
    const result = await conn.sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: { line, character: col },
    });
    log("CMD", `hover → ${compact(result, 200)}`);
}

async function doDefinition(file, line, col) {
    const absPath = resolve(root, file);
    const uri = pathToFileURL(absPath).href;
    log("CMD", `definition ${basename(absPath)}:${line + 1}:${col + 1}`);
    const result = await conn.sendRequest("textDocument/definition", {
        textDocument: { uri },
        position: { line, character: col },
    });
    log("CMD", `definition → ${compact(result, 300)}`);
}

async function doReferences(file, line, col) {
    const absPath = resolve(root, file);
    const uri = pathToFileURL(absPath).href;
    log("CMD", `references ${basename(absPath)}:${line + 1}:${col + 1}`);
    const result = await conn.sendRequest("textDocument/references", {
        textDocument: { uri },
        position: { line, character: col },
        context: { includeDeclaration: true },
    });
    const locs = Array.isArray(result) ? result : [];
    log("CMD", `references → ${locs.length} locations`);
    for (const l of locs.slice(0, 10)) {
        log(
            "  REF",
            `${shortPath(l.uri)}:${(l.range?.start?.line ?? 0) + 1}:${(l.range?.start?.character ?? 0) + 1}`,
        );
    }
    if (locs.length > 10) log("  REF", `… (${locs.length - 10} more)`);
}

// ---------------------------------------------------------------------------
// Command dispatch — supports chaining multiple commands
// ---------------------------------------------------------------------------

async function runCommands() {
    while (positional.length > 0) {
        const cmd = positional.shift();
        switch (cmd) {
            case "idle": {
                const ms = parseInt(positional.shift() ?? "5000", 10) || 5000;
                log("CMD", `idle ${ms}ms — observing background traffic…`);
                await new Promise((r) => setTimeout(r, ms));
                log("CMD", "idle done");
                break;
            }
            case "symbol":
            case "workspaceSymbol": {
                const query = positional.shift();
                if (!query) {
                    console.error("error: symbol <query>");
                    process.exit(2);
                }
                await doSymbol(query);
                break;
            }
            case "open": {
                const file = positional.shift();
                if (!file) {
                    console.error("error: open <file>");
                    process.exit(2);
                }
                await doOpen(file);
                break;
            }
            case "hover": {
                const { file, line, col } = consumeLineCol();
                await doHover(file, line, col);
                break;
            }
            case "definition": {
                const { file, line, col } = consumeLineCol();
                await doDefinition(file, line, col);
                break;
            }
            case "references": {
                const { file, line, col } = consumeLineCol();
                await doReferences(file, line, col);
                break;
            }
            case "initOptions": {
                console.log(JSON.stringify(cfg.initOptions, null, 2));
                break;
            }
            default:
                console.error(`error: unknown command "${cmd}"`);
                process.exit(2);
        }
    }
}

try {
    await runCommands();
} catch (e) {
    log("ERROR", e?.message ?? e);
    process.exitCode = 1;
} finally {
    log("SHUTDOWN", "sending shutdown + exit");
    try {
        await conn.sendRequest("shutdown", null);
    } catch {}
    try {
        await conn.sendNotification("exit", {});
    } catch {}
    setTimeout(() => proc.kill(), 500);
}
