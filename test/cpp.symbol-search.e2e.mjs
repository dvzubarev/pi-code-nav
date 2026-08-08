// End-to-end C++ code_search_symbol scenarios through ccls.
//
// Tests various symbol search scenarios with complex C++ code featuring:
// - Templates (Result<T>, IntrusiveList<T>, PoolAllocator<T>)
// - Nested namespaces (engine::math, engine::physics, data, util)
// - Overloaded functions (toString)
// - Nested classes (RigidBody::State, RigidBody::Properties)
// - Operator overloading (Vec3::operator+, operator*, operator==)
// - Inheritance hierarchy (Entity -> GameObject -> Character -> Player)
// - Enums (LogLevel, OutputFormat, RigidBody::State)
// - Using aliases (CollisionCallback, DealableCard)
// - Anonymous namespaces
// - Lambda factories
//
// All tests share a single ccls instance to avoid re-parsing the fixture
// and C++ stdlib for every test case.

import { describe, before, after, test } from "node:test";
import { nav } from "./cpp-helpers.mjs";
import { serverAvailable, SHOULD_RUN_E2E, withSharedWorkspace } from "./e2e-helpers.mjs";
import { matches, notMatches } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const cppOk = SHOULD_RUN_E2E ? await serverAvailable("cpp") : false;
const unavailable = skip || !cppOk;

// Shared workspace: ccls is started once and reused for all tests in this file.
const register = unavailable ? describe.skip : describe;
register("code_search_symbol C++ scenarios", () => {
    let ws;

    before(async () => {
        ws = await withSharedWorkspace(
            ["symbol-search/symbol_search.cpp", "symbol-search/build/compile_commands.json"],
            "symbol-search",
        );
    });

    after(async () => {
        await ws?.cleanup();
    });

    // Helper: run a symbol search against the shared workspace.
    const search = (params) => nav.symbol(params, ws.root, ws.clientOf);

    // ─── Bare name searches ────────────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Vec3 cpp
    test("code_search_symbol finds a struct by bare name", async () => {
        const response = await search({ query: "Vec3", language: "cpp" });
        matches(/\[cpp\].*Vec3/, "Vec3 struct not found")(response);
        matches(/Struct/, "should be identified as a struct")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol length cpp
    test("code_search_symbol finds a method by bare name", async () => {
        const response = await search({ query: "length", language: "cpp" });
        matches(/\[cpp\].*length/, "length method not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol toString cpp
    test("code_search_symbol finds overloaded functions by bare name", async () => {
        const response = await search({ query: "toString", language: "cpp" });
        // Multiple toString overloads should appear
        matches(
            /\[cpp\] Function std::string engine::util::toString\(int value\)/,
            "int overload missing",
        )(response);
        matches(
            /\[cpp\] Function std::string engine::util::toString\(float value\)/,
            "float overload missing",
        )(response);
        matches(
            /\[cpp\] Function std::string engine::util::toString\(bool value\)/,
            "bool overload missing",
        )(response);
        matches(
            /\[cpp\] Function std::string engine::util::toString\(const math::Vec3 &vec\)/,
            "Vec3 overload missing",
        )(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Player cpp
    test("code_search_symbol finds a class in inheritance hierarchy", async () => {
        const response = await search({ query: "Player", language: "cpp" });
        matches(/\[cpp\].*Player/, "Player class not found")(response);
        matches(/Class/, "should be identified as a class")(response);
    });

    // ─── Qualified name searches ───────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'engine::math::Vec3' cpp
    test("code_search_symbol finds a symbol via fully qualified namespace path", async () => {
        const response = await search({ query: "engine::math::Vec3", language: "cpp" });
        matches(/\[cpp\].*engine::math::Vec3/, "qualified Vec3 not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'engine::physics::RigidBody' cpp
    test("code_search_symbol finds a class via partial namespace qualification", async () => {
        const response = await search({ query: "engine::physics::RigidBody", language: "cpp" });
        matches(/\[cpp\].*engine::physics::RigidBody/, "qualified RigidBody not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'RigidBody::State' cpp
    test("code_search_symbol finds a nested enum class via class qualification", async () => {
        const response = await search({ query: "RigidBody::State", language: "cpp" });
        matches(/\[cpp\].*RigidBody::State/, "nested enum State not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'engine::math::dot' cpp
    test("code_search_symbol finds a free function in a namespace", async () => {
        const response = await search({ query: "engine::math::dot", language: "cpp" });
        matches(/\[cpp\].*engine::math::dot/, "dot product function not found")(response);
    });

    // ─── Template symbol searches ──────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Result cpp
    test("code_search_symbol finds a class template", async () => {
        const response = await search({ query: "Result", language: "cpp" });
        matches(/\[cpp\].*Result/, "Result template not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'data::Result' cpp
    test("code_search_symbol finds a template via namespace qualification", async () => {
        const response = await search({ query: "data::Result", language: "cpp" });
        matches(/\[cpp\].*data::Result/, "qualified Result template not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol IntrusiveList cpp
    test("code_search_symbol finds a template with non-type parameters", async () => {
        const response = await search({ query: "IntrusiveList", language: "cpp" });
        matches(/\[cpp\].*IntrusiveList/, "IntrusiveList template not found")(response);
    });

    // ─── Include parameter tests ───────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Vec3 cpp --info code
    test("code_search_symbol with include=definition returns source code", async () => {
        const response = await search({
            query: "Vec3",
            language: "cpp",
            include: ["definition"],
        });
        matches(/--- definition ---/, "definition section header missing")(response);
        matches(/struct Vec3 \{/, "struct definition body missing")(response);
        matches(/float x, y, z;/, "member declaration missing")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Vec3 cpp --info hover
    test("code_search_symbol with include=hover returns signature and docs", async () => {
        const response = await search({
            query: "Vec3",
            language: "cpp",
            include: ["hover"],
        });
        matches(/--- hover ---/, "hover section header missing")(response);
        matches(/signature:/, "signature line missing")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Vec3 cpp --info references
    test("code_search_symbol with include=references returns usages", async () => {
        const response = await search({
            query: "Vec3",
            language: "cpp",
            include: ["references"],
        });
        matches(/--- references ---/, "references section header missing")(response);
        matches(/# \d+ references/, "reference count missing")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Vec3 cpp --info code,hover,references
    test("code_search_symbol with multiple include options returns all sections", async () => {
        const response = await search({
            query: "Vec3",
            language: "cpp",
            include: ["definition", "hover", "references"],
        });
        matches(/--- definition ---/, "definition section missing")(response);
        matches(/--- hover ---/, "hover section missing")(response);
        matches(/--- references ---/, "references section missing")(response);
    });

    // ─── list_symbols parameter tests ──────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Vec3 cpp --info code --list-symbols
    test("code_search_symbol with list_symbols adds metadata to definitions", async () => {
        const response = await search({
            query: "Vec3",
            language: "cpp",
            include: ["definition"],
            list_symbols: true,
        });
        matches(/--- definition ---/, "definition section missing")(response);
        // list_symbols should add role metadata like "Vec3@1 type"
        matches(/\w+@\d+ \w+/, "symbol role metadata missing")(response);
    });

    // ─── kinds filter tests ────────────────────────────────────────────────

    // `kinds` filters symbols matching the query; it does not reinterpret the
    // matched class as a container and search its descendants.
    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol RigidBody cpp --kind enum
    test("code_search_symbol kinds filter does not search inside a matching class", async () => {
        const response = await search({
            query: "RigidBody",
            language: "cpp",
            kinds: ["enum"],
        });
        matches(
            /^\(no symbols matching "RigidBody"\)$/,
            "the RigidBody class should be removed by the enum filter",
        )(response);
        notMatches(/RigidBody::State/, "the filter should not return nested enum members")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol State cpp --kind enum
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol State cpp --kind class
    test("code_search_symbol enum kinds filter accepts enums and rejects them as classes", async () => {
        const accepted = await search({ query: "State", language: "cpp", kinds: ["enum"] });
        const rejected = await search({ query: "State", language: "cpp", kinds: ["class"] });
        matches(/\[cpp\] Enum .*RigidBody::State/, "enum should pass the enum filter")(accepted);
        matches(/^\(no symbols matching "State"\)$/, "enum should fail the class filter")(
            rejected,
        );
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'RigidBody::State' cpp --kind enum
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'RigidBody::State' cpp --kind class
    test("code_search_symbol kinds filter works with a qualified name", async () => {
        const accepted = await search({
            query: "RigidBody::State",
            language: "cpp",
            kinds: ["enum"],
        });
        const rejected = await search({
            query: "RigidBody::State",
            language: "cpp",
            kinds: ["class"],
        });
        matches(/\[cpp\] Enum .*RigidBody::State/, "qualified enum should pass")(accepted);
        matches(
            /^\(no symbols matching "RigidBody::State"\)$/,
            "qualified enum should fail the class filter",
        )(rejected);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol toString cpp --kind function
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol toString cpp --kind method
    test("code_search_symbol function kinds filter accepts functions and rejects them as methods", async () => {
        const accepted = await search({
            query: "toString",
            language: "cpp",
            kinds: ["function"],
        });
        const rejected = await search({
            query: "toString",
            language: "cpp",
            kinds: ["method"],
        });
        matches(/\[cpp\] Function .*toString\(int value\)/, "function should pass")(accepted);
        matches(/^\(no symbols matching "toString"\)$/, "functions should fail the method filter")(
            rejected,
        );
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getState cpp --kind method
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getState cpp --kind function
    test("code_search_symbol method kinds filter accepts methods and rejects them as functions", async () => {
        const accepted = await search({
            query: "getState",
            language: "cpp",
            kinds: ["method"],
        });
        const rejected = await search({
            query: "getState",
            language: "cpp",
            kinds: ["function"],
        });
        matches(/\[cpp\] Method .*RigidBody::getState\(\)/, "method should pass")(accepted);
        matches(/^\(no symbols matching "getState"\)$/, "method should fail the function filter")(
            rejected,
        );
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getPosition cpp --kind method
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getPosition cpp --kind function
    test("code_search_symbol method kinds filter works with another bare method", async () => {
        const accepted = await search({
            query: "getPosition",
            language: "cpp",
            kinds: ["method"],
        });
        const rejected = await search({
            query: "getPosition",
            language: "cpp",
            kinds: ["function"],
        });
        matches(/\[cpp\] Method .*getPosition\(\)/, "method should pass")(accepted);
        matches(
            /^\(no symbols matching "getPosition"\)$/,
            "method should fail the function filter",
        )(rejected);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Debug cpp --kind enummember
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Debug cpp --kind enum
    test("code_search_symbol distinguishes enum members from enums", async () => {
        const accepted = await search({
            query: "Debug",
            language: "cpp",
            kinds: ["enummember"],
        });
        const rejected = await search({ query: "Debug", language: "cpp", kinds: ["enum"] });
        matches(/\[cpp\] EnumMember .*LogLevel::Debug/, "enum member should pass")(accepted);
        matches(/^\(no symbols matching "Debug"\)$/, "enum member should fail the enum filter")(
            rejected,
        );
    });

    // ─── name_pattern filter tests ─────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol toString cpp --regex 'toString\(int value\)'
    test("code_search_symbol name_pattern selects one C++ overload by full signature", async () => {
        const response = await search({
            query: "toString",
            language: "cpp",
            name_pattern: "toString\\(int value\\)",
        });
        matches(/\[cpp\] Function .*toString\(int value\)/, "int overload should remain")(response);
        notMatches(/toString\(float value\)/, "float overload should be filtered out")(response);
        notMatches(/toString\(bool value\)/, "bool overload should be filtered out")(response);
        notMatches(/toString\(const math::Vec3/, "Vec3 overload should be filtered out")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol RigidBody cpp --regex 'RigidBody::RigidBody'
    test("code_search_symbol name_pattern separates a constructor from its class", async () => {
        const response = await search({
            query: "RigidBody",
            language: "cpp",
            name_pattern: "RigidBody::RigidBody",
        });
        matches(/\[cpp\] Constructor .*RigidBody::RigidBody\(/, "constructor should remain")(
            response,
        );
        notMatches(/\[cpp\] Class class .*RigidBody/, "class should be filtered out")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol toString cpp --regex 'math::Vec3'
    test("code_search_symbol name_pattern selects an overload by parameter type", async () => {
        const response = await search({
            query: "toString",
            language: "cpp",
            name_pattern: "math::Vec3",
        });
        matches(/toString\(const math::Vec3 &vec\)/, "Vec3 overload should remain")(response);
        notMatches(/toString\(int value\)/, "int overload should be filtered out")(response);
        notMatches(/toString\(float value\)/, "float overload should be filtered out")(response);
        notMatches(/toString\(bool value\)/, "bool overload should be filtered out")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol toString cpp --regex 'toString\(bool value\)'
    test("code_search_symbol name_pattern selects another overload without leaking siblings", async () => {
        const response = await search({
            query: "toString",
            language: "cpp",
            name_pattern: "toString\\(bool value\\)",
        });
        matches(/toString\(bool value\)/, "bool overload should remain")(response);
        notMatches(/toString\(int value\)/, "int overload should be filtered out")(response);
        notMatches(/toString\(float value\)/, "float overload should be filtered out")(response);
        notMatches(/toString\(const math::Vec3/, "Vec3 overload should be filtered out")(response);
    });

    // name_pattern case-insensitivity test using a query that has exact matches
    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getPosition cpp --regex 'GETPOSITION'
    test("code_search_symbol with name_pattern is case-insensitive", async () => {
        const response = await search({
            query: "getPosition",
            language: "cpp",
            name_pattern: "GETPOSITION",
        });
        matches(
            /\[cpp\].*getPosition/,
            "case-insensitive pattern should match getPosition",
        )(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol RigidBody cpp --regex '['
    test("code_search_symbol rejects an invalid name_pattern regex", async () => {
        await search({
            query: "RigidBody",
            language: "cpp",
            name_pattern: "[",
        }).then(
            () => {
                throw new Error("expected rejection");
            },
            (err) => matches(/Invalid name_pattern/, "wrong error")(err.message),
        );
    });

    // ─── Language detection tests ──────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol Vec3
    test("code_search_symbol auto-detects C++ when language is omitted", async () => {
        const response = await search({ query: "Vec3" });
        matches(/\[cpp\].*Vec3/, "language autodetection missed C++ symbol")(response);
    });

    // ─── Complex qualified name scenarios ──────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'RigidBody::Properties' cpp
    test("code_search_symbol finds nested struct via class qualification", async () => {
        const response = await search({ query: "RigidBody::Properties", language: "cpp" });
        matches(/\[cpp\].*RigidBody::Properties/, "nested Properties struct not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'config::LogLevel' cpp
    test("code_search_symbol finds enum in a namespace", async () => {
        const response = await search({ query: "config::LogLevel", language: "cpp" });
        matches(
            /\[cpp\].*config::LogLevel/,
            "LogLevel enum not found in config namespace",
        )(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'engine::math::cross' cpp
    test("code_search_symbol distinguishes between similarly named functions in namespaces", async () => {
        const response = await search({ query: "engine::math::cross", language: "cpp" });
        matches(/\[cpp\].*engine::math::cross/, "cross product function not found")(response);
        notMatches(
            /\[cpp\].*dot/,
            "dot function should not appear when searching for cross",
        )(response);
    });

    // ─── Operator overload searches ────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'Vec3::operator+' cpp
    test("code_search_symbol finds operator+ overload via qualified name", async () => {
        const response = await search({ query: "Vec3::operator+", language: "cpp" });
        matches(/\[cpp\].*operator\+/, "operator+ not found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'Vec3::operator*' cpp
    test("code_search_symbol finds operator* overload via qualified name", async () => {
        const response = await search({ query: "Vec3::operator*", language: "cpp" });
        matches(/\[cpp\].*operator\*/, "operator* not found")(response);
    });

    // ─── Using alias and type alias searches ───────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'RigidBody::CollisionCallback' cpp
    test("code_search_symbol finds using alias for function type", async () => {
        const response = await search({ query: "RigidBody::CollisionCallback", language: "cpp" });
        matches(/\[cpp\].*CollisionCallback/, "using alias not found")(response);
    });

    // ─── Edge case: Multiple kinds of same name ────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol State cpp
    test("code_search_symbol finds symbols with common names across scopes", async () => {
        const response = await search({ query: "State", language: "cpp" });
        matches(/\[cpp\].*State/, "State should be found")(response);
    });

    // ─── Edge case: Template specialization names ──────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'data::Result<void>' cpp --info code
    test("code_search_symbol resolves the exact template specialization for include", async () => {
        const response = await search({
            query: "data::Result<void>",
            language: "cpp",
            include: ["definition"],
        });
        matches(/^# 1 match for "data::Result<void>"/m, "expected one exact specialization")(response);
        matches(
            /\[cpp\] Class template<> class engine::data::Result<void>/,
            "Result<void> specialization should be selected",
        )(response);
        notMatches(
            /\[cpp\].*Result<void>::(?:ok|error|success|errorMessage)/,
            "specialization members must not be selected as exact matches",
        )(response);
    });

    // ─── Combined filters ──────────────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getState cpp --kind method --regex 'get.*'
    test("code_search_symbol combines kinds and name_pattern filters", async () => {
        const response = await search({
            query: "getState",
            language: "cpp",
            kinds: ["method"],
            name_pattern: "get.*",
        });
        matches(/\[cpp\] Method.*get/, "getter methods should be present")(response);
        notMatches(/\[cpp\] Method.*set/, "setter methods should be filtered")(response);
        notMatches(/\[cpp\] Class/, "class should be filtered by kinds")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getPosition cpp --kind method --regex 'get.*'
    test("code_search_symbol combined filters work with another direct method name", async () => {
        const response = await search({
            query: "getPosition",
            language: "cpp",
            kinds: ["method"],
            name_pattern: "get.*",
        });
        matches(/\[cpp\] Method.*getPosition/, "getter method should be present")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol getPosition cpp --kind method --regex 'get.*' --info code,hover
    test("code_search_symbol combines all parameters for precise search", async () => {
        const response = await search({
            query: "getPosition",
            language: "cpp",
            kinds: ["method"],
            name_pattern: "get.*",
            include: ["definition", "hover"],
        });
        matches(/--- definition ---/, "definition section missing")(response);
        matches(/--- hover ---/, "hover section missing")(response);
        matches(/\[cpp\] Method.*get/, "getter methods should be present")(response);
    });

    // ─── Edge case: Anonymous namespace symbols ────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol InternalState cpp
    test("code_search_symbol finds symbols in anonymous namespaces", async () => {
        const response = await search({ query: "InternalState", language: "cpp" });
        matches(/\[cpp\].*InternalState/, "anonymous namespace struct should be found")(response);
    });

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol updateGlobalState cpp
    test("code_search_symbol finds functions in anonymous namespaces", async () => {
        const response = await search({ query: "updateGlobalState", language: "cpp" });
        matches(
            /\[cpp\].*updateGlobalState/,
            "anonymous namespace function should be found",
        )(response);
    });

    // ─── Edge case: Lambda factory ─────────────────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol makeFilter cpp
    test("code_search_symbol finds lambda factory function", async () => {
        const response = await search({ query: "makeFilter", language: "cpp" });
        matches(/\[cpp\].*makeFilter/, "lambda factory function not found")(response);
    });

    // ─── Edge case: Template member functions ──────────────────────────────

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'data::Result::map' cpp
    test("code_search_symbol finds template member function via qualified name", async () => {
        const response = await search({ query: "data::Result::map", language: "cpp" });
        matches(/\[cpp\].*map/, "template member function not found")(response);
    });

    // ─── Include with qualified name + kinds filter ────────────────────────
    // This is the correct pattern for getting detailed info on specific nested symbols.

    // Reproduce from the repository root:
    //   CODE_NAV_ROOT=test/fixtures/symbol-search node scripts/nav-cli.mjs symbol 'RigidBody::State' cpp --kind enum --info code,hover
    test("code_search_symbol include with qualified name and kinds filter works correctly", async () => {
        const response = await search({
            query: "RigidBody::State",
            language: "cpp",
            kinds: ["enum"],
            include: ["definition", "hover"],
        });
        matches(/--- definition ---/, "definition section missing")(response);
        matches(/--- hover ---/, "hover section missing")(response);
        matches(/enum class State/, "enum definition body missing")(response);
    });
});
