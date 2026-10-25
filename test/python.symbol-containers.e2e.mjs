// Regression: Class.member must not degrade to every bare member in the index.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { nav, pythonScenario } from "./python-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

const given = {
    files: {
        "pyproject.toml": "[project]\nname='containers'\nversion='0'",
        "pkg/__init__.py": "",
        "pkg/records.py": `
        from typing import overload
        class LazyRecords:
            @overload
            def items(self, many: bool) -> list[int]: ...
            @overload
            def items(self) -> list[int]: ...
            def items(self, many: bool = False) -> list[int]:
                return [1]

        class OtherRecords:
            def items(self) -> list[int]:
                return [2]

        def items() -> list[int]:
            return [3]

        class Outer:
            class Inner:
                def items(self) -> list[int]:
                    return [4]
    `,
        "caller.py": `
        from pkg.records import LazyRecords
        result = LazyRecords().items()
    `,
    },
    async setup(ws) {
        const client = await ws.clientOf("python");
        const documentSymbols = client.documentSymbols.bind(client);
        ws.documentRequests = [];
        client.documentSymbols = async (path, text) => {
            ws.documentRequests.push(path);
            return documentSymbols(path, text);
        };
    },
};

for (const query of ["LazyRecords.items", "pkg.records.LazyRecords.items"]) {
    pythonScenario(`code_search_symbol resolves ${query} before references fan-out`, {
        given,
        when: ({ root, clientOf }) =>
            nav.symbol({ query, language: "python", include: ["references"] }, root, clientOf),
        then: [
            matches(/^# 3 matches for /m, "both overloads and implementation should fan out"),
            matches(/--- references ---[\s\S]*caller\.py:2:\d+/),
            notMatches(/# \d+ exact matches|ERROR:|OtherRecords|collections[/\\]/),
            (_response, ws) =>
                assert.deepEqual(
                    ws.documentRequests,
                    [resolve(ws.root, "pkg/records.py")],
                    "only the container's file should need a document-symbol request",
                ),
        ],
    });
}

pythonScenario("code_search_symbol resolves nested Python containers", {
    given,
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "Outer.Inner.items", language: "python" }, root, clientOf),
    then: [matches(/^\[python\] Method items  .*records\.py:19:13$/)],
});

pythonScenario(
    "code_search_symbol rejects an unknown Python container instead of returning bare-name hits",
    {
        given,
        when: ({ root, clientOf }) =>
            nav.symbol(
                { query: "Missing.items", language: "python", include: ["references"] },
                root,
                clientOf,
            ),
        then: [matches(/^\(no symbols matching "Missing.items"\)$/)],
    },
);
