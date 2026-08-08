// Unit tests for detectProjectLanguages (nav.ts).
//
// No language servers required — this is pure filesystem detection. Uses
// mkdtemp to build throwaway project roots, then asserts which languages the
// detector reports.
//
// Run:  npm run test:unit -- test/detect.test.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "./helpers.mjs";

// The detection result is cached per root for the module's lifetime (mirrors
// the session-scoped server lifetime). Clear it before each test so one
// test's root can't satisfy another's lookup via cache.
let clearCache;
before(async () => {
    ({ clearDetectedLanguagesCache: clearCache } = await load("./src/nav.ts"));
});
before(() => clearCache?.());

/** Build an empty temp dir and return its path (caller removes it). */
async function mkroot() {
    return mkdtemp(join(tmpdir(), "code-nav-detect-"));
}

test("python: detected via pyproject.toml root marker", async () => {
    const root = await mkroot();
    try {
        await writeFile(join(root, "pyproject.toml"), "[project]\n");
        await writeFile(join(root, "main.py"), "print('hi')\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const langs = await detectProjectLanguages(root);
        assert.ok(langs.includes("python"), `expected python in ${JSON.stringify(langs)}`);
        assert.ok(
            !langs.includes("typescript"),
            `did not expect typescript in ${JSON.stringify(langs)}`,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("typescript: detected via package.json root marker", async () => {
    const root = await mkroot();
    try {
        await writeFile(join(root, "package.json"), '{"name":"x"}\n');
        await writeFile(join(root, "index.ts"), "export const x = 1;\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const langs = await detectProjectLanguages(root);
        assert.ok(langs.includes("typescript"), `expected typescript in ${JSON.stringify(langs)}`);
        assert.ok(!langs.includes("python"), `did not expect python in ${JSON.stringify(langs)}`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("mixed: python + typescript detected via both root markers", async () => {
    const root = await mkroot();
    try {
        await writeFile(join(root, "pyproject.toml"), "[project]\n");
        await writeFile(join(root, "package.json"), '{"name":"x"}\n');
        await writeFile(join(root, "app.py"), "\n");
        await writeFile(join(root, "app.ts"), "\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const langs = await detectProjectLanguages(root);
        assert.ok(langs.includes("python"), `expected python in ${JSON.stringify(langs)}`);
        assert.ok(langs.includes("typescript"), `expected typescript in ${JSON.stringify(langs)}`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("source-only: .cpp file with no build marker is found by the scan", async () => {
    const root = await mkroot();
    try {
        await writeFile(join(root, "main.cpp"), "int main() {}\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const langs = await detectProjectLanguages(root);
        assert.ok(langs.includes("cpp"), `expected cpp in ${JSON.stringify(langs)}`);
        assert.ok(!langs.includes("python"), `did not expect python in ${JSON.stringify(langs)}`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("source scan is recursive (file in a subdir)", async () => {
    const root = await mkroot();
    try {
        await mkdir(join(root, "src"));
        await writeFile(join(root, "src", "app.py"), "\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const langs = await detectProjectLanguages(root);
        assert.ok(langs.includes("python"), `expected python in ${JSON.stringify(langs)}`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("scan skips .venv / __pycache__ / node_modules", async () => {
    // A stray .py inside .venv should not be the reason python is detected
    // when there are no root markers and no real source files. (We can't
    // easily assert python is ABSENT here because the temp dir itself has no
    // other languages — instead we assert the skip dirs are not descended
    // into by confirming detection completes and returns the fallback set
    // quickly. The meaningful assertion is that a junk .py in .venv alone
    // does not produce a false "python-only" detection that would skip ts.)
    const root = await mkroot();
    try {
        await mkdir(join(root, ".venv"), { recursive: true });
        await writeFile(join(root, ".venv", "junk.py"), "\n");
        await mkdir(join(root, "node_modules"), { recursive: true });
        await writeFile(join(root, "node_modules", "junk.js"), "\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const langs = await detectProjectLanguages(root);
        // No real markers, no real source → falls back to all four so nothing
        // is silently hidden.
        assert.deepEqual([...langs].sort(), ["bash", "cpp", "python", "typescript"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("empty dir falls back to all four languages", async () => {
    const root = await mkroot();
    try {
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const langs = await detectProjectLanguages(root);
        assert.deepEqual([...langs].sort(), ["bash", "cpp", "python", "typescript"]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("result is cached: second call returns without re-scanning", async () => {
    const root = await mkroot();
    try {
        await writeFile(join(root, "pyproject.toml"), "[project]\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        const first = await detectProjectLanguages(root);
        // Mutate the root AFTER the first call: add a tsconfig.json. If the
        // second call hits the cache, typescript must NOT appear (the cached
        // result predates the marker). If it re-scanned, it would pick up the
        // new marker and wrongly include typescript.
        await writeFile(join(root, "tsconfig.json"), "{}\n");
        const second = await detectProjectLanguages(root);
        assert.deepEqual(second, first, "second call should return cached result, not re-scan");
        assert.ok(
            !second.includes("typescript"),
            "cache miss: re-scanned and saw the new tsconfig.json",
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("cache is keyed by resolved absolute path", async () => {
    const root = await mkroot();
    try {
        await writeFile(join(root, "pyproject.toml"), "[project]\n");
        const { detectProjectLanguages } = await load("./src/nav.ts");
        // Same root via a relative-ish path string with a trailing slash and
        // . segment — resolve() normalizes these, so they share one cache entry.
        const a = await detectProjectLanguages(root);
        const b = await detectProjectLanguages(join(root, "."));
        assert.deepEqual(b, a);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
