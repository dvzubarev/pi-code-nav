// Unit tests for the project-readiness policies (src/project-progress.ts).
//
// Each policy is exercised through `createProjectReadiness(serverKind)` with a
// mock ProjectHost, so the tests verify WHAT each policy waits for without a
// real language server:
//
//   - Noop (pyright/custom):         ready immediately.
//   - TypeScript:                    bootstrap didOpen + work-done begin/end.
//   - C++:                           bootstrap didOpen + $ccls/info polling.
//   - Bash:                          window/logMessage BackgroundAnalysis.
//   - ty:                            workspace/diagnostic + work-done end.
//
// Selection is by serverKind, not language: a "custom" server must never
// inherit a built-in server's policy (see the routing tests below).
//
// Timers are squeezed via the CODE_NAV_PROJECT_LOAD_*_TIMEOUT_MS env vars so
// the timeout boundaries are asserted, not just the happy paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { createProjectReadiness } = await load("./src/project-progress.ts");

/** A mock ProjectHost with per-test hooks. */
function host({ docsOpen = false, bootstrap = null, onOpen = null, requestImpl = null } = {}) {
    const opened = [];
    return {
        hasOpenDocuments: () => docsOpen,
        findBootstrapFile: async () => bootstrap,
        openDocument: async (path) => {
            opened.push(path);
            if (onOpen) await onOpen(path);
        },
        request: async (method, params, timeoutMs) => {
            if (requestImpl) return requestImpl(method, params, timeoutMs);
            throw new Error(`unexpected request ${method}`);
        },
        opened,
    };
}

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a promise-returning fn with overridden project-load timeouts. */
async function withTimeouts({ start = 20, end = 30 }, fn) {
    const prevStart = process.env.CODE_NAV_PROJECT_LOAD_START_TIMEOUT_MS;
    const prevEnd = process.env.CODE_NAV_PROJECT_LOAD_END_TIMEOUT_MS;
    process.env.CODE_NAV_PROJECT_LOAD_START_TIMEOUT_MS = String(start);
    process.env.CODE_NAV_PROJECT_LOAD_END_TIMEOUT_MS = String(end);
    try {
        return await fn();
    } finally {
        if (prevStart === undefined) delete process.env.CODE_NAV_PROJECT_LOAD_START_TIMEOUT_MS;
        else process.env.CODE_NAV_PROJECT_LOAD_START_TIMEOUT_MS = prevStart;
        if (prevEnd === undefined) delete process.env.CODE_NAV_PROJECT_LOAD_END_TIMEOUT_MS;
        else process.env.CODE_NAV_PROJECT_LOAD_END_TIMEOUT_MS = prevEnd;
    }
}

// ---------------------------------------------------------------------------
// No-op policy (pyright + custom servers)
// ---------------------------------------------------------------------------

test("noop policy: workspace and document readiness are immediate", async () => {
    const ready = createProjectReadiness("pyright");
    const h = host();
    assert.equal(await ready.ensureWorkspaceReady(h), true);
    await ready.ensureDocumentReady(h, "/tmp/x.py");
    assert.equal(h.opened.length, 0, "noop must not open a bootstrap file");
});

// ---------------------------------------------------------------------------
// Policy routing — selection is by serverKind, never language
// ---------------------------------------------------------------------------

for (const kind of ["custom", "pyright"]) {
    test(`routing: cpp + ${kind} → no-op policy (no $ccls/info, no bootstrap)`, async () => {
        const ready = createProjectReadiness(kind);
        const h = host({ bootstrap: "/root/main.cpp" });
        assert.equal(await ready.ensureWorkspaceReady(h), true);
        assert.equal(h.opened.length, 0, "custom cpp must not bootstrap a source file");
        // A no-op document readiness never touches the host.
        await ready.ensureDocumentReady(h, "/root/a.cpp");
    });
}

test("routing: typescript + custom → no-op policy (no bootstrap find)", async () => {
    const ready = createProjectReadiness("custom");
    let finds = 0;
    const h = {
        hasOpenDocuments: () => false,
        findBootstrapFile: async () => {
            finds++;
            return "/root/a.ts";
        },
        openDocument: async () => {},
        request: async () => {
            throw new Error("unexpected request");
        },
        opened: [],
    };
    assert.equal(await ready.ensureWorkspaceReady(h), true);
    assert.equal(finds, 0, "custom typescript must not run the tsserver bootstrap scan");
});

test("routing: bash + custom → no-op policy (no BackgroundAnalysis wait)", async () => {
    const ready = createProjectReadiness("custom");
    const h = host();
    // The no-op policy is immediate and does not wait on log messages.
    assert.equal(await ready.ensureWorkspaceReady(h), true);
    // A late BackgroundAnalysis log would be ignored by the no-op policy.
    ready.onLogMessage('INFO BackgroundAnalysis: resolving glob "**/*.sh"');
});

test("routing: built-in kinds get their own policies", () => {
    const byName = {
        ccls: "CppProjectReadiness",
        "typescript-language-server": "TypeScriptProjectReadiness",
        "bash-language-server": "BashProjectReadiness",
        ty: "TyProjectReadiness",
    };
    for (const [kind, name] of Object.entries(byName)) {
        assert.equal(createProjectReadiness(kind).constructor.name, name);
    }
});

// ---------------------------------------------------------------------------
// TypeScript — bootstrap didOpen + work-done begin/end
// ---------------------------------------------------------------------------

test("typescript: no source file → ensureWorkspaceReady=false without opening", async () => {
    const ready = createProjectReadiness("typescript-language-server");
    const h = host({ bootstrap: null });
    assert.equal(await ready.ensureWorkspaceReady(h), false);
    assert.equal(h.opened.length, 0);
});

test("typescript: bootstrap open failure → false", async () => {
    const ready = createProjectReadiness("typescript-language-server");
    const h = host({
        bootstrap: "/root/src/a.ts",
        onOpen: async () => {
            throw new Error("boom");
        },
    });
    assert.equal(await ready.ensureWorkspaceReady(h), false);
});

test("typescript: waits for the work-done interval started by bootstrap open", async () => {
    const ready = createProjectReadiness("typescript-language-server");
    let settled = false;
    const h = host({
        bootstrap: "/root/src/a.ts",
        // didOpen starts the load; deliver only `begin` here.
        onOpen: async () => {
            ready.onProgress({ token: "t", value: { kind: "begin" } });
        },
    });
    const p = ready.ensureWorkspaceReady(h).then((r) => {
        settled = true;
        return r;
    });
    await tick();
    assert.equal(settled, false, "must not resolve before the matching end");
    // The server finishes loading.
    ready.onProgress({ token: "t", value: { kind: "end" } });
    assert.equal(await p, true);
    assert.deepEqual(h.opened, ["/root/src/a.ts"]);
});

test("typescript: warm open documents need no bootstrap or wait", async () => {
    const ready = createProjectReadiness("typescript-language-server");
    const h = host({ docsOpen: true, bootstrap: "/root/src/a.ts" });
    assert.equal(await ready.ensureWorkspaceReady(h), true);
    assert.equal(h.opened.length, 0);
});

// ---------------------------------------------------------------------------
// C++ — bootstrap didOpen + $ccls/info polling
// ---------------------------------------------------------------------------

test("cpp: no source file → false", async () => {
    const ready = createProjectReadiness("ccls");
    const h = host({ bootstrap: null });
    assert.equal(await ready.ensureWorkspaceReady(h), false);
});

test("cpp: polls $ccls/info until two stable idle samples", async () => {
    const ready = createProjectReadiness("ccls");
    let calls = 0;
    const h = host({
        docsOpen: true, // already open — document readiness path still polls
        requestImpl: async (method) => {
            assert.equal(method, "$ccls/info");
            calls++;
            return { pipeline: { completed: 3, enqueued: 3 } };
        },
    });
    await ready.ensureDocumentReady(h, "/root/src/a.cpp");
    assert.ok(calls >= 2, `expected at least two stable samples, got ${calls}`);
});

test("cpp: waits through an in-progress pipeline sample", async () => {
    const ready = createProjectReadiness("ccls");
    const samples = [
        { pipeline: { completed: 1, enqueued: 5 } },
        { pipeline: { completed: 5, enqueued: 5 } },
        { pipeline: { completed: 5, enqueued: 5 } },
    ];
    let calls = 0;
    const h = host({
        docsOpen: true,
        requestImpl: async () => samples[calls++],
    });
    await ready.ensureDocumentReady(h, "/root/src/a.cpp");
    assert.equal(calls, 3, "one busy sample then two stable idle samples");
});

test("cpp: invalid $ccls/info response → throws", async () => {
    const ready = createProjectReadiness("ccls");
    const h = host({ docsOpen: true, requestImpl: async () => ({}) });
    await assert.rejects(ready.ensureDocumentReady(h, "/root/src/a.cpp"), /invalid \$ccls\/info/);
});

test("cpp: document sync invalidates idle state so the next query re-polls", async () => {
    const ready = createProjectReadiness("ccls");
    let calls = 0;
    const h = host({
        docsOpen: true,
        requestImpl: async () => {
            calls++;
            return { pipeline: { completed: 2, enqueued: 2 } };
        },
    });
    await ready.ensureDocumentReady(h, "/root/src/a.cpp");
    const afterFirst = calls;
    // A didChange may enqueue fresh work; a subsequent query must not trust
    // the previously-established idle state.
    ready.onDocumentSynced("/root/src/a.cpp");
    await ready.ensureDocumentReady(h, "/root/src/a.cpp");
    assert.ok(calls > afterFirst, "re-poll expected after onDocumentSynced");
});

test("cpp: ensureWorkspaceReady opens a bootstrap file before polling", async () => {
    const ready = createProjectReadiness("ccls");
    let calls = 0;
    const h = host({
        bootstrap: "/root/src/main.cpp",
        requestImpl: async () => {
            calls++;
            return { pipeline: { completed: 0, enqueued: 0 } };
        },
    });
    assert.equal(await ready.ensureWorkspaceReady(h), true);
    assert.deepEqual(h.opened, ["/root/src/main.cpp"]);
    assert.ok(calls >= 2);
});

test("cpp: later $/progress begin invalidates the settled poll and re-polls", async () => {
    const ready = createProjectReadiness("ccls");
    let calls = 0;
    const h = host({
        docsOpen: true,
        requestImpl: async () => {
            calls++;
            return { pipeline: { completed: 7, enqueued: 7 } };
        },
    });
    // First readiness completes a poll and caches "ended".
    await ready.ensureDocumentReady(h, "/root/src/a.cpp");
    const afterFirst = calls;
    assert.ok(afterFirst >= 2);
    // A second readiness is served from the sticky completed cache.
    await ready.ensureDocumentReady(h, "/root/src/a.cpp");
    assert.equal(calls, afterFirst, "warm cache must not re-poll");
    // A later indexing begin invalidates the cache even without a didChange.
    ready.onProgress({ token: "index", value: { kind: "begin" } });
    await ready.ensureDocumentReady(h, "/root/src/a.cpp");
    assert.ok(calls > afterFirst, "expected re-poll after $/progress begin");
});

test("cpp: invalidation between idle samples restarts the stability requirement", async () => {
    const ready = createProjectReadiness("ccls");
    let calls = 0;
    // Gate each $ccls/info request so the test controls exactly when each
    // sample lands relative to the invalidation.
    const gates = [];
    const h = host({
        docsOpen: true,
        requestImpl: async () => {
            calls++;
            return new Promise((resolve) => gates.push(resolve));
        },
    });
    let settled = false;
    const result = ready.ensureDocumentReady(h, "/root/src/a.cpp").then(() => {
        settled = true;
    });

    // Sample 1: idle (7,7) → becomes the first stable sample.
    while (gates.length < 1) await tick();
    gates.shift()({ pipeline: { completed: 7, enqueued: 7 } });
    // Wait for the poll's inter-sample pause and the second request.
    await sleep(40);
    while (gates.length < 1) await tick();

    // Invalidate while the second request is in flight, and answer with the
    // same stale (7,7) counters (the new queue is not yet visible).
    ready.onProgress({ token: "index", value: { kind: "begin" } });
    gates.shift()({ pipeline: { completed: 7, enqueued: 7 } });

    // The second sample alone must NOT complete the poll: it was reset by the
    // invalidation and only becomes the *first* sample of the new generation.
    await sleep(40);
    assert.equal(settled, false, "second idle sample must not complete after invalidation");

    // The third sample is the second stable idle sample after invalidation.
    while (gates.length < 1) await tick();
    assert.equal(calls, 3, "poll must require a third sample after invalidation");
    gates.shift()({ pipeline: { completed: 7, enqueued: 7 } });
    await result;
    assert.equal(settled, true);
});

// ---------------------------------------------------------------------------
// Bash — window/logMessage BackgroundAnalysis
// ---------------------------------------------------------------------------

test("bash: resolve early when info logs are disabled (start timeout)", async () => {
    await withTimeouts({ start: 25 }, async () => {
        const ready = createProjectReadiness("bash-language-server");
        const h = host();
        assert.equal(await ready.ensureWorkspaceReady(h), true);
    });
});

test("bash: waits for the Completed log message", async () => {
    const ready = createProjectReadiness("bash-language-server");
    const h = host();
    let settled = false;
    const p = ready.ensureWorkspaceReady(h).then((r) => {
        settled = true;
        return r;
    });
    ready.onLogMessage('INFO BackgroundAnalysis: resolving glob "**/*.sh"');
    await tick();
    assert.equal(settled, false, "must not resolve before Completed");
    ready.onLogMessage("INFO BackgroundAnalysis: Completed after 0.1 seconds.");
    assert.equal(await p, true);
});

test("bash: started indexing but no completion → hard timeout", async () => {
    await withTimeouts({ start: 25, end: 40 }, async () => {
        const ready = createProjectReadiness("bash-language-server");
        const h = host();
        // Deliver the start message immediately so we enter the completion
        // wait, then never deliver Completed.
        ready.onLogMessage('INFO BackgroundAnalysis: resolving glob "**/*.sh"');
        await assert.rejects(ready.ensureWorkspaceReady(h), /Bash workspace indexing timed out/);
    });
});

test("bash: soft start-not-observed timeout is not memoized", async () => {
    await withTimeouts({ start: 30, end: 60 }, async () => {
        const ready = createProjectReadiness("bash-language-server");
        const h = host();
        // First query: no start log arrives, so the soft start window expires.
        assert.equal(await ready.ensureWorkspaceReady(h), true);
        // Analysis starts LATER (after the soft window). A second workspace
        // query must notice "in_progress" and wait for completion rather than
        // reusing the earlier resolved barrier.
        ready.onLogMessage('INFO BackgroundAnalysis: resolving glob "**/*.sh"');
        let settled = false;
        const p = ready.ensureWorkspaceReady(h).then((r) => {
            settled = true;
            return r;
        });
        await tick();
        assert.equal(settled, false, "must not reuse the soft-expired barrier");
        ready.onLogMessage("INFO BackgroundAnalysis: Completed after 0.1 seconds.");
        assert.equal(await p, true);
    });
});

// ---------------------------------------------------------------------------
// ty — workspace/diagnostic + work-done end
// ---------------------------------------------------------------------------

test("ty: triggers one workspace/diagnostic and waits for the work-done end", async () => {
    const ready = createProjectReadiness("ty");
    let requests = 0;
    let requestedMethod;
    let requestedToken;
    const h = host({
        requestImpl: async (method, params) => {
            requests++;
            requestedMethod = method;
            requestedToken = params?.workDoneToken;
            // Deliberately never resolve: ty long-polls a no-change request.
            return new Promise(() => {});
        },
    });
    let settled = false;
    const p = ready.ensureWorkspaceReady(h).then((r) => {
        settled = true;
        return r;
    });
    await tick();
    assert.equal(requests, 1);
    assert.equal(requestedMethod, "workspace/diagnostic");
    assert.match(requestedToken, /^code-nav-ty-workspace-/);
    assert.equal(settled, false, "must not resolve before progress end");
    ready.onProgress({ token: requestedToken, value: { kind: "begin" } });
    ready.onProgress({ token: requestedToken, value: { kind: "end" } });
    assert.equal(await p, true);
});

test("ty: a normal diagnostic response is also a completion barrier", async () => {
    const ready = createProjectReadiness("ty");
    const h = host({ requestImpl: async () => ({ diagnosticMode: "workspace" }) });
    assert.equal(await ready.ensureWorkspaceReady(h), true);
});

test("ty: memoizes the workspace warm-up for the server lifetime", async () => {
    const ready = createProjectReadiness("ty");
    let requests = 0;
    const h = host({
        requestImpl: async () => {
            requests++;
            return { done: true };
        },
    });
    await ready.ensureWorkspaceReady(h);
    await ready.ensureDocumentReady(h, "/root/src/a.py");
    assert.equal(requests, 1, "workspace/diagnostic must run only once");
});
