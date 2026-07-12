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
//   wedge-stdin         — replies to initialize, then STOPS reading stdin
//                        permanently (removes the data listener + pauses).
//                        Distinct from `silent` (which keeps reading stdin
//                        and only ignores requests): a wedged INPUT pipe
//                        blocks the client's `writable.write()` on a large
//                        didOpen payload, holding StreamMessageWriter's
//                        writeSemaphore forever so the following request never
//                        reaches its own Promise.race. The client must reject
//                        via the didOpen/notification timeout, not hang.
//   ok                 — replies to initialize + initialized, then answers
//                        workspace/symbol with a canned SymbolInformation[].
//                        Used as a control: the happy path must still work.
//
// Framing: Content-Length header + JSON body, one message per write. We do
// NOT use vscode-jsonrpc on the server side — hand-rolled framing keeps this
// script dependency-free and trivially auditable.
//
// Not run directly by `npm test`; spawned by test/lsp-client.test.mjs.

const mode = process.argv[2] ?? "ok";

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
        if (mode === "wedge-stdin") {
            // Stop reading stdin entirely. Any subsequent write (the large
            // didOpen the client is about to send) will exceed the OS pipe
            // buffer and block the client's writer — holding the writer's
            // semaphore. The client's didOpen-notification timeout must
            // reject (not hang) so the following documentSymbol request can
            // also reject (via the timeout or the dispose on teardown).
            process.stdin.removeAllListeners("data");
            process.stdin.pause();
            return;
        }
        return; // notification, no reply
    }
    if (msg.method === "workspace/symbol") {
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
