// Diagnostic rendering and cancellation/retry regressions; no real server needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { load } from "./helpers.mjs";

const { diagnostics } = await load("./src/diagnostics.ts");
const { renderDiagnostic } = await load("./src/render.ts");
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

async function renderList(t, diags, pushed = false) {
    const root = await workspace(t);
    const client = clientWith(async () => {
        if (pushed) throw new Error("Method not found");
        return diags;
    });
    client.waitForPushedDiagnostics = async () => diags;
    return diagnostics({ path: "a.py" }, root, async () => client);
}

function at(line, character = 0) {
    return { start: { line, character }, end: { line, character: character + 1 } };
}

for (const pushed of [false, true]) {
    test(`diagnostics deduplicates identical entries from one ${pushed ? "push" : "pull"} response`, async (t) => {
        const diags = [diagnostic, structuredClone(diagnostic), diagnostic];
        const before = structuredClone(diags);
        const result = await renderList(t, diags, pushed);
        assert.equal(
            result,
            "1 diagnostic(s) for a.py (3 reported):\n" +
                renderDiagnostic("a.py", diagnostic) +
                "  [3 occurrences]",
        );
        assert.deepEqual(diags, before, "must not mutate the server's cached diagnostics");
    });
}

test("diagnostics keeps different ranges, severities, sources, codes, and messages separate", async (t) => {
    const diags = [
        diagnostic,
        { ...diagnostic, range: at(1) },
        { ...diagnostic, range: { start: diagnostic.range.start, end: { line: 0, character: 2 } } },
        { ...diagnostic, severity: 2 },
        { ...diagnostic, source: "pyright" },
        { ...diagnostic, code: 1 },
        { ...diagnostic, code: "1" },
        { ...diagnostic, message: "Another error" },
    ];
    const result = await renderList(t, diags);
    assert.equal(
        result,
        `8 diagnostic(s) for a.py:\n${diags.map((d) => renderDiagnostic("a.py", d)).join("\n")}`,
    );
});

const warningText = "'save' overrides a member function but is not marked 'override'";
function cclsInstantiation(type, line) {
    const note = `in instantiation of template class 'Index<${type}>' requested here`;
    const common = { source: "ccls", code: 3, relatedInformation: [] };
    return [
        {
            ...common,
            range: at(62, 27),
            severity: 2,
            message: `${warningText}\n\na.py:${line}:5: note: ${note}\n\n/base.h:50:18:\nnote: overridden virtual function is here`,
        },
        {
            ...common,
            range: at(line - 1, 4),
            severity: 3,
            message: `${note}\n\nindex.h:63:28: warning: ${warningText}`,
        },
    ];
}

for (const pushed of [false, true]) {
    test(`diagnostics groups ccls template warnings and folds reciprocal info notes (${pushed ? "push" : "pull"})`, async (t) => {
        const diags = [...cclsInstantiation("float", 100), ...cclsInstantiation("int", 200)];
        // ccls can repeat exactly the same instantiation chain as well.
        diags.push(...structuredClone(cclsInstantiation("int", 200)));
        const before = structuredClone(diags);
        const result = await renderList(t, diags, pushed);
        assert.equal(
            result,
            "1 diagnostic(s) for a.py (6 reported; 3 related diagnostics folded):\n" +
                `a.py:63:28  warning  ccls (3)  ${warningText}  [3 occurrences]\n` +
                "  a.py:100:5  note: in instantiation of template class 'Index<float>' requested here\n" +
                "  /base.h:50:18  note: overridden virtual function is here\n" +
                "  a.py:200:5  note: in instantiation of template class 'Index<int>' requested here",
        );
        assert.deepEqual(diags, before);
    });
}

test("diagnostics keeps standalone and non-reciprocal ccls info diagnostics", async (t) => {
    const [parent, mirror] = cclsInstantiation("float", 100);
    const otherFile = { ...parent, message: parent.message.replace("a.py:100", "other.py:100") };
    const unrelated = {
        ...mirror,
        message: mirror.message.replace(warningText, "A different warning"),
    };
    const extraContext = {
        ...mirror,
        message: mirror.message + "\n\nother.h:1:1: note: Unique context",
    };
    for (const diags of [
        [mirror],
        [parent, unrelated],
        [otherFile, mirror],
        [parent, extraContext],
    ]) {
        const result = await renderList(t, diags);
        assert.match(result, new RegExp(`^${diags.length} diagnostic\\(s\\)`));
        assert.doesNotMatch(result, /folded/);
        assert.match(result, /  info  ccls/);
    }
});

test("diagnostics also folds mirrored ccls error context with CRLF separators", async (t) => {
    const diags = cclsInstantiation("float", 100).map((d) => ({
        ...d,
        severity: d.severity === 2 ? 1 : d.severity,
        message: d.message.replace("warning:", "error:").replaceAll("\n", "\r\n"),
    }));
    const result = await renderList(t, diags);
    assert.match(
        result,
        /^1 diagnostic\(s\) for a.py \(2 reported; 1 related diagnostics folded\):/,
    );
    assert.match(result, /a.py:63:28  error  ccls/);
    assert.match(result, /a.py:100:5  note: in instantiation/);
    assert.doesNotMatch(result, /  info  ccls/);
});

test("diagnostics preserves arbitrary multiline messages, including ccls suffixes it cannot parse", async (t) => {
    for (const source of ["ty", "ccls"]) {
        const d = {
            ...diagnostic,
            source,
            message: "Primary message\n\nDetailed explanation\n  with indentation",
        };
        assert.equal(
            await renderList(t, [d]),
            `1 diagnostic(s) for a.py:\n${renderDiagnostic("a.py", d)}`,
        );
    }
    const d = { ...cclsInstantiation("float", 100)[0], source: "custom" };
    assert.equal(
        await renderList(t, [d]),
        `1 diagnostic(s) for a.py:\n${renderDiagnostic("a.py", d)}`,
    );
});

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
