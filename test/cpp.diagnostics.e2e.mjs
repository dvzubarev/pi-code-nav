// End-to-end C++ diagnostics scenarios through ccls.

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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

cppScenario("code_diagnostics rebuilds ccls's preamble after a header and source edit", {
    given: {
        files: {
            "worker.h": `
                #pragma once
                #include <cstddef>
                class Worker {
                  public:
                    std::size_t wait_any(int requests, bool *blocked = nullptr);
                };
            `,
            "worker.cpp": `
                #include "worker.h"
                std::size_t Worker::wait_any(int requests, bool *blocked) {
                    return requests + (blocked != nullptr);
                }
            `,
            "build/compile_commands.json": compileCommands("worker.cpp"),
        },
    },
    when: async ({ root, clientOf }) => {
        // Match the agent workflow that exposed the bug: inspect the header,
        // diagnose the source, edit both files on disk, then diagnose again.
        await nav.outline({ path: "worker.h" }, root, clientOf);
        const before = await nav.diagnostics({ path: "worker.cpp" }, root, clientOf);
        await writeFile(
            resolve(root, "worker.h"),
            "#pragma once\n#include <cstddef>\nclass Worker { public: std::size_t wait_any(int requests); };\n",
        );
        await writeFile(
            resolve(root, "worker.cpp"),
            '#include "worker.h"\nstd::size_t Worker::wait_any(int requests) { return requests; }\n',
        );
        const after = await nav.diagnostics({ path: "worker.cpp" }, root, clientOf);
        return { before, after };
    },
    then: [
        ({ before, after }) => {
            assert.match(before, /no diagnostics/, `expected clean initial source:\n${before}`);
            assert.match(
                after,
                /no diagnostics/,
                `stale ccls preamble produced an error:\n${after}`,
            );
            assert.doesNotMatch(after, /does not match any declaration/, after);
        },
    ],
});
