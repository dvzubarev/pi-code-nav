// End-to-end C++ outline scenarios through ccls.

import { nav, cppScenario } from "./cpp-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

cppScenario("code_outline renders C++ structural symbols and ccls signatures", {
    given: {
        files: {
            "sample.cpp": `
                constexpr int MAX = 64;
                struct Widget {
                  int field;
                  void method();
                };
                int main() { return 0; }
            `,
        },
    },
    when: ({ root, clientOf }) => nav.outline({ path: "sample.cpp" }, root, clientOf),
    then: [
        notMatches(/MAX/, "constants are not structural outline entries"),
        notMatches(/Field field/, "fields are not structural outline entries"),
        matches(/^Function main  .*\.cpp:\d+:\d+  range=\d+-\d+$/m, "main header missing"),
        matches(/^  signature: int main\(\)$/m, "main signature missing"),
        matches(/^  Method method  .*\.cpp:\d+:\d+  range=\d+-\d+$/m, "method header missing"),
        matches(/^    signature: void Widget::method\(\)$/m, "method signature missing"),
        matches(/^Struct Widget  .*\.cpp:\d+:\d+  range=\d+-\d+$/m, "Widget header missing"),
        matches(/^  signature: struct Widget \{\}$/m, "Widget signature missing"),
    ],
});
