/**
 * LSP client over stdio.
 *
 * One LspClient instance wraps a single language server child process.
 * Servers are spawned lazily on first request and shut down when the
 * extension closes the pool (session_shutdown or /code-nav:off).
 */

import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
const SOURCE_EXTS: Record<Lang, readonly string[]> = {
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

export class LspClient {
	readonly lang: Lang;
	readonly rootUri: string;
	private proc: ChildProcessWithoutNullStreams | null = null;
	private conn: MessageConnection | null = null;
	private capabilities: ServerCapabilities | null = null;
	/** Resolves when initialize + initialized handshake completes. */
	private ready: Promise<void> | null = null;
	/** Documents opened on this server, keyed by file URI. */
	private openDocs = new Map<string, number>();

	constructor(lang: Lang, rootPath: string, cfg: ServerConfig) {
		this.lang = lang;
		this.rootUri = pathToFileURL(rootPath).href;
		this.cfg = cfg;
	}

	private cfg: ServerConfig;

	/** Spawn the server and complete the LSP initialize handshake. */
	async ensureReady(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = this.start();
		return this.ready;
	}

	private async start(): Promise<void> {
		const { command, args, initOptions } = this.cfg;
		const proc = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: undefined,
		});
		this.proc = proc;

		// Drain stderr so the pipe doesn't block; surface fatal lines via console.
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => {
			const line = chunk.trim();
			if (line) console.error(`[code-nav ${this.lang}] ${line}`);
		});
		proc.on("exit", (code, signal) => {
			if (this.proc) {
				console.error(
					`[code-nav ${this.lang}] server exited code=${code} signal=${signal}`,
				);
			}
			this.proc = null;
			this.conn = null;
			this.capabilities = null;
			this.ready = null;
			this.openDocs.clear();
		});

		// StreamMessageReader/Writer accept NodeJS streams directly (node RAL).
		const reader = new StreamMessageReader(proc.stdout);
		const writer = new StreamMessageWriter(proc.stdin);
		const conn = createMessageConnection(reader, writer, silentLogger);
		conn.listen();
		this.conn = conn;

		const initParams: InitializeParams = {
			processId: process.pid,
			rootUri: this.rootUri,
			capabilities: {
				textDocument: {
					synchronization: { didSave: true },
					hover: { contentFormat: ["markdown", "plaintext"] },
					definition: { linkSupport: false },
					references: {},
					documentSymbol: {
						hierarchicalDocumentSymbolSupport: true,
					},
					rename: { prepareSupport: false },
					// Advertise support for the diagnostic pull model (LSP 3.17). Servers
					// that implement textDocument/diagnostic (pyright/ty) will then
					// advertise diagnosticProvider in their ServerCapabilities, which we
					// check via supportsPullDiagnostics(). code_diagnostics is a pure
					// request/response tool (pull) — no publishDiagnostics collection.
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

		const result = (await conn.sendRequest("initialize", initParams)) as {
			capabilities: ServerCapabilities;
		};
		this.capabilities = result.capabilities;

		// Send initialized notification (required by the spec).
		conn.sendNotification("initialized", {});
	}

	/** Open or refresh a document on the server (didOpen). */
	async openDocument(absPath: string, text: string): Promise<void> {
		await this.ensureReady();
		const uri = pathToFileURL(absPath).href;
		if (this.openDocs.has(uri)) return;
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
		this.conn!.sendNotification("textDocument/didOpen", {
			textDocument: doc,
		});
		this.openDocs.set(uri, version);
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
		const res = await this.conn!.sendRequest("textDocument/documentSymbol", {
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
		const res = await this.conn!.sendRequest("textDocument/definition", {
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
		const res = await this.conn!.sendRequest("textDocument/references", params);
		return (res as Location[] | null) ?? [];
	}

	async hover(absPath: string, line: number, col: number, text: string): Promise<Hover | null> {
		await this.openDocument(absPath, text);
		const uri = pathToFileURL(absPath).href;
		const res = await this.conn!.sendRequest("textDocument/hover", {
			textDocument: { uri },
			position: { line, character: col },
		});
		return res as Hover | null;
	}

	async workspaceSymbol(query: string): Promise<SymbolInformation[]> {
		await this.ensureReady();
		const res = await this.conn!.sendRequest("workspace/symbol", { query });
		return (res as SymbolInformation[] | null) ?? [];
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
		const res = await this.conn!.sendRequest("textDocument/rename", params);
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
		const res = await this.conn!.sendRequest("textDocument/diagnostic", {
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
		try {
			await conn.sendRequest("shutdown");
			conn.sendNotification("exit", null);
		} catch {
			// Server may have already exited.
		}
		try {
			proc.kill("SIGTERM");
		} catch {}
	}
}
