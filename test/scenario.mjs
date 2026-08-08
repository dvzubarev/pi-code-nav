// Small declarative layer for LSP end-to-end scenarios. It deliberately stays
// on node:test: real language servers make full-output snapshots too unstable
// across server versions, while named response matchers keep the contract visible.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withWorkspace } from "./e2e-helpers.mjs";

/** Remove the indentation introduced by a template literal. */
export function dedent(text) {
    const lines = text.replace(/^\n|\n\s*$/g, "").split("\n");
    const indents = lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length);
    const indent = indents.length === 0 ? 0 : Math.min(...indents);
    return lines.map((line) => line.slice(indent)).join("\n") + "\n";
}

/** Assert that the complete rendered response matches a regular expression. */
export function matches(pattern, message = "response did not match") {
    return (response) => assert.match(response, pattern, `${message}:\n${response}`);
}

/** Assert that the complete rendered response does not match a regexp. */
export function notMatches(pattern, message = "response matched unexpectedly") {
    return (response) => assert.doesNotMatch(response, pattern, `${message}:\n${response}`);
}

/**
 * Register a real-server scenario.
 *
 * `given.files` maps workspace-relative paths to source text (or an async
 * function receiving the workspace, for generated files such as a compile DB).
 * `given.setup`, when present, runs after those files are written. `workspaceRoot`
 * optionally selects a copied subdirectory as the language-server root. `when`
 * receives the same workspace bundle as the older tests, and returns the tool response.
 * `then` contains response assertions, keeping fixture, request, and contract
 * adjacent in the test body. For hard-error contracts, use `error` instead.
 */
export function scenario(name, { skip = false, given = {}, when, then = [], error }) {
    const register = skip ? test.skip : test;
    register(name, async () => {
        const ws = await withWorkspace(given.fixtures ?? [], given.workspaceRoot ?? ".");
        try {
            for (const [path, text] of Object.entries(given.files ?? {})) {
                const destination = resolve(ws.root, path);
                await mkdir(dirname(destination), { recursive: true });
                const contents = typeof text === "function" ? await text(ws) : text;
                await writeFile(destination, dedent(contents), "utf8");
            }
            await given.setup?.(ws);
            if (error) {
                await assert.rejects(when(ws), error);
                return;
            }
            const response = await when(ws);
            for (const check of then) await check(response, ws);
        } finally {
            await ws.cleanup();
        }
    });
}
