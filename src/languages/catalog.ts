/**
 * The neutral language catalog — the single source of truth for every
 * language code-nav can route to an LSP server.
 *
 * This module is transport-neutral: it does NOT import `lsp-client.ts`,
 * tree-sitter, pi, or anything else that owns language decisions, so the LSP
 * layer, project detection, extension routing, and tree-sitter parsing can
 * all consume the same definitions without a transport dependency.
 *
 * `LANGUAGES` is the ONE registry. Everything else is derived from it:
 *
 *   - `Lang`        — the union of language ids (`LANGUAGES[].id`).
 *   - `ALL_LANGS`   — `LANGUAGES.map(l => l.id)`.
 *   - `SOURCE_EXTS` — per-language source-file extensions.
 *   - `EXT_LANG`    — extension → language (the LSP routing key).
 *   - `ROOT_MARKERS`— per-language root-level project markers.
 *   - `DISPLAY_NAMES`— human labels for status/diagnostic output.
 *   - `langForFile` — extension → language lookup helper.
 *
 * Adding a language is exactly ONE edit: a new entry in `LANGUAGES`.
 * `sourceExts` and `rootMarkers` may be empty lists (source scanning is a
 * valid detection fallback and some languages have no reliable root marker);
 * only `displayName` and the `id` are always required.
 *
 * `./types.ts` is a type-only re-export facade for the `Lang` type, kept for
 * a stable, clearly neutral import path. It imports this module (type-only,
 * erased at runtime); this module never imports it back, so there is no
 * circular dependency.
 */

/** Per-language metadata used by routing and project detection. */
export interface LanguageInfo {
    /** Human-readable label for status/diagnostic output. */
    displayName: string;
    /**
     * File extensions that count as source files for this language. Leading
     * dot, lowercase. This is both the LSP "which server" routing key and the
     * bootstrap source-scan set (findFirstSourceFile + project detection).
     */
    sourceExts: readonly string[];
    /**
     * Root-level marker files signalling the language is in use. May be empty
     * (the source-extension scan is the detection fallback). Checked first by
     * project detection because existsSync is cheaper than a directory walk.
     */
    rootMarkers: readonly string[];
}

/** A registry entry: the stable id plus its metadata. */
export interface LanguageDef extends LanguageInfo {
    id: string;
}

/**
 * The exhaustive language registry — the only place a language is declared.
 * `as const` preserves the literal ids so `Lang` can be derived from them.
 */
export const LANGUAGES = [
    {
        id: "cpp",
        displayName: "C++",
        // `.m`/`.mm` (Objective-C/Objective-C++) route to ccls here; they are
        // part of this single list, so EXT_LANG / SOURCE_EXTS / detection can
        // never drift apart on them.
        sourceExts: [".cpp", ".cc", ".cxx", ".c", ".hpp", ".hh", ".hxx", ".h", ".m", ".mm"],
        rootMarkers: [
            "CMakeLists.txt",
            "Makefile",
            "meson.build",
            "compile_commands.json",
            "CMakeCache.txt",
            "Makefile.am",
            "configure.ac",
        ],
    },
    {
        id: "python",
        displayName: "Python",
        sourceExts: [".py"],
        rootMarkers: [
            "pyproject.toml",
            "setup.py",
            "setup.cfg",
            "requirements.txt",
            "Pipfile",
            "poetry.lock",
            "uv.lock",
            ".python-version",
        ],
    },
    {
        id: "bash",
        displayName: "Bash",
        sourceExts: [".sh", ".bash"],
        rootMarkers: ["shell.nix"],
    },
    {
        id: "typescript",
        displayName: "TypeScript/JavaScript",
        // TypeScript/JavaScript — one LSP server (typescript-language-server)
        // serves all of these; the languageId in didOpen distinguishes the JSX
        // variants. tree-sitter uses distinct grammars for the JSX variants
        // (see tsLangForFile). .mts/.cts/.mjs/.cjs are TS/JS module variants.
        sourceExts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
        rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json", "deno.json"],
    },
] as const satisfies readonly LanguageDef[];

/** The union of supported language ids, derived from `LANGUAGES`. */
export type Lang = (typeof LANGUAGES)[number]["id"];

/** Every supported language id, in canonical order, derived from `LANGUAGES`. */
export const ALL_LANGS: Lang[] = LANGUAGES.map((l) => l.id);

/** Extensions that count as source files for each language. */
export const SOURCE_EXTS = Object.fromEntries(
    LANGUAGES.map((l) => [l.id, l.sourceExts]),
) as unknown as Record<Lang, readonly string[]>;

/**
 * File extension → language. This is the LSP routing key shared by the tool
 * implementations (via `langForFile`) and the CLI harness. Derived from
 * `LANGUAGES[].sourceExts`, so it cannot diverge from `SOURCE_EXTS`.
 */
export const EXT_LANG: Record<string, Lang> = {};
for (const l of LANGUAGES) {
    for (const ext of l.sourceExts) EXT_LANG[ext] = l.id;
}

/** Root-level marker files that signal a language is in use. */
export const ROOT_MARKERS = Object.fromEntries(
    LANGUAGES.map((l) => [l.id, l.rootMarkers]),
) as unknown as Record<Lang, readonly string[]>;

/** Human-readable label per language. */
export const DISPLAY_NAMES = Object.fromEntries(
    LANGUAGES.map((l) => [l.id, l.displayName]),
) as unknown as Record<Lang, string>;

/** Map a file path to its LSP language, or null if unknown. */
export function langForFile(path: string): Lang | null {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return null;
    const ext = path.slice(dot).toLowerCase();
    return EXT_LANG[ext] ?? null;
}
