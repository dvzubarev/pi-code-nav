// End-to-end Python diagnostics scenarios through ty.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, pythonScenario } from "./python-helpers.mjs";
import { matches } from "./scenario.mjs";

pythonScenario("code_diagnostics reports a Python type error", {
    given: {
        fixtures: ["second.py"],
        files: { "bad.py": 'import second\nsecond.Point("not an int")' },
    },
    when: ({ root, clientOf }) => nav.diagnostics({ path: "bad.py" }, root, clientOf),
    then: [matches(/\d+ diagnostic\(s\) for bad\.py:/, "diagnostic header missing")],
});

const concurrentPaths = Array.from({ length: 6 }, (_, i) => `module_${i}.py`);

pythonScenario("code_diagnostics handles concurrent Python document opens and changes", {
    given: {
        files: {
            "warmup.py": "x = 1",
            ...Object.fromEntries(
                concurrentPaths.map((path) => [
                    path,
                    'bad: int = "wrong"\n' +
                        Array.from(
                            { length: 80 },
                            (_, i) =>
                                `def function_${i}(value: int) -> int:\n    return value + ${i}\n`,
                        ).join("\n"),
                ]),
            ),
        },
    },
    when: async ({ root, clientOf }) => {
        // The initial readiness barrier batches opens on a cold server. Warm
        // it first to exercise didOpen racing an already-running pull instead.
        await nav.diagnostics({ path: "warmup.py" }, root, clientOf);
        const queryAll = () =>
            Promise.all(concurrentPaths.map((path) => nav.diagnostics({ path }, root, clientOf)));
        const opened = await queryAll();
        await Promise.all(
            concurrentPaths.map(async (path) => {
                const absolute = resolve(root, path);
                await writeFile(
                    absolute,
                    (await readFile(absolute, "utf8")) + 'changed: int = "wrong"\n',
                );
            }),
        );
        return { opened, changed: await queryAll() };
    },
    then: [
        (response) => {
            for (const [phase, count] of [
                ["opened", 1],
                ["changed", 2],
            ]) {
                response[phase].forEach((text, i) => {
                    assert.ok(
                        text.startsWith(`${count} diagnostic(s) for ${concurrentPaths[i]}:`),
                        text,
                    );
                    assert.match(text, /error/);
                });
            }
        },
    ],
});
