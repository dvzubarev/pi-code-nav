// Fresh-ccls indexing scenarios for code_search_symbol.

import { resolve } from "node:path";
import { nav, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { matches, scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const cppOk = SHOULD_RUN_E2E ? await serverAvailable("cpp") : false;
const unavailable = skip || !cppOk;

scenario("code_search_symbol waits for a fresh ccls whole-project index", {
    skip: unavailable,
    given: {
        files: {
            "alpha.cpp": "struct AlphaGadget { int value; };\nint main() { return 0; }",
            "beta.cpp": "struct BetaGadget { int value; };\nint main() { return 0; }",
            "gamma.cpp": "struct GammaGadget { int value; };\nint main() { return 0; }",
            "build/compile_commands.json": ({ root }) =>
                JSON.stringify(
                    ["alpha.cpp", "beta.cpp", "gamma.cpp"].map((file) => ({
                        directory: root,
                        command: `clang++ -std=c++17 ${file}`,
                        file: resolve(root, file),
                    })),
                    null,
                    2,
                ),
        },
    },
    // No document is opened before the first query. At least two results come
    // from translation units that the warm-up path did not open itself.
    when: async ({ root, clientOf }) => {
        const results = [];
        for (const symbol of ["AlphaGadget", "BetaGadget", "GammaGadget"]) {
            results.push({
                symbol,
                response: await nav.symbol({ query: symbol, language: "cpp" }, root, clientOf),
            });
        }
        return results;
    },
    then: [
        (results) => {
            for (const { symbol, response } of results) {
                matches(new RegExp(`\\[cpp\\].*${symbol}\\b`), `${symbol} missing`)(response);
            }
        },
    ],
});

scenario("code_search_symbol warms up fresh ccls without a compile database", {
    skip: unavailable,
    given: {
        files: {
            "sample.cpp": `
                struct Gadget {
                  int count;
                  void tick();
                };
                int main() { return 0; }
            `,
        },
    },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "Gadget", language: "cpp" }, root, clientOf),
    then: [matches(/\[cpp\].*Gadget/, "Gadget missing after warm-up")],
});
