/**
 * LSP client over stdio.
 *
 * One LspClient instance wraps a single language server child process.
 * Servers are spawned lazily on first request and shut down when the
 * extension closes the pool (session_shutdown or /code-nav:off).
 */

import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readdir, readFile, unlink } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import { resolve, join } from "node:path";
import {
    createMessageConnection,
    StreamMessageReader,
    StreamMessageWriter,
    type MessageConnection,
    type Logger,
    type TextDocumentItem,
    type InitializeParams,
    type ServerCapabilities,
    type DocumentSymbol,
    type SymbolInformation,
    type Location,
    type Hover,
    type WorkspaceEdit,
    type Definition,
    type ReferenceParams,
    type RenameParams,
    type Diagnostic,
    type DocumentDiagnosticReport,
    type FullDocumentDiagnosticReport,
    type PublishDiagnosticsParams,
} from "vscode-languageserver-protocol/node";

// Importing from the /node subpath auto-installs the jsonrpc Node RAL
// as a side effect of module load (see vscode-jsonrpc/lib/node/main.js).

export type Lang = "cpp" | "python" | "bash" | "typescript";

/** Command + args + init options for one language. */
export interface ServerConfig {
    command: string;
    args: string[];
    /** Passed as `initializationOptions` in the LSP initialize request. */
    initOptions: Record<string, unknown>;
}

/** Per-language defaults. C++ and bash match the user's Emacs config. */
const CCLS_CONFIG: ServerConfig = {
    command: "ccls",
    args: [],
    initOptions: {
        cache: { directory: `${process.env.HOME}/.cache/ccls` },
        compilationDatabaseDirectory: "build",
    },
};

/** Python: pyright (matches the user's Emacs config). */
const PYRIGHT_CONFIG: ServerConfig = {
    command: "pyright-langserver",
    args: ["--stdio"],
    initOptions: {
        multiRoot: false,
        useLibraryCodeForTypes: true,
    },
};

/**
 * Python: ty (Astral) — preferred when available because it implements
 * workspace/symbol (pyright does not) and reports standard LSP SymbolKind.
 * No init options needed; ty discovers pyproject.toml / .venv from the root.
 */
const TY_CONFIG: ServerConfig = {
    command: "ty",
    args: ["server"],
    initOptions: {},
};

const BASH_CONFIG: ServerConfig = {
    command: "bash-language-server",
    args: ["start"],
    initOptions: {},
};

/**
 * TypeScript/JavaScript: typescript-language-server wrapping tsserver. One
 * server covers both .ts and .tsx — the languageId sent in didOpen
 * distinguishes them ("typescript"/"typescriptreact"). The server implements
 * workspace/symbol, hover, definition, references, rename, and the pull
 * diagnostic model.
 */
const TYPESCRIPT_CONFIG: ServerConfig = {
    command: "typescript-language-server",
    args: ["--stdio"],
    initOptions: {
        // Let the server locate the local tsconfig.json / jsconfig.json and
        // honor the project's compiler options.
        hostInfo: "pi-code-nav",
    },
};

const DEFAULTS: Record<Lang, ServerConfig> = {
    cpp: CCLS_CONFIG,
    python: PYRIGHT_CONFIG,
    bash: BASH_CONFIG,
    typescript: TYPESCRIPT_CONFIG,
};

/**
 * Memoized PATH lookup. Returns true if `cmd` is executable on PATH.
 * Uses `which` (POSIX, always present) to avoid a node_modules dep.
 */
const cmdOnPathCache = new Map<string, boolean>();
function commandExists(cmd: string): boolean {
    const cached = cmdOnPathCache.get(cmd);
    if (cached !== undefined) return cached;
    try {
        execSync(`command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`, {
            stdio: "ignore",
        });
        cmdOnPathCache.set(cmd, true);
        return true;
    } catch {
        cmdOnPathCache.set(cmd, false);
        return false;
    }
}

/**
 * Derive the LSP `languageId` for a document from its file extension.
 *
 * Most languages have one id matching the `Lang` tag. The TypeScript server
 * is one server covering two file kinds: `.ts` -> "typescript" and `.tsx` ->
 * "typescriptreact" (likewise `.js`/`.jsx`/`.mjs`/`.cjs` -> the js variants).
 * Sending the right id lets tsserver apply the correct syntax + JSX rules.
 * Falls back to the server language for extensions with no per-file variant.
 */
function languageIdFor(absPath: string, lang: Lang): string {
    const dot = absPath.lastIndexOf(".");
    const ext = dot < 0 ? "" : absPath.slice(dot).toLowerCase();
    if (lang === "typescript") {
        if (ext === ".tsx") return "typescriptreact";
        if (ext === ".jsx") return "javascriptreact";
        if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
        return "typescript";
    }
    if (lang === "cpp") return "cpp";
    return lang; // python, bash
}

/**
 * Extensions that count as source files for each language, used by
 * findFirstSourceFile to locate a representative file to open.
 */
export const SOURCE_EXTS: Record<Lang, readonly string[]> = {
    typescript: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    cpp: [".cpp", ".cc", ".cxx", ".c", ".hpp", ".hh", ".hxx", ".h"],
    python: [".py"],
    bash: [".sh", ".bash"],
};

/**
 * Recursively find the first source file of `lang` under `rootUri`, skipping
 * node_modules, .git, build/, dist/, and hidden directories. Depth-first,
 * shallow — returns on the first match (we only need one file to trigger
 * tsserver project loading). Returns an absolute path or null.
 */
async function findFirstSourceFile(rootUri: string, lang: Lang): Promise<string | null> {
    let rootPath: string;
    try {
        rootPath = fileURLToPath(rootUri);
    } catch {
        return null;
    }
    const exts = SOURCE_EXTS[lang];
    const SKIP = new Set(["node_modules", ".git", ".", "build", "dist", "out", ".next", ".cache"]);
    async function scan(dir: string): Promise<string | null> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return null;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SKIP.has(e.name)) continue;
                const found = await scan(resolve(dir, e.name));
                if (found) return found;
            } else if (e.isFile()) {
                const dot = e.name.lastIndexOf(".");
                if (dot >= 0 && exts.includes(e.name.slice(dot).toLowerCase())) {
                    return resolve(dir, e.name);
                }
            }
        }
        return null;
    }
    return scan(rootPath);
}

/**
 * Resolve the effective config for a language.
 *
 * For Python: if the user explicitly set a `command` in .pi/lsp.json, use it
 * verbatim (their choice wins). Otherwise auto-detect: prefer `ty` when on
 * PATH (it implements workspace/symbol and standard SymbolKind), falling back
 * to `pyright-langserver`.
 */
export function resolveConfig(
    lang: Lang,
    overrides?: Partial<Record<Lang, Partial<ServerConfig>>>,
): ServerConfig {
    if (lang === "python") {
        const ov = overrides?.python;
        // Explicit user command wins (e.g. force pyright, or pick basedpyright).
        if (ov?.command) {
            return {
                command: ov.command,
                args: ov.args ?? PYRIGHT_CONFIG.args,
                initOptions: { ...PYRIGHT_CONFIG.initOptions, ...ov.initOptions },
            };
        }
        const base = commandExists("ty") ? TY_CONFIG : PYRIGHT_CONFIG;
        if (!ov) return base;
        return {
            command: base.command,
            args: ov.args ?? base.args,
            initOptions: { ...base.initOptions, ...ov.initOptions },
        };
    }
    const base = DEFAULTS[lang];
    const ov = overrides?.[lang];
    if (!ov) return base;
    return {
        command: ov.command ?? base.command,
        args: ov.args ?? base.args,
        initOptions: { ...base.initOptions, ...ov.initOptions },
    };
}

/** Minimal stderr logger — server diagnostics go here, not the agent. */
const silentLogger: Logger = {
    error: (_m: string) => {},
    warn: (_m: string) => {},
    info: (_m: string) => {},
    log: (_m: string) => {},
};

/**
 * Default per-request deadline (ms). A server that has replied to
 * `initialize` but then silently drops a request (or crashes after init
 * without disposing its connection) would otherwise leave sendRequest
 * awaiting forever — the tool call hangs. The exit/onClose → dispose() path
 * rejects in-flight requests on process death; this timeout covers the
 * alive-but-silent case (e.g. typescript-language-server over a project-less
 * root, or a server wedged mid-request). Generous enough for slow indexing
 * (ccls on a cold cache, tsserver on a large project); short enough that the
 * agent gets an error it can report per-language instead of hanging.
 * Override with the CODE_NAV_REQUEST_TIMEOUT_MS env var (ms) — used by the
 * unit tests to keep the silent-server regression test fast.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
function resolveRequestTimeoutMs(): number {
    return (
        Number.parseInt(process.env.CODE_NAV_REQUEST_TIMEOUT_MS ?? "", 10) ||
        DEFAULT_REQUEST_TIMEOUT_MS
    );
}

class RequestTimeoutError extends Error {
    constructor(method: string, ms: number) {
        super(`LSP ${method} timed out after ${ms}ms`);
        this.name = "RequestTimeoutError";
    }
}

/**
 * sendRequest with a bounded deadline. Races the jsonrpc sendRequest against a
 * timer; on timeout, rejects with RequestTimeoutError (and disposes the
 * connection — a wedged server's pending request is worthless, and dispose
 * also rejects any OTHER in-flight requests on the same dead connection).
 * The timer is cleared on a prompt reply so no dangling timeout fires after
 * success. `conn` is the live MessageConnection (caller passes this.conn!,
 * having just ensureReady()'d).
 */
async function requestWithTimeout(
    conn: MessageConnection,
    method: string,
    params: unknown,
    ms: number = resolveRequestTimeoutMs(),
): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError(method, ms)), ms);
    });
    try {
        // When params is undefined, call sendRequest with NO params argument so
        // the jsonrpc layer omits `params` on the wire. Passing `null` (or
        // even `undefined` as an explicit arg) makes vscode-jsonrpc's auto
        // parameter-structure logic wrap it as `params: [null]` (a sequence).
        // Strict servers (ty, using serde) reject that for param-less
        // methods like `shutdown` with "invalid type: sequence, expected unit".
        const req =
            params === undefined ? conn.sendRequest(method) : conn.sendRequest(method, params);
        return await Promise.race([req, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * sendNotification with a bounded deadline. Same rationale as
 * requestWithTimeout, but for notifications. Critical because a notification
 * write that never completes holds StreamMessageWriter's writeSemaphore
 * (capacity 1) forever — every subsequent sendRequest/sendNotification then
 * queues behind it and never reaches its own Promise.race, so the per-request
 * timeout never starts and the tool hangs indefinitely.
 *
 * The wedged-write scenario: a server that stops draining stdin after
 * `initialize` (alive-but-silent on its INPUT pipe — distinct from the
 * alive-but-silent-on-OUTPUT case requestWithTimeout covers). The `initialized`
 * ack and `didOpen` payloads are normally small enough to fit in the OS pipe
 * buffer, but a large didOpen (a big source file) or a buffer already partly
 * full will exceed the high-water mark and block `writable.write()` forever.
 *
 * On timeout we dispose the connection (same as a wedged request): the
 * notification is worthless if it couldn't be written, and dispose rejects
 * any other in-flight writes on the same dead transport. Throws
 * RequestTimeoutError so the caller can attribute the failure.
 */
async function notifyWithTimeout(
    conn: MessageConnection,
    method: string,
    params: unknown,
    ms: number = resolveRequestTimeoutMs(),
): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError(method, ms)), ms);
    });
    try {
        await Promise.race([conn.sendNotification(method, params), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export class LspClient {
    readonly lang: Lang;
    readonly rootUri: string;
    /**
     * The filesystem root path this client was initialized with (the
     * `workspaceFolders[0]` sent at initialize). Kept as a plain path (not
     * just a URI) so callers can compute `relative(rootPath, file)` for
     * module-path derivation in code_search_symbol's qualified-name filter.
     */
    readonly rootPath: string;
    private proc: ChildProcessWithoutNullStreams | null = null;
    private conn: MessageConnection | null = null;
    private capabilities: ServerCapabilities | null = null;
    /** Resolves when initialize + initialized handshake completes. */
    private ready: Promise<void> | null = null;
    /** Documents opened on this server, keyed by file URI. */
    private openDocs = new Map<string, { version: number; text: string }>();
    /**
     * Extra workspace folders added after initialize via
     * `workspace/didChangeWorkspaceFolders` (third-party / stdlib roots for
     * code_search_symbol). Idempotent: `addWorkspaceFolders` dedupes against
     * this set and against `rootPath`. Plain filesystem paths (not URIs) so
     * callers can do `relative(folder, file)` for module-path derivation.
     * Cleared on shutdown/exit alongside the other per-session state.
     */
    private extraWorkspaceFolders: string[] = [];
    /**
     * Latest push-model diagnostics per URI, populated by the
     * textDocument/publishDiagnostics notification handler. Latest-wins: each
     * notification replaces the previous set for that URI (the spec sends a
     * full set, not a delta). Used as a synchronous fallback for
     * code_diagnostics on servers that reject the LSP 3.17 pull model
     * (typescript-language-server, bash-language-server, ccls) — the tool opens
     * the document, waits briefly for the server's delayer to fire, then reads
     * this map. Cleared on server exit/shutdown alongside openDocs.
     */
    private diagnosticsByUri = new Map<string, Diagnostic[]>();

    constructor(lang: Lang, rootPath: string, cfg: ServerConfig, logDir?: string) {
        this.lang = lang;
        this.rootPath = rootPath;
        this.rootUri = pathToFileURL(rootPath).href;
        this.cfg = cfg;
        this.logDir = logDir;
    }

    private cfg: ServerConfig;
    /**
     * Optional directory for per-server log files. When set (the pi extension
     * passes ~/.pi/agent/logs/code-nav), each spawned server's stderr is teed
     * to <logDir>/<lang>-<pid>.log and the file is removed on shutdown/exit.
     * When unset (CLI harness, tests), stderr is only surfaced via
     * console.error — unchanged behavior.
     */
    private logDir?: string;
    /** Absolute path of the open log file, or undefined when no log is open. */
    private logPath?: string;
    /** Open write stream for the per-server log file, or undefined. */
    private logStream?: WriteStream;

    /** Spawn the server and complete the LSP initialize handshake. */
    async ensureReady(): Promise<void> {
        if (this.ready) return this.ready;
        this.ready = this.start();
        return this.ready;
    }

    private async start(): Promise<void> {
        const { command, args, initOptions } = this.cfg;
        // rejectReady lets the proc 'error' handler reject the outer
        // start()/ensureReady() promise. start() is async and awaits
        // initialize on the spawned process; without a way to reject the
        // outer promise from an async event, a proc 'error' (spawn-time
        // ENOENT, or a later transport error) would be swallowed and the
        // await would never settle — ensureReady() would hang forever.
        // Set just after the promise is created.
        let rejectReady: ((err: Error) => void) | undefined;
        // Set by the proc 'error' handler on spawn failure (ENOENT/EACCES).
        // Checked (after a microtask yield to let the async 'error' event
        // fire) before we call conn.sendRequest("initialize") — so that on a
        // spawn failure we never queue the initialize write on a dead stdin.
        // vscode-jsonrpc's sendRequest re-throws after rejecting its promise
        // when the underlying write throws ERR_STREAM_DESTROYED; that stray
        // rejection is unawaited and surfaces as an unhandledRejection. By
        // not calling sendRequest at all when spawn already failed, we avoid
        // the stray entirely (the error handler rejects rejectReady instead).
        let spawnError: Error | undefined;
        const proc = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: undefined,
        });
        this.proc = proc;

        // Attach the 'error' handler BEFORE anything else. spawn() does NOT
        // throw synchronously on ENOENT (missing binary on PATH) — it emits
        // an asynchronous 'error' event on the ChildProcess. With no
        // listener, Node treats that as an uncaught exception and kills the
        // whole process (the exact crash that took down pi when a project
        // detected bash as a language but bash-language-server wasn't on
        // PATH: the per-language try/catch in nav.ts symbol() never saw it,
        // because the event has no awaiter by the time it fires). Catching
        // it here turns the failure into a rejected ensureReady() promise,
        // which the caller's soft-failure catch converts to an
        // "ERROR  [lang]  server unavailable: ..." row — the intended
        // behavior. The handler is attached before the log-file setup
        // because an ENOENT can fire extremely early (proc.pid is undefined
        // for a never-spawned child); if the log stream happens to be open
        // by then we tee to it, but console.error is the guaranteed
        // surface.
        proc.on("error", (err: NodeJS.ErrnoException) => {
            const msg = `server spawn failed: ${err.code ?? "UNKNOWN"} ${err.message}`;
            console.error(`[code-nav ${this.lang}] ${msg}`);
            if (this.logStream && !this.logStream.destroyed) {
                try {
                    this.logStream.write(`${msg}\n`);
                } catch {
                    /* ignore — logging failure must not break teardown */
                }
            }
            // Dispose the connection if one was started (defensive: on a
            // spawn-time ENOENT there is no conn yet, but a later 'error'
            // — e.g. EACCES after a partial start — could have one).
            if (this.conn) {
                try {
                    this.conn.dispose();
                } catch {
                    /* already disposed/ended */
                }
            }
            this.proc = null;
            this.conn = null;
            this.capabilities = null;
            this.openDocs.clear();
            this.diagnosticsByUri.clear();
            this.extraWorkspaceFolders = [];
            this.closeLog();
            // Record the spawn failure so the body's post-listen guard can
            // throw it (and skip the initialize write) instead of letting
            // vscode-jsonrpc leak an unawaited ERR_STREAM_DESTROYED.
            spawnError = err;
            // Reject the in-flight ensureReady()/start() promise so the
            // caller's await throws instead of hanging forever. Without
            // this, the 'error' is swallowed and the initialize await in
            // the body below never settles. Clear this.ready first so a
            // later ensureReady() retry attempts a fresh spawn instead of
            // re-awaiting the (about-to-be-rejected) promise.
            this.ready = null;
            if (rejectReady) rejectReady(err);
        });

        // Open a per-server log file when a logDir was provided (the pi
        // extension passes ~/.pi/agent/logs/code-nav so the user can inspect
        // server stderr without access to the agent's temp files). Named by
        // PID so concurrent pi instances — each spawning its own server with a
        // distinct PID — never collide. The file is removed on shutdown/exit
        // (see closeLog). Stderr is still surfaced via console.error too, so
        // the CLI harness and tests (which pass no logDir) are unaffected.
        if (this.logDir) {
            try {
                const logPath = join(this.logDir, `${this.lang}-${proc.pid}.log`);
                this.logStream = createWriteStream(logPath, { flags: "ax" });
                this.logStream.on("error", () => {
                    // Couldn't open/write the log (e.g. disk full, permission).
                    // Don't let a logging failure take down the server — drop
                    // the stream and keep going without a log file.
                    this.logStream = undefined;
                    this.logPath = undefined;
                });
                this.logPath = logPath;
            } catch {
                this.logStream = undefined;
                this.logPath = undefined;
            }
        }

        // Drain stderr so the pipe doesn't block; surface fatal lines via console.
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (chunk: string) => {
            const line = chunk.trim();
            if (line) console.error(`[code-nav ${this.lang}] ${line}`);
            // Tee to the per-server log file when one is open. write() on a
            // closing/errored stream can throw synchronously — guard it so a
            // logging problem never breaks the LSP transport.
            if (this.logStream && !this.logStream.destroyed) {
                try {
                    this.logStream.write(chunk);
                } catch {
                    /* ignore — see comment above */
                }
            }
        });
        // Swallow stream-level 'error' events on stdin/stdout. The proc
        // 'error' handler above already catches spawn-time failures (ENOENT)
        // and disposes the connection; but the JSON-RPC transport wraps
        // proc.stdin/proc.stdout in its own reader/writer, and a buffered
        // write to a stdin that has already been destroyed (e.g. after an
        // ENOENT, where the process never existed but the writer queued an
        // initialize write before the stream closed) rejects as an
        // ERR_STREAM_DESTROYED. Without a listener on these streams that
        // rejection would surface as an unhandledRejection and abort the
        // test/process. Log it at debug level and move on — the connection
        // is being torn down anyway.
        proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
            const msg = `stdin stream error: ${err.code ?? "UNKNOWN"} ${err.message}`;
            console.error(`[code-nav ${this.lang}] ${msg}`);
        });
        proc.stdout.on("error", (err: NodeJS.ErrnoException) => {
            const msg = `stdout stream error: ${err.code ?? "UNKNOWN"} ${err.message}`;
            console.error(`[code-nav ${this.lang}] ${msg}`);
        });
        proc.on("exit", (code, signal) => {
            if (this.proc) {
                console.error(
                    `[code-nav ${this.lang}] server exited code=${code} signal=${signal}`,
                );
            }
            // Dispose the connection FIRST, while `conn` still holds the live
            // MessageConnection. dispose() rejects every in-flight sendRequest
            // promise with ConnectionErrors.Disposed (error code
            // PendingResponseRejected, -32097) — see vscode-jsonrpc
            // messages.ts: "The connection got disposed or lost and all
            // pending responses got rejected." Without this, a server that
            // exits AFTER a successful initialize but BEFORE answering a
            // request (e.g. ty crashes over some projects right after init)
            // leaves the sendRequest promise awaiting a reply on a dead pipe
            // forever — the tool hangs. The field-nilling below only stops
            // FUTURE requests; it does not settle the outstanding ones.
            if (this.conn) {
                try {
                    this.conn.dispose();
                } catch {
                    // Connection may already be disposed/ended.
                }
            }
            this.proc = null;
            this.conn = null;
            this.capabilities = null;
            this.ready = null;
            this.openDocs.clear();
            this.diagnosticsByUri.clear();
            this.extraWorkspaceFolders = [];
            // Remove the per-server log file — the server is gone, its log is
            // no longer interesting. Fire-and-forget; closeLog is idempotent.
            this.closeLog();
        });

        // StreamMessageReader/Writer accept NodeJS streams directly (node RAL).
        const reader = new StreamMessageReader(proc.stdout);
        const writer = new StreamMessageWriter(proc.stdin);
        const conn = createMessageConnection(reader, writer, silentLogger);
        // Register the push-diagnostics handler BEFORE sending initialize, so no
        // early publishDiagnostics notification (sent right after didOpen on some
        // servers) is missed. String method name, per the landmine #2 rule.
        conn.onNotification(
            "textDocument/publishDiagnostics",
            (params: PublishDiagnosticsParams) => {
                const uri = params.uri;
                const diags = params.diagnostics ?? [];
                this.diagnosticsByUri.set(uri, diags);
            },
        );
        // If the transport closes without the process exiting (reader hits
        // EOF / writer error), vscode-jsonrpc fires onClose. dispose() there
        // too for the same reason as the exit handler above — reject in-flight
        // requests instead of leaving them dangling on a dead pipe. The
        // closure captures the local `conn`, not `this.conn`, so it still works
        // after the exit handler nulls this.conn; onClose on an already-
        // disposed connection is a no-op.
        conn.onClose(() => {
            try {
                conn.dispose();
            } catch {}
        });
        conn.listen();
        this.conn = conn;

        // Yield one microtask so the async proc 'error' event (ENOENT fires
        // on the next tick) has a chance to run before we queue the
        // initialize write. If spawn already failed, bail out here — calling
        // sendRequest on a dead stdin leaks an unawaited ERR_STREAM_DESTROYED
        // rejection from vscode-jsonrpc's sendRequest (it re-throws after
        // rejecting its own promise). The error handler already rejected
        // rejectReady, so ensureReady() rejects cleanly.
        await new Promise<void>((r) => setImmediate(r));
        if (spawnError) throw spawnError;

        const initParams: InitializeParams = {
            processId: process.pid,
            rootUri: this.rootUri,
            capabilities: {
                textDocument: {
                    // didOpen/didChange/didClose are always supported when
                    // `synchronization` is present (per LSP spec — the client
                    // capability only opts into willSave/willSaveWaitUntil/
                    // didSave). The SERVER's initialize result advertises its
                    // preferred textDocumentSync (Full/Incremental/None +
                    // openClose + save), which is what governs whether it acts
                    // on the didChange we send. All four servers we use accept
                    // full-content didChange. openDocument() sends didChange
                    // with the whole document text whenever a tool reads
                    // different text than the server last saw — this is what
                    // keeps the server's index/diagnostics fresh after the
                    // agent edits the file on disk.
                    synchronization: { didSave: true },
                    hover: { contentFormat: ["markdown", "plaintext"] },
                    definition: { linkSupport: false },
                    references: {},
                    documentSymbol: {
                        hierarchicalDocumentSymbolSupport: true,
                    },
                    rename: { prepareSupport: false },
                    // Advertise support for BOTH diagnostics models so each server
                    // can pick the one it implements:
                    //  - Pull (textDocument/diagnostic, LSP 3.17): pyright/ty implement
                    //    it and answer the request (pyright even without advertising
                    //    diagnosticProvider). code_diagnostics tries pull first.
                    //  - Push (textDocument/publishDiagnostics): typescript-language-
                    //    server gates its ENTIRE diagnostics flow on
                    //    Boolean(clientCapabilities.textDocument.publishDiagnostics)
                    //    (cli.mjs: diagnosticsSupport = Boolean(publishDiagnostics));
                    //    without this cap it sends zero notifications no matter how
                    //    long you wait. bash-language-server/ccls likewise push via
                    //    this notification. We collect into diagnosticsByUri (latest-
                    //    wins) and code_diagnostics falls back to that map when the
                    //    pull request is rejected. The tool contract stays
                    //    synchronous; the push cache is an implementation detail.
                    publishDiagnostics: {
                        // We don't render diagnostic tags, related information, or
                        // version fields; the mere PRESENCE of this capability key
                        // is what typescript-language-server gates its diagnostics
                        // flow on (Boolean(clientCaps.textDocument.publishDiagnostics)).
                        versionSupport: false,
                    },
                    // Pull model advertisement (see above).
                    diagnostic: {
                        dynamicRegistration: false,
                        relatedDocumentSupport: false,
                    },
                },
                workspace: {
                    symbol: {},
                },
            },
            initializationOptions: initOptions,
        };
        // workspaceFolders.index was added in 3.x for multi-root; ccls/pyright ignore it.
        const wf = [
            { uri: this.rootUri, name: "root" },
        ] as unknown as InitializeParams["workspaceFolders"];
        initParams.workspaceFolders = wf;

        const result = (await Promise.race([
            requestWithTimeout(conn, "initialize", initParams),
            // Reject the handshake immediately if the spawn failed (ENOENT,
            // EACCES, …) rather than waiting for requestWithTimeout's own
            // timeout — the proc 'error' handler calls rejectReady with the
            // original errno so the surfaced message is specific.
            new Promise<never>((_, reject) => {
                rejectReady = reject;
            }),
        ])) as {
            capabilities: ServerCapabilities;
        };
        this.capabilities = result.capabilities;

        // Send initialized notification (required by the spec) and AWAIT it.
        // sendNotification returns a Promise<void> that resolves once the
        // message is written to the transport. If we fire-and-forget it,
        // the next request from the caller (e.g. workspace/symbol, sent as
        // soon as ensureReady() returns) can be queued on the wire BEFORE
        // the initialized notification is flushed, or land at the server
        // before it has processed initialized and flipped its state machine.
        // ty (Astral) is strict about the LSP handshake and crashes the
        // whole server with: "expected initialized notification, got:
        // <next request>" — which presents as the tool hanging because the
        // process dies after initialize but before answering the request.
        // Awaiting guarantees initialized is on the wire first. Wrapped in
        // notifyWithTimeout: if the server's stdin is wedged (alive-but-silent
        // on its INPUT pipe — e.g. ty stalled mid-handshake), the write never
        // completes and would otherwise hold the writer semaphore forever,
        // hanging every subsequent request without ever starting its timeout.
        await notifyWithTimeout(conn, "initialized", {});
    }

    /**
     * Open or refresh a document on the server.
     *
     * First call for a URI sends `textDocument/didOpen` with the full text.
     * Subsequent calls send `textDocument/didChange` (full-content sync) when
     * the new text differs from what the server last saw — this is what keeps
     * the server's index/diagnostics fresh after the agent edits the file on
     * disk. Without it the server keeps analyzing the version-1 snapshot
     * forever (we don't advertise workspace/didChangeWatchedFiles, so the
     * server has no other way to learn the file changed). Every nav.ts tool
     * reads the file fresh from disk before calling in, so a didChange is sent
     * automatically whenever the on-disk content has changed since the last
     * tool call touched that file.
     *
     * Versioning: starts at 1 on didOpen and monotonically increments on each
     * didChange. Servers use the version to order updates and to match
     * publishDiagnostics to the document version they describe; skipping it
     * or reusing a value confuses servers that track it (tsserver, pyright).
     *
     * The text is tracked here (not re-read from disk) because the caller
     * already has it — and comparing against the last-sent text is what lets
     * us skip the no-op didChange when a tool is called twice on an
     * unmodified file (avoids re-indexing churn on ccls/tsserver).
     */
    async openDocument(absPath: string, text: string): Promise<void> {
        await this.ensureReady();
        const uri = pathToFileURL(absPath).href;
        const existing = this.openDocs.get(uri);
        if (existing) {
            if (existing.text === text) return; // no change since last sync
            const version = existing.version + 1;
            // Full-content sync: send the entire document text. We never
            // compute incremental (range) edits — the server is told the
            // whole file each time. The LSP client capability only opts into
            // willSave/willSaveWaitUntil/didSave; didOpen/didChange/didClose
            // are always available when `synchronization` is advertised, and
            // the server's initialize result declares its preferred
            // textDocumentSync (all four servers we use accept full-content
            // didChange).
            await notifyWithTimeout(this.conn!, "textDocument/didChange", {
                textDocument: { uri, version },
                contentChanges: [{ text }],
            });
            this.openDocs.set(uri, { version, text });
            // Clear any stale push-diagnostics cached for this URI: after a
            // didChange the server will re-publish a fresh set (possibly
            // empty) keyed to the new version. Dropping the old set prevents
            // code_diagnostics' push fallback from returning diagnostics for
            // the pre-edit snapshot during the brief window before the new
            // publish arrives.
            this.diagnosticsByUri.delete(uri);
            return;
        }
        const version = 1;
        const doc: TextDocumentItem = {
            uri,
            // Derive languageId from the file extension where the LSP convention
            // distinguishes variants of one server language (e.g. .ts ->
            // "typescript", .tsx -> "typescriptreact"). Falls back to the server
            // language for cases with no per-extension distinction.
            languageId: languageIdFor(absPath, this.lang),
            version,
            text,
        };
        // Awaited under a timeout: a fire-and-forget didOpen whose write never
        // completes (server stopped draining stdin) would hold the writer
        // semaphore forever and hang every following request without its
        // timeout ever starting. See notifyWithTimeout.
        await notifyWithTimeout(this.conn!, "textDocument/didOpen", {
            textDocument: doc,
        });
        this.openDocs.set(uri, { version, text });
    }

    async closeDocument(absPath: string): Promise<void> {
        const uri = pathToFileURL(absPath).href;
        if (!this.openDocs.has(uri)) return;
        this.conn!.sendNotification("textDocument/didClose", {
            textDocument: { uri },
        });
        this.openDocs.delete(uri);
    }

    /**
     * Ensure the language server has loaded a project (index) before a request
     * that requires one. Only the TypeScript server (tsserver) needs this: it
     * loads projects lazily on the first didOpen of a file in that project, and
     * `workspace/symbol` (navto) throws "No Project." if invoked before any file
     * has been opened. This is a no-op for servers that index eagerly on
     * `initialize` (ccls/pyright/ty/bash-language-server).
     *
     * Implementation: if no document has been opened yet, find one source file
     * of this server's language under the workspace root and open it. The file
     * stays open for the session (matching the no-close-until-shutdown policy).
     * Returns true if a project is known to be loaded (a doc is open or one was
     * just opened); false if no matching file could be found.
     */
    async ensureProjectLoaded(): Promise<boolean> {
        await this.ensureReady();
        if (this.openDocs.size > 0) return true; // a doc is open → project loaded
        if (this.lang !== "typescript") return true; // only tsserver needs this
        const file = await findFirstSourceFile(this.rootUri, this.lang);
        if (!file) return false;
        try {
            const text = await readFile(file, "utf8");
            await this.openDocument(file, text);
            return true;
        } catch {
            return false;
        }
    }

    supports(method: keyof ServerCapabilities): boolean {
        return Boolean(this.capabilities && this.capabilities[method]);
    }

    async documentSymbols(
        absPath: string,
        text: string,
    ): Promise<DocumentSymbol[] | SymbolInformation[]> {
        await this.openDocument(absPath, text);
        const uri = pathToFileURL(absPath).href;
        const res = await requestWithTimeout(this.conn!, "textDocument/documentSymbol", {
            textDocument: { uri },
        });
        return (res as DocumentSymbol[] | SymbolInformation[] | null) ?? [];
    }

    async definition(
        absPath: string,
        line: number,
        col: number,
        text: string,
    ): Promise<Definition> {
        await this.openDocument(absPath, text);
        const uri = pathToFileURL(absPath).href;
        const res = await requestWithTimeout(this.conn!, "textDocument/definition", {
            textDocument: { uri },
            position: { line, character: col },
        });
        return (res as Definition) ?? [];
    }

    async references(
        absPath: string,
        line: number,
        col: number,
        text: string,
    ): Promise<Location[]> {
        await this.openDocument(absPath, text);
        const uri = pathToFileURL(absPath).href;
        const params: ReferenceParams = {
            textDocument: { uri },
            position: { line, character: col },
            context: { includeDeclaration: true },
        };
        const res = await requestWithTimeout(this.conn!, "textDocument/references", params);
        return (res as Location[] | null) ?? [];
    }

    async hover(absPath: string, line: number, col: number, text: string): Promise<Hover | null> {
        await this.openDocument(absPath, text);
        const uri = pathToFileURL(absPath).href;
        const res = await requestWithTimeout(this.conn!, "textDocument/hover", {
            textDocument: { uri },
            position: { line, character: col },
        });
        return res as Hover | null;
    }

    async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
        await this.ensureReady();
        const res = await requestWithTimeout(this.conn!, "workspace/symbol", { query });
        return (res as SymbolInformation[] | null) ?? [];
    }

    /**
     * Add extra workspace folders (third-party / stdlib roots) to this
     * server's index via `workspace/didChangeWorkspaceFolders`, so that
     * `workspace/symbol` can find symbols in those trees too.
     *
     * This is the mechanism that lets `code_search_symbol` act as a single
     * entry point for third-party symbol search on servers whose default
     * index is workspace-only (notably `ty` — ccls already indexes
     * third-parties via its compilation database, so it does not need this).
     * Verified: ty advertises `workspace.workspaceFolders.supported` AND
     * `changeNotifications: true`, and once a `site-packages` / stdlib dir is
     * added as a workspace folder, ty indexes it and `workspace/symbol`
     * returns symbols from it.
     *
     * Idempotent: paths already present (in `rootPath` or in
     * `extraWorkspaceFolders`) are skipped. No-op when the server does not
     * advertise `workspace.workspaceFolders.supported` (defensive — every
     * server we currently use does, but a future server might not). Silent
     * on failure: the notification is fire-and-forget under a timeout; if the
     * server rejects it or the write wedges, we proceed without those roots
     * rather than breaking the symbol query (the query still runs against
     * the workspace root). Returns the list of folder paths actually newly
     * added (empty if none).
     *
     * NOTE: a single `ensureReady` must have completed before calling so the
     * server has its capabilities and a live connection; callers should
     * `await this.ensureReady()` (or any method that does) first.
     */
    async addWorkspaceFolders(paths: string[]): Promise<string[]> {
        await this.ensureReady();
        const caps = this.capabilities as { workspace?: { workspaceFolders?: { supported?: boolean } } } | null;
        if (!caps?.workspace?.workspaceFolders?.supported) return [];
        const want: string[] = [];
        const seen = new Set<string>([this.rootPath, ...this.extraWorkspaceFolders]);
        for (const p of paths) {
            if (!p) continue;
            let abs: string;
            try {
                abs = resolve(p);
            } catch {
                continue;
            }
            if (seen.has(abs)) continue;
            seen.add(abs);
            want.push(abs);
        }
        if (want.length === 0) return [];
        const added = want.map((p) => ({ uri: pathToFileURL(p).href, name: p.split("/").pop() || p }));
        try {
            await notifyWithTimeout(this.conn!, "workspace/didChangeWorkspaceFolders", {
                event: { added, removed: [] },
            });
            this.extraWorkspaceFolders.push(...want);
        } catch {
            // Server rejected or the write wedged — proceed without the
            // roots. The symbol query still runs against the workspace root.
            return [];
        }
        return want;
    }

    /**
     * All workspace folder paths this server knows about: the root plus any
     * extra folders added via `addWorkspaceFolders`. Used by
     * `code_search_symbol` to derive a result file's module path (relative to
     * the longest matching folder) for qualified-name filtering. Returns a
     * copy sorted by length DESCENDING so longest-prefix matches win when a
     * broad folder (e.g. `lib/python3.13`) is a prefix of a more specific
     * one (e.g. `lib/python3.13/site-packages`).
     */
    workspaceFolderPaths(): string[] {
        return [this.rootPath, ...this.extraWorkspaceFolders].sort(
            (a, b) => b.length - a.length,
        );
    }

    async rename(
        absPath: string,
        line: number,
        col: number,
        text: string,
        newName: string,
    ): Promise<WorkspaceEdit> {
        await this.openDocument(absPath, text);
        const uri = pathToFileURL(absPath).href;
        const params: RenameParams = {
            textDocument: { uri },
            position: { line, character: col },
            newName,
        };
        const res = await requestWithTimeout(this.conn!, "textDocument/rename", params);
        return (res as WorkspaceEdit) ?? {};
    }

    /**
     * Whether the server advertises the diagnostic pull model
     * (ServerCapabilities.diagnosticProvider). Introspection only — code_diagnostics
     * does NOT gate on this, because capability advertisement is unreliable:
     * pyright answers textDocument/diagnostic without advertising
     * diagnosticProvider, while bash-language-server rejects the method with a
     * JSON-RPC error. The tool sends the request and lets the server's actual
     * response/error decide. ty advertises diagnosticProvider; pyright does not
     * (but still answers); ccls/bash-language-server do not.
     */
    supportsPullDiagnostics(): boolean {
        return Boolean(
            this.capabilities &&
            (this.capabilities as unknown as { diagnosticProvider?: unknown }).diagnosticProvider,
        );
    }

    /**
     * Pull diagnostics for a document via the LSP 3.17 textDocument/diagnostic
     * request (single request → single response). The document must already be
     * open on the server (openDocument / didOpen). Returns the Diagnostic[] for
     * `absPath`, or null if the server returned an "unchanged" report with no
     * cached result. Throws if the server does not support the pull model (e.g.
     * bash-language-server rejects with a JSON-RPC "Unhandled method" error);
     * the caller surfaces the error. Note: pyright answers this request even
     * though it does not advertise diagnosticProvider — so callers should NOT
     * pre-gate on supportsPullDiagnostics(); just try and handle the throw.
     * Uses string method names (not DocumentDiagnosticRequest.type) for the same
     * reason the other methods do — the .type ProtocolRequestType overloads fail
     * to type-check against the MessageConnection in some 3.17/3.18
     * configurations (see MAINTAINER.md "LSP method calls").
     */
    async pullDiagnostics(absPath: string): Promise<Diagnostic[] | null> {
        await this.ensureReady();
        const uri = pathToFileURL(absPath).href;
        const res = await requestWithTimeout(this.conn!, "textDocument/diagnostic", {
            textDocument: { uri },
        });
        const report = res as DocumentDiagnosticReport | null;
        if (!report) return null;
        // A "full" report carries items; an "unchanged" report means the server's
        // cached result for this document is still valid (we passed no
        // previousResultId, so this should not happen in practice — but handle it).
        if (report.kind === "full") {
            return (report as FullDocumentDiagnosticReport).items ?? [];
        }
        return null;
    }

    /**
     * Read the latest push-model diagnostics cached for `absPath` from the
     * textDocument/publishDiagnostics handler, or undefined if none have arrived
     * yet. This is the FALLBACK for code_diagnostics on servers that reject the
     * pull model (typescript-language-server, bash-language-server, ccls): the
     * tool opens the document, waits for the server's diagnostics delayer to
     * fire, then polls this. Returns a snapshot copy so the caller can iterate
     * without the notification handler mutating the array mid-loop.
     *
     * The push model is only active because start() advertises
     * textDocument.publishDiagnostics in client capabilities — without that,
     * typescript-language-server gates its whole diagnostics flow off
     * (diagnosticsSupport = Boolean(clientCaps.textDocument.publishDiagnostics))
     * and sends zero notifications.
     */
    getPushedDiagnostics(absPath: string): Diagnostic[] | undefined {
        const uri = pathToFileURL(absPath).href;
        const diags = this.diagnosticsByUri.get(uri);
        return diags ? [...diags] : undefined;
    }

    /** Graceful LSP shutdown + exit. Safe to call multiple times. */
    async shutdown(): Promise<void> {
        const conn = this.conn;
        const proc = this.proc;
        if (!conn || !proc) return;
        this.conn = null;
        this.proc = null;
        this.capabilities = null;
        this.ready = null;
        this.openDocs.clear();
        this.diagnosticsByUri.clear();
        this.extraWorkspaceFolders = [];
        try {
            // Bounded: a silent/wedged server would otherwise hang shutdown
            // forever (the silent-fake regression test hits this in its
            // finally). 1s is generous for a well-behaved server's shutdown;
            // a wedged server won't honor it anyway and we SIGTERM below.
            // Pass undefined (not null): shutdown takes no params. null would
            // be wrapped as `params: [null]` on the wire and rejected by
            // strict servers (ty: "invalid type: sequence, expected unit").
            await requestWithTimeout(conn, "shutdown", undefined, 1000);
        } catch {
            // Server may have already exited, be wedged, or reject the request.
            // shutdown() is best-effort; we proceed to kill the process below.
        }
        // Send the `exit` notification fire-and-forget, but attach a rejection
        // handler: the underlying socket write can reject with EPIPE/
        // ERR_STREAM_DESTROYED if the server has already closed its stdio (ccls
        // exits fast), and jsonrpc's sendNotification returns a Promise<void>
        // whose rejection would otherwise be unhandled. The try/catch above only
        // catches synchronous throws, not this async rejection. Tolerating it is
        // consistent with shutdown()'s race-tolerance contract (see MAINTAINER.md).
        try {
            const p = conn.sendNotification("exit", null) as unknown as Promise<void> | undefined;
            if (p && typeof p.catch === "function") p.catch(() => {});
        } catch {
            // Synchronous throw (e.g. connection already disposed) — tolerate.
        }
        try {
            proc.kill("SIGTERM");
        } catch {}
        // Remove the per-server log file on graceful shutdown, mirroring the
        // exit handler. The server is being killed; its log is no longer
        // interesting. closeLog is idempotent so a double-call (exit handler
        // then shutdown, or vice versa) is safe.
        this.closeLog();
    }

    /**
     * Close and remove the per-server log file, if one is open. Idempotent:
     * safe to call from both the exit handler and shutdown(). Tolerates an
     * already-deleted file (ENOENT) and a never-opened log (no logDir). The
     * stream is end()ed (flushes buffered writes) before unlink so the file
     * isn't removed while data is still pending. Errors are swallowed — a
     // logging cleanup failure must never break the LSP teardown path.
     */
    private closeLog(): void {
        const stream = this.logStream;
        const path = this.logPath;
        this.logStream = undefined;
        this.logPath = undefined;
        if (stream && !stream.destroyed) {
            try {
                stream.end();
            } catch {
                /* ignore */
            }
        }
        if (path) {
            // Fire-and-forget: unlink is async and we don't want to block
            // teardown on it. The exit handler (synchronous) and shutdown()
            // both tolerate the file lingering briefly.
            unlink(path).catch(() => {
                /* ENOENT or permission error — already gone or not ours */
            });
        }
    }
}
