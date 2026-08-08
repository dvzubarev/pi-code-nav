// Scenario-style TypeScript code_search_symbol tests through
// typescript-language-server. The fixture models a checkout service split
// between a billing domain and an API layer, with duplicate names across
// modules and real cross-module calls.

import { nav, typescriptScenario } from "./typescript-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

const fixtures = [
    "symbol-search-typescript/package.json",
    "symbol-search-typescript/tsconfig.json",
    "symbol-search-typescript/billing/invoice.ts",
    "symbol-search-typescript/api/serializers.ts",
    "symbol-search-typescript/api/checkout.ts",
];

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-typescript" node scripts/nav-cli.mjs symbol CheckoutService
// The omitted language exercises project detection rather than the CLI's
// positional language argument.
typescriptScenario("code_search_symbol auto-detects TypeScript in a checkout service", {
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) => nav.symbol({ query: "CheckoutService" }, root, clientOf),
    then: [
        matches(
            /\[typescript\] Class CheckoutService  .*api[\\/]checkout\.ts:\d+:\d+/,
            "workspace class missing",
        ),
        notMatches(/no symbols matching/, "the detected TypeScript project should be searchable"),
    ],
});

// The bootstrap scan opens api/checkout.ts first. InvoiceLedger exists only in
// billing/invoice.ts, so this catches the cold-project race where didOpen was
// followed by workspace/symbol before tsserver finished loading the tsconfig.
typescriptScenario("code_search_symbol waits for a cold TypeScript project to load", {
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "InvoiceLedger", language: "typescript" }, root, clientOf),
    then: [
        matches(
            /\[typescript\] Class InvoiceLedger  .*billing[\\/]invoice\.ts:\d+:\d+/,
            "symbol from an unopened project file missing",
        ),
        notMatches(/api[\\/]checkout\.ts/, "an import binding was returned instead of the declaration"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-typescript" node scripts/nav-cli.mjs symbol billing.invoice.Invoice typescript
// The qualified query should select the domain interface, not another exact
// name from the API module.
typescriptScenario("code_search_symbol resolves a qualified TypeScript module symbol", {
    // TODO: re-enable when workspace/symbol stops returning the imported
    // binding instead of the declaration from the qualified module.
    skip: true,
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "billing.invoice.Invoice", language: "typescript" }, root, clientOf),
    then: [
        matches(
            /\[typescript\] Interface Invoice  .*billing[\\/]invoice\.ts:\d+:\d+/,
            "qualified domain interface missing",
        ),
        notMatches(/InvoicePayload/, "qualified search leaked the API payload type"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-typescript" node scripts/nav-cli.mjs symbol calculateInvoiceTotal typescript --include definition,hover,references
// The CLI uses the same public include names; list_symbols has no CLI alias.
typescriptScenario("code_search_symbol includes definition, hover, and references", {
    // TODO: re-enable when symbol search resolves the declaration rather than
    // an import binding before include fan-out.
    skip: true,
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            {
                query: "calculateInvoiceTotal",
                language: "typescript",
                include: ["definition", "hover", "references"],
                list_symbols: true,
            },
            root,
            clientOf,
        ),
    then: [
        matches(
            /^# 1 match for "calculateInvoiceTotal" — include: definition, hover, references$/m,
            "include header missing",
        ),
        matches(/--- definition ---[\\s\\S]*function calculateInvoiceTotal/, "definition missing"),
        matches(/--- hover ---[\\s\\S]*signature:/, "hover section missing"),
        matches(/--- references ---[\\s\\S]*billing[\\/]invoice\.ts:\d+:\d+/, "references missing"),
        matches(/symbols: .*calculateInvoiceTotal@\d+ \w+/, "list_symbols metadata missing"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-typescript" node scripts/nav-cli.mjs symbol serialize typescript --kinds method
// The public kinds parameter must distinguish class methods from the
// same-named module-level serializer functions.
typescriptScenario("code_search_symbol kinds selects TypeScript methods", {
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            { query: "serialize", language: "typescript", kinds: ["method"] },
            root,
            clientOf,
        ),
    then: [
        matches(
            /^\[typescript\] Method serialize  .*api[\\/]checkout\.ts:\d+:\d+$/m,
            "checkout method missing",
        ),
        notMatches(
            /^\[typescript\] Function serialize  /m,
            "module-level functions should be filtered",
        ),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-typescript" node scripts/nav-cli.mjs symbol serialize typescript --name-pattern '^SERIALIZE$'
// name_pattern is applied case-insensitively to the rendered TypeScript name.
typescriptScenario("code_search_symbol name_pattern matches TypeScript names case-insensitively", {
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            { query: "serialize", language: "typescript", name_pattern: "^SERIALIZE$" },
            root,
            clientOf,
        ),
    then: [
        matches(
            /^\[typescript\] Function serialize  .*api[\\/]checkout\.ts:/m,
            "checkout function missing",
        ),
        matches(
            /^\[typescript\] Method serialize  .*api[\\/]checkout\.ts:/m,
            "checkout method missing",
        ),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-typescript" node scripts/nav-cli.mjs symbol serialize typescript --kinds method --name-pattern '^SERIALIZE$' --include definition
// Filters run before include fan-out, so only the three exact methods receive
// definition sections and the functions do not leak into the response.
typescriptScenario("code_search_symbol combines kinds, name_pattern, and include", {
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            {
                query: "serialize",
                language: "typescript",
                kinds: ["method"],
                name_pattern: "^SERIALIZE$",
                include: ["definition"],
                list_symbols: true,
            },
            root,
            clientOf,
        ),
    then: [
        matches(
            /^# 3 matches for "serialize" — include: definition$/m,
            "filtered fan-out count missing",
        ),
        matches(/== \[1\] \[typescript\] Method serialize /, "method fan-out missing"),
        matches(/--- definition ---/, "definition sections missing"),
        matches(/symbols: .*serialize@\d+ \w+/, "list_symbols metadata missing"),
        notMatches(/Function serialize/, "filtered functions should not fan out"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-typescript" node scripts/nav-cli.mjs symbol serialize typescript --name-pattern '['
// Invalid public name_pattern values are hard errors rather than empty search
// results, matching the tool contract.
typescriptScenario("code_search_symbol rejects an invalid TypeScript name_pattern", {
    given: { fixtures, workspaceRoot: "symbol-search-typescript" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            { query: "serialize", language: "typescript", name_pattern: "[" },
            root,
            clientOf,
        ),
    error: /Invalid name_pattern/,
});
