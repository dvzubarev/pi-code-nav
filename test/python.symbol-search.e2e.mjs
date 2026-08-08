// Scenario-style Python code_search_symbol tests through ty.
// The fixture is a small commerce package with domain, API, and payment layers.

import assert from "node:assert/strict";
import { nav, pythonScenario } from "./python-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

const fixtures = [
    "symbol-search-python/pyproject.toml",
    "symbol-search-python/commerce/__init__.py",
    "symbol-search-python/commerce/domain.py",
    "symbol-search-python/commerce/payments.py",
    "symbol-search-python/commerce/api.py",
];

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-python" node scripts/nav-cli.mjs symbol CheckoutService
pythonScenario("code_search_symbol auto-detects Python in a multi-module service", {
    given: { fixtures },
    when: ({ root, clientOf }) => nav.symbol({ query: "CheckoutService" }, root, clientOf),
    then: [
        matches(
            /\[python\] Class CheckoutService  .*commerce[\\/]payments\.py:\d+:\d+/,
            "service class missing",
        ),
        notMatches(/\(no symbols matching/, "workspace symbol should be found"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-python" node scripts/nav-cli.mjs symbol commerce.domain.Invoice python
pythonScenario("code_search_symbol resolves a qualified workspace module symbol", {
    given: { fixtures },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "commerce.domain.Invoice", language: "python" }, root, clientOf),
    then: [
        matches(
            /\[python\] Class Invoice  .*commerce[\\/]domain\.py:\d+:\d+/,
            "qualified workspace class missing",
        ),
        notMatches(/\[python\] Class LineItem/, "qualified search leaked a sibling class"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-python" node scripts/nav-cli.mjs symbol calculate_invoice python --info code,hover,references
pythonScenario("code_search_symbol includes all detail sections and symbol metadata", {
    given: { fixtures },
    when: ({ root, clientOf }) =>
        nav.symbol(
            {
                query: "calculate_invoice",
                language: "python",
                include: ["definition", "hover", "references"],
                list_symbols: true,
            },
            root,
            clientOf,
        ),
    then: [
        matches(/^# 1 match for "calculate_invoice" — include: definition, hover, references$/m),
        matches(/--- definition ---[\s\S]*def calculate_invoice\(/, "definition section missing"),
        matches(/symbols: calculate_invoice@\d+ var/, "definition symbol metadata missing"),
        matches(/--- hover ---[\s\S]*signature: def calculate_invoice/, "hover section missing"),
        matches(/--- references ---[\s\S]*kind: call/, "reference section missing"),
        matches(/calculate_invoice@\d+ call/, "reference symbol metadata missing"),
        matches(/commerce[\\/]payments\.py:\d+:\d+/, "cross-module call reference missing"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-python" node scripts/nav-cli.mjs symbol serialize python --kind method
pythonScenario("code_search_symbol kinds selects a method from competing Python symbols", {
    given: { fixtures },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "serialize", language: "python", kinds: ["method"] }, root, clientOf),
    then: [
        matches(/^\[python\] Method serialize  .*commerce[\\/]domain\.py:\d+:\d+$/m),
        notMatches(/^\[python\] Function serialize  /m, "function should be filtered out"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-python" node scripts/nav-cli.mjs symbol serialize python --regex '^SERIALIZE$'
pythonScenario("code_search_symbol name_pattern is case-insensitive over Python names", {
    given: { fixtures },
    when: ({ root, clientOf }) =>
        nav.symbol(
            { query: "serialize", language: "python", name_pattern: "^SERIALIZE$" },
            root,
            clientOf,
        ),
    then: [
        (response) => {
            const rows = response.split("\n").filter((line) => line.startsWith("[python]"));
            assert.equal(rows.length, 2, `both exact serialize symbols should match:\n${response}`);
        },
        matches(/\[python\] Function serialize  .*commerce[\\/]api\.py:/),
        matches(/\[python\] Method serialize  .*commerce[\\/]domain\.py:/),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-python" node scripts/nav-cli.mjs symbol serialize python --kind method --regex '^SERIALIZE$' --info code
pythonScenario("code_search_symbol applies kinds and name_pattern before include fan-out", {
    given: { fixtures },
    when: ({ root, clientOf }) =>
        nav.symbol(
            {
                query: "serialize",
                language: "python",
                kinds: ["method"],
                name_pattern: "^SERIALIZE$",
                include: ["definition"],
            },
            root,
            clientOf,
        ),
    then: [
        matches(/^# 1 match for "serialize" — include: definition$/m),
        matches(/== \[1\] \[python\] Method serialize  .*commerce[\\/]domain\.py:/),
        matches(/--- definition ---[\s\S]*def serialize\(/),
        notMatches(/Function serialize/, "filtered function should not fan out"),
    ],
});
