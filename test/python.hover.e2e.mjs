// End-to-end Python hover scenarios through ty.

import { nav, pythonScenario } from "./python-helpers.mjs";
import { matches } from "./scenario.mjs";

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
