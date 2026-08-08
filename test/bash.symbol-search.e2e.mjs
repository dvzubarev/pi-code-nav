// Scenario-style Bash code_search_symbol tests through bash-language-server.
// The fixture models a CI release deployment split between an entry point and
// sourced retry/logging libraries.

import { bashScenario, nav } from "./bash-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

const fixtures = [
    "symbol-search-bash/deploy.sh",
    "symbol-search-bash/lib/logging.sh",
    "symbol-search-bash/lib/retry.sh",
];

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-bash" node scripts/nav-cli.mjs symbol deploy_release
bashScenario("code_search_symbol auto-detects Bash and finds a deployment function", {
    given: { fixtures, workspaceRoot: "symbol-search-bash" },
    when: ({ root, clientOf }) => nav.symbol({ query: "deploy_release" }, root, clientOf),
    then: [
        matches(
            /^\[bash\] Function deploy_release  .*deploy\.sh:\d+:\d+$/m,
            "deployment entry point should be returned as a function",
        ),
        notMatches(/no symbols matching/, "the detected Bash workspace should be searchable"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-bash" node scripts/nav-cli.mjs symbol RETRY_MAX_ATTEMPTS bash
bashScenario("code_search_symbol accepts an explicit Bash language", {
    given: { fixtures, workspaceRoot: "symbol-search-bash" },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "RETRY_MAX_ATTEMPTS", language: "bash" }, root, clientOf),
    then: [
        matches(
            /^\[bash\] Variable RETRY_MAX_ATTEMPTS  .*lib[\\/]retry\.sh:\d+:\d+$/m,
            "retry policy variable should be returned with its declaration location",
        ),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-bash" node scripts/nav-cli.mjs symbol log_event bash --kinds function
bashScenario("code_search_symbol kinds filters Bash functions", {
    given: { fixtures, workspaceRoot: "symbol-search-bash" },
    when: ({ root, clientOf }) =>
        nav.symbol({ query: "log_event", language: "bash", kinds: ["function"] }, root, clientOf),
    then: [
        matches(/^\[bash\] Function log_event  .*lib[\\/]logging\.sh:/m),
        notMatches(/^\[bash\] Variable /m, "a function filter must not emit variables"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-bash" node scripts/nav-cli.mjs symbol log_info bash --name-pattern '^LOG_INFO$'
bashScenario("code_search_symbol name_pattern is case-insensitive for Bash names", {
    given: { fixtures, workspaceRoot: "symbol-search-bash" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            { query: "log_info", language: "bash", name_pattern: "^LOG_INFO$" },
            root,
            clientOf,
        ),
    then: [
        matches(/^\[bash\] Function log_info  .*lib[\\/]logging\.sh:/m),
        notMatches(/log_event/, "the anchored name pattern must exclude neighboring functions"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-bash" node scripts/nav-cli.mjs symbol deploy_release bash --include definition,hover,references --list-symbols
bashScenario("code_search_symbol includes Bash definition, hover, and references", {
    given: { fixtures, workspaceRoot: "symbol-search-bash" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            {
                query: "deploy_release",
                language: "bash",
                include: ["definition", "hover", "references"],
                list_symbols: true,
            },
            root,
            clientOf,
        ),
    then: [
        matches(
            /^# 1 match for "deploy_release" — include: definition, hover, references$/m,
            "all requested detail sections should fan out for one exact function",
        ),
        matches(/--- definition ---[\s\S]*deploy_release\(\)/, "function definition is missing"),
        matches(/--- hover ---/, "hover section is missing"),
        matches(/--- references ---/, "references section is missing"),
        matches(
            /symbols: .*deploy_release@\d+ \w+/,
            "definition/reference symbol metadata is missing",
        ),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-bash" node scripts/nav-cli.mjs symbol log_event bash --kinds function --name-pattern '^LOG_.*' --include hover
bashScenario("code_search_symbol combines Bash filters with include", {
    given: { fixtures, workspaceRoot: "symbol-search-bash" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            {
                query: "log_event",
                language: "bash",
                kinds: ["function"],
                name_pattern: "^LOG_.*",
                include: ["hover"],
            },
            root,
            clientOf,
        ),
    then: [
        matches(/^# 1 match for "log_event" — include: hover$/m),
        matches(/== \[1\] \[bash\] Function log_event /, "filtered function should fan out"),
        matches(/--- hover ---/, "filtered hover section is missing"),
        notMatches(/log_info/, "the query should not fan out a neighboring function"),
    ],
});

// Reproduce from the repository root:
//   CODE_NAV_ROOT="$PWD/test/fixtures/symbol-search-bash" node scripts/nav-cli.mjs symbol deploy_release bash --name-pattern '['
bashScenario("code_search_symbol rejects an invalid Bash name_pattern", {
    given: { fixtures, workspaceRoot: "symbol-search-bash" },
    when: ({ root, clientOf }) =>
        nav.symbol(
            { query: "deploy_release", language: "bash", name_pattern: "[" },
            root,
            clientOf,
        ),
    error: /Invalid name_pattern/,
});
