// Tests for the structured error contract and the symbol-table path dedup.
// Pure (no LSP servers needed) — exercises:
//   - renderErrorRow format (the ERROR row parses with the same column
//     grammar as a data row, leading `ERROR` token distinguishes from data)
//   - nav.scan hard failures now THROW (Cannot read, No grammar, parse
//     failed, bad params) instead of returning inline strings
//   - nav.definition now THROWS on every failure (no fallbacks, no soft-
//     failure rows) — the tool's contract is "verbatim source code or a hard
//     error". Covers: unknown language, cannot read, server unavailable, no
//     definition found, could not resolve body. (Multiple definitions is NOT
//     a failure — it returns one block per site.)
//   - scalar nav tools throw on operational failures; clean empty results are
//     still normal successful output.
//
// Server-failure paths use a `clientOf` that throws, so no real server is
// required.
//
// Run:  npm run test:unit -- test/errors.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { load } from "./helpers.mjs";

// A clientOf that always throws — simulates "server unavailable" without
// needing a real language server on PATH.
const throwingClientOf = async (_lang) => {
    throw new Error("server unavailable: simulated");
};

test("renderErrorRow format: ERROR token + path:line:col + reason", async () => {
    const { renderErrorRow } = await load("./src/render.ts");
    const row = renderErrorRow("svc.ts", 10, 5, "no definition found");
    // Leading ERROR token (so a consumer splits on \n and checks the first
    // token to distinguish data from error rows).
    assert.ok(row.startsWith("ERROR  "), `row should start with "ERROR  ": ${row}`);
    // The path:line:col appears (same column grammar as a data row's location).
    assert.match(row, /svc\.ts:10:5/);
    // The reason is present.
    assert.match(row, /no definition found$/);
});

test("renderErrorRow distinguishes from a data row by first token", async () => {
    const { renderErrorRow } = await load("./src/render.ts");
    const errorRow = renderErrorRow("svc.ts", 1, 1, "cannot read");
    // A consumer splits rows on \n and checks: first token === "ERROR" → error.
    const firstToken = errorRow.split(/\s+/)[0];
    assert.equal(firstToken, "ERROR", `first token should be ERROR: ${errorRow}`);
});

test("nav.scan hard failure: Cannot read → throws (isError in index.ts)", async () => {
    const { scan } = await load("./src/nav.ts");
    // A path that does not exist. scan must THROW (so index.ts's err() sets
    // isError: true) rather than returning an inline string.
    await assert.rejects(
        scan({ path: "does-not-exist.ts" }, "/nonexistent-cwd", throwingClientOf),
        /Cannot read/,
    );
});

test("nav.scan hard failure: No grammar for unsupported extension → throws", async () => {
    const { scan } = await load("./src/nav.ts");
    // .txt has no tree-sitter grammar. tsLangForFile returns null → scan throws
    // UnknownLanguageError. Use a real temp file so we get past readFile.
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "x.txt");
        await writeFile(file, "hello\n", "utf8");
        await assert.rejects(scan({ path: file }, dir, throwingClientOf), /Unknown language/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.scan hard failure: bad startLine → throws", async () => {
    const { scan } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "x.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        await assert.rejects(
            scan({ path: "x.ts", startLine: 0, endLine: 1 }, dir, throwingClientOf),
            /startLine/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.scan hard failure: bad endLine < startLine → throws", async () => {
    const { scan } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "x.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        await assert.rejects(
            scan({ path: "x.ts", startLine: 5, endLine: 1 }, dir, throwingClientOf),
            /endLine .* must be >= startLine/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.definition hard failure: unknown language → throws", async () => {
    const { definition } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "x.txt");
        await writeFile(file, "hello\n", "utf8");
        await assert.rejects(
            definition({ path: "x.txt", line: 1, column: 1 }, dir, throwingClientOf),
            /Unknown language/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.definition hard failure: cannot read input file → throws", async () => {
    const { definition } = await load("./src/nav.ts");
    await assert.rejects(
        definition({ path: "nope.ts", line: 1, column: 1 }, "/nonexistent-cwd", throwingClientOf),
        /Cannot read/,
    );
});

test("nav.definition hard failure: server unavailable → throws", async () => {
    const { definition } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        await assert.rejects(
            definition({ path: "svc.ts", line: 1, column: 1 }, dir, throwingClientOf),
            /typescript: server unavailable/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.references hard failure: server unavailable → throws", async () => {
    const { references } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        await assert.rejects(
            references({ path: "svc.ts", line: 1, column: 1 }, dir, throwingClientOf),
            /typescript: server unavailable/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.hover hard failure: server unavailable → throws", async () => {
    const { hover } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        await assert.rejects(
            hover({ path: "svc.ts", line: 1, column: 1 }, dir, throwingClientOf),
            /typescript: server unavailable/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.diagnostics uses a 60-second push deadline and reports an unavailable result", async () => {
    const { diagnostics } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        await writeFile(resolve(dir, "svc.ts"), "const x = 1;\n", "utf8");
        const client = {
            openDocument: async () => {},
            pullDiagnostics: async () => {
                throw new Error("Unhandled method textDocument/diagnostic");
            },
            waitForPushedDiagnostics: async (_path, timeoutMs) => {
                assert.equal(timeoutMs, 60_000);
                return undefined; // Simulate expiry or server exit/shutdown.
            },
        };
        await assert.rejects(
            diagnostics({ path: "svc.ts" }, dir, async () => client),
            /diagnostics unavailable for svc\.ts: the server does not support pull diagnostics .*; push diagnostics were not received within 60 seconds/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.diagnostics treats an empty push notification as a clean result", async () => {
    const { diagnostics } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        await writeFile(resolve(dir, "svc.ts"), "const x = 1;\n", "utf8");
        const client = {
            openDocument: async () => {},
            pullDiagnostics: async () => {
                throw new Error("Unhandled method textDocument/diagnostic");
            },
            waitForPushedDiagnostics: async () => [],
        };
        assert.equal(
            await diagnostics({ path: "svc.ts" }, dir, async () => client),
            "(no diagnostics for svc.ts)",
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("position-based tools reject non-positive coordinates", async () => {
    const { definition, hover, references, rename } = await load("./src/nav.ts");
    for (const fn of [definition, hover, references, rename]) {
        await assert.rejects(
            fn({ path: "x.ts", line: 0, column: 1, newName: "y" }, ".", throwingClientOf),
            /line \(0\) must be a positive integer/,
        );
    }
});

test("nav.outline hard failure: Cannot read → throws", async () => {
    const { outline } = await load("./src/nav.ts");
    await assert.rejects(
        outline({ path: "nope.ts" }, "/nonexistent-cwd", throwingClientOf),
        /Cannot read/,
    );
});

test("nav.outline hard failure: unknown language → throws UnknownLanguageError", async () => {
    const { outline } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "x.txt");
        await writeFile(file, "hello\n", "utf8");
        await assert.rejects(outline({ path: "x.txt" }, dir, throwingClientOf), /Unknown language/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.symbol hard failure: invalid `language` → throws (not a raw TypeError)", async () => {
    const { symbol } = await load("./src/nav.ts");
    // The tool schema (index.ts) constrains `language` to a StringEnum, but
    // nav.ts is also called directly by the CLI harness/tests, which bypass
    // that schema. An invalid value must fail with a clean, agent-readable
    // message — NOT propagate into resolveConfig's `DEFAULTS[lang]` lookup
    // and throw a raw "Cannot read properties of undefined" TypeError.
    await assert.rejects(
        symbol({ query: "foo", language: "javascript" }, "/nonexistent-cwd", throwingClientOf),
        /Unknown language "javascript"/,
    );
});

test("nav.symbol accepts a valid `language` without throwing on validation", async () => {
    const { symbol } = await load("./src/nav.ts");
    // "typescript" is a valid Lang (previously omitted from the tool
    // description's allowed-value list). Validation must pass the language
    // check; the request then fails later for an unrelated recoverable
    // reason (server unavailable), which nav.symbol reports as an ERROR row
    // rather than a thrown rejection — proving it got past the language
    // check without raising the validation error.
    const result = await symbol(
        { query: "foo", language: "typescript" },
        "/nonexistent-cwd",
        throwingClientOf,
    );
    assert.match(result, /ERROR\s+\[typescript\]\s+server unavailable/);
});

// --- Clean empty results are NOT ERROR rows ----------------------------------
// A symbol with no references is a legitimate outcome, not a failure. These
// use a mock client that returns empty results, so the tool reaches the "no
// references found" path without a real server. The output must be a
// parenthesized note, NOT an `ERROR` row.
//
// NOTE: code_definition is the exception — its contract is "return verbatim
// source code", so even a clean "no definition found" is a HARD failure there
// (no source code to return). See the definition test below.

/** A mock LspClient that returns empty definition/reference results. */
function emptyResultClientOf() {
    const client = {
        // nav.definition now opens the document and waits for indexing (cpp)
        // before querying, and resolves the DocumentSymbol at the cursor BEFORE
        // calling textDocument/definition (the cursor-on-a-definition fast
        // path). Return an empty tree so the fast path finds nothing and the
        // tool falls through to textDocument/definition (which also returns
        // empty) → "No definition found" hard error.
        openDocument: async () => {},
        waitForIndexingComplete: async () => {},
        documentSymbols: async () => [],
        definition: async () => [],
        references: async () => [],
        hover: async () => null,
    };
    return async () => client;
}

test("nav.definition clean empty result: no definition → HARD error (throws)", async () => {
    const { definition } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        // code_definition's contract is "verbatim source code or a hard error".
        // A clean "no definition found" means no source code can be returned —
        // so it throws (isError) rather than emitting a parenthesized note.
        await assert.rejects(
            definition({ path: "svc.ts", line: 1, column: 1 }, dir, emptyResultClientOf()),
            /No definition found for svc\.ts:1:1/,
        );
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.definition multiple sites: returns one block per site + trailing count (not an error)", async () => {
    const { definition } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-multidef-"));
    try {
        // Two definition source files. Each defines a function `foo` whose
        // identifier sits at line 1, column 7 (0-based 0:6) — the mock
        // documentSymbols tree below reports a matching selectionRange so
        // resolveDefBodyRange resolves the body range to the whole line.
        await writeFile(resolve(dir, "a.ts"), "function foo() { return 1; }\n", "utf8");
        await writeFile(resolve(dir, "b.ts"), "function foo() { return 2; }\n", "utf8");
        await writeFile(resolve(dir, "svc.ts"), "const x = foo();\n", "utf8");
        // Mock LspClient: definition() returns two Locations (a.ts and b.ts),
        // documentSymbols() returns a one-child tree whose selectionRange.start
        // matches each loc.range.start — so resolveDefBodyRange resolves the
        // body to lines 0-0 (the `function foo` line).
        const idStart = { line: 0, character: 6 };
        const makeClient = () => ({
            openDocument: async () => {},
            waitForIndexingComplete: async () => {},
            definition: async () => [
                { uri: `file://${resolve(dir, "a.ts")}`, range: { start: idStart, end: idStart } },
                { uri: `file://${resolve(dir, "b.ts")}`, range: { start: idStart, end: idStart } },
            ],
            documentSymbols: async () => [
                {
                    name: "foo",
                    kind: 12,
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 27 } },
                    selectionRange: { start: idStart, end: { line: 0, character: 9 } },
                    children: [],
                },
            ],
        });
        const clientOf = async () => makeClient();
        const out = await definition({ path: "svc.ts", line: 1, column: 7 }, dir, clientOf);
        const lines = out.split("\n");
        // Two header lines (one per site), grep-style <defPath>:<sl>-<el>.
        const headers = lines.filter((l) => /[/\\](a|b)\.ts:\d+-\d+$/.test(l));
        assert.equal(headers.length, 2, `expected 2 site headers, got:\n${out}`);
        // Both bodies present.
        assert.match(out, /return 1;/, `body of site 1 missing:\n${out}`);
        assert.match(out, /return 2;/, `body of site 2 missing:\n${out}`);
        // Trailing count comment.
        assert.match(out, /# 2 definitions for svc\.ts:1:7$/, `trailing count missing:\n${out}`);
        // NOT a hard error — no throw, no isError. (If it had thrown, this
        // test would reject before reaching the asserts above.)
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.references clean empty result: no references → parenthesized note, not ERROR", async () => {
    const { references } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        const out = await references(
            { path: "svc.ts", line: 1, column: 1 },
            dir,
            emptyResultClientOf(),
        );
        // Clean empty result — parenthesized note, NOT an ERROR row.
        assert.match(out, /^\(no references found for svc\.ts:1:1\)/, out);
        assert.ok(!/^ERROR/.test(out), `should not be an ERROR row:\n${out}`);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});
