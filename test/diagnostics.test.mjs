// Pull-diagnostic cancellation/retry regressions; no real language server needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { load } from "./helpers.mjs";

const { diagnostics } = await load("./src/diagnostics.ts");
const cancelled = (code = -32802, data = { retriggerRequest: true }) =>
    Object.assign(new Error("server cancelled the request"), { code, data });
const diagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    source: "ty",
    message: "Expected int, found str",
};

async function workspace(t) {
    const root = await mkdtemp(resolve(tmpdir(), "code-nav-diagnostics-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await Promise.all(
        ["a.py", "b.py"].map((path) => writeFile(resolve(root, path), 'x: int = "bad"\n')),
    );
    return root;
}

function clientWith(pullDiagnostics) {
    return {
        openDocument: async () => {},
        ensureDocumentReady: async () => {},
        pullDiagnostics,
        waitForPushedDiagnostics: async () => assert.fail("must retry pull, not wait for push"),
    };
}

test("diagnostics retries retriggerable cancellation and renders the real result", async (t) => {
    const root = await workspace(t);
    let calls = 0;
    let opens = 0;
    const client = clientWith(async (path) => {
        assert.equal(path, resolve(root, "a.py"));
        if (++calls < 3) throw cancelled();
        return [diagnostic];
    });
    client.openDocument = async () => {
        opens++;
    };
    const result = await diagnostics({ path: "a.py" }, root, async () => client);
    assert.match(result, /1 diagnostic\(s\) for a\.py:/);
    assert.match(result, /Expected int, found str/);
    assert.equal(calls, 3);
    assert.equal(opens, 1, "retry must not reopen documents and trigger more cancellations");
});

test("diagnostics retry budgets are independent for concurrent Python calls", async (t) => {
    const root = await workspace(t);
    const calls = new Map();
    const client = clientWith(async (path) => {
        const count = (calls.get(path) ?? 0) + 1;
        calls.set(path, count);
        if (count <= 3) throw cancelled();
        return path.endsWith("a.py") ? [diagnostic] : [];
    });
    const results = await Promise.all(
        ["a.py", "b.py"].map((path) => diagnostics({ path }, root, async () => client)),
    );
    assert.match(results[0], /1 diagnostic\(s\) for a\.py:/);
    assert.equal(results[1], "(no diagnostics for b.py)");
    assert.deepEqual([...calls.values()], [4, 4]);
});

test("diagnostics stops repeated cancellations without entering the 60-second push wait", async (t) => {
    const root = await workspace(t);
    let calls = 0;
    const client = clientWith(async () => {
        calls++;
        throw cancelled();
    });
    await assert.rejects(
        diagnostics({ path: "a.py" }, root, async () => client),
        /python: diagnostics unavailable for a\.py: .*cancelled.*4 attempts/,
    );
    assert.equal(calls, 4);
});

for (const [label, error] of [
    ["explicitly non-retriggerable cancellation", cancelled(-32802, { retriggerRequest: false })],
    ["cancellation without retrigger data", cancelled(-32802, null)],
    ["client cancellation", cancelled(-32800)],
    ["unsupported pull method", Object.assign(new Error("Method not found"), { code: -32601 })],
    ["same message without a protocol code", new Error("server cancelled the request")],
]) {
    test(`diagnostics does not retry ${label}`, async (t) => {
        const root = await workspace(t);
        let pulls = 0;
        let pushes = 0;
        const client = clientWith(async () => {
            pulls++;
            throw error;
        });
        client.waitForPushedDiagnostics = async () => {
            pushes++;
            return [];
        };
        assert.equal(
            await diagnostics({ path: "a.py" }, root, async () => client),
            "(no diagnostics for a.py)",
        );
        assert.equal(pulls, 1);
        assert.equal(pushes, 1);
    });
}

test("diagnostics still falls back to push if a retry encounters unsupported pull", async (t) => {
    const root = await workspace(t);
    let calls = 0;
    const client = clientWith(async () => {
        if (++calls === 1) throw cancelled();
        throw Object.assign(new Error("Method not found"), { code: -32601 });
    });
    client.waitForPushedDiagnostics = async () => [diagnostic];
    assert.match(
        await diagnostics({ path: "a.py" }, root, async () => client),
        /1 diagnostic\(s\)/,
    );
    assert.equal(calls, 2);
});
