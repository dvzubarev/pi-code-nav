// End-to-end tests for code_scan (the tree-sitter identifier scanner), via nav.*.
//
// These exercise the nav.scan function — the renamed code_symbols_in tool,
// now with an optional `pattern` filter and whole-file default when no line
// range is given. The default path (include_docs=false) makes ZERO LSP calls,
// so these tests do NOT need a language server on PATH: nav.scan with
// include_docs unset never touches clientOf. They run as part of the e2e
// suite but are effectively pure-syntax tests.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";

// No server probe needed — code_scan's default path is server-free. We only
// skip when the e2e suite is explicitly disabled.
const runOrSkip = SHOULD_RUN_E2E ? test : test.skip;

runOrSkip("code_scan with no line range scans the whole file", async () => {
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "svc.ts");
        await writeFile(
            file,
            [
                `import { readFile } from "node:fs/promises";`,
                `export function greet(name: string): string { return name; }`,
                `export class Service {`,
                `  constructor(private id: number) {}`,
                `  getId(): number { return this.id; }`,
                `}`,
                ``,
            ].join("\n"),
            "utf8",
        );
        // No startLine/endLine → whole file. No include_docs → no LSP calls.
        // A clientOf that throws if called proves the default path is server-free.
        const throwingClientOf = async () => {
            throw new Error("code_scan default path should not call clientOf");
        };
        const out = await nav.scan({ path: "svc.ts" }, ws.root, throwingClientOf);
        // The header reflects the whole-file range (1 .. lineCount, where
        // lineCount includes the trailing empty line from the join).
        assert.match(out, /Symbols in svc\.ts:1-7 /, `header missing:\n${out}`);
        // readFile is an import (third-party entry point) — the whole reason
        // code_scan exists. It must appear. Rows carry only `(line:col)` (the
        // path is in the header once), so match `(1:<col>)` not `svc.ts(1:<col>)`.
        assert.match(out, /import\s+readFile\s+\(1:\d+\)/, `readFile import missing:\n${out}`);
        // greet is a called name (call role) inside the body — wait, greet is
        // a declaration here. Service is a type. getId is a member. Check a few
        // roles are present to confirm the whole file was walked.
        assert.match(out, /type\s+Service/, `Service type missing:\n${out}`);
        assert.match(out, /member\s+getId/, `getId member missing:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_scan pattern filters symbols by name regexp", async () => {
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "svc.ts");
        await writeFile(
            file,
            [
                `import { readFile } from "node:fs/promises";`,
                `import { writeFile } from "node:fs/promises";`,
                `export function greet(name: string): string { return name; }`,
                `export class Service {`,
                `  constructor(private id: number) {}`,
                `  getId(): number { return this.id; }`,
                `}`,
                ``,
            ].join("\n"),
            "utf8",
        );
        // Pattern "File$" matches readFile and writeFile (the imports), but
        // NOT greet/Service/getId. Confirms the filter is applied post-parse.
        const throwingClientOf = async () => {
            throw new Error("code_scan default path should not call clientOf");
        };
        const out = await nav.scan({ path: "svc.ts", pattern: "File$" }, ws.root, throwingClientOf);
        assert.match(out, /import\s+readFile\s+\(1:\d+\)/, `readFile missing:\n${out}`);
        assert.match(out, /import\s+writeFile\s+\(2:\d+\)/, `writeFile missing:\n${out}`);
        // Non-matching names are filtered out.
        assert.ok(!/type\s+Service/.test(out), `Service should be filtered out:\n${out}`);
        assert.ok(!/member\s+getId/.test(out), `getId should be filtered out:\n${out}`);
        assert.ok(!/greet/.test(out), `greet should be filtered out:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_scan pattern with a bad regexp reports an error", async () => {
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "svc.ts");
        await writeFile(file, `const x = 1;\n`, "utf8");
        const throwingClientOf = async () => {
            throw new Error("code_scan default path should not call clientOf");
        };
        // An invalid regexp is a hard error (throws) — same contract as code_tree.
        await assert.rejects(
            nav.scan({ path: "svc.ts", pattern: "(" }, ws.root, throwingClientOf),
            /Invalid regexp/,
        );
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_scan with a line range still works (back-compat)", async () => {
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "svc.ts");
        await writeFile(
            file,
            [
                `import { readFile } from "node:fs/promises";`, // line 1
                `export function greet(name: string): string { return name; }`, // line 2
                `export class Service {`, // line 3
                `  getId(): number { return this.id; }`, // line 4
                `}`,
                ``,
            ].join("\n"),
            "utf8",
        );
        // Only line 1 — the import line. readFile should appear; Service (line 3)
        // should not, confirming the range is honored.
        const throwingClientOf = async () => {
            throw new Error("code_scan default path should not call clientOf");
        };
        const out = await nav.scan(
            { path: "svc.ts", startLine: 1, endLine: 1 },
            ws.root,
            throwingClientOf,
        );
        assert.match(out, /Symbols in svc\.ts:1-1 /, `header should show range 1-1:\n${out}`);
        assert.match(out, /import\s+readFile/, `readFile missing:\n${out}`);
        assert.ok(!/type\s+Service/.test(out), `Service should be outside range:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});
