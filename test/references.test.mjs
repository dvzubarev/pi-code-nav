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

test("syntax context renders complete read expressions and distinguishes declarations", async () => {
    const { referenceSyntaxContext } = await load("./src/tree-sitter-parse.ts");
    const input = `const payload = 1;
consume(
  payload
);
`;

    const declaration = await referenceSyntaxContext("typescript", input, 0, 6);
    assert.equal(declaration.kind, "declaration");
    assert.equal(declaration.source, "1 | const payload = 1;");

    const read = await referenceSyntaxContext("typescript", input, 2, 2);
    assert.equal(read.kind, "read");
    assert.equal(read.source, "2 | consume(\n3 |   payload\n4 | )");
});

test("enclosing context renders the nearest structural skeleton with adjacent comments", async () => {
    const { referenceSyntaxContext } = await load("./src/tree-sitter-parse.ts");
    const input = `void work() {
  int payload = 1;
  if (ready()) {
    prepare();
    // This use needs the prepared state.
    consume(payload);
    finish();
  }
}
`;

    const context = await referenceSyntaxContext("cpp", input, 5, 12, "enclosing");
    assert.equal(context.startLine, 3, "the if, not the function or plain block, is nearest");
    assert.equal(context.endLine, 8);
    assert.match(context.source, /^3 \|   if \(ready\(\)\) \{/);
    assert.match(context.source, /\.\.\. \| <\.\.\.>\n5 \|     \/\/ This use needs the prepared state\./);
    assert.match(context.source, /6 \|     consume\(payload\);/);
    assert.match(context.source, /\.\.\. \| <\.\.\.>\n8 \|   \}$/);
    assert.doesNotMatch(context.source, /void work|prepare\(\)|finish\(\)/);
});

test("enclosing context skips try and falls back to the containing function", async () => {
    const { referenceSyntaxContext } = await load("./src/tree-sitter-parse.ts");
    const input = `function run(payload: string) {
  try {
    consume(payload);
  } finally {
    cleanup();
  }
}
`;

    const context = await referenceSyntaxContext("typescript", input, 2, 12, "enclosing");
    assert.equal(context.startLine, 1);
    assert.equal(context.endLine, 7);
    assert.match(context.source, /^1 \| function run\(payload: string\) \{/);
    assert.match(context.source, /3 \|     consume\(payload\);/);
    assert.match(context.source, /7 \| \}$/);
    assert.doesNotMatch(context.source, /2 \|   try|finally|cleanup/);
});

test("references rejects list_symbols with location-only context", async () => {
    const { references } = await load("./src/nav.ts");
    await assert.rejects(
        references(
            { path: "sample.ts", line: 1, column: 1, context: "none", list_symbols: true },
            process.cwd(),
            async () => {
                throw new Error("server should not be reached");
            },
        ),
        /list_symbols requires context/,
    );
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
