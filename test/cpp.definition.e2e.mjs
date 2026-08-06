// End-to-end C++ definition scenarios through ccls.

import { nav, compileCommands, cppScenario } from "./cpp-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

cppScenario("code_definition on a C++ definition returns its body, not its header declaration", {
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

cppScenario("code_definition on a header-only C++ call includes its doc comment", {
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
