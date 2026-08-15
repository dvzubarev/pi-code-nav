/**
 * Grammar lifecycle + language-key helpers (subsystem 1 of the tree-sitter
 * support, previously a section of `../tree-sitter-parse.ts`).
 *
 * web-tree-sitter's Parser.init() must run once before any Parser is
 * constructed; Language.load loads a grammar WASM into a Language object. We
 * cache both — the init promise and the per-language Language — so repeated
 * code_scan/reference/definition calls pay zero startup cost after the first.
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
import { readFile } from "node:fs/promises";
import type { Lang } from "../languages/types";

/**
 * Languages we can parse. Mirrors the LSP `Lang` set, but kept independent so
 * the syntax layer has no dependency on lsp-client.ts (it makes no LSP calls).
 * Bash is included; its node classification is deliberately conservative
 * (see classifyBash) — bare `word` nodes are skipped because they are mostly
 * arguments/literals and too noisy, matching the design doc's "finalize bash
 * when implementing; don't block on it" guidance.
 */
/** Superset of `Lang`: the four LSP languages plus `tsx` (the JSX dialect
 * that parses with a distinct tree-sitter grammar but is served by the single
 * `typescript` LSP server). */
export type TsLang = Lang | "tsx";

/** Map a file extension to a tree-sitter language, or null if unsupported. */
export function tsLangForFile(path: string): TsLang | null {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    const ext = path.slice(dot).toLowerCase();
    if (ext === ".py") return "python";
    if (
        ext === ".c" ||
        ext === ".cc" ||
        ext === ".cpp" ||
        ext === ".cxx" ||
        ext === ".h" ||
        ext === ".hh" ||
        ext === ".hpp" ||
        ext === ".hxx" ||
        ext === ".m" ||
        ext === ".mm"
    )
        return "cpp";
    if (ext === ".sh" || ext === ".bash") return "bash";
    // TypeScript and TSX get distinct tree-sitter grammars: the `typescript`
    // grammar mis-parses JSX (`<div>` becomes type_arguments, `{x}` an object),
    // so .tsx must use the `tsx` grammar. .js/.jsx/.mjs/.cjs parse with the
    // typescript grammar (JavaScript is a strict subset for our role purposes —
    // call/member/type/import classification is identical).
    if (
        ext === ".ts" ||
        ext === ".mts" ||
        ext === ".cts" ||
        ext === ".js" ||
        ext === ".mjs" ||
        ext === ".cjs"
    )
        return "typescript";
    if (ext === ".tsx" || ext === ".jsx") return "tsx";
    return null;
}

/**
 * Map a tree-sitter language to the LSP `Lang` whose server can answer
 * hover/definition for files of that grammar.
 *
 * `TsLang` is a superset of `Lang`: `.tsx` (and `.jsx`) parse with the `tsx`
 * tree-sitter grammar but are served by the single `typescript` LSP server
 * (typescript-language-server), which distinguishes .ts/.tsx via the
 * `languageId` it gets in didOpen. Callers that need an LSP client for a
 * `tsLang` (e.g. code_scan's `include_docs` enrichment) MUST go through
 * this helper rather than casting `tsLang as Lang` — that cast is only valid
 * for python/cpp/bash/typescript and would break for `tsx`.
 */
export type LspLang = Lang;
export function tsLangToLspLang(lang: TsLang): LspLang {
    if (lang === "tsx") return "typescript";
    return lang;
}

// ---------------------------------------------------------------------------
// Parser / language lifecycle.
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;
const languageCache = new Map<TsLang, Promise<Language>>();

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

/** Get (and cache) the loaded Language for a tree-sitter language. */
export async function getLanguage(lang: TsLang): Promise<Language> {
    let cached = languageCache.get(lang);
    if (!cached) {
        cached = (async () => {
            await ensureInit();
            const wasmPath = getWasmPath(lang);
            const wasmBytes = await readFile(wasmPath);
            return Language.load(wasmBytes);
        })().catch((e) => {
            languageCache.delete(lang); // allow retry on failure
            throw e;
        });
        languageCache.set(lang, cached);
    }
    return cached;
}
