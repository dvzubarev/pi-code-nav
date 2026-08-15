// Regression tests for LspClient's no-hang guarantees on server failure.
//
// The bug this guards against: a language server that replies to `initialize`
// but then dies (or goes silent) before answering a request left the client's
// `sendRequest` promise awaiting forever on a dead/quiet pipe — the tool call
// hung. Two fixes in lsp-client.ts cover the two failure modes:
//
//   1. proc.on(\"exit\") + conn.onClose now call conn.dispose(), which rejects
//      every in-flight sendRequest promise (vscode-jsonrpc error code
//      PendingResponseRejected, -32097). Covers a server that EXITS mid-
//      request (e.g. ty crashes over some projects right after init).
//   2. requestWithTimeout races sendRequest against a deadline (default 30s,
//      overridable via CODE_NAV_REQUEST_TIMEOUT_MS for these tests). Covers a
//      server that stays ALIVE but never replies (wedged / silent).
//
// Both are exercised here against a tiny fake LSP server
// (test/fixtures/fake-lsp-server.mjs) that completes the initialize handshake
// then exhibits one of three modes: exit-mid-request, silent, or ok (control).
// No real language server is needed — the fake speaks just enough JSON-RPC —
// so these run under `npm test` (unit), not `npm run test:e2e`.
//
// Each test asserts BOTH that the call rejects (the regression) AND that it
// rejects promptly (a hard per-test deadline catches a re-introduced hang
// where the promise never settles).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = resolve(EXT_DIR, "test/fixtures/fake-lsp-server.mjs");

const jiti = createJiti(EXT_DIR, { cache: false, interopDefault: true });
const { LspClient, resolveConfig } = await jiti.import("./src/lsp-client.ts");

/** A ServerConfig pointing at our fake server in `mode`. */
function fakeConfig(mode) {
    return {
        command: process.execPath,
        args: [FIXTURE, mode],
        initOptions: {},
        // The fake server is not a known built-in: `serverKind` is part of the
        // resolved-config contract (ResolvedServerConfig), so declare it
        // explicitly instead of relying on JS to hide the TS requirement.
        serverKind: "custom",
    };
}

/** Per-test hard deadline: if the promise hasn't settled by `ms`, fail fast. */
function withDeadline(ms, label, fn) {
    return async () => {
        let timer;
        const guard = new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`${label}: HUNG past ${ms}ms (regression re-introduced)`)),
                ms,
            );
        });
        try {
            await Promise.race([fn(), guard]);
        } finally {
            clearTimeout(timer);
        }
    };
}

/** Tolerate the teardown EPIPE/ERR_STREAM_DESTROYED rejections (see e2e-helpers). */
process.on("unhandledRejection", (err) => {
    if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return;
    throw err;
});

// Short per-request timeout for the whole file. This makes the "silent"
// regression test fast (300ms vs the 30s default) AND keeps it deterministic:
// env-var mutation per-test would race under node:test's concurrent subtest
// scheduling. The "exit-mid-request" test still passes because dispose()
// rejects in ~30ms, well under 300ms; the control test succeeds fast.
process.env.CODE_NAV_REQUEST_TIMEOUT_MS = "300";

test(
    "workspaceSymbol rejects (not hangs) when server EXITS mid-request",
    withDeadline(8000, "exit-mid-request", async () => {
        // The per-request timeout (300ms, set file-wide above) is a BACKSTOP
        // here; the primary rejection path is dispose()-on-exit, which fires
        // in milliseconds. The assertion below verifies dispose won, not the
        // timeout — so a regression that kept the timeout but lost the
        // exit→dispose wiring would be caught on the error message.
        const root = await mkdtemp(resolve(tmpdir(), "code-nav-fake-"));
        const c = new LspClient("python", root, fakeConfig("exit-mid-request"));
        try {
            // initialize succeeds (the fake replies before crashing), so
            // ensureReady resolves — mirroring the real ty-crashes-after-init
            // scenario where the client believes it is ready.
            await c.ensureReady();
            await assert.rejects(
                c.workspaceSymbol("raw_resp_line_iter"),
                // dispose() rejects with a ConnectionError (Disposed) or a
                // ResponseError carrying PendingResponseRejected (-32097).
                // Accept either; the point is it rejects, and fast.
                (err) => {
                    const msg = String(err?.message ?? err);
                    // Must NOT be the timeout error (that would mean dispose
                    // didn't fire and we waited the full 15s).
                    assert.ok(
                        !/timed out/.test(msg),
                        `should reject via dispose-on-exit, not the timeout; got: ${msg}`,
                    );
                    return true;
                },
            );
        } finally {
            try {
                await c.shutdown();
            } catch {}
            await rm(root, { recursive: true, force: true });
        }
    }),
);

test(
    "workspaceSymbol rejects (not hangs) when server stays ALIVE but silent",
    withDeadline(8000, "silent", async () => {
        // File-wide 300ms timeout must reject this; withDeadline(2000) is the
        // hard guard that fails the test (as a hang) if the timeout regresses.
        const root = await mkdtemp(resolve(tmpdir(), "code-nav-fake-"));
        const c = new LspClient("python", root, fakeConfig("silent"));
        try {
            await c.ensureReady();
            await assert.rejects(c.workspaceSymbol("raw_resp_line_iter"), (err) => {
                const msg = String(err?.message ?? err);
                assert.match(
                    msg,
                    /timed out/i,
                    `silent server should be caught by the timeout; got: ${msg}`,
                );
                return true;
            });
        } finally {
            try {
                await c.shutdown();
            } catch {}
            await rm(root, { recursive: true, force: true });
        }
    }),
);

test("ty defaults to workspace diagnostics so it can report whole-project progress", () => {
    const config = resolveConfig("python");
    if (config.command === "ty") assert.equal(config.initOptions.diagnosticMode, "workspace");
});

test("Python project loading waits for ty workspace-diagnostic progress", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-nav-fake-"));
    const tyCommand = resolve(root, "ty");
    await symlink(process.execPath, tyCommand);
    const c = new LspClient("python", root, {
        command: tyCommand,
        args: [FIXTURE, "ty-workspace-progress"],
        initOptions: { diagnosticMode: "workspace" },
        // LspClient recognizes ty via the resolved server identity, not a
        // command-path regex — so this READINESS test must declare it.
        serverKind: "ty",
    });
    try {
        await c.ensureProjectLoaded();
        const syms = await c.workspaceSymbol("raw_resp_line_iter");
        assert.equal(
            syms.length,
            1,
            "workspace/symbol ran before ty finished checking the project",
        );
    } finally {
        try {
            await c.shutdown();
        } catch {}
        await rm(root, { recursive: true, force: true });
    }
});

test("Bash project loading waits for BackgroundAnalysis completion log", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-nav-fake-"));
    // The fake speaks the bash-language-server protocol, so identify it by
    // the built-in server kind it emulates — the readiness policy is selected
    // by serverKind, and "custom" would select the no-op policy instead.
    const c = new LspClient("bash", root, {
        ...fakeConfig("bash-index-log"),
        serverKind: "bash-language-server",
    });
    try {
        await c.ensureProjectLoaded();
        const syms = await c.workspaceSymbol("raw_resp_line_iter");
        assert.equal(
            syms.length,
            1,
            "workspace/symbol ran before Bash BackgroundAnalysis completed",
        );
    } finally {
        try {
            await c.shutdown();
        } catch {}
        await rm(root, { recursive: true, force: true });
    }
});

test("control: workspaceSymbol succeeds against the ok fake server", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-nav-fake-"));
    const c = new LspClient("python", root, fakeConfig("ok"));
    try {
        await c.ensureReady();
        const syms = await c.workspaceSymbol("raw_resp_line_iter");
        assert.equal(syms.length, 1, `expected 1 canned symbol, got ${syms.length}`);
        assert.equal(syms[0].name, "raw_resp_line_iter");
    } finally {
        try {
            await c.shutdown();
        } catch {}
        await rm(root, { recursive: true, force: true });
    }
});

test(
    // Regression: spawn() with a missing binary (ENOENT) emits an asynchronous
    // 'error' event on the ChildProcess. With no listener, Node treats it as an
    // UNCAUGHT exception and kills the whole pi process — the original crash
    // when a project detected bash as a language but bash-language-server
    // wasn't on PATH. The proc 'error' handler in LspClient.start() must
    // catch it, log it, and reject the in-flight ensureReady() promise so
    // nav.ts symbol()'s per-language soft-failure catch turns it into an
    // "ERROR  [lang]  server unavailable: ..." row. Two assertions matter:
    //   1. ensureReady() REJECTS (not hangs, not crashes the test process).
    //   2. The rejection surfaces the original errno (ENOENT), not a timeout.
    "ensureReady rejects (not crashes) when binary is missing (ENOENT)",
    withDeadline(8000, "spawn-enoent", async () => {
        const root = await mkdtemp(resolve(tmpdir(), "code-nav-fake-"));
        const c = new LspClient("bash", root, {
            // A binary that cannot exist on any PATH: spawn() will emit
            // 'error' with code ENOENT.
            command: "definitely-missing-language-server-xyz",
            args: ["start"],
            initOptions: {},
            serverKind: "custom",
        });
        try {
            await assert.rejects(c.ensureReady(), (err) => {
                const msg = String(err?.message ?? err);
                // The pre-flight check names the missing command
                // (instead of letting spawn() emit a raw ENOENT).
                assert.match(
                    msg,
                    /command not found on PATH/,
                    `should surface the missing-command error, not a generic/timeout; got: ${msg}`,
                );
                // And it must NOT be the request timeout — that would
                // mean the 'error' handler didn't reject and we waited
                // the full file-wide 300ms for the reader-close path.
                assert.ok(
                    !/timed out/.test(msg),
                    `should reject via the 'error' handler, not the timeout; got: ${msg}`,
                );
                return true;
            });
        } finally {
            try {
                await c.shutdown();
            } catch {}
            await rm(root, { recursive: true, force: true });
        }
    }),
);
