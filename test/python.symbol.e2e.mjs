// End-to-end Python symbol-search scenarios through ty.

import assert from "node:assert/strict";
import { nav, project, pythonScenario, thirdPartyScenario } from "./python-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

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
            assert.match(rows[0], /\[python\] Function loads  .*cbor2\/\_decoder\.py:\d+:\d+/);
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
