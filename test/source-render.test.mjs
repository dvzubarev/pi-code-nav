import assert from "node:assert/strict";
import test from "node:test";
import { loadParse } from "./helpers.mjs";

test("renderNumberedSource keeps source verbatim and adds line-local symbols", async () => {
    const { renderNumberedSource } = await loadParse();
    const source = ["ignored", "  return build(value);", "}"].join("\n");
    const out = renderNumberedSource(source, 2, 3, [
        { name: "build", role: "call", line: 2, column: 10 },
        { name: "value", role: "var", line: 2, column: 16 },
    ]);
    assert.equal(
        out,
        "2 |   return build(value);\n" + "  | symbols: build@10 call, value@16 var\n" + "3 | }",
    );
});

test("annotateNumberedSource annotates only symbols visible in a partial line", async () => {
    const { annotateNumberedSource } = await loadParse();
    const source = "before(); target(arg); after();";
    const out = annotateNumberedSource("1 | target(arg)", source, [
        { name: "before", role: "call", line: 1, column: 1 },
        { name: "target", role: "call", line: 1, column: 11 },
        { name: "arg", role: "var", line: 1, column: 18 },
        { name: "after", role: "call", line: 1, column: 24 },
    ]);
    assert.equal(out, "1 | target(arg)\n  | symbols: target@11 call, arg@18 var");
});
