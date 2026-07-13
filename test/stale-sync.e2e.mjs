// Regression test for the stale-diagnostics / stale-index bug.
//
// Before the fix, LspClient.openDocument() early-returned once a URI was in
// openDocs, so the server kept analyzing the version-1 snapshot forever. After
// the agent edited the file on disk, re-running code_diagnostics still showed
// the old errors, and code_outline did not see newly-added symbols — because
// no textDocument/didChange was ever sent.
//
// This test reproduces that exact scenario end-to-end: write a file with an
// error, diagnose it (expect the error), fix the file, diagnose again (expect
// NO error), and also confirm outline picks up a newly-added method.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";

const skip = !SHOULD_RUN_E2E;
const tyOk = SHOULD_RUN_E2E ? await serverAvailable("python") : false;
const runOrSkip = (name, fn) => (skip || !tyOk ? test.skip(name, fn) : test(name, fn));

runOrSkip("diagnostics reflects on-disk edits (no stale results)", async () => {
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "stale_repro.py");
        // v1: undefined name `missing_thing` — ty reports an error.
        await writeFile(file, "def f():\n    return missing_thing\n", "utf8");

        const before = await nav.diagnostics({ path: "stale_repro.py" }, ws.root, ws.clientOf);
        assert.match(before, /1 diagnostic\(s\)/, `expected an error before the fix:\n${before}`);
        assert.match(before, /missing_thing/, `error should name the undefined symbol:\n${before}`);

        // v2: fix the file — no undefined name anymore.
        await writeFile(file, "def f():\n    return 42\n", "utf8");

        const after = await nav.diagnostics({ path: "stale_repro.py" }, ws.root, ws.clientOf);
        assert.match(after, /no diagnostics/, `expected NO error after the fix:\n${after}`);
        assert.doesNotMatch(
            after,
            /missing_thing/,
            `stale error must NOT appear after the fix:\n${after}`,
        );
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("outline reflects newly-added symbols (no stale index)", async () => {
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "stale_outline.py");
        // v1: one function.
        await writeFile(file, "def alpha():\n    return 1\n", "utf8");

        const before = await nav.outline({ path: "stale_outline.py" }, ws.root, ws.clientOf);
        assert.match(before, /Function alpha/, `alpha should be in the outline:\n${before}`);
        assert.doesNotMatch(
            before,
            /beta/,
            `beta must not appear yet (not added):\n${before}`,
        );

        // v2: add a second function.
        await writeFile(file, "def alpha():\n    return 1\n\ndef beta():\n    return 2\n", "utf8");

        const after = await nav.outline({ path: "stale_outline.py" }, ws.root, ws.clientOf);
        assert.match(after, /Function alpha/, `alpha should still be present:\n${after}`);
        assert.match(
            after,
            /Function beta/,
            `beta should appear after the edit (didChange must have fired):\n${after}`,
        );
    } finally {
        await ws.cleanup();
    }
});
