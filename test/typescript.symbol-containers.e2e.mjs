// The dotted strategy must also recover TypeScript class/namespace ancestry.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { nav, typescriptScenario } from "./typescript-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

const given = {
    files: {
        "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
        "noise.ts": "class AnotherRecords { items() { return [5]; } }",
        "records.ts": `
        class LazyRecords {
            items() { return [1]; }
        }
        class OtherRecords {
            items() { return [2]; }
        }
        function items() { return [3]; }
        namespace Outer {
            export class Inner {
                items() { return [4]; }
            }
        }
        const result = new LazyRecords().items();
    `,
    },
    async setup(ws) {
        const client = await ws.clientOf("typescript");
        const documentSymbols = client.documentSymbols.bind(client);
        ws.documentRequests = [];
        client.documentSymbols = async (path, text) => {
            ws.documentRequests.push(path);
            return documentSymbols(path, text);
        };
    },
};

for (const query of ["LazyRecords.items", "records.LazyRecords.items"]) {
    typescriptScenario(
        `code_search_symbol resolves ${query} before TypeScript references fan-out`,
        {
            given,
            when: ({ root, clientOf }) =>
                nav.symbol(
                    { query, language: "typescript", include: ["references"] },
                    root,
                    clientOf,
                ),
            then: [
                matches(/^# 1 match for /m),
                matches(/Method items  .*records\.ts:2:5/),
                matches(/--- references ---[\s\S]*records\.ts:13:\d+/),
                notMatches(/ERROR:|OtherRecords|# \d+ exact matches/),
                (_response, ws) =>
                    assert.deepEqual(
                        ws.documentRequests,
                        [resolve(ws.root, "records.ts")],
                        "the unrelated source file should not need document-symbol inspection",
                    ),
            ],
        },
    );
}

typescriptScenario("code_search_symbol resolves TypeScript namespace/class containers", {
    given,
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "Outer.Inner.items", language: "typescript" }, root, clientOf),
    then: [matches(/^\[typescript\] Method items  .*records\.ts:10:9$/)],
});
