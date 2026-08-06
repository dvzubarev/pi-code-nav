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
import { nav, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";
import { scenario } from "./scenario.mjs";

const skip = !SHOULD_RUN_E2E;
const tyOk = SHOULD_RUN_E2E ? await serverAvailable("python") : false;
const runOrSkip = (name, fn) => (skip || !tyOk ? test.skip(name, fn) : test(name, fn));

scenario("diagnostics reflects on-disk edits (no stale results)", {
    skip: skip || !tyOk,

    given: {
        files: {
            "stale_repro.py": `
                def f():
                    return missing_thing
            `,
        },
    },

    when: async ({ root, clientOf }) => {
        const before = await nav.diagnostics({ path: "stale_repro.py" }, root, clientOf);
        await writeFile(resolve(root, "stale_repro.py"), "def f():\n    return 42\n", "utf8");
        const after = await nav.diagnostics({ path: "stale_repro.py" }, root, clientOf);
        return { before, after };
    },

    then: [
        ({ before, after }) => {
            assert.match(
                before,
                /1 diagnostic\(s\)/,
                `expected an error before the fix:\n${before}`,
            );
            assert.match(
                before,
                /missing_thing/,
                `error should name the undefined symbol:\n${before}`,
            );
            assert.match(after, /no diagnostics/, `expected NO error after the fix:\n${after}`);
            assert.doesNotMatch(
                after,
                /missing_thing/,
                `stale error must NOT appear after the fix:\n${after}`,
            );
        },
    ],
});

scenario("outline reflects newly-added symbols (no stale index)", {
    skip: skip || !tyOk,

    given: {
        files: {
            "stale_outline.py": `
                def alpha():
                    return 1
            `,
        },
    },

    when: async ({ root, clientOf }) => {
        const before = await nav.outline({ path: "stale_outline.py" }, root, clientOf);
        await writeFile(
            resolve(root, "stale_outline.py"),
            "def alpha():\n    return 1\n\ndef beta():\n    return 2\n",
            "utf8",
        );
        const after = await nav.outline({ path: "stale_outline.py" }, root, clientOf);
        return { before, after };
    },

    then: [
        ({ before, after }) => {
            assert.match(before, /Function alpha/, `alpha should be in the outline:\n${before}`);
            assert.doesNotMatch(before, /beta/, `beta must not appear yet:\n${before}`);
            assert.match(after, /Function alpha/, `alpha should still be present:\n${after}`);
            assert.match(after, /Function beta/, `beta should appear after the edit:\n${after}`);
        },
    ],
});
