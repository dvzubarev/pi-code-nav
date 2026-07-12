// Bash parseSymbols behavior.
//
// Bash is the deliberately-conservative language: the design doc
// (code_scan.md "Node types") finalized:
//   - `variable_name` → "var"        (e.g. $HOME, ${X})
//   - `word` child of `command_name` → "call"   (the command being invoked)
//   - everything else (bare `word` arguments, `string`, `subscript` indices)
//     → skipped (bare words are mostly arguments/literals, too noisy)
// And: "Do not block the tool on bash" — bash polish is deferred. These tests
// pin the conservative contract so a future polish doesn't silently change it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMap, assertEntry, assertNoEntry } from "./helpers.mjs";

test("command_name word → call (the invoked command)", async () => {
    const m = await parseMap("bash", "echo hello\n", { startLine: 1, endLine: 1 });
    assertEntry(m, "call", "echo", 1, 1);
    // `hello` is a bare word argument → skipped.
    assertNoEntry(m, "var", "hello");
    assertNoEntry(m, "call", "hello");
});

test("variable_name → var (filtered by default, includable)", async () => {
    const text = 'echo "${HOME}"\n';
    const def = await parseMap("bash", text, { startLine: 1, endLine: 1 });
    const withVar = await parseMap("bash", text, {
        startLine: 1,
        endLine: 1,
        roles: ["call", "var"],
    });
    assertEntry(def, "call", "echo", 1, 1);
    assertNoEntry(def, "var", "HOME");
    assertEntry(withVar, "call", "echo", 1, 1);
    assertEntry(withVar, "var", "HOME", 1, 9);
});

test("bare word arguments are skipped (not call, not var)", async () => {
    const text = "ls -la /tmp\n";
    const m = await parseMap("bash", text, {
        startLine: 1,
        endLine: 1,
        roles: ["call", "var"],
    });
    assertEntry(m, "call", "ls", 1, 1);
    // `-la` and `/tmp` are bare words → no rows.
    assertNoEntry(m, "var", "-la");
    assertNoEntry(m, "var", "/tmp");
    assertNoEntry(m, "call", "-la");
    assertNoEntry(m, "call", "/tmp");
});

test("assignment target is var (x=1)", async () => {
    const text = "x=1\n";
    const withVar = await parseMap("bash", text, {
        startLine: 1,
        endLine: 1,
        roles: ["var"],
    });
    // `x` is a variable_name (the assignment target) → var.
    assertEntry(withVar, "var", "x", 1, 1);
});

test("subscript index is skipped", async () => {
    // `arr[0]` — the index `0` is a subscript child; bare words/numbers in
    // subscripts are skipped per the conservative contract.
    const text = 'echo "${arr[0]}"\n';
    const m = await parseMap("bash", text, {
        startLine: 1,
        endLine: 1,
        roles: ["call", "var"],
    });
    assertEntry(m, "call", "echo", 1, 1);
    assertEntry(m, "var", "arr", 1, 9);
});

test("string contents are skipped (not misread as commands)", async () => {
    const text = 'echo "rm -rf /"\n';
    const m = await parseMap("bash", text, {
        startLine: 1,
        endLine: 1,
        roles: ["call", "var"],
    });
    assertEntry(m, "call", "echo", 1, 1);
    // `rm` is inside a string literal — must NOT become a call.
    assertNoEntry(m, "call", "rm");
    assertNoEntry(m, "var", "rm");
});

test("comment is skipped", async () => {
    const text = "# echo is a command but this is a comment\necho hi\n";
    const m = await parseMap("bash", text, { startLine: 1, endLine: 2 });
    // Only the real `echo` on line 2; the `echo` in the comment must not appear.
    assertEntry(m, "call", "echo", 2, 1);
    assertNoEntry(m, "var", "is");
    assertNoEntry(m, "var", "command");
});

test("bash fragment (command list) parses without wrapping", async () => {
    // No shebang, no enclosing function — just statements. tree-sitter
    // error-recovery handles it (the load-bearing snippet guarantee).
    // Pad so the fragment is genuinely at lines 5-6 of the text.
    const text = "\n".repeat(4) + "cd /tmp\nrm -f old.log\n";
    const m = await parseMap("bash", text, { startLine: 5, endLine: 6 });
    assertEntry(m, "call", "cd", 5, 1);
    assertEntry(m, "call", "rm", 6, 1);
    // `-f` and `old.log` are bare word args → skipped.
    assertNoEntry(m, "var", "f");
    assertNoEntry(m, "var", "old.log");
});

test("default role set drops var, keeps calls", async () => {
    const text = "x=1\necho $x\n";
    const def = await parseMap("bash", text, { startLine: 1, endLine: 2 });
    assertEntry(def, "call", "echo", 2, 1);
    // `x` (assignment target / variable expansion) is var → dropped by default.
    assertNoEntry(def, "var", "x");
});
