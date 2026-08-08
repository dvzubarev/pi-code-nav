// Core behavior of parseSymbols + helpers, language-agnostic.
//
// Covers: tsLangForFile, default role set, role filtering, occurrence
// preservation, absolute-position math (1-based conversion), empty
// ranges, the renderSymbolTable format, and hoverFirstLine.
//
// IMPORTANT: parseSymbols(lang, opts) takes the text INSIDE opts (opts.text),
// and slices that text by [startLine, endLine] (1-based). So startLine must
// refer to a line that actually exists in `text` — to test "a symbol at line
// 43", pad the text with blank lines rather than passing a 1-line string with
// startLine=43 (that yields an empty slice). The output line is
// startLine + treeRow (1-based), and the column is treeColumn + 1.
//
// Run:  npm run test:unit -- test/core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadParse, parseMap, parseList, assertEntry, assertNoEntry } from "./helpers.mjs";

test("tsLangForFile maps extensions to TsLang", async () => {
    const { tsLangForFile } = await loadParse();
    assert.equal(tsLangForFile("foo.py"), "python");
    assert.equal(tsLangForFile("foo.cpp"), "cpp");
    assert.equal(tsLangForFile("foo.h"), "cpp");
    assert.equal(tsLangForFile("foo.hpp"), "cpp");
    assert.equal(tsLangForFile("foo.c"), "cpp");
    assert.equal(tsLangForFile("foo.sh"), "bash");
    assert.equal(tsLangForFile("foo.bash"), "bash");
    assert.equal(tsLangForFile("foo.txt"), null);
    assert.equal(tsLangForFile("Makefile"), null); // no extension
});

test("DEFAULT_SYMBOL_ROLES omits var", async () => {
    const { DEFAULT_SYMBOL_ROLES } = await loadParse();
    assert.deepEqual([...DEFAULT_SYMBOL_ROLES], ["type", "call", "member", "import"]);
    assert.ok(!DEFAULT_SYMBOL_ROLES.includes("var"));
});

test("var is omitted by default but includable via roles", async () => {
    const text = "x = 1\ny = 2\n";
    const def = await parseMap("python", text, { startLine: 1, endLine: 2 });
    const withVar = await parseMap("python", text, {
        startLine: 1,
        endLine: 2,
        roles: ["type", "call", "member", "import", "var"],
    });
    // `x` and `y` are assignment targets → role var.
    assertNoEntry(def, "var", "x");
    assertNoEntry(def, "var", "y");
    assertEntry(withVar, "var", "x", 1, 1);
    assertEntry(withVar, "var", "y", 2, 1);
});

test("roles narrows the emitted set", async () => {
    const text = "import cbor2\nx = cbor2.load(data)\n";
    const onlyImport = await parseList("python", text, {
        startLine: 1,
        endLine: 2,
        roles: ["import"],
    });
    // Only the import row remains (cbor2 on line 1 at the import statement).
    assert.deepEqual(onlyImport, ["import\tcbor2\t1:8"]);
});

test("every symbol occurrence is preserved", async () => {
    // Pad blank lines so the content genuinely sits at lines 10-12.
    const text = "\n".repeat(9) + "load(x)\nload(y)\nload(z)\n";
    const entries = await parseList("python", text, {
        startLine: 10,
        endLine: 12,
        roles: ["call"],
    });
    assert.deepEqual(entries, ["call\tload\t10:1", "call\tload\t11:1", "call\tload\t12:1"]);
});

test("absolute position math: startLine offsets row, column is 1-based", async () => {
    // `cbor2` in `import cbor2` sits at column 8 (0-based 7 → 1-based 8). Pad
    // blank lines so the import genuinely sits on line 43 of the text.
    const text = "\n".repeat(42) + "import cbor2\n"; // cbor2 on line 43
    const m = await parseMap("python", text, { startLine: 43, endLine: 43 });
    assertEntry(m, "import", "cbor2", 43, 8);
});

test("endLine < startLine yields an empty slice (no rows, no throw)", async () => {
    const { parseSymbols } = await loadParse();
    // parseSymbols slices `text` by [startLine-1, endLine); a reversed range is
    // a 0-length slice → []. The tool layer (index.ts) is what rejects bad
    // ranges (endLine >= startLine guard); parseSymbols itself is benign.
    const entries = await parseSymbols("python", { text: "x = 1\n", startLine: 2, endLine: 1 });
    assert.deepEqual(entries, []);
});

test("empty range yields []", async () => {
    const { parseSymbols } = await loadParse();
    const entries = await parseSymbols("python", { text: "x = 1\n", startLine: 99, endLine: 100 });
    assert.deepEqual(entries, []);
});

test("unsupported language is reported via tsLangForFile (the real gate)", async () => {
    // parseSymbols is typed to TsLang; the public gate is tsLangForFile.
    const { tsLangForFile } = await loadParse();
    assert.equal(tsLangForFile("foo.unknownext"), null);
});

test("renderSymbolTable format is the documented header + rows", async () => {
    const { parseSymbols, renderSymbolTable } = await loadParse();
    const entries = await parseSymbols("python", {
        text: "import cbor2\n",
        startLine: 1,
        endLine: 1,
        roles: ["import"],
    });
    const out = renderSymbolTable("widget.py", 1, 1, entries);
    // Header carries the full path once + a role legend; rows emit only
    // `:line:col` (the header path + row :line:col reconstructs the position).
    assert.match(
        out,
        /^Symbols in widget\.py:1-1 \(roles: type\|call\|member\|import\|var, 1-based, reusable as code_\* input\):/,
    );
    // The row layout: "  <role pad6> <name>  :<line>:<col>" — path is NOT
    // repeated per row (it's in the header).
    assert.match(out, /  import cbor2\s+:1:8/);
    // The full path must NOT appear on the data row (only in the header).
    assert.ok(!/import cbor2\s+widget\.py:1:8/.test(out), `row should not repeat the path:\n${out}`);
});

test("renderSymbolTable empty case", async () => {
    const { renderSymbolTable } = await loadParse();
    const out = renderSymbolTable("x.py", 1, 1, []);
    assert.match(out, /\(no identifiers found\)/);
});

test("renderSymbolTable with docs label column", async () => {
    const { renderSymbolTable } = await loadParse();
    const entries = [{ role: "call", name: "load", line: 2, column: 5 }];
    const docs = new Map([["load|call", "(load) -> Any"]]);
    const out = renderSymbolTable("x.py", 1, 2, entries, docs);
    // Row carries only `:line:col` (path is in the header), then the docs label.
    assert.match(out, /load\s+:2:5  \(load\) -> Any/);
});

test("hoverFirstLine skips fences and blanks, truncates", async () => {
    const { hoverFirstLine } = await loadParse();
    assert.equal(hoverFirstLine("```python\ndef load():\n```"), "def load():");
    assert.equal(hoverFirstLine("\n\n  hi  "), "hi");
    // Truncation at 80 chars (79 + ellipsis).
    const long = "x".repeat(100);
    assert.equal(hoverFirstLine(long).length, 80);
    assert.ok(hoverFirstLine(long).endsWith("…"));
    assert.equal(hoverFirstLine(""), "");
    assert.equal(hoverFirstLine("```"), ""); // only a fence → nothing
});

test("tree-sitter parses raw function-body fragments without wrapping", async () => {
    // The design doc's load-bearing guarantee: a dedented function body (no
    // enclosing `def`) parses without error and still classifies identifiers.
    // This is exactly the shape code_definition's snippet output takes.
    // NOTE: there is no `import` line here, so `cbor2` is the `object` field of
    // the attribute access → var (the import role only attaches at an import
    // statement, not at a usage site).
    const body = "    result = cbor2.load(data)\n    return result\n";
    const entries = await parseList("python", body, {
        startLine: 1,
        endLine: 2,
        roles: ["member", "var"],
    });
    assert.ok(entries.includes("var\tresult\t1:5"));
    assert.ok(entries.includes("var\tresult\t2:12"));
    assert.ok(entries.includes("var\tcbor2\t1:14"));
    assert.ok(entries.includes("member\tload\t1:20"));
    assert.ok(entries.includes("var\tdata\t1:25"));
});

test("comment and string noise is excluded (the regex-killer case)", async () => {
    // Straight from code_scan.md "Why tree-sitter and not regex":
    //   # TODO: fix the load function
    //   msg = "sort the data and check size"
    //   x = cbor2.load(data)  # use load not loads
    // `load`/`sort`/`size`/`function` in comments/strings must NOT appear.
    const text = [
        "# TODO: fix the load function",
        'msg = "sort the data and check size"',
        "x = cbor2.load(data)  # use load not loads",
    ].join("\n");
    const m = await parseMap("python", text, {
        startLine: 1,
        endLine: 3,
        roles: ["type", "call", "member", "import", "var"],
    });
    // The real identifiers: msg, x, cbor2 (var — usage, not import), load (member), data.
    assertEntry(m, "var", "msg", 2, 1);
    assertEntry(m, "var", "x", 3, 1);
    assertEntry(m, "var", "cbor2", 3, 5);
    assertEntry(m, "member", "load", 3, 11);
    assertEntry(m, "var", "data", 3, 16);
    // Tokens that appear ONLY in comments/strings must be absent.
    assertNoEntry(m, "var", "sort");
    assertNoEntry(m, "var", "size");
    assertNoEntry(m, "var", "function");
    // `load` is a member here, never a call; comment occurrences don't spawn rows.
    assertNoEntry(m, "call", "load");
});
