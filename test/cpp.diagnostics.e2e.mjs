// End-to-end C++ diagnostics scenarios through ccls.

import { nav, compileCommands, cppScenario } from "./cpp-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

cppScenario("code_diagnostics reports a C++ type error after ccls indexing", {
    given: {
        files: {
            "bad.cpp": `
                int main() {
                    int x = "not an int";
                    return x;
                }
            `,
            "build/compile_commands.json": compileCommands("bad.cpp"),
        },
    },
    when: ({ root, clientOf }) => nav.diagnostics({ path: "bad.cpp" }, root, clientOf),
    then: [
        notMatches(
            /textDocument\/diagnostic request failed/,
            "pull error leaked instead of push fallback",
        ),
        matches(/\d+ diagnostic\(s\) for bad\.cpp:/, "diagnostic header missing"),
        matches(
            /(?:cannot initialize|no viable conversion|incompatible|not assignable)/i,
            "type mismatch missing",
        ),
    ],
});

cppScenario("code_diagnostics reports a clean C++ translation unit", {
    given: {
        files: {
            "good.cpp": "int main() { return 0; }",
            "build/compile_commands.json": compileCommands("good.cpp"),
        },
    },
    when: ({ root, clientOf }) => nav.diagnostics({ path: "good.cpp" }, root, clientOf),
    then: [matches(/no diagnostics for good\.cpp/, "expected no diagnostics")],
});
