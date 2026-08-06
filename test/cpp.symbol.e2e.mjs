// Fresh-ccls indexing scenarios for code_search_symbol.

import { resolve } from "node:path";
import { nav, cppScenario } from "./cpp-helpers.mjs";
import { matches } from "./scenario.mjs";

cppScenario("code_search_symbol waits for a fresh ccls whole-project index", {
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

cppScenario("code_search_symbol warms up fresh ccls without a compile database", {
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
    when: ({ root, clientOf }) => nav.symbol({ query: "Gadget", language: "cpp" }, root, clientOf),
    then: [matches(/\[cpp\].*Gadget/, "Gadget missing after warm-up")],
});
