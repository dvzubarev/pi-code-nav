// End-to-end C++ reference scenarios through ccls.

import { nav, cppScenario } from "./cpp-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

// Reproduce from the repository root:
//   CODE_NAV_ROOT=test/fixtures node scripts/nav-cli.mjs references refs.cpp 1 5
cppScenario("code_references renders a complete multiline C++ call", {
    given: { fixtures: ["refs.cpp"] },
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

// Real source: test/fixtures/simple_xy_wr.cpp, scraped from:
// https://github.com/Unidata/netcdf-cxx4/blob/main/examples/simple_xy_wr.cpp
// Reproduce from the repository root:
//   CODE_NAV_ROOT=test/fixtures node scripts/nav-cli.mjs references simple_xy_wr.cpp 38 7 --context none
cppScenario("code_references supports the explicit none context on the scraped C++ example", {
    given: { fixtures: ["simple_xy_wr.cpp"] },
    when: ({ root, clientOf }) =>
        nav.references(
            { path: "simple_xy_wr.cpp", line: 38, column: 7, context: "none" },
            root,
            clientOf,
        ),
    then: [
        matches(/simple_xy_wr\.cpp:44:7/, "dataOut write reference missing"),
        matches(/simple_xy_wr\.cpp:69:19/, "dataOut read reference missing"),
        matches(/simple_xy_wr\.cpp:38:7/, "dataOut declaration missing"),
        notMatches(/kind:/, "none context should not render AST metadata"),
        matches(/# 3 references$/, "complete reference count missing"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT=test/fixtures node scripts/nav-cli.mjs references simple_xy_wr.cpp 38 7 --context syntax --offset 1 --limit 3
cppScenario("code_references supports syntax context with explicit pagination", {
    given: { fixtures: ["simple_xy_wr.cpp"] },
    when: ({ root, clientOf }) =>
        nav.references(
            {
                path: "simple_xy_wr.cpp",
                line: 38,
                column: 7,
                context: "syntax",
                offset: 1,
                limit: 3,
            },
            root,
            clientOf,
        ),
    then: [
        matches(/kind: write\n\n44 \| dataOut\[i\]\[j\] = i \* NY \+ j/),
        matches(
            /kind: read\n\n69 \| data\.putVar\(dataOut\)/,
            "read should include its complete containing expression",
        ),
        matches(/kind: declaration\n\n38 \| int dataOut\[NX\]\[NY\];/),
        matches(/# 3 references$/, "explicit limit should include the full page"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT=test/fixtures node scripts/nav-cli.mjs references simple_xy_wr.cpp 38 7 --context enclosing --offset 2 --limit 1
cppScenario("code_references supports enclosing context with a non-default offset and limit", {
    given: { fixtures: ["simple_xy_wr.cpp"] },
    when: ({ root, clientOf }) =>
        nav.references(
            {
                path: "simple_xy_wr.cpp",
                line: 38,
                column: 7,
                context: "enclosing",
                offset: 2,
                limit: 1,
            },
            root,
            clientOf,
        ),
    then: [
        matches(/kind: read\n\n69 \| data\.putVar\(dataOut\);/, "enclosing statement missing"),
        matches(/enclosing: main  .*simple_xy_wr\.cpp:34:5/),
        matches(/# showing references 2-2 of 3$/, "offset and limit pagination missing"),
    ],
});
