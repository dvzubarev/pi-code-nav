// End-to-end C++ tests through ccls. Skipped when ccls is unavailable.

import { resolve } from "node:path";
import { nav, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { matches, notMatches, scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const cppOk = SHOULD_RUN_E2E ? await serverAvailable("cpp") : false;
const unavailable = skip || !cppOk;

const compileCommands =
    (source) =>
    ({ root }) =>
        JSON.stringify([
            {
                directory: root,
                command: `clang++ -std=c++17 -I. ${source}`,
                file: resolve(root, source),
            },
        ]);

scenario("code_outline renders C++ structural symbols and ccls signatures", {
    skip: unavailable,
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

scenario("code_references renders a complete multiline C++ call", {
    skip: unavailable,
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

scenario("code_diagnostics reports a C++ type error after ccls indexing", {
    skip: unavailable,
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

scenario("code_diagnostics reports a clean C++ translation unit", {
    skip: unavailable,
    given: {
        files: {
            "good.cpp": "int main() { return 0; }",
            "build/compile_commands.json": compileCommands("good.cpp"),
        },
    },
    when: ({ root, clientOf }) => nav.diagnostics({ path: "good.cpp" }, root, clientOf),
    then: [matches(/no diagnostics for good\.cpp/, "expected no diagnostics")],
});

scenario("code_definition on a C++ definition returns its body, not its header declaration", {
    skip: unavailable,
    given: {
        files: {
            "fbin_file.h": `
                #pragma once

                namespace diskann{
                struct fbin_file_t{
                    const char* path;
                private:
                    void assign(const fbin_file_t& f);
                };
                }
            `,
            "fbin_file.cpp": `
                #include "fbin_file.h"

                namespace diskann{


                void fbin_file_t::assign(const fbin_file_t& f){
                    path = f.path;
                }
                }
            `,
            "build/compile_commands.json": compileCommands("fbin_file.cpp"),
        },
    },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "fbin_file.cpp", line: 6, column: 19 }, root, clientOf),
    then: [
        matches(/(^|\/)fbin_file\.cpp:6-\d+$/m, "should return the cpp body"),
        matches(/void fbin_file_t::assign/, "cpp definition missing"),
        matches(/path = f\.path/, "cpp body statement missing"),
        notMatches(/void assign\(const fbin_file_t& f\);/, "header declaration was returned"),
    ],
});

scenario("code_definition on a header-only C++ call includes its doc comment", {
    skip: unavailable,
    given: {
        files: {
            "thirdparty.h": `
                #pragma once

                /** this is doc string for this function
                 *  line two of the doc string
                 *  line three of the doc string
                 */
                void thirdparty_func(const unsigned int location, int* pool, int pool_size);
            `,
            "main.cpp": `
                #include "thirdparty.h"

                int main(){
                    int pool[10];
                    thirdparty_func(0u, pool, 10);
                    return 0;
                }
            `,
            "build/compile_commands.json": compileCommands("main.cpp"),
        },
    },
    when: ({ root, clientOf }) =>
        nav.definition({ path: "main.cpp", line: 5, column: 5 }, root, clientOf),
    then: [
        matches(/(^|\/)thirdparty\.h:3-7$/m, "header should include doc-comment range"),
        matches(/\/\*\* this is doc string for this function/, "doc comment opener missing"),
        matches(/line three of the doc string/, "doc comment body missing"),
        matches(
            /void thirdparty_func\(const unsigned int location, int\* pool, int pool_size\);/,
            "prototype missing",
        ),
    ],
});
