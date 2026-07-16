// End-to-end regression for code_search_symbol on a FRESH ccls, covering the
// whole-project indexing case that the previous "fix for cpp" commit got wrong.
//
// ccls populates its workspace/symbol index by parsing ALL translation units
// listed in compile_commands.json — NOT just the file a caller opens. On a
// cold cache this takes a moment, and until it finishes workspace/symbol sees
// only a subset of TUs. ensureProjectLoaded must wait for the whole-project
// index (ccls reports it via $/progress begin/report/end on the "index" token,
// which we opt into with window.workDoneProgress + a workDoneProgress/create
// handler) before workspace/symbol runs.
//
// This reproduces the DiskANN report: a cross-file symbol (one living in a TU
// the caller never opened) was missing until the whole-project index finished.
// We build a 3-TU project, open NO file ourselves, and assert symbols from
// (at least two) un-opened TUs are found — proving the wait, not just the
// per-file warm-up the old commit did.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";

const skip = !SHOULD_RUN_E2E;
const cppOk = SHOULD_RUN_E2E ? await serverAvailable("cpp") : false;
const runOrSkip = (name, fn) => (skip || !cppOk ? test.skip(name, fn) : test(name, fn));

runOrSkip(
    "code_search_symbol finds cross-file symbols on a fresh ccls (whole-project index)",
    async () => {
        // Three TUs, each with a unique struct. ensureProjectLoaded opens ONE of
        // them (findFirstSourceFile) and waits for the whole-project index; the
        // other two structs live in TUs that are NEVER opened. If all three are
        // found, at least two came from un-opened TUs — the whole-project index
        // completed, which is exactly what the $/progress "end" wait guarantees.
        // A cold cache: the temp workspace paths are unique per run (mkdtemp), so
        // ccls's cache keys are fresh — no prior indexing.
        const ws = await withWorkspace([]);
        try {
            const root = ws.root;
            const tus = [
                { file: "alpha.cpp", sym: "AlphaGadget" },
                { file: "beta.cpp", sym: "BetaGadget" },
                { file: "gamma.cpp", sym: "GammaGadget" },
            ];
            for (const { file, sym } of tus) {
                await writeFile(
                    resolve(root, file),
                    [`struct ${sym} { int value; };`, `int main() { return 0; }`, ``].join("\n"),
                    "utf8",
                );
            }
            // ccls (per the code-nav config) looks for compile_commands.json under
            // <root>/build/. Listing all three TUs makes ccls index all of them at
            // initialize — independently of which one ensureProjectLoaded opens.
            // No external includes are needed; ccls parses with its own clang
            // driver using these flags, and the trivial structs need none.
            await mkdir(resolve(root, "build"), { recursive: true });
            const db = tus.map(({ file }) => ({
                directory: root,
                command: `clang++ -std=c++17 ${file}`,
                file: resolve(root, file),
            }));
            await writeFile(
                resolve(root, "build", "compile_commands.json"),
                JSON.stringify(db, null, 2),
                "utf8",
            );

            // No didOpen before this — the client is fresh. ensureProjectLoaded
            // must open a warm-up file AND wait for the whole-project index.
            for (const { sym } of tus) {
                const out = await nav.symbol({ query: sym, language: "cpp" }, root, ws.clientOf);
                assert.match(
                    out,
                    new RegExp(`\\[cpp\\].*${sym}\\b`),
                    `expected a ${sym} hit from a fresh ccls, got:\n${out}`,
                );
            }
        } finally {
            await ws.cleanup();
        }
    },
);

runOrSkip(
    "code_search_symbol finds a symbol on a fresh ccls with NO compile_commands (warm-up file)",
    async () => {
        // Without compile_commands.json, a fresh ccls indexes NOTHING until a
        // document is opened (there is no initial index to dispatch). Before the
        // warm-up-file fix, workspace/symbol returned empty here and
        // code_search_symbol reported "(no symbols matching ...)". ensureProjectLoaded
        // must open a source file (so ccls on-demand-parses it and its symbols land
        // in the workspace/symbol index) before the query runs. No $/progress is
        // emitted for an on-demand parse, so waitForIndexingComplete returns after
        // the short no-begin timeout — by which point the trivial file is parsed.
        const ws = await withWorkspace([]);
        try {
            const file = resolve(ws.root, "sample.cpp");
            await writeFile(
                file,
                [
                    `struct Gadget {`,
                    `  int count;`,
                    `  void tick();`,
                    `};`,
                    `int main() { return 0; }`,
                    ``,
                ].join("\n"),
                "utf8",
            );
            // No didOpen before this — the client is fresh, and there is no
            // compile_commands.json, so ccls has indexed nothing yet.
            const out = await nav.symbol(
                { query: "Gadget", language: "cpp" },
                ws.root,
                ws.clientOf,
            );
            assert.match(
                out,
                /\[cpp\].*Gadget/,
                `expected a Gadget hit from a fresh ccls (no compile_commands), got:\n${out}`,
            );
        } finally {
            await ws.cleanup();
        }
    },
);
