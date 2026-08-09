// End-to-end Python definition scenarios through ty.

import { nav, pythonScenario } from "./python-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

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

pythonScenario("code_definition renders numbered source with line-local symbols", {
    given: { fixtures: ["defs.py"] },
    when: ({ root, clientOf }) =>
        nav.definition(
            {
                path: "defs.py",
                line: 43,
                column: 9,
                list_symbols: ["call"],
            },
            root,
            clientOf,
        ),
    then: [
        matches(/^43 \|     def config\(self\):$/m),
        matches(/^44 \|         return make_config\(\)$/m),
        matches(/^   \| symbols: make_config@16 call$/m),
        notMatches(/self@\d+ var/, "unrequested vars should not be rendered"),
        notMatches(/Symbols in /, "detached symbol table should not be rendered"),
    ],
});

pythonScenario("code_definition follows a constructor call to its class", {
    given: { fixtures: ["defs.py"] },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "defs.py", line: 48, column: 9 }, root, clientOf),
    then: [matches(/^.*defs\.py:33-\d+$/m), matches(/class Greeter/)],
});
