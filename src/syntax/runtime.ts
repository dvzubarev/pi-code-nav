/**
 * Grammar lifecycle (subsystem 1 of the tree-sitter support, previously a
 * section of `../tree-sitter-parse.ts`).
 *
 * web-tree-sitter's Parser.init() must run once before any Parser is
 * constructed; Language.load loads a grammar WASM into a Language object. We
 * cache both — the init promise and the per-language Language — so repeated
 * code_scan/reference/definition calls pay zero startup cost after the first.
 *
 * Language-KEY helpers (`TsLang`, `tsLangForFile`, `tsLangToLspLang`) are no
 * longer defined here: they are derived from the per-grammar `SyntaxLanguage`
 * registry in `./languages/index.ts`, which is the single source of truth for
 * grammar↔LSP↔extension routing. This module re-exports them so existing
 * importers keep the same surface. See `languages/index.ts` for the design.
 *
 * Dependency choice: we use the WASM builds (web-tree-sitter runtime +
 * tree-sitter-wasm prebuilt grammars) rather than the native node bindings.
 * The native `tree-sitter` / `tree-sitter-python` / `tree-sitter-cpp` /
 * `tree-sitter-bash` packages have irreconcilable peer-dependency ranges
 * (tree-sitter-cpp@0.23.4 requires tree-sitter@^0.21.1 while
 * tree-sitter-python@0.25 requires tree-sitter@^0.25.0 — there is no single
 * tree-sitter version satisfying all three grammars without --legacy-peer-deps).
 * The WASM path has no native compilation, no peer conflicts, and the grammars
 * ship prebuilt. See code_scan.md "Dependency — WASM, not native bindings".
 */

import { Parser, Language } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import type { SupportedLanguage } from "tree-sitter-wasm";
import { readFile } from "node:fs/promises";
import type { TsLang as RegistryTsLang } from "./languages/index";

// Re-export the registry-derived language keys for back-compat. The source of
// truth is the `SyntaxLanguage` registry (`./languages/index.ts`).
export { tsLangForFile, tsLangToLspLang } from "./languages/index";
export type { TsLang } from "./languages/index";

// ---------------------------------------------------------------------------
// Parser / language lifecycle.
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;
const languageCache = new Map<RegistryTsLang, Promise<Language>>();

/** Idempotently initialize the web-tree-sitter wasm runtime. */
function ensureInit(): Promise<void> {
    if (!initPromise) {
        // Parser.init() with no options: in Node it auto-locates web-tree-sitter.wasm
        // relative to the module (via import.meta.url). Verified under jiti.
        initPromise = Parser.init().catch((e) => {
            initPromise = null; // allow retry on failure
            throw e;
        });
    }
    return initPromise;
}

/** Get (and cache) the loaded Language for a tree-sitter grammar key.
 * The grammar key is a `TsLang` from the `SyntaxLanguage` registry; every
 * registered grammar also ships in `tree-sitter-wasm`, so the cast to its
 * `SupportedLanguage` key set is safe. */
export async function getLanguage(grammar: RegistryTsLang): Promise<Language> {
    let cached = languageCache.get(grammar);
    if (!cached) {
        cached = (async () => {
            await ensureInit();
            const wasmPath = getWasmPath(grammar as SupportedLanguage);
            const wasmBytes = await readFile(wasmPath);
            return Language.load(wasmBytes);
        })().catch((e) => {
            languageCache.delete(grammar); // allow retry on failure
            throw e;
        });
        languageCache.set(grammar, cached);
    }
    return cached;
}
