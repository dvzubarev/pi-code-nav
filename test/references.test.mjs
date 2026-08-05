import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "./helpers.mjs";

const source = `class Worker {
  run() {
    return dispatch<string>(
      "first",
      "second");
  }
}
`;

function clientWithReferences(file) {
    const uri = pathToFileURL(file).href;
    return {
        openDocument: async () => {},
        references: async () => [
            { uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } },
            { uri, range: { start: { line: 2, character: 11 }, end: { line: 2, character: 19 } } },
        ],
    };
}

test("references defaults to syntax context with role and enclosing metadata", async () => {
    const { references } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-refs-"));
    const file = resolve(dir, "sample.ts");
    try {
        await writeFile(file, source, "utf8");
        const out = await references({ path: file, line: 1, column: 7 }, dir, async () =>
            clientWithReferences(file),
        );
        assert.match(out, /kind: call/);
        assert.match(out, /enclosing: Worker\.run\s+.*sample\.ts:2:3/);
        assert.match(out, /3 \| dispatch<string>\(/);
        assert.match(out, /5 \|\s+"second"\)/);
        assert.match(out, /# 2 references$/);
    } finally {
        await rm(dir, { recursive: true });
    }
});

test("references compact mode is paginated and reports the total", async () => {
    const { references } = await load("./src/nav.ts");
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-refs-page-"));
    const file = resolve(dir, "sample.ts");
    try {
        await writeFile(file, source, "utf8");
        const out = await references(
            { path: file, line: 1, column: 7, context: "none", offset: 2, limit: 1 },
            dir,
            async () => clientWithReferences(file),
        );
        assert.doesNotMatch(out, /kind:/);
        assert.match(out, /sample\.ts:3:12/);
        assert.match(out, /# showing references 2-2 of 2$/);
    } finally {
        await rm(dir, { recursive: true });
    }
});
