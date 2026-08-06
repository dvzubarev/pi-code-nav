// End-to-end Python reference scenarios through ty.

import assert from "node:assert/strict";
import { nav, pythonScenario } from "./python-helpers.mjs";

pythonScenario("code_references adds Python roles, source, and enclosing symbols", {
    given: { fixtures: ["second.py"] },
    when: async ({ root, clientOf }) => ({
        direct: await nav.references({ path: "second.py", line: 10, column: 7 }, root, clientOf),
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
