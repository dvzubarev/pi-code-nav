/**
 * code_diagnostics — errors/warnings for a file, fetched on demand.
 *
 * Pure request/response: opens the document on the server (didOpen is required
 * for the server to analyze it), then tries the LSP 3.17 pull model
 * (textDocument/diagnostic). The push model (textDocument/publishDiagnostics)
 * is the fallback for servers that reject the pull request
 * (bash-language-server, ccls). TypeScript/JavaScript are unsupported and
 * return a concrete tsc command instead of contacting a language server.
 * The push wait is event-driven, with a generous 60-second deadline to prevent
 * a live but silent server from hanging the tool indefinitely.
 *
 * Capability advertisement is unreliable: pyright implements
 * textDocument/diagnostic but does NOT advertise diagnosticProvider, while
 * bash-language-server rejects the method with a JSON-RPC error. So we do NOT
 * gate on supportsPullDiagnostics() — we send the request and let the server's
 * actual response (or error) decide. See docs/code_diagnostics.md.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LSPErrorCodes, type Diagnostic } from "vscode-languageserver-protocol/node";
import { DEFAULT_PUSH_DIAGNOSTICS_TIMEOUT_MS, type LspClient } from "./lsp-client";
import { awaitReadyForQuery, ClientProvider, UnknownLanguageError } from "./nav-core";
import { diagnosticMessage, langForFile, renderDiagnostic, toAbs } from "./render";

export interface DiagnosticsParams {
    path: string;
}

const MAX_PULL_DIAGNOSTICS_ATTEMPTS = 4;

function isRetriggerableCancellation(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const { code, data } = error as {
        code?: unknown;
        data?: { retriggerRequest?: unknown } | null;
    };
    return code === LSPErrorCodes.ServerCancelled && data?.retriggerRequest === true;
}

function pullFailureDescription(error: Error): string {
    const unsupported = /unhandled method|method not found|unknown request/i.test(error.message);
    return unsupported
        ? `the server does not support pull diagnostics (${error.message})`
        : `the pull-diagnostics request failed (${error.message})`;
}

/** Find the target file's config, not the session cwd (which may be another project). */
async function typeScriptCheckCommand(absPath: string): Promise<string> {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    let dir = dirname(absPath);
    while (true) {
        try {
            if ((await stat(join(dir, "tsconfig.json"))).isFile()) {
                return `cd ${quote(dir)} && npx tsc --noEmit --pretty false -p tsconfig.json`;
            }
        } catch {
            // No config here; tsc normally searches parent directories too.
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Without a config, explicitly check this file using compiler defaults.
    const ext = extname(absPath).toLowerCase();
    const flags =
        ([".js", ".jsx", ".mjs", ".cjs"].includes(ext) ? " --allowJs --checkJs" : "") +
        ([".tsx", ".jsx"].includes(ext) ? " --jsx preserve" : "");
    return `cd ${quote(dirname(absPath))} && npx tsc --noEmit --pretty false${flags} ${quote(basename(absPath))}`;
}

export async function diagnostics(
    params: DiagnosticsParams,
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
        // Hard failure: cannot read the file at all. Throw so index.ts's err()
        // sets isError: true — the agent gets a machine-readable failure bit
        // instead of an inline string indistinguishable from a data row.
        throw new Error(`Cannot read ${abs}: ${e}`);
    }
    if (lang === "typescript") {
        throw new Error(
            `TypeScript/JavaScript diagnostics are unsupported by code_diagnostics. Run:\n${await typeScriptCheckCommand(abs)}`,
        );
    }
    let client: LspClient;
    try {
        client = await clientOf(lang);
    } catch (e) {
        // Hard failure: the language server could not be spawned.
        throw new Error(`${lang}: server unavailable: ${e}`);
    }
    // Open the document on the server and (for cpp) wait for ccls to finish
    // indexing this TU. didOpen is required for the server to analyze the
    // file; both the pull model (textDocument/diagnostic) and the push model
    // (textDocument/publishDiagnostics) operate on opened documents. The cpp
    // indexing wait is best-effort (see awaitReadyForQuery); the push
    // fallback below no longer needs to repeat it. Idempotent (openDocument
    // dedupes by URI).
    await awaitReadyForQuery(lang, client, abs, text);
    // Try the pull model first (LSP 3.17 textDocument/diagnostic). We do NOT
    // pre-gate on supportsPullDiagnostics(): pyright answers without
    // advertising diagnosticProvider, while bash-language-server rejects with
    // a JSON-RPC "Unhandled method" error. The request itself is the source
    // of truth: a server that can't answer returns an error we fall back
    // from (below) rather than trusting advertised capabilities.
    let diags: Diagnostic[] | null | undefined;
    let pullError: Error | null = null;
    for (let attempt = 0; attempt < MAX_PULL_DIAGNOSTICS_ATTEMPTS; attempt++) {
        try {
            diags = await client.pullDiagnostics(abs);
            break;
        } catch (e) {
            if (isRetriggerableCancellation(e)) {
                // A concurrent didOpen/didChange can invalidate ty's in-flight
                // analysis. ServerCancelled + retriggerRequest asks us to pull
                // again, not wait for a push that a pull server may never send.
                // Back off briefly (25/50/100ms) to let a burst of syncs settle;
                // do not reopen the document or serialize unrelated tool calls.
                if (attempt === MAX_PULL_DIAGNOSTICS_ATTEMPTS - 1) {
                    throw new Error(
                        `${lang}: diagnostics unavailable for ${params.path}: the server cancelled the pull-diagnostics request after ${MAX_PULL_DIAGNOSTICS_ATTEMPTS} attempts`,
                    );
                }
                await delay(25 * 2 ** attempt);
                continue;
            }
            pullError = e instanceof Error ? e : new Error(String(e));
            break;
        }
    }
    // FALLBACK: push model (textDocument/publishDiagnostics). Servers that reject
    // the pull model (bash-language-server, ccls)
    // still emit publishDiagnostics notifications after didOpen, but only if the
    // client advertised textDocument.publishDiagnostics in initialize (which
    // LspClient.start() does). This wait is now EVENT-DRIVEN: instead of polling
    // the push cache on a fixed ~1.2s budget (far too short for ccls, which
    // publishes only after whole-project indexing — often 10-60s on a cold
    // cache), we block on a promise that resolves the instant the server
    // actually pushes diagnostics for this URI. The contract stays
    // synchronous (one bounded wait → one result). The 60-second cap leaves
    // room for ccls cold indexing but prevents a live silent server from
    // hanging the agent forever.
    //
    // For cpp specifically, ccls publishes publishDiagnostics for a file only
    // once its translation unit has compiled — which on a cold cache happens
    // DURING whole-project indexing. We already waited for indexing to
    // complete above (awaitReadyForQuery, event-driven via ccls's $/progress
    // "end"), so the push is ready to arrive; here we just wait for it. This
    // is the user's "wait while it is ready" ask: the tool no longer times
    // out mid-index and surfaces a misleading pull-error.
    if (pullError || diags === null) {
        // cpp indexing was already waited for above (awaitReadyForQuery), so
        // ccls's publishDiagnostics (which fires only after the TU compiles)
        // is now ready to arrive. We just wait for the push.
        const pushed = await client.waitForPushedDiagnostics(
            abs,
            DEFAULT_PUSH_DIAGNOSTICS_TIMEOUT_MS,
        );
        if (pushed !== undefined) {
            // An empty pushed set is an authoritative clean result. Pull
            // rejection is expected for push-only servers and is irrelevant
            // once their fallback succeeds.
            return renderDiagnostics(params.path, pushed);
        }
        // An exhausted push deadline or server termination is NOT a clean-file
        // result. Make that explicit rather than returning an empty result.
        if (pullError) {
            throw new Error(
                `${lang}: diagnostics unavailable for ${params.path}: ${pullFailureDescription(
                    pullError,
                )}; push diagnostics were not received within 60 seconds`,
            );
        }
        return `(no diagnostics returned for ${params.path})`;
    }
    return renderDiagnostics(params.path, diags as Diagnostic[]);
}

interface EmbeddedNote {
    path: string;
    line: number;
    column: number;
    kind: string;
    message: string;
}

/** ccls embeds Clang's note chain in message, even with relatedInformation enabled. */
function splitDiagnostic(diagnostic: Diagnostic) {
    const message = diagnosticMessage(diagnostic);
    const unchanged = { diagnostic, message, notes: [] as EmbeddedNote[] };
    if (diagnostic.source !== "ccls") return unchanged;
    const [primary, ...paragraphs] = message.split(/\r?\n\s*\r?\n/);
    if (paragraphs.length === 0) return unchanged;
    const notes: EmbeddedNote[] = [];
    for (const paragraph of paragraphs) {
        const match = /^(.*):(\d+):(\d+):\s*(note|warning|error|remark):\s+([\s\S]+)$/.exec(
            paragraph,
        );
        // Don't truncate arbitrary multiline diagnostics: only a fully recognized
        // Clang location/severity suffix is safe to separate from the message.
        if (!match) return unchanged;
        notes.push({
            path: match[1],
            line: Number(match[2]),
            column: Number(match[3]),
            kind: match[4],
            message: match[5],
        });
    }
    return { diagnostic, message: primary, notes };
}

type SplitDiagnostic = ReturnType<typeof splitDiagnostic>;

/** Fold only info entries proven to mirror a primary's embedded note. */
function isMirroredNote(entry: SplitDiagnostic, parent: SplitDiagnostic, path: string): boolean {
    if (entry.diagnostic.source !== "ccls" || entry.diagnostic.severity !== 3) return false;
    const kind = parent.diagnostic.severity === 1 ? "error" : "warning";
    const start = parent.diagnostic.range.start;
    if (
        entry.notes.length === 0 ||
        !entry.notes.every(
            (note) =>
                note.kind === kind &&
                note.line === start.line + 1 &&
                note.column === start.character + 1 &&
                note.message === parent.message,
        )
    )
        return false;
    const entryStart = entry.diagnostic.range.start;
    return parent.notes.some(
        (note) =>
            note.kind === "note" &&
            note.line === entryStart.line + 1 &&
            note.column === entryStart.character + 1 &&
            note.message === entry.message &&
            (note.path === path || note.path === basename(path)),
    );
}

/** Shared renderer for pull and push; never mutates the server's cached list. */
function renderDiagnostics(path: string, diags: Diagnostic[]): string {
    if (diags.length === 0) {
        return `(no diagnostics for ${path})`;
    }
    const entries = diags.map(splitDiagnostic);
    const parents = entries.filter(
        ({ diagnostic, notes }) =>
            diagnostic.source === "ccls" &&
            notes.length > 0 &&
            (diagnostic.severity === 1 || diagnostic.severity === 2),
    );
    const groups = new Map<
        string,
        { entry: SplitDiagnostic; count: number; notes: Map<string, EmbeddedNote> }
    >();
    let folded = 0;
    for (const entry of entries) {
        if (parents.some((parent) => isMirroredNote(entry, parent, path))) {
            folded++;
            continue;
        }
        const d = entry.diagnostic;
        // Full range + severity/source/code + primary text: never merge issues
        // at distinct locations or different diagnostic kinds. Only ccls's
        // recognized context suffix is excluded; other messages match verbatim.
        const key = JSON.stringify([
            d.range.start.line,
            d.range.start.character,
            d.range.end.line,
            d.range.end.character,
            d.severity,
            d.source,
            d.code,
            entry.message,
        ]);
        let group = groups.get(key);
        if (!group) {
            group = { entry, count: 0, notes: new Map() };
            groups.set(key, group);
        }
        group.count++;
        for (const note of entry.notes) {
            group.notes.set(JSON.stringify(note), note);
        }
    }
    const lines: string[] = [];
    for (const { entry, count, notes } of groups.values()) {
        const repeats = count > 1 ? `  [${count} occurrences]` : "";
        lines.push(
            renderDiagnostic(path, { ...entry.diagnostic, message: entry.message }) + repeats,
        );
        for (const note of notes.values()) {
            lines.push(`  ${note.path}:${note.line}:${note.column}  ${note.kind}: ${note.message}`);
        }
    }
    const summary =
        groups.size === diags.length
            ? ""
            : ` (${diags.length} reported${folded ? `; ${folded} related diagnostics folded` : ""})`;
    return `${groups.size} diagnostic(s) for ${path}${summary}:\n` + lines.join("\n");
}
