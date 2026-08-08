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

cppScenario("code_definition keeps comments before C++ class, method, and function bodies", {
    given: {
        files: {
            "definition-comments.cpp": `
                class DefinitionCommentClass
                // comments before the class body
                /* block comment before the class body */
                {
                public:
                    int run()
                    /// comments before the method body
                    /* block comment before the method body */
                    {
                        /** comments before the first method statement */
                        return 7;
                    }
                };

                int definitionCommentFunction()
                // comments before the free-function body
                /* block comment before the free-function body */
                {
                    // comment before the first free-function statement
                    return 11;
                }
            `,
            "build/compile_commands.json": compileCommands("definition-comments.cpp"),
        },
    },
    when: async ({ root, clientOf }) => ({
        classBody: await nav.definition(
            { path: "definition-comments.cpp", line: 1, column: 7 },
            root,
            clientOf,
        ),
        methodBody: await nav.definition(
            { path: "definition-comments.cpp", line: 6, column: 9 },
            root,
            clientOf,
        ),
        functionBody: await nav.definition(
            { path: "definition-comments.cpp", line: 15, column: 5 },
            root,
            clientOf,
        ),
    }),
    then: [
        ({ classBody, methodBody, functionBody }) => {
            matches(
                /(^|\/)definition-comments\.cpp:1-13$/m,
                "class body range is wrong",
            )(classBody);
            matches(
                /^2 \| \/\/ comments before the class body$/m,
                "class line comment missing",
            )(classBody);
            matches(
                /^3 \| \/\* block comment before the class body \*\/$/m,
                "class block comment missing",
            )(classBody);
            matches(
                /^7 \|     \/\/\/ comments before the method body$/m,
                "method line comment missing",
            )(classBody);
            matches(
                /^8 \|     \/\* block comment before the method body \*\/$/m,
                "method block comment missing",
            )(classBody);
            matches(/^11 \|         return 7;$/m, "class body method missing")(classBody);
            notMatches(/free-function body/, "class body leaked the following function")(classBody);

            matches(
                /(^|\/)definition-comments\.cpp:6-12$/m,
                "method body range is wrong",
            )(methodBody);
            matches(
                /^7 \|     \/\/\/ comments before the method body$/m,
                "method line comment missing",
            )(methodBody);
            matches(
                /^8 \|     \/\* block comment before the method body \*\/$/m,
                "method block comment missing",
            )(methodBody);
            matches(/^9 \|     \{\s*$/m, "method opening brace missing")(methodBody);
            matches(
                /^10 \|         \/\*\* comments before the first method statement \*\/$/m,
                "method body comment missing",
            )(methodBody);
            matches(/^11 \|         return 7;$/m, "method body statement missing")(methodBody);
            notMatches(/class body/, "method body leaked the enclosing class prefix")(methodBody);
            notMatches(
                /free-function body/,
                "method body leaked the following function",
            )(methodBody);

            matches(
                /(^|\/)definition-comments\.cpp:15-21$/m,
                "function body range is wrong",
            )(functionBody);
            matches(
                /^16 \| \/\/ comments before the free-function body$/m,
                "function line comment missing",
            )(functionBody);
            matches(
                /^17 \| \/\* block comment before the free-function body \*\/$/m,
                "function block comment missing",
            )(functionBody);
            matches(
                /^19 \|     \/\/ comment before the first free-function statement$/m,
                "function body comment missing",
            )(functionBody);
            matches(/^20 \|     return 11;$/m, "function body statement missing")(functionBody);
            notMatches(
                /class body|method body/,
                "function body leaked the preceding class",
            )(functionBody);
        },
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
