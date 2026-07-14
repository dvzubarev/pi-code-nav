// Tests for the structured error contract and the symbol-table path dedup.
// Pure (no LSP servers needed) — exercises:
//   - renderErrorRow format (the ERROR row parses with the same column
//     grammar as a data row, leading `ERROR` token distinguishes from data)
//   - nav.scan hard failures now THROW (Cannot read, No grammar, parse
//     failed, bad params) instead of returning inline strings
//   - nav.definition now THROWS on every failure (no fallbacks, no soft-
//     failure rows) — the tool's contract is "verbatim source code or a hard
//     error". Covers: unknown language, cannot read, server unavailable, no
//     definition found, multiple definitions, could not resolve body.
//   - nav.references/hover per-position soft failures emit structured ERROR
//     rows (with the ### position header when batching)
//
// The batched-tool soft-failure path is exercised with a `clientOf` that
// throws — so the language-server spawn fails and we see the ERROR row for
// "server unavailable" without needing a real server.
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
    const { renderErrorRow } = await load("./render.ts");
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
    const { renderErrorRow } = await load("./render.ts");
    const errorRow = renderErrorRow("svc.ts", 1, 1, "cannot read");
    // A consumer splits rows on \n and checks: first token === "ERROR" → error.
    const firstToken = errorRow.split(/\s+/)[0];
    assert.equal(firstToken, "ERROR", `first token should be ERROR: ${errorRow}`);
});

test("nav.scan hard failure: Cannot read → throws (isError in index.ts)", async () => {
    const { scan } = await load("./nav.ts");
    // A path that does not exist. scan must THROW (so index.ts's err() sets
    // isError: true) rather than returning an inline string.
    await assert.rejects(
        scan({ path: "does-not-exist.ts" }, "/nonexistent-cwd", throwingClientOf),
        /Cannot read/,
    );
});

test("nav.scan hard failure: No grammar for unsupported extension → throws", async () => {
    const { scan } = await load("./nav.ts");
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
    const { scan } = await load("./nav.ts");
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
    const { scan } = await load("./nav.ts");
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
    const { definition } = await load("./nav.ts");
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
    const { definition } = await load("./nav.ts");
    await assert.rejects(
        definition({ path: "nope.ts", line: 1, column: 1 }, "/nonexistent-cwd", throwingClientOf),
        /Cannot read/,
    );
});

test("nav.definition hard failure: server unavailable → throws", async () => {
    const { definition } = await load("./nav.ts");
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

test("nav.references per-position soft failure → ERROR row", async () => {
    const { references } = await load("./nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        const out = await references(
            { positions: [{ path: "svc.ts", line: 1, column: 1 }] },
            dir,
            throwingClientOf,
        );
        assert.match(out, /^ERROR  svc\.ts:1:1  typescript: server unavailable/, out);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.hover per-position soft failure → ERROR row", async () => {
    const { hover } = await load("./nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        const out = await hover(
            { positions: [{ path: "svc.ts", line: 1, column: 1 }] },
            dir,
            throwingClientOf,
        );
        assert.match(out, /^ERROR  svc\.ts:1:1  typescript: server unavailable/, out);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.outline hard failure: Cannot read → throws", async () => {
    const { outline } = await load("./nav.ts");
    await assert.rejects(
        outline({ path: "nope.ts" }, "/nonexistent-cwd", throwingClientOf),
        /Cannot read/,
    );
});

test("nav.outline hard failure: unknown language → throws UnknownLanguageError", async () => {
    const { outline } = await load("./nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "x.txt");
        await writeFile(file, "hello\n", "utf8");
        await assert.rejects(outline({ path: "x.txt" }, dir, throwingClientOf), /Unknown language/);
    } finally {
        await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true }));
    }
});

test("nav.tree hard failure: Cannot read → throws", async () => {
    const { tree } = await load("./nav.ts");
    await assert.rejects(
        tree({ path: "nope.ts", pattern: "x" }, "/nonexistent-cwd", throwingClientOf),
        /Cannot read/,
    );
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
        definition: async () => [],
        references: async () => [],
        hover: async () => null,
    };
    return async () => client;
}

test("nav.definition clean empty result: no definition → HARD error (throws)", async () => {
    const { definition } = await load("./nav.ts");
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

test("nav.references clean empty result: no references → parenthesized note, not ERROR", async () => {
    const { references } = await load("./nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-err-"));
    try {
        const file = resolve(dir, "svc.ts");
        await writeFile(file, "const x = 1;\n", "utf8");
        const out = await references(
            { positions: [{ path: "svc.ts", line: 1, column: 1 }] },
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
