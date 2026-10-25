// Qualified-name regression tests through the public pipeline, without servers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "./helpers.mjs";

const { symbol } = await load("./src/symbol.ts");

function node(name, line, children = [], kind = 5) {
    const start = { line, character: 0 };
    return {
        name,
        kind,
        range: { start, end: { line: line + (children.length ? 20 : 0), character: 80 } },
        selectionRange: {
            start: { line, character: 4 },
            end: { line, character: 4 + name.length },
        },
        children,
    };
}

async function setup(t, language = "python") {
    const dir = await mkdtemp(resolve(tmpdir(), "code-nav-dotted-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const root = resolve(dir, "workspace");
    const dependency = resolve(dir, "dependency");
    const trees = new Map();
    const calls = new Map();
    const rows = [];
    const containers = [];
    const queryResults = new Map();
    const queries = [];
    const client = {
        rootPath: root,
        supports: () => true,
        ensureProjectLoaded: async () => true,
        addWorkspaceFolders: async () => {},
        workspaceFolderPaths: () => [dependency, root],
        workspaceSymbol: async (query) => {
            queries.push(query);
            if (queryResults.has(query)) {
                const value = queryResults.get(query);
                if (value instanceof Error) throw value;
                return value;
            }
            return [...rows, ...containers].filter((s) =>
                s.name.toLowerCase().includes(query.toLowerCase()),
            );
        },
        documentSymbols: async (path) => {
            calls.set(path, (calls.get(path) ?? 0) + 1);
            const value = trees.get(path);
            if (value instanceof Error) throw value;
            return value ?? [];
        },
        openDocument: async () => {},
        ensureDocumentReady: async () => {},
        references: async () => [],
    };
    async function file(rel, tree, { external = false, name = "items", lines = [2] } = {}) {
        const path = resolve(external ? dependency : root, rel);
        await mkdir(dirname(path), { recursive: true });
        // Real source permits identifier fallback and include:references.
        await writeFile(path, Array.from({ length: 30 }, () => "def items(): pass").join("\n"));
        trees.set(path, tree);
        function indexContainers(nodes) {
            for (const s of nodes) {
                if ([2, 3, 5, 10, 11, 23].includes(s.kind) || s.children?.length) {
                    containers.push({
                        name: s.name,
                        kind: s.kind,
                        location: { uri: pathToFileURL(path).href, range: s.range },
                    });
                }
                indexContainers(s.children ?? []);
            }
        }
        if (Array.isArray(tree)) indexContainers(tree);
        for (const line of lines)
            rows.push({
                name,
                kind: 6,
                location: {
                    uri: pathToFileURL(path).href,
                    range: {
                        start: { line, character: 0 },
                        end: { line, character: 10 },
                    },
                },
            });
        return path;
    }
    const search = (query, extra = {}) =>
        symbol({ query, language, ...extra }, root, async () => client);
    return { root, file, search, calls, queries, containers, queryResults };
}

for (const language of ["python", "typescript"]) {
    test(`${language}: Class.items excludes sibling classes, top-level and stdlib names before references fan-out`, async (t) => {
        const f = await setup(t, language);
        const ext = language === "python" ? "py" : "ts";
        const path = await f.file(
            `records.${ext}`,
            [
                node("LazyRecords", 0, [node("items", 2, [], 6)]),
                node("OtherRecords", 21, [node("items", 23, [], 6)]),
            ],
            { lines: [2, 23] },
        );
        await f.file(`standalone.${ext}`, [node("items", 2, [], 12)]);
        await f.file(`collections.${ext}`, [node("Mapping", 0, [node("items", 2, [], 6)])], {
            external: true,
        });
        const out = await f.search("LazyRecords.items", { include: ["references"] });
        assert.match(out, /^# 1 match for "LazyRecords.items" — include: references/m);
        assert.match(out, /records\.(py|ts):3:5/);
        assert.match(out, /--- references ---/);
        assert.doesNotMatch(out, /standalone|collections|:24:|ERROR/);
        assert.deepEqual(f.queries, ["items", "LazyRecords"]);
        assert.equal(f.calls.get(path), 1, "ranking and selection lookup share the tree");
        assert.deepEqual([...f.calls.keys()], [path], "unrelated files must never be opened");
    });
}

test("nested and module-qualified containers retain every overload, not similarly named classes", async (t) => {
    const f = await setup(t);
    await f.file(
        "pkg/records.py",
        [node("Outer", 0, [node("Inner", 1, [node("items", 2, [], 6), node("items", 4, [], 6)])])],
        { lines: [2, 4] },
    );
    await f.file("other/records.py", [
        node("Outer", 0, [node("Inner", 1, [node("items", 2, [], 6)])]),
    ]);
    await f.file("pkg/wrong.py", [node("MyInner", 0, [node("items", 2, [], 6)])]);
    for (const query of ["Outer.Inner.items", "Inner.items", "pkg.records.Outer.Inner.items"]) {
        const out = await f.search(query);
        const rows = out.split("\n").filter((s) => s.startsWith("[python]"));
        assert.equal(rows.length, query.startsWith("pkg.") ? 2 : 3, out);
        assert.doesNotMatch(out, /wrong\.py/);
        if (query.startsWith("pkg.")) assert.doesNotMatch(out, /other[/\\]records/);
    }
});

test("unknown or case-mismatched containers return empty, not unrelated bare-name matches", async (t) => {
    const f = await setup(t);
    await f.file("pkg/records.py", [node("LazyRecords", 0, [node("items", 2, [], 6)])]);
    for (const query of [
        "Missing.items",
        "lazyrecords.items",
        "pkg.Missing.items",
        "NotLazyRecords.items",
    ]) {
        assert.equal(
            await f.search(query, { include: ["references"] }),
            `(no symbols matching "${query}")`,
        );
    }
});

test("package re-exports retain the requested class and discard same-named methods in other classes", async (t) => {
    const f = await setup(t);
    await f.file("aiohttp/streams.py", [node("StreamReader", 0, [node("items", 2, [], 6)])], {
        external: true,
    });
    await f.file("aiohttp/wrong.py", [node("OtherReader", 0, [node("items", 2, [], 6)])], {
        external: true,
    });
    const out = await f.search("aiohttp.StreamReader.items");
    assert.match(out, /streams\.py:3:5/);
    assert.doesNotMatch(out, /wrong\.py/);
    await f.file("aiohttp/web_request.py", [node("Request", 2)], {
        external: true,
        name: "Request",
    });
    assert.match(await f.search("aiohttp.web.Request"), /web_request\.py:3:5/);
});

test("failed, empty and flat document-symbol responses do not invent container matches", async (t) => {
    const f = await setup(t);
    const path = await f.file("failed.py", new Error("documentSymbol unsupported"), {
        lines: [2, 4],
    });
    await f.file("empty.py", []);
    await f.file("flat.py", [
        {
            name: "items",
            kind: 6,
            containerName: "LazyRecords",
            location: {
                uri: "file:///flat.py",
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } },
            },
        },
    ]);
    assert.equal(await f.search("LazyRecords.items"), '(no symbols matching "LazyRecords.items")');
    assert.equal(f.calls.get(path), 1, "failed lookups are cached across candidates");
});

test("module-only qualification still works without hierarchical symbols", async (t) => {
    const f = await setup(t);
    await f.file("pkg/records.py", new Error("unsupported"));
    await f.file("other.py", []);
    const out = await f.search("pkg.records.items");
    assert.match(out, /pkg[/\\]records\.py:3:5/);
    assert.doesNotMatch(out, /other\.py/);
    assert.deepEqual(f.queries, ["items"], "module matching skips the container search");
});

test("bare queries retain workspace-first behavior without ancestry lookups for rejected hits", async (t) => {
    const f = await setup(t);
    const own = await f.file("own.py", [node("items", 2, [], 12)]);
    const external = await f.file("external.py", [], { external: true });
    const out = await f.search("items");
    assert.match(out, /own\.py/);
    assert.doesNotMatch(out, /external\.py/);
    assert.equal(f.calls.get(own), 1);
    assert.equal(f.calls.has(external), false);
});

test("container extents reject same-file sibling members before document-symbol loading", async (t) => {
    const f = await setup(t);
    await f.file(
        "records.py",
        [
            node("LazyRecords", 0, [node("different", 2, [], 6)]),
            node("Other", 21, [node("items", 23, [], 6)]),
        ],
        { lines: [23] },
    );
    assert.equal(await f.search("LazyRecords.items"), '(no symbols matching "LazyRecords.items")');
    assert.equal(f.calls.size, 0, "the range prefilter needs no file contents");
});

test("identifier-only container ranges narrow by file without rejecting real members", async (t) => {
    const f = await setup(t);
    const path = await f.file("records.py", [node("LazyRecords", 0, [node("items", 2, [], 6)])]);
    await f.file("unrelated.py", [node("Other", 0, [node("items", 2, [], 6)])]);
    f.containers.find((s) => s.name === "LazyRecords").location.range = {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 17 },
    };
    assert.match(await f.search("LazyRecords.items"), /records\.py:3:5/);
    assert.deepEqual([...f.calls.keys()], [path]);
});

test("a known container with no member candidates in its files needs no document requests", async (t) => {
    const f = await setup(t);
    await f.file("empty.py", [node("LazyRecords", 0)], { lines: [] });
    await f.file("elsewhere.py", [node("Other", 0, [node("items", 2, [], 6)])]);
    assert.equal(await f.search("LazyRecords.items"), '(no symbols matching "LazyRecords.items")');
    assert.equal(f.calls.size, 0);
});

for (const mode of ["empty", "unsupported", "import binding"]) {
    test(`container prefilter falls back safely for ${mode} search results`, async (t) => {
        const f = await setup(t);
        const path = await f.file("records.py", [
            node("LazyRecords", 0, [node("items", 2, [], 6)]),
        ]);
        await f.file("unrelated.py", [node("Other", 0, [node("items", 2, [], 6)])]);
        const result =
            mode === "unsupported"
                ? new Error("lookup failed")
                : mode === "empty"
                  ? []
                  : [
                        {
                            name: "LazyRecords",
                            kind: 13,
                            location: {
                                uri: pathToFileURL(resolve(f.root, "imports.py")).href,
                                range: {
                                    start: { line: 0, character: 0 },
                                    end: { line: 0, character: 11 },
                                },
                            },
                        },
                    ];
        f.queryResults.set("LazyRecords", result);
        const out = await f.search("LazyRecords.items");
        assert.match(out, /records\.py:3:5/);
        assert.doesNotMatch(out, /unrelated\.py|ERROR/);
        assert.equal(f.calls.get(path), 1);
        assert.equal(f.calls.size, 2, "only fallback mode scans all exact-name files");
    });
}

test("exact containers in workspace and dependencies both participate in the prefilter", async (t) => {
    const f = await setup(t);
    const own = await f.file("own.py", [node("LazyRecords", 0, [node("items", 2, [], 6)])]);
    const external = await f.file(
        "external.py",
        [node("LazyRecords", 0, [node("items", 2, [], 6)])],
        { external: true },
    );
    await f.file("noise.py", [node("MyLazyRecords", 0, [node("items", 2, [], 6)])]);
    const out = await f.search("LazyRecords.items");
    assert.equal(out.split("\n").length, 2, out);
    assert.deepEqual(new Set(f.calls.keys()), new Set([own, external]));
});
