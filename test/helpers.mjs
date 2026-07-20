// Shared test helpers.
//
// We load the extension's TypeScript modules through jiti — the *same* loader
// pi uses to load extensions — rather than bare `node --experimental-strip-types`.
// Reasons (see the testing discussion in MAINTAINER.md):
//   - The extension imports `web-tree-sitter`, `tree-sitter-wasm`,
//     `vscode-languageserver-protocol`, etc., whose resolution must be relative
//     to the extension dir. Bare node TS-stripping resolves bare specifiers
//     relative to the importing file, which breaks when the test file lives
//     under test/.
//   - index.ts relies on tsconfig `paths` mappings for
//     @earendil-works/pi-coding-agent and typebox. jiti honors those; native
//     stripping does not. (src/tree-sitter-parse.ts itself has no such mappings,
//     but using jiti uniformly keeps the harness future-proof for lsp-client
//     and index.ts tests.)
//
// `EXT_DIR` is the absolute path to the extension root, so tests can be run
// from any cwd (CI, local, `npm test`).

import { createJiti } from "/home/denin/.npm-local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const jiti = createJiti(EXT_DIR, {
    // Cache off so edits to the .ts source are picked up on re-run without
    // needing to clear a cache dir. The modules are tiny; re-parse is cheap.
    cache: false,
    // interopDefault so `import { parseSymbols } from ...` works regardless of
    // how the module's default export is shaped.
    interopDefault: true,
});

/** Load a module from the extension by relative path (e.g. "./src/tree-sitter-parse.ts"). */
export function load(rel) {
    return jiti.import(rel);
}

/** Convenience: the tree-sitter parse module (the unit-test target). */
export function loadParse() {
    return load("./src/tree-sitter-parse.ts");
}

/**
 * Run `parseSymbols` and return a map keyed by `${role}:${name}` → the entry.
 * Tests assert on specific roles/names without depending on row order, since
 * dedup keeps the *first* occurrence's position (order within a role is
 * significant only for the kept position, not for which rows exist).
 */
export async function parseMap(lang, text, opts = {}) {
    const { parseSymbols } = await loadParse();
    const entries = await parseSymbols(lang, { text, ...opts });
    if (entries === null) throw new Error(`parseSymbols returned null for ${lang}`);
    const m = new Map();
    for (const e of entries) m.set(`${e.role}:${e.name}`, e);
    return m;
}

/** All entries as a sorted, stable string list for snapshot-style assertions. */
export async function parseList(lang, text, opts = {}) {
    const { parseSymbols } = await loadParse();
    const entries = await parseSymbols(lang, { text, ...opts });
    if (entries === null) throw new Error(`parseSymbols returned null for ${lang}`);
    return entries.map((e) => `${e.role}\t${e.name}\t${e.line}:${e.column}`).sort();
}

/** Assert that a map contains a role:name entry at the expected 1-based pos. */
export function assertEntry(map, role, name, line, column) {
    const e = map.get(`${role}:${name}`);
    if (!e) {
        throw new Error(`missing ${role}:${name} (have: ${[...map.keys()].join(", ")})`);
    }
    if (e.line !== line || e.column !== column) {
        throw new Error(`${role}:${name} expected ${line}:${column}, got ${e.line}:${e.column}`);
    }
    return e;
}

/** Assert that a map does NOT contain a role:name entry. */
export function assertNoEntry(map, role, name) {
    if (map.has(`${role}:${name}`)) {
        throw new Error(`unexpected ${role}:${name} present (should be filtered)`);
    }
}
