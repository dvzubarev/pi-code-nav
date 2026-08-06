// End-to-end C++ reference scenarios through ccls.

import { nav, cppScenario } from "./cpp-helpers.mjs";
import { matches } from "./scenario.mjs";

cppScenario("code_references renders a complete multiline C++ call", {
    given: {
        files: {
            "refs.cpp": `
                int compute(int value) {
                  return value * 2;
                }

                int main() {
                  int result = compute(
                      21
                  );
                  return result;
                }
            `,
        },
    },
    when: ({ root, clientOf }) =>
        nav.references({ path: "refs.cpp", line: 1, column: 5 }, root, clientOf),
    then: [
        matches(/kind: declaration\n\n1 \| compute/),
        matches(/enclosing: compute  .*refs\.cpp:1:5/),
        matches(/enclosing: main  .*refs\.cpp:5:5/),
        matches(/kind: call\n\n6 \| compute\(\n7 \|       21\n8 \|   \)/, "multiline call missing"),
        matches(/# 2 references$/, "reference count missing"),
    ],
});
