// End-to-end tests for the Python (ty) language server, via nav.*.
//
// These call the SAME nav.* functions index.ts uses, against a real ty server
// and real fixture files — verifying the full pipeline (nav → LspClient → ty →
// render.ts → text). Skipped when CODE_NAV_SKIP_E2E is set or ty isn't on PATH.
//
// Run:  npm run test:e2e

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nav, withWorkspace, serverAvailable, SHOULD_RUN_E2E } from "./e2e-helpers.mjs";

// Probe the server ONCE at module load (not as a test) so there's no stray
// child process lingering between tests. Each test skips itself if the probe
// failed. node:test runs tests in a file sequentially, so this is safe.
const skip = !SHOULD_RUN_E2E;
const tyOk = SHOULD_RUN_E2E ? await serverAvailable("python") : false;

// Probe whether the environment exposes third-party/stdlib roots for the
// qualified-name tests. Those tests need `typing` (stdlib), `cbor2` (an
// installed third-party), and `aiohttp` (a third-party with both a
// class-qualified method and a re-exported class — the two
// qualified-query edge cases) to be discoverable via
// $propagatedBuildInputs (the nix shell sets it; a bare venv/conda without
// it falls back to $PYTHONPATH). When the probe finds no roots, the
// third-party tests skip (green) instead of failing red — they're
// exercising env-dependent behavior. We check that at least one root is
// discoverable AND that `typing`/`cbor2`/`aiohttp` actually resolve as
// importable modules from those roots (cheap stat checks would be ideal,
// but importlib is the authoritative test). We approximate by checking the
// discovered roots contain `typing.py`, a `cbor2` package, and an `aiohttp`
// package somewhere; if the env is the project's own nix shell this is true.
async function thirdPartyAvailable() {
    if (!tyOk) return false;
    let roots = [];
    try {
        roots = await nav.discoverThirdPartyRoots("python", process.cwd());
    } catch {
        return false;
    }
    if (roots.length === 0) return false;
    // Confirm typing.py, cbor2/, and aiohttp/ exist under some root.
    const { stat } = await import("node:fs/promises");
    let hasTyping = false;
    let hasCbor2 = false;
    let hasAiohttp = false;
    for (const r of roots) {
        if (!hasTyping) {
            try { await stat(resolve(r, "typing.py")); hasTyping = true; } catch {}
        }
        if (!hasCbor2) {
            try { await stat(resolve(r, "cbor2")); hasCbor2 = true; } catch {}
            try { await stat(resolve(r, "cbor2.py")); hasCbor2 = true; } catch {}
        }
        if (!hasAiohttp) {
            try { await stat(resolve(r, "aiohttp")); hasAiohttp = true; } catch {}
        }
    }
    return hasTyping && hasCbor2 && hasAiohttp;
}
const thirdPartyOk = await thirdPartyAvailable();
// runOrSkip registers the test normally when the server is up, or as a skip
// (passing) test otherwise — so `npm run test:e2e` on a server-less machine
// reports green skips rather than red failures.
const runOrSkip = (name, fn) => (skip || !tyOk ? test.skip(name, fn) : test(name, fn));
// runOrSkipThirdParty: same as runOrSkip but ALSO requires the third-party/
// stdlib roots (typing + cbor2) to be discoverable — the qualified-name and
// bare-third-party tests assert env-dependent behavior that only holds in the
// project's nix shell. Elsewhere they'd fail red; this keeps them green skips.
const runOrSkipThirdParty = (name, fn) =>
    (skip || !tyOk || !thirdPartyOk ? test.skip(name, fn) : test(name, fn));

runOrSkip("code_outline on second.py shows classes/methods with signatures, ranges, docs", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        const out = await nav.outline({ path: "second.py" }, ws.root, ws.clientOf);
        const lines = out.split("\n");
        // Multi-line blocks: header line with kind+name+range on the first line,
        // then sub-lines `  signature:` and `  doc:`.
        assert.ok(
            lines.some((l) => /^Class Point  second\.py:\d+:\d+  range=\d+-\d+$/.test(l)),
            `Point header missing:\n${out}`,
        );
        assert.ok(
            lines.some((l) => /^Class TempC  second\.py:\d+:\d+  range=\d+-\d+$/.test(l)),
            `TempC header missing:\n${out}`,
        );
        // TempC's children (__init__, punintend) are indented two spaces.
        assert.ok(
            lines.some((l) => /^  Method punintend  second\.py:\d+:\d+  range=\d+-\d+$/.test(l)),
            `punintend header missing:\n${out}`,
        );
        // Doc snippets: TempC has `"""documentation of tempC"""` and punintend
        // has `"""Documentation of punintend """`. The `doc:` sub-line.
        assert.ok(
            lines.some((l) => /^  doc: documentation of tempC/.test(l)),
            `TempC doc snippet missing:\n${out}`,
        );
        assert.ok(
            lines.some((l) => /^    doc: Documentation of punintend/.test(l)),
            `punintend doc snippet missing:\n${out}`,
        );
        // code_outline keeps only structural kinds (class/method/function/...).
        // The module-level Constant GLOB (second.py:8) is dropped — no opt-out.
        // See docs/code_outline.md.
        assert.ok(
            !lines.some((l) => /Constant GLOB/.test(l)),
            `GLOB should be hidden (not a structural kind):\n${out}`,
        );
        // second.py has only 5 entries (< default limit 20) → no pagination
        // trailing message.
        assert.ok(
            !/more entries/.test(out),
            `small file should not paginate:\n${out}`,
        );
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_outline paginates: limit bounds rows and emits a trailing continue message", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // second.py has 5 kept entries (Point, __init__, TempC, __init__,
        // punintend). With limit=2, page 1 shows 2 rows + a trailing
        // `[N more entries in <path>. Use offset=<next> to continue.]` message
        // mirroring pi's `read` tool idiom.
        const out = await nav.outline(
            { path: "second.py", offset: 1, limit: 2 },
            ws.root,
            ws.clientOf,
        );
        const lines = out.split("\n");
        // Exactly 2 entry headers + their signature/doc sub-lines + 1 trailing message.
        // Count header lines (Kind name :range pattern) — not signature/doc sub-lines.
        const headerRows = lines.filter((l) => /\b\w+  second\.py:\d+:\d+  range=\d+-\d+$/.test(l));
        assert.equal(headerRows.length, 2, `expected 2 entry headers, got:\n${out}`);
        // Trailing message names the remaining count and the next offset.
        assert.match(
            out,
            /^\[3 more entries in second\.py\. Use offset=3 to continue\.\]$/m,
            `trailing continue message missing:\n${out}`,
        );
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_outline pagination continues at offset, re-emitting ancestor (cont.) mid-class", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // offset=4 lands on TempC's __init__ (entry 4 of 5), which is INSIDE
        // TempC (entry 3, on the previous page). The page must re-emit TempC
        // as a `(cont.)` context row at depth 0 so the indented __init__ /
        // punintend rows aren't orphaned. The context row carries the body
        // range but NO signature/docs (it was shown in full on page 1).
        const out = await nav.outline(
            { path: "second.py", offset: 4, limit: 2 },
            ws.root,
            ws.clientOf,
        );
        const lines = out.split("\n").filter((l) => l);
        // First line is the re-emitted ancestor context row.
        assert.match(
            lines[0],
            /^Class TempC  \(cont\.\)  second\.py:\d+:\d+  range=\d+-\d+$/,
            `expected TempC (cont.) context row first, got:\n${out}`,
        );
        // The context row must NOT carry a signature or docs column.
        assert.ok(!/docs:/.test(lines[0]), `context row should have no docs:\n${out}`);
        // Followed by the two entries at depth 1 (indented), each with
        // multi-line sub-lines (signature, doc). Find them by kind+name.
        assert.ok(
            lines.some((l) => /^  Constructor __init__ /.test(l)),
            `__init__ missing:\n${out}`,
        );
        assert.ok(
            lines.some((l) => /^  Method punintend /.test(l)),
            `punintend missing:\n${out}`,
        );
        // Last page (entry 5 is the final one) → no trailing message.
        assert.ok(!/more entries/.test(out), `last page should not paginate:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_outline offset past end returns a note (not a throw)", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // offset beyond the entry count is a soft empty-page result, not a
        // hard error — the file is readable, the language is known, so this
        // is NOT an isError path. The agent gets a note it can act on.
        const out = await nav.outline(
            { path: "second.py", offset: 999, limit: 10 },
            ws.root,
            ws.clientOf,
        );
        assert.match(
            out,
            /^\(offset 999 is past the end; 5 entries in second\.py\)$/,
            `past-end note missing:\n${out}`,
        );
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_search_symbol 'tempc' finds TempC with its identifier position", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // This is the exact workflow from the issue: `symbol tempc`.
        const out = await nav.symbol({ query: "tempc", language: "python" }, ws.root, ws.clientOf);
        // ty matches case-insensitively on the query prefix; the result row must
        // name TempC as a Class and point at its identifier (col 7 of its line).
        // renderSymbolInfo now emits `<path>:<line>:<col>` (grep-style).
        assert.match(out, /\[python\] Class TempC  .*second\.py:\d+:7/);
        // There must be no other-symbol rows (only TempC should match "tempc").
        const rows = out.split("\n").filter((l) => l.trim());
        for (const r of rows) assert.match(r, /TempC/, `unexpected row for "tempc" query: ${r}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkipThirdParty("code_search_symbol qualified 'typing.cast' finds stdlib cast", async () => {
    // Gated by thirdPartyOk (see probe at module load): requires typing
    // on the third-party roots (nix shell sets $propagatedBuildInputs).
    // Qualified query: the agent asks for `typing.cast` specifically. ty does
    // NOT support qualified names natively (querying "typing.cast" returns 0),
    // so the tool strips the qualifier, queries "cast", then filters to
    // exact-name matches whose module path matches `typing`. The stdlib
    // `typing.py` must be indexed (added as a workspace folder via
    // $propagatedBuildInputs) for this to return anything.
    const ws = await withWorkspace([]);
    try {
        await writeFile(resolve(ws.root, "pyproject.toml"), "[project]\nname='t'\nversion='0'\n");
        await writeFile(resolve(ws.root, "main.py"), "import typing\nx = typing.cast(int, 5)\n");
        const out = await nav.symbol(
            { query: "typing.cast", language: "python" },
            ws.root,
            ws.clientOf,
        );
        // Exactly one row, naming `cast` in typing.py. The trim note (if any)
        // starts with `#` and is not a data row.
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        assert.equal(rows.length, 1, `expected 1 row for typing.cast, got:\n${out}`);
        assert.match(rows[0], /\[python\] Function cast  .*typing\.py:\d+:\d+/);
    } finally {
        await ws.cleanup();
    }
});

runOrSkipThirdParty("code_search_symbol qualified 'cbor2.loads' finds the cbor2 function", async () => {
    // Gated by thirdPartyOk: requires cbor2 on the third-party roots.
    // Qualified query into an INSTALLED third-party package (cbor2). The
    // function lives in `cbor2/_decoder.py`, so its module path is
    // `cbor2._decoder`; the qualifier `cbor2` matches as a package prefix.
    // Requires $propagatedBuildInputs to expose cbor2's site-packages (the
    // nix shell sets this); without it the test would return no symbols, so
    // we assert the cbor2 result is present and exact when env is present.
    const ws = await withWorkspace([]);
    try {
        await writeFile(resolve(ws.root, "pyproject.toml"), "[project]\nname='t'\nversion='0'\n");
        await writeFile(resolve(ws.root, "main.py"), "import cbor2\nx = cbor2.loads(b'')\n");
        const out = await nav.symbol(
            { query: "cbor2.loads", language: "python" },
            ws.root,
            ws.clientOf,
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        assert.equal(rows.length, 1, `expected 1 row for cbor2.loads, got:\n${out}`);
        assert.match(rows[0], /\[python\] Function loads  .*cbor2\/_decoder\.py:\d+:\d+/);
    } finally {
        await ws.cleanup();
    }
});

runOrSkipThirdParty("code_search_symbol bare 'loads' ranks cbor2.loads (third-party) at top", async () => {
    // Gated by thirdPartyOk: requires cbor2 on the third-party roots.
    // Bare query with NO workspace symbol named `loads`: the workspace-first
    // tier (T1) is empty, so third-party exact matches (T2) rank first —
    // cbor2.loads should appear before any fuzzy `load_*` stdlib noise. The
    // fuzzy tail is trimmed with a trailing note. (If cbor2 isn't on
    // propagatedBuildInputs the row won't appear; we assert that
    // IF a `loads` row in cbor2 appears, it is before any fuzzy row.)
    const ws = await withWorkspace([]);
    try {
        await writeFile(resolve(ws.root, "pyproject.toml"), "[project]\nname='t'\nversion='0'\n");
        await writeFile(resolve(ws.root, "main.py"), "import cbor2\nx = cbor2.loads(b'')\n");
        const out = await nav.symbol(
            { query: "loads", language: "python" },
            ws.root,
            ws.clientOf,
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        // All exact-name `loads` rows must appear before any non-exact row.
        // (Fuzzy rows like `load_package_tests` have a different name.)
        let seenFuzzy = false;
        for (const r of rows) {
            const isExact = /\] Function loads  |\] Variable loads  |\] Field loads  /.test(r);
            if (!isExact) seenFuzzy = true;
            if (isExact && seenFuzzy) {
                assert.fail(`exact 'loads' row after a fuzzy row:\n${out}`);
            }
        }
        // And the cbor2 one specifically should be present and first.
        const cbor2Idx = rows.findIndex((r) => r.includes("cbor2/_decoder.py"));
        assert.ok(cbor2Idx >= 0, `cbor2.loads missing from:\n${out}`);
        assert.equal(cbor2Idx, 0, `cbor2.loads should be the first row:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_search_symbol bare 'mymethod' returns ONLY the workspace symbol", async () => {
    // Bare query where the workspace HAS the symbol: T1 (workspace exact) is
    // non-empty, so ALL third-party fuzzy noise is dropped — the agent's bare
    // name refers to their own symbol. This is the regression guard for the
    // `tempc`-style flood that motivated the workspace-first tiering.
    const ws = await withWorkspace([]);
    try {
        await writeFile(resolve(ws.root, "pyproject.toml"), "[project]\nname='t'\nversion='0'\n");
        await writeFile(
            resolve(ws.root, "main.py"),
            "import cbor2, typing\nclass MyThing:\n    def mymethod(self): pass\n",
        );
        const out = await nav.symbol(
            { query: "mymethod", language: "python" },
            ws.root,
            ws.clientOf,
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        assert.equal(rows.length, 1, `expected ONLY the workspace mymethod, got:\n${out}`);
        assert.match(rows[0], /\[python\] Method mymethod  .*main\.py:\d+:\d+/);
    } finally {
        await ws.cleanup();
    }
});

runOrSkipThirdParty("code_search_symbol qualified 'aiohttp.StreamReader.iter_chunks' finds the method", async () => {
    // Gated by thirdPartyOk: requires aiohttp on the third-party roots.
    // Regression guard for a qualified query whose qualifier contains a CLASS
    // name (not a module): `iter_chunks` is a method of class `StreamReader`,
    // defined in `aiohttp/streams.py` (module path `aiohttp.streams`). The
    // qualifier `aiohttp.StreamReader` is NOT a module path, so the precise
    // module-path match (Q1) misses; the leading-component fallback (Q2)
    // matches on the shared `aiohttp` prefix. Before the fix this returned
    // `(no symbols matching ...)`. ty indexes methods, so the method IS
    // returned; the case-sensitive name match also drops the lowercase
    // `request` methods that ty's fuzzy search returns for a `Request` query
    // (not relevant here, but the same guard).
    const ws = await withWorkspace([]);
    try {
        await writeFile(resolve(ws.root, "pyproject.toml"), "[project]\nname='t'\nversion='0'\n");
        await writeFile(
            resolve(ws.root, "main.py"),
            "import aiohttp\nasync def f():\n    r = aiohttp.StreamReader()\n    async for c in r.iter_chunks(): pass\n",
        );
        const out = await nav.symbol(
            { query: "aiohttp.StreamReader.iter_chunks", language: "python" },
            ws.root,
            ws.clientOf,
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        // Exactly one `iter_chunks` row in aiohttp/streams.py. The trim note
        // (if any) starts with `#` and is not a data row.
        const dataRows = rows.filter((l) => !l.startsWith("[python] #"));
        assert.equal(dataRows.length, 1, `expected 1 row for iter_chunks, got:\n${out}`);
        assert.match(
            dataRows[0],
            /\[python\] Method iter_chunks  .*aiohttp\/streams\.py:\d+:\d+/,
        );
    } finally {
        await ws.cleanup();
    }
});

runOrSkipThirdParty("code_search_symbol qualified 'aiohttp.web.Request' finds the re-exported class", async () => {
    // Gated by thirdPartyOk: requires aiohttp on the third-party roots.
    // Regression guard for a qualified query where the symbol is DEFINED in a
    // submodule whose name shares a prefix with the qualifier but is NOT a
    // dotted child of it: `Request` is defined in `aiohttp/web_request.py`
    // (module path `aiohttp.web_request`), but accessed as `aiohttp.web.Request`
    // because `aiohttp/web.py` re-exports it. The precise match (Q1) misses
    // because `aiohttp.web_request` does NOT `.startsWith("aiohttp.web.")`
    // (the `_` breaks the `.` boundary); the leading-component fallback (Q2)
    // matches on the shared `aiohttp` prefix. Before the fix this returned
    // `(no symbols matching ...)`. The class `Request` (capital R) must be
    // present; lowercase `request` methods are dropped by the case-sensitive
    // name match for qualified queries.
    const ws = await withWorkspace([]);
    try {
        await writeFile(resolve(ws.root, "pyproject.toml"), "[project]\nname='t'\nversion='0'\n");
        await writeFile(
            resolve(ws.root, "main.py"),
            "import aiohttp.web\nasync def f(): req = aiohttp.web.Request(...)\n",
        );
        const out = await nav.symbol(
            { query: "aiohttp.web.Request", language: "python" },
            ws.root,
            ws.clientOf,
        );
        const rows = out.split("\n").filter((l) => l.startsWith("[python]"));
        const dataRows = rows.filter((l) => !l.startsWith("[python] #"));
        // The class `Request` in aiohttp/web_request.py MUST be present.
        assert.ok(
            dataRows.some((r) => /\[python\] Class Request  .*aiohttp\/web_request\.py:\d+:\d+/.test(r)),
            `class Request in web_request.py missing from:\n${out}`,
        );
        // Lowercase `request` methods (case-variant noise) must NOT appear —
        // a qualified query is case-sensitive on the bare tail.
        assert.ok(
            !dataRows.some((r) => /\] (Method|Function) request  /.test(r)),
            `lowercase 'request' methods should be dropped (case-sensitive qualified match):\n${out}`,
        );
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_definition on punintend returns its body", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // punintend is at second.py:24:9 (1-based) per code_outline. definition
        // should resolve the enclosing body and return the verbatim source.
        const out = await nav.definition(
            { path: "second.py", line: 24, column: 9 },
            ws.root,
            ws.clientOf,
        );
        // New output format: header `<defPath>:<sl>-<el>` then raw source (no fence).
        const lines = out.split("\n");
        assert.match(
            lines[0],
            /second\.py:\d+-\d+$/,
            `header should be <defPath>:<sl>-<el>, got:\n${out}`,
        );
        assert.match(out, /def punintend/, `punintend body missing:\n${out}`);
        // The docstring should be inside the resolved body extent.
        assert.match(out, /Documentation of punintend/);
        // No code fence — the body is raw source ready for editing.
        assert.ok(!/^```$/m.test(out), `body should have no code fence:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

// ---------------------------------------------------------------------------
// code_definition: Python coverage.
//
// These tests pin code_definition's behavior across the cases that matter for
// Python (ty): cursor on a top-level def, cursor on a class definition, cursor
// on a method inside a class, and cursor on a CALL SITE (which must jump to
// the def — verifying the documentSymbol fast path does not wrongly
// short-circuit when the cursor is on a use, not a def).
//
// Fixture: test/fixtures/defs.py — positions verified by probing ty directly.
// Python function bodies rarely contain `{` (only dict/set literals), so
// snippetHasBody returns false for most bodies → the documentSymbol fast path
// falls through to textDocument/definition (ty doesn't bounce, so this is
// correct). A few bodies here DO contain `{` (dict literal, f-string interp)
// which exercises the short-circuit path too.
// ---------------------------------------------------------------------------

runOrSkip("code_definition on top-level def returns body + docstring", async () => {
    const ws = await withWorkspace(["defs.py"]);
    try {
        // make_config is at defs.py:28:5 (1-based) per code_outline. The body
        // spans lines 28-30 (def, docstring, return with dict literal).
        const out = await nav.definition(
            { path: "defs.py", line: 28, column: 5 },
            ws.root,
            ws.clientOf,
        );
        const lines = out.split("\n");
        assert.match(lines[0], /defs\.py:\d+-\d+$/, `header shape wrong:\n${out}`);
        assert.match(out, /def make_config/, `def line missing:\n${out}`);
        assert.match(out, /Build a default config/, `docstring missing:\n${out}`);
        assert.match(out, /"timeout"/, `dict-return body missing:\n${out}`);
        assert.ok(!/^```$/m.test(out), `should have no code fence:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_definition on class def returns whole class body", async () => {
    const ws = await withWorkspace(["defs.py"]);
    try {
        // Greeter is at defs.py:33:7. Its body spans the whole class
        // (lines 33-44): docstring, __init__, greet, config.
        const out = await nav.definition(
            { path: "defs.py", line: 33, column: 7 },
            ws.root,
            ws.clientOf,
        );
        const lines = out.split("\n");
        assert.match(lines[0], /defs\.py:33-\d+$/, `should start at line 33:\n${out}`);
        assert.match(out, /class Greeter/, `class line missing:\n${out}`);
        // The class body should include all its members.
        assert.match(out, /def __init__/, `__init__ missing from class body:\n${out}`);
        assert.match(out, /def greet/, `greet missing from class body:\n${out}`);
        assert.match(out, /def config/, `config missing from class body:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_definition on method inside class returns method body only", async () => {
    const ws = await withWorkspace(["defs.py"]);
    try {
        // greet is at defs.py:39:9 (1-based). Its body spans lines 39-41
        // (def, docstring, return with f-string). Crucially, the resolved
        // range should be JUST the method, not the whole enclosing class —
        // this verifies documentSymbol's hierarchical selectionRange narrows
        // to the right child, not the parent class.
        const out = await nav.definition(
            { path: "defs.py", line: 39, column: 9 },
            ws.root,
            ws.clientOf,
        );
        const lines = out.split("\n");
        assert.match(lines[0], /defs\.py:39-\d+$/, `should start at line 39:\n${out}`);
        assert.match(out, /def greet/, `greet def missing:\n${out}`);
        assert.match(out, /Return the greeting/, `greet docstring missing:\n${out}`);
        // The body should NOT include the __init__ or config methods — only greet.
        assert.ok(!/def __init__/.test(out), `should not include __init__:\n${out}`);
        assert.ok(!/def config/.test(out), `should not include config:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_definition on call site jumps to the def (not the call)", async () => {
    const ws = await withWorkspace(["defs.py"]);
    try {
        // `make_config()` is CALLED inside Greeter.config at defs.py:44:16
        // (1-based). code_definition here must NOT short-circuit (the cursor
        // is on a call, not a def) — it must fall through to
        // textDocument/definition, which jumps to make_config's def at 28:5.
        // This is the key test for the documentSymbol fast path's gate: the
        // enclosing symbol at the cursor is Greeter.config (a method), but its
        // selectionRange doesn't match the cursor, so step 0 falls through.
        const out = await nav.definition(
            { path: "defs.py", line: 44, column: 16 },
            ws.root,
            ws.clientOf,
        );
        const lines = out.split("\n");
        // The header should point at make_config's def range (starting line 28),
        // NOT the call site at line 44.
        assert.match(lines[0], /defs\.py:28-\d+$/, `should jump to make_config def (line 28), got:\n${out}`);
        assert.match(out, /def make_config/, `should show make_config body:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_definition on class call site jumps to class def", async () => {
    const ws = await withWorkspace(["defs.py"]);
    try {
        // `Greeter("world")` is called inside use_all at defs.py:48:9 (1-based).
        // code_definition should jump to the Greeter class def at 33:7.
        const out = await nav.definition(
            { path: "defs.py", line: 48, column: 9 },
            ws.root,
            ws.clientOf,
        );
        const lines = out.split("\n");
        assert.match(lines[0], /defs\.py:33-\d+$/, `should jump to Greeter class def (line 33), got:\n${out}`);
        assert.match(out, /class Greeter/, `should show Greeter class body:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_hover on Point.__init__ signature shows x param", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // __init__ is at second.py:11:9 (the `def`). Hovering there should
        // surface the signature, which mentions the `x` parameter.
        const out = await nav.hover(
            { path: "second.py", line: 11, column: 9 },
            ws.root,
            ws.clientOf,
        );
        assert.ok(out.length > 0, "hover returned empty text");
        // ty returns a signature like __init__(self, x: int = 0, y: int = 0) -> None
        assert.match(out, /x\s*:\s*int/i, `x param missing from hover:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_hover emits a signature-first line before the markdown body", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // Hovering __init__ (second.py:11:9) should emit a collapsed one-line
        // signature as the first line (prefixed `signature: `), BEFORE the
        // raw markdown body. This surfaces structured signature info that would
        // otherwise be buried inside a ```python fence.
        const out = await nav.hover(
            { path: "second.py", line: 11, column: 9 },
            ws.root,
            ws.clientOf,
        );
        const firstLine = out.split("\n")[0];
        assert.match(
            firstLine,
            /^signature: /,
            `first line should be the signature line, got:\n${out}`,
        );
        // The signature line should mention the x param (collapsed from the
        // multi-line fenced signature ty returns).
        assert.match(firstLine, /x\s*:\s*int/i, `x param missing from signature line:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_references on Point class lists __init__ usages", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // Point is defined at second.py:10:7. Its references include its use as
        // a default parameter in TempC.__init__ (p: Point = Point()).
        const out = await nav.references(
            { path: "second.py", line: 10, column: 7 },
            ws.root,
            ws.clientOf,
        );
        // The count is now a trailing `# N references` comment (trivially
        // ignorable), not a leading `N reference(s):` glue line. At least one
        // reference row should be present (the def itself, plus the default-arg
        // usage and the call in TempC.__init__).
        assert.match(out, /# \d+ references$/, `trailing count comment missing:\n${out}`);
        // renderLocation now emits `<path>:<line>:<col>` (grep-style,
        // single position instead of a start - end range).
        const rows = out
            .split("\n")
            .filter((l) => /second\.py:\d+:\d+/.test(l));
        assert.ok(rows.length >= 1, `no reference rows:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});

runOrSkip("code_diagnostics on a file with a type error reports an error", async () => {
    const ws = await withWorkspace(["second.py"]);
    try {
        // Introduce a real type error: call punintend with a bad arg type.
        const bad = resolve(ws.root, "bad.py");
        await writeFile(bad, "import second\nsecond.Point('not an int')\n", "utf8");
        const out = await nav.diagnostics({ path: "bad.py" }, ws.root, ws.clientOf);
        // ty should report at least one diagnostic (error severity is common
        // for an int-vs-str mismatch, but be lenient — just require *a* diag).
        assert.match(out, /\d+ diagnostic\(s\) for bad\.py:/, `diagnostic header missing:\n${out}`);
    } finally {
        await ws.cleanup();
    }
});
