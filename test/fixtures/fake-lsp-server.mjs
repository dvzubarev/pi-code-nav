// Fake LSP server over stdio for lsp-client timeout/dispose regression tests.
//
// Speaks just enough JSON-RPC to complete the `initialize` handshake, then
// exhibits one of several controllable failure modes so the client's
// in-flight `sendRequest` promises can be asserted to reject (instead of
// hanging) when the server dies or goes silent mid-request.
//
// Modes (selected by argv[2]):
//   exit-mid-request   — replies to initialize + initialized, then EXITS as
//                        soon as it receives workspace/symbol (simulates a
//                        server that crashes after init, like ty over some
//                        projects). The client must reject the pending
//                        request via its proc.on("exit") -> conn.dispose().
//   silent             — replies to initialize + initialized, then ignores
//                        every subsequent request forever (stays alive, never
//                        answers). The client must reject via the per-request
//                        timeout.
//   ok                 — replies to initialize + initialized, then answers
//                        workspace/symbol with a canned SymbolInformation[].
//                        Used as a control: the happy path must still work.
//   bash-index-log     — emits Bash LS BackgroundAnalysis start/completion
//                        window/logMessage notifications and returns no symbols
//                        until completion. Exercises the Bash indexing barrier.
//   ty-workspace-progress — workspace/diagnostic emits work-done begin/end and
//                        intentionally long-polls; symbols appear after end.
//
// Framing: Content-Length header + JSON body, one message per write. We do
// NOT use vscode-jsonrpc on the server side — hand-rolled framing keeps this
// script dependency-free and trivially auditable.
//
// Not run directly by `npm test`; spawned by test/lsp-client.test.mjs.

const mode = process.argv[2] ?? "ok";
let bashIndexed = false;
let tyWorkspaceChecked = false;

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\r\n\r\n")) !== -1) {
        const headerBlock = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        const m = headerBlock.match(/Content-Length:\s*(\d+)/i);
        if (!m) continue;
        const len = parseInt(m[1], 10);
        if (buf.length < len) {
            // Not enough body yet; push back and wait. (We already sliced the
            // headers off, so re-prepend a synthetic header+sep to keep the
            // loop simple on the next data event.)
            buf = `Content-Length: ${len}\r\n\r\n${buf}`;
            return;
        }
        const body = buf.slice(0, len);
        buf = buf.slice(len);
        let msg;
        try {
            msg = JSON.parse(body);
        } catch {
            continue;
        }
        handle(msg);
    }
});

function write(obj) {
    const body = JSON.stringify(obj);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function handle(msg) {
    if (msg.method === "initialize") {
        write({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
                capabilities: {
                    workspaceSymbolProvider: true,
                    textDocumentSync: { openClose: true, change: 1, save: true },
                    hoverProvider: true,
                    definitionProvider: true,
                    referencesProvider: true,
                    documentSymbolProvider: true,
                    renameProvider: true,
                },
            },
        });
        return;
    }
    if (msg.method === "initialized") {
        if (mode === "bash-index-log") {
            write({
                jsonrpc: "2.0",
                method: "window/logMessage",
                params: {
                    type: 3,
                    message: 'INFO BackgroundAnalysis: resolving glob "**/*.sh" inside workspace...',
                },
            });
            setTimeout(() => {
                bashIndexed = true;
                write({
                    jsonrpc: "2.0",
                    method: "window/logMessage",
                    params: {
                        type: 3,
                        message: "INFO BackgroundAnalysis: Completed after 0.1 seconds.",
                    },
                });
            }, 100);
        }
        return; // notification, no reply
    }
    if (msg.method === "workspace/diagnostic" && mode === "ty-workspace-progress") {
        const token = msg.params?.workDoneToken;
        write({
            jsonrpc: "2.0",
            method: "$/progress",
            params: { token, value: { kind: "begin", title: "Checking" } },
        });
        setTimeout(() => {
            tyWorkspaceChecked = true;
            write({
                jsonrpc: "2.0",
                method: "$/progress",
                params: { token, value: { kind: "end", message: "Checked workspace" } },
            });
        }, 100);
        // Deliberately no response: ty long-polls an unchanged diagnostic request.
        return;
    }
    if (msg.method === "workspace/symbol") {
        if ((mode === "bash-index-log" && !bashIndexed) ||
            (mode === "ty-workspace-progress" && !tyWorkspaceChecked)) {
            write({ jsonrpc: "2.0", id: msg.id, result: [] });
            return;
        }
        if (mode === "exit-mid-request") {
            // Crash immediately, leaving the request unanswered. The client's
            // exit handler must dispose the connection and reject this promise.
            process.exit(2);
        }
        if (mode === "silent") {
            // Swallow the request: never reply, never exit. The client's
            // per-request timeout must reject.
            return;
        }
        // mode === "ok": answer with one canned symbol.
        write({
            jsonrpc: "2.0",
            id: msg.id,
            result: [
                {
                    name: "raw_resp_line_iter",
                    kind: 12, // Function
                    location: {
                        uri: "file:///fake/mod.py",
                        range: {
                            start: { line: 5, character: 0 },
                            end: { line: 33, character: 33 },
                        },
                    },
                },
            ],
        });
        return;
    }
    // For any other request in silent/exit modes, also stay silent/exit so
    // those modes are robust across whatever the client sends.
    if (mode === "exit-mid-request") process.exit(2);
    if (mode === "silent") return;
    // ok: generic empty success.
    write({ jsonrpc: "2.0", id: msg.id, result: null });
}
