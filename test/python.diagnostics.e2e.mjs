// End-to-end Python diagnostics scenarios through ty.

import { nav, pythonScenario } from "./python-helpers.mjs";
import { matches } from "./scenario.mjs";

pythonScenario("code_diagnostics reports a Python type error", {
    given: {
        fixtures: ["second.py"],
        files: { "bad.py": 'import second\nsecond.Point("not an int")' },
    },
    when: ({ root, clientOf }) => nav.diagnostics({ path: "bad.py" }, root, clientOf),
    then: [matches(/\d+ diagnostic\(s\) for bad\.py:/, "diagnostic header missing")],
});
