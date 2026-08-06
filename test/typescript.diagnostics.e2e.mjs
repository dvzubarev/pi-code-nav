// End-to-end TypeScript diagnostics scenarios.

import assert from "node:assert/strict";
import {
    nav,
    resolve,
    runOrSkip,
    typescriptScenario,
    withWorkspace,
    writeFile,
} from "./typescript-helpers.mjs";
import { matches } from "./scenario.mjs";

typescriptScenario("code_diagnostics uses tsserver's push fallback", {
    given: {
        files: {
            "bad.ts": `
                const x: number = "string";
                console.log(x.notReal);
            `,
        },
    },
    when: ({ root, clientOf }) => nav.diagnostics({ path: "bad.ts" }, root, clientOf),
    then: [
        matches(/\d+ diagnostic\(s\) for bad\.ts:/, "diagnostic header missing"),
        matches(/string['"s]? is not assignable to type ['"n]?number/i, "type mismatch missing"),
        matches(
            /Property ['"]?notReal['"]? does not exist on type/i,
            "missing-property error missing",
        ),
    ],
});

runOrSkip(
    "code_diagnostics on a clean .ts file reports no diagnostics (push fallback)",
    async () => {
        // A clean file: the push cache should contain an empty array (the server
        // publishes an empty set), and the tool reports "no diagnostics". This
        // distinguishes a clean file from a silent/broken server.
        const ws = await withWorkspace([]);
        try {
            const good = resolve(ws.root, "good.ts");
            await writeFile(good, `const x: number = 42;\nconsole.log(x);\n`, "utf8");
            const out = await nav.diagnostics({ path: "good.ts" }, ws.root, ws.clientOf);
            assert.match(
                out,
                /no diagnostics for good\.ts/,
                `expected no diagnostics, got:\n${out}`,
            );
        } finally {
            await ws.cleanup();
        }
    },
);

runOrSkip("code_diagnostics receives fresh push diagnostics after didChange", async () => {
    const ws = await withWorkspace([]);
    try {
        const file = resolve(ws.root, "changed.ts");
        await writeFile(file, `const x: number = "wrong";\n`, "utf8");
        const before = await nav.diagnostics({ path: "changed.ts" }, ws.root, ws.clientOf);
        assert.match(before, /diagnostic\(s\)/, `expected an initial error:\n${before}`);

        await writeFile(file, `const x: number = 42;\n`, "utf8");
        const after = await nav.diagnostics({ path: "changed.ts" }, ws.root, ws.clientOf);
        assert.match(after, /no diagnostics/, `expected a fresh clean result:\n${after}`);
    } finally {
        await ws.cleanup();
    }
});
