/**
 * Project language detection — used by `code_search_symbol` (symbol.ts) so the
 * per-language workspace/symbol loop only spawns servers that can actually
 * find a project here. Without this, a pure-Python project still spawns
 * typescript-language-server, whose workspace/symbol throws "No Project." and
 * aborts the whole multi-language query — discarding results already collected
 * from python.
 *
 * Two tiers, short-circuiting per language as soon as it's confirmed present:
 *   1. Root-level marker files (existsSync — no I/O recursion).
 *   2. A bounded breadth-first source-file scan against SOURCE_EXTS.
 *
 * Results are memoized per resolved root path for the session (a project's
 * language set is stable; servers are likewise kept alive for the whole
 * session). `clearDetectedLanguagesCache` lets tests reset between cases.
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Lang } from "./languages/types";
import { ALL_LANGS, ROOT_MARKERS, SOURCE_EXTS } from "./languages/catalog";

/** Directories never descended into during the source-file scan. */
const SCAN_SKIP = new Set([
    "node_modules",
    ".git",
    ".",
    "build",
    "dist",
    "out",
    ".next",
    ".cache",
    ".direnv",
    ".venv",
    "venv",
    "__pycache__",
    ".ruff_cache",
    ".pytest_cache",
    "target",
]);

/** Cap on directories visited during the BFS source scan so a huge tree (e.g.
 * node_modules leaking in) can't make the first symbol query slow. */
const SCAN_MAX_DIRS = 2000;

/**
 * Memoized detection results, keyed by resolved absolute root path. A
 * project's language set is stable for the session (servers are likewise
 * kept alive for the whole session — see AGENTS.md), so the filesystem scan
 * runs at most once per workspace. Subsequent code_search_symbol calls hit
 * the cache and skip both the marker checks and the BFS source scan.
 */
const detectedLanguagesCache = new Map<string, Lang[]>();

/** Detect which languages are present in a project root. Returns the full
 * language set (never empty — falls back to all four so a mis-detection never
 * silently hides results; the caller still pays the cost but gets correct
 * answers). Memoized per resolved root. */
export async function detectProjectLanguages(rootPath: string): Promise<Lang[]> {
    const key = resolve(rootPath);
    const cached = detectedLanguagesCache.get(key);
    if (cached) return cached;
    const result = await detectProjectLanguagesUncached(key);
    detectedLanguagesCache.set(key, result);
    return result;
}

async function detectProjectLanguagesUncached(rootPath: string): Promise<Lang[]> {
    const found = new Set<Lang>();
    // Tier 1: root markers.
    for (const lang of ALL_LANGS) {
        const markers = ROOT_MARKERS[lang];
        if (markers.some((m) => existsSync(resolve(rootPath, m)))) {
            found.add(lang);
        }
    }
    if (found.size === ALL_LANGS.length) return [...found];

    // Tier 2: bounded breadth-first source-extension scan. Build the set of
    // languages still unconfirmed so we can stop early once all resolve.
    const wanted = new Set<Lang>(ALL_LANGS);
    for (const l of found) wanted.delete(l);
    let dirsVisited = 0;
    let queue: string[] = [rootPath];
    while (queue.length > 0 && wanted.size > 0 && dirsVisited < SCAN_MAX_DIRS) {
        const dir = queue.shift()!;
        dirsVisited++;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SCAN_SKIP.has(e.name)) continue;
                queue.push(resolve(dir, e.name));
            } else if (e.isFile() && wanted.size > 0) {
                const dot = e.name.lastIndexOf(".");
                if (dot < 0) continue;
                const ext = e.name.slice(dot).toLowerCase();
                for (const lang of wanted) {
                    if (SOURCE_EXTS[lang].includes(ext)) {
                        found.add(lang);
                        wanted.delete(lang);
                        break;
                    }
                }
            }
        }
    }
    if (found.size === 0) return [...ALL_LANGS];
    return [...found];
}

/** Clear the detection cache. Tests call this between cases so results from
 * one temp-dir root don't leak into another through the shared module. */
export function clearDetectedLanguagesCache(): void {
    detectedLanguagesCache.clear();
}
