// End-to-end Python scenarios through ty. Skipped when ty is unavailable.

import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { matches, notMatches, scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const tyOk = SHOULD_RUN_E2E ? await serverAvailable("python") : false;
const unavailable = skip || !tyOk;

async function thirdPartyAvailable() {
    if (!tyOk) return false;
    let roots;
    try {
        roots = await nav.discoverThirdPartyRoots("python", process.cwd());
    } catch {
        return false;
    }
    const someExists = async (paths) => {
        for (const path of paths) {
            try {
                await stat(path);
                return true;
            } catch {}
        }
        return false;
    };
    return (
        roots.length > 0 &&
        (await someExists(roots.map((root) => resolve(root, "typing.py")))) &&
        (await someExists(
            roots.flatMap((root) => [resolve(root, "cbor2"), resolve(root, "cbor2.py")]),
        )) &&
        (await someExists(roots.map((root) => resolve(root, "aiohttp"))))
    );
}

const thirdPartyUnavailable = unavailable || !(await thirdPartyAvailable());
const pythonScenario = (name, spec) => scenario(name, { skip: unavailable, ...spec });
const thirdPartyScenario = (name, spec) =>
    scenario(name, { skip: thirdPartyUnavailable, ...spec });
const project = (main) => ({
    files: {
        "pyproject.toml": "[project]\nname='t'\nversion='0'",
        "main.py": main,
    },
});

pythonScenario("code_outline renders Python structure, signatures, ranges, and docs", {
    given: { fixtures: ["second.py"] },
    when: ({ root, clientOf }) => nav.outline({ path: "second.py" }, root, clientOf),
    then: [
        matches(/^Class Point  second\.py:\d+:\d+  range=\d+-\d+$/m, "Point missing"),
        matches(/^Class TempC  second\.py:\d+:\d+  range=\d+-\d+$/m, "TempC missing"),
        matches(/^  Method punintend  second\.py:\d+:\d+  range=\d+-\d+$/m),
        matches(/^  doc: documentation of tempC/m, "TempC docs missing"),
        matches(/^    doc: Documentation of punintend/m, "method docs missing"),
        notMatches(/Constant GLOB/, "non-structural constant should be hidden"),
        notMatches(/more entries/, "small outline should not paginate"),
    ],
});

pythonScenario("code_outline paginates with a bounded page and continuation note", {
    given: { fixtures: ["second.py"] },
    when: ({ root, clientOf }) =>
        nav.outline({ path: "second.py", offset: 1, limit: 2 }, root, clientOf),
    then: [
        (response) => {
            const rows = response
                .split("\n")
                .filter((line) => /\b\w+  second\.py:\d+:\d+  range=\d+-\d+$/.test(line));
            assert.equal(rows.length, 2, `expected two entries:\n${response}`);
        },
        matches(/^\[3 more entries in second\.py\. Use offset=3 to continue\.\]$/m),
    ],
});

pythonScenario("code_outline re-emits an ancestor when pagination starts inside a class", {
    given: { fixtures: ["second.py"] },
    when: ({ root, clientOf }) =>
        nav.outline({ path: "second.py", offset: 4, limit: 2 }, root, clientOf),
    then: [
        matches(/^Class TempC  \(cont\.\)  second\.py:\d+:\d+  range=\d+-\d+$/m),
        (response) => {
            const first = response.split("\n")[0];
            assert.doesNotMatch(first, /docs?:/, `context row should have no docs:\n${response}`);
        },
        matches(/^  Constructor __init__ /m),
        matches(/^  Method punintend /m),
        notMatches(/more entries/, "last page should not paginate"),
    ],
});

pythonScenario("code_outline returns a note when offset is past the end", {
    given: { fixtures: ["second.py"] },
    when: ({ root, clientOf }) =>
        nav.outline({ path: "second.py", offset: 999, limit: 10 }, root, clientOf),
    then: [matches(/^\(offset 999 is past the end; 5 entries in second\.py\)$/)],
});

pythonScenario("code_search_symbol finds the requested workspace class", {
    given: { files: { "main.py": "class TempC:\n    pass" } },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "tempc", language: "python" }, root, clientOf),
    then: [
        matches(/\[python\] Class TempC  .*main\.py:1:7/, "TempC result missing"),
        (response) => {
            for (const row of response.split("\n").filter(Boolean))
                assert.match(row, /TempC/, `unexpected row: ${row}`);
        },
    ],
});

thirdPartyScenario("code_search_symbol finds qualified stdlib typing.cast", {
    given: project("import typing\nx = typing.cast(int, 5)"),
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "typing.cast", language: "python" }, root, clientOf),
    then: [
        (response) => {
            const rows = response.split("\n").filter((line) => line.startsWith("[python]"));
            assert.equal(rows.length, 1, `expected one row:\n${response}`);
            assert.match(rows[0], /\[python\] Function cast  .*typing\.py:\d+:\d+/);
        },
    ],
});

thirdPartyScenario("code_search_symbol finds qualified third-party cbor2.loads", {
    given: project("import cbor2\nx = cbor2.loads(b'')"),
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "cbor2.loads", language: "python" }, root, clientOf),
    then: [
        (response) => {
            const rows = response.split("\n").filter((line) => line.startsWith("[python]"));
            assert.equal(rows.length, 1, `expected one row:\n${response}`);
            assert.match(rows[0], /\[python\] Function loads  .*cbor2\/_decoder\.py:\d+:\d+/);
        },
    ],
});

thirdPartyScenario("code_search_symbol ranks exact third-party loads before fuzzy matches", {
    given: project("import cbor2\nx = cbor2.loads(b'')"),
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "loads", language: "python" }, root, clientOf),
    then: [
        (response) => {
            const rows = response.split("\n").filter((line) => line.startsWith("[python]"));
            let seenFuzzy = false;
            for (const row of rows) {
                const exact = /\] (Function|Variable|Field) loads  /.test(row);
                if (!exact) seenFuzzy = true;
                if (exact && seenFuzzy) assert.fail(`exact row follows fuzzy row:\n${response}`);
            }
            assert.equal(
                rows.findIndex((row) => row.includes("cbor2/_decoder.py")),
                0,
                `cbor2.loads should be first:\n${response}`,
            );
        },
    ],
});

pythonScenario("code_search_symbol returns only an exact workspace method", {
    given: project("import cbor2, typing\nclass MyThing:\n    def mymethod(self): pass"),
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "mymethod", language: "python" }, root, clientOf),
    then: [
        (response) => {
            const rows = response.split("\n").filter((line) => line.startsWith("[python]"));
            assert.equal(rows.length, 1, `expected only workspace method:\n${response}`);
            assert.match(rows[0], /\[python\] Method mymethod  .*main\.py:\d+:\d+/);
        },
    ],
});

thirdPartyScenario("code_search_symbol resolves a class-qualified aiohttp method", {
    given: project(`
        import aiohttp
        async def f():
            r = aiohttp.StreamReader()
            async for c in r.iter_chunks(): pass
    `),
    when: ({ root, clientOf }) =>
        nav.symbol(
            { query: "aiohttp.StreamReader.iter_chunks", language: "python" },
            root,
            clientOf,
        ),
    then: [
        (response) => {
            const rows = response
                .split("\n")
                .filter((line) => line.startsWith("[python]") && !line.startsWith("[python] #"));
            assert.equal(rows.length, 1, `expected one method:\n${response}`);
            assert.match(rows[0], /\[python\] Method iter_chunks  .*aiohttp\/streams\.py:\d+:\d+/);
        },
    ],
});

thirdPartyScenario("code_search_symbol resolves an aiohttp re-export without case noise", {
    given: project("import aiohttp.web\nasync def f(): req = aiohttp.web.Request(...)"),
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "aiohttp.web.Request", language: "python" }, root, clientOf),
    then: [
        matches(/\[python\] Class Request  .*aiohttp\/web_request\.py:\d+:\d+/, "class missing"),
        notMatches(/\] (Method|Function) request  /, "lowercase case-variant should be removed"),
    ],
});

pythonScenario("code_definition returns a Python method body", {
    given: { fixtures: ["second.py"] },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "second.py", line: 24, column: 9 }, root, clientOf),
    then: [
        matches(/^.*second\.py:\d+-\d+$/m, "definition header missing"),
        matches(/def punintend/),
        matches(/Documentation of punintend/),
        notMatches(/^```$/m, "body should not be fenced"),
    ],
});

pythonScenario("code_definition returns a top-level body and docstring", {
    given: { fixtures: ["defs.py"] },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "defs.py", line: 28, column: 5 }, root, clientOf),
    then: [
        matches(/^.*defs\.py:\d+-\d+$/m),
        matches(/def make_config/),
        matches(/Build a default config/),
        matches(/"timeout"/),
        notMatches(/^```$/m),
    ],
});

pythonScenario("code_definition returns a complete Python class body", {
    given: { fixtures: ["defs.py"] },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "defs.py", line: 33, column: 7 }, root, clientOf),
    then: [
        matches(/^.*defs\.py:33-\d+$/m),
        matches(/class Greeter/),
        matches(/def __init__/),
        matches(/def greet/),
        matches(/def config/),
    ],
});

pythonScenario("code_definition narrows a class member to its method body", {
    given: { fixtures: ["defs.py"] },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "defs.py", line: 39, column: 9 }, root, clientOf),
    then: [
        matches(/^.*defs\.py:39-\d+$/m),
        matches(/def greet/),
        matches(/Return the greeting/),
        notMatches(/def __init__/),
        notMatches(/def config/),
    ],
});

pythonScenario("code_definition follows a function call to its definition", {
    given: { fixtures: ["defs.py"] },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "defs.py", line: 44, column: 16 }, root, clientOf),
    then: [matches(/^.*defs\.py:28-\d+$/m), matches(/def make_config/)],
});

pythonScenario("code_definition follows a constructor call to its class", {
    given: { fixtures: ["defs.py"] },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "defs.py", line: 48, column: 9 }, root, clientOf),
    then: [matches(/^.*defs\.py:33-\d+$/m), matches(/class Greeter/)],
});

pythonScenario("code_hover shows the Point constructor parameter", {
    given: { fixtures: ["second.py"] },
    when: ({ root, clientOf }) =>
        nav.hover({ path: "second.py", line: 11, column: 9 }, root, clientOf),
    then: [matches(/x\s*:\s*int/i, "x parameter missing")],
});

pythonScenario("code_hover puts a collapsed signature before its markdown body", {
    given: { fixtures: ["second.py"] },
    when: ({ root, clientOf }) =>
        nav.hover({ path: "second.py", line: 11, column: 9 }, root, clientOf),
    then: [
        matches(/^signature: /, "first line must be a signature"),
        matches(/^signature: .*x\s*:\s*int/im, "signature must include x"),
    ],
});

pythonScenario("code_references adds Python roles, source, and enclosing symbols", {
    given: { fixtures: ["second.py"] },
    when: async ({ root, clientOf }) => ({
        direct: await nav.references(
            { path: "second.py", line: 10, column: 7 },
            root,
            clientOf,
        ),
        included: await nav.symbol(
            { query: "Point", language: "python", include: ["references"] },
            root,
            clientOf,
        ),
    }),
    then: [
        ({ direct, included }) => {
            assert.match(direct, /kind: declaration\n\n10 \| Point/);
            assert.match(direct, /kind: type\n\n20 \| Point/);
            assert.match(direct, /kind: call\n\n20 \| Point\(\)/);
            assert.match(direct, /enclosing: TempC\.__init__  .*second\.py:20:9/);
            assert.match(direct, /# 3 references$/);
            assert.match(included, /--- references ---/);
            assert.match(included, /kind: type\n\n20 \| Point/);
            assert.match(included, /kind: call\n\n20 \| Point\(\)/);
            assert.match(included, /enclosing: TempC\.__init__  .*second\.py:20:9/);
        },
    ],
});

pythonScenario("code_diagnostics reports a Python type error", {
    given: {
        fixtures: ["second.py"],
        files: { "bad.py": 'import second\nsecond.Point("not an int")' },
    },
    when: ({ root, clientOf }) => nav.diagnostics({ path: "bad.py" }, root, clientOf),
    then: [matches(/\d+ diagnostic\(s\) for bad\.py:/, "diagnostic header missing")],
});
