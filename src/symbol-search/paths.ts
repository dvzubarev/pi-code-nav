/**
 * Path helpers shared by the symbol-search strategies.
 *
 * These derive classification signals (which workspace folder a result lives
 * under, and its dotted module path) from `file://` URIs. No LSP/pi/fs
 * dependency beyond `render.uriToPath`; pure string manipulation.
 */

import { sep } from "node:path";
import { uriToPath } from "../render";

/**
 * The filesystem path of the workspace folder a result file lives under, or
 * null when it is under none. `folders` MUST be sorted longest-first so the
 * most specific folder wins (a broad folder like `lib/python3.13` is a prefix
 * of `lib/python3.13/site-packages`).
 */
export function homeFolderOf(uri: string, folders: readonly string[]): string | null {
    const p = uriToPath(uri);
    for (const f of folders) {
        if (p === f || p.startsWith(f + sep)) return f;
    }
    return null;
}

/**
 * Derive the dotted module path of a result file relative to its home folder
 * (the longest matching workspace folder), for Python/TypeScript qualified-
 * name filtering.
 *
 * `folders` MUST be sorted longest-first (see `LspClient.workspaceFolderPaths`)
 * so a specific folder (`lib/python3.13/site-packages`) wins over a broad one
 * (`lib/python3.13`) that is a prefix of it. Returns e.g. `cbor2._decoder` for
 * `.../site-packages/cbor2/_decoder.py`, `typing` for `.../python3.13/typing.py`.
 * `__init__.py` maps to the package name (the containing dir name). For a
 * workspace-root file the result is the project-relative path (e.g. `second`
 * for `.../workspace/second.py`); callers distinguish workspace vs third-party
 * with `homeFolderOf` (the home folder equals `rootPath` or not).
 */
export function modulePathOf(uri: string, folders: readonly string[]): string | null {
    const p = uriToPath(uri);
    const f = homeFolderOf(uri, folders);
    if (!f || p === f) return null;
    let rel = p
        .slice(f.length + 1)
        .replace(/\.py[i]?$/, "")
        .replace(/\.ts$/, "")
        .replace(/\.tsx$/, "");
    // __init__ -> the package (the containing dir name).
    if (rel.endsWith("/__init__")) rel = rel.slice(0, -9);
    return rel.split(/[/\\]/).join(".");
}
