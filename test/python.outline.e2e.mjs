// End-to-end Python outline scenarios through ty.

import assert from "node:assert/strict";
import { nav, pythonScenario } from "./python-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

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
