// Fresh-ccls indexing scenarios for code_search_symbol.

import { describe, before, after, test } from "node:test";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { compileCommands, nav, cppScenario } from "./cpp-helpers.mjs";
import { serverAvailable, SHOULD_RUN_E2E, withWorkspace } from "./e2e-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const cppOk = SHOULD_RUN_E2E ? await serverAvailable("cpp") : false;
const unavailable = skip || !cppOk;

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

// Real source: test/fixtures/functor.cpp, scraped from:
// https://mayankj08.github.io/2017/07/02/Functors-In-C++/
// Reproduce from the repository root:
//   tmp=$(mktemp -d); cp test/fixtures/functor.cpp "$tmp/"; CODE_NAV_ROOT="$tmp" node scripts/nav-cli.mjs symbol 'MyAddFunctor::operator()' cpp --info code; rm -rf "$tmp"
cppScenario("code_search_symbol expands a qualified C++ call operator", {
    given: {
        fixtures: ["functor.cpp"],
        files: { "build/compile_commands.json": compileCommands("functor.cpp") },
    },
    when: async ({ root, clientOf }) => {
        // Warm the real ccls index before exercising the qualified query. The
        // production call itself is tested by the fresh-index scenarios above;
        // this delay keeps the parser assertion independent of cold-index timing.
        await nav.symbol({ query: "MyAddFunctor", language: "cpp" }, root, clientOf);
        return nav.symbol(
            {
                query: "MyAddFunctor::operator()",
                language: "cpp",
                include: ["definition"],
            },
            root,
            clientOf,
        );
    },
    then: [
        matches(/^# 1 match for "MyAddFunctor::operator\(\)" — include: definition/m),
        matches(/\[cpp\] Method int MyAddFunctor::operator\(\)\(int y\)/),
        matches(/--- definition ---[\s\S]*int operator\(\)\(int y\) \{/),
    ],
});

// Shared blackjack workspace: ccls is started once and reused for all blackjack
// tests, avoiding repeated stdlib indexing.
const registerBlackjack = unavailable ? describe.skip : describe;
registerBlackjack("code_search_symbol C++ blackjack scenarios", () => {
    let ws;

    before(async () => {
        ws = await withWorkspace(["blackjack.cpp"]);
        // Write compile_commands.json with the fixture's relative path.
        const buildDir = resolve(ws.root, "build");
        await mkdir(buildDir, { recursive: true });
        await writeFile(
            resolve(buildDir, "compile_commands.json"),
            JSON.stringify(
                [
                    {
                        directory: ".",
                        command: "clang++ -std=c++17 -I. blackjack.cpp",
                        file: "blackjack.cpp",
                    },
                ],
                null,
                2,
            ),
            "utf8",
        );
        // Start ccls once; the first query waits for its index.
        await ws.clientOf("cpp");
    });

    after(async () => {
        await ws?.cleanup();
    });

    // Helper: run a symbol search against the shared blackjack workspace.
    const search = (params) => nav.symbol(params, ws.root, ws.clientOf);

    // Real source: test/fixtures/blackjack.cpp, scraped from:
    // https://gist.github.com/thebashpotato/704c4508cb859448f4233817b5e1249b
    // Reproduce from the repository root:
    //   CODE_NAV_ROOT="$PWD/test/fixtures" node scripts/nav-cli.mjs symbol 'blackjack::Deck::drawCard' cpp
    test("code_search_symbol finds a symbol in the cold index of a real C++ example", async () => {
        const response = await search({ query: "blackjack::Deck::drawCard", language: "cpp" });
        matches(/\[cpp\].*blackjack::Deck::drawCard/, "cold-index method missing")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT="$PWD/test/fixtures" node scripts/nav-cli.mjs symbol 'blackjack::Deck::drawCard' cpp --info code,hover,references
    test("code_search_symbol includes definition, hover, and references for a C++ method", async () => {
        await search({ query: "blackjack::Deck", language: "cpp" });
        const response = await search({
            query: "blackjack::Deck::drawCard",
            language: "cpp",
            include: ["definition", "hover", "references"],
        });
        matches(
            /^# 1 match for "blackjack::Deck::drawCard" — include: definition, hover, references/m,
        )(response);
        matches(/--- definition ---[\s\S]*return std::nullopt;/)(response);
        matches(/--- hover ---[\s\S]*signature: auto blackjack::Deck::drawCard\(\)/)(response);
        matches(/--- references ---[\s\S]*kind: call[\s\S]*deck\.drawCard\(\)/)(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT="$PWD/test/fixtures" node scripts/nav-cli.mjs symbol blackjack::Rank cpp --info code
    test("code_search_symbol returns the source declaration for a C++ enum", async () => {
        await search({ query: "blackjack::Rank", language: "cpp" });
        const response = await search({
            query: "blackjack::Rank",
            language: "cpp",
            include: ["definition"],
        });
        matches(/--- definition ---[\s\S]*enum class Rank : std::uint16_t \{[\s\S]*ACE = 1,[\s\S]*KING/)(
            response,
        );
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT="$PWD/test/fixtures" node scripts/nav-cli.mjs symbol blackjack::Deck::DealableCard cpp --info code
    test("code_search_symbol returns the source declaration for a C++ using alias", async () => {
        await search({ query: "blackjack::Deck", language: "cpp" });
        const response = await search({
            query: "blackjack::Deck::DealableCard",
            language: "cpp",
            include: ["definition"],
        });
        matches(/--- definition ---[\s\S]*using DealableCard = std::unique_ptr<Card>/)(response);
    });
});



// Reproduce from the repository root:
//   tmp=$(mktemp -d); cp test/fixtures/functor.cpp "$tmp/"; CODE_NAV_ROOT="$tmp" node scripts/nav-cli.mjs symbol MyAddFunctor cpp --kind struct; rm -rf "$tmp"
cppScenario(
    "code_search_symbol include=definition keeps comments before C++ class and method bodies",
    {
        given: {
            files: {
                "symbol-comments.cpp": `
                class SymbolCommentClass
                // comments before the symbol-search class body
                /* block comment before the symbol-search class body */
                {
                public:
                    int run()
                    /// comments before the symbol-search method body
                    /* block comment before the symbol-search method body */
                    {
                        // comment before the first symbol-search statement
                        return 22;
                    }
                };
                int main() { return 0; }
            `,
                "build/compile_commands.json": compileCommands("symbol-comments.cpp"),
            },
        },
        when: async ({ root, clientOf }) => ({
            classBody: await nav.symbol(
                { query: "SymbolCommentClass", language: "cpp", include: ["definition"] },
                root,
                clientOf,
            ),
            methodBody: await nav.symbol(
                { query: "SymbolCommentClass::run", language: "cpp", include: ["definition"] },
                root,
                clientOf,
            ),
        }),
        then: [
            ({ classBody, methodBody }) => {
                matches(
                    /^# 1 match for "SymbolCommentClass" — include: definition$/m,
                    "class match header is wrong",
                )(classBody);
                matches(/symbol-comments\.cpp:1-13/m, "class body range is wrong")(classBody);
                matches(
                    /^2 \| \/\/ comments before the symbol-search class body$/m,
                    "class line comment missing",
                )(classBody);
                matches(
                    /^3 \| \/\* block comment before the symbol-search class body \*\/$/m,
                    "class block comment missing",
                )(classBody);
                matches(
                    /^7 \|     \/\/\/ comments before the symbol-search method body$/m,
                    "method line comment missing",
                )(classBody);
                matches(/^11 \|         return 22;$/m, "class body method missing")(classBody);
                notMatches(/main\(\)/, "class definition leaked the following function")(classBody);

                matches(
                    /^# 1 match for "SymbolCommentClass::run" — include: definition$/m,
                    "method match header is wrong",
                )(methodBody);
                matches(/symbol-comments\.cpp:6-12/m, "method body range is wrong")(methodBody);
                matches(
                    /^7 \|     \/\/\/ comments before the symbol-search method body$/m,
                    "method line comment missing",
                )(methodBody);
                matches(
                    /^8 \|     \/\* block comment before the symbol-search method body \*\/$/m,
                    "method block comment missing",
                )(methodBody);
                matches(
                    /^10 \|         \/\/ comment before the first symbol-search statement$/m,
                    "method body comment missing",
                )(methodBody);
                matches(/^11 \|         return 22;$/m, "method body statement missing")(methodBody);
                notMatches(/class body|main\(\)/, "method definition leaked surrounding source")(methodBody);
            },
        ],
    },
);

cppScenario("code_search_symbol applies the public kinds filter to C++ classes and constructors", {
    given: { fixtures: ["functor.cpp"] },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "MyAddFunctor", language: "cpp", kinds: ["struct"] }, root, clientOf),
    then: [
        matches(/\[cpp\] Struct struct MyAddFunctor \{\}/),
        notMatches(/\[cpp\] Constructor MyAddFunctor::/, "constructor should be filtered out"),
    ],
});

// Reproduce from the repository root:
//   tmp=$(mktemp -d); cp test/fixtures/functor.cpp "$tmp/"; CODE_NAV_ROOT="$tmp" node scripts/nav-cli.mjs symbol MyAddFunctor cpp --regex 'MYADDFUNCTOR::MYADDFUNCTOR'; rm -rf "$tmp"
cppScenario("code_search_symbol applies a case-insensitive C++ name_pattern to full signatures", {
    given: { fixtures: ["functor.cpp"] },
    when: ({ root, clientOf }) =>
        nav.symbol(
            {
                query: "MyAddFunctor",
                language: "cpp",
                name_pattern: "MYADDFUNCTOR::MYADDFUNCTOR",
            },
            root,
            clientOf,
        ),
    then: [
        matches(/\[cpp\] Constructor MyAddFunctor::MyAddFunctor\(int inp\)/),
        notMatches(
            /\[cpp\] Struct struct MyAddFunctor/,
            "struct should not match the full-signature pattern",
        ),
    ],
});

// Reproduce from the repository root:
//   tmp=$(mktemp -d); cp test/fixtures/functor.cpp "$tmp/"; CODE_NAV_ROOT="$tmp" node scripts/nav-cli.mjs symbol MyAddFunctor; rm -rf "$tmp"
cppScenario("code_search_symbol detects C++ when language is omitted", {
    given: { fixtures: ["functor.cpp"] },
    when: ({ root, clientOf }) => nav.symbol({ query: "MyAddFunctor" }, root, clientOf),
    then: [matches(/\[cpp\].*MyAddFunctor/, "language autodetection missed the C++ symbol")],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures" node scripts/nav-cli.mjs symbol MyAddFunctor cpp --regex '['
cppScenario("code_search_symbol rejects an invalid public name_pattern", {
    given: { fixtures: ["functor.cpp"] },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "MyAddFunctor", language: "cpp", name_pattern: "[" }, root, clientOf),
    error: /Invalid name_pattern/,
});

// Real source: test/fixtures/blackjack.cpp, scraped from:
// https://gist.github.com/thebashpotato/704c4508cb859448f4233817b5e1249b

