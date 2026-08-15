/**
 * Python third-party / stdlib root discovery — extracted from `src/symbol.ts`.
 *
 * Discovers extra workspace folders for `code_search_symbol` so servers whose
 * default index is workspace-only (notably `ty`) can find symbols in
 * third-party trees. ccls does NOT use this — it indexes third-parties via
 * its compilation database's `-isystem` flags, so adding folders to ccls
 * would just re-parse them as source trees for no benefit (and real indexing
 * cost). The strategy interface exposes this as `discoverExtraRoots`; the
 * non-python strategies omit it.
 *
 * The discovery is environment-driven and nix-aware (the user's primary
 * environment), with a generic fallback:
 *
 *   - From `$propagatedBuildInputs` (nix — each entry is a package prefix;
 *     we add `lib/pythonX.Y` (stdlib) and `lib/pythonX.Y/site-packages`
 *     (installed packages)). `$PYTHONPATH` is ONLY consulted when
 *     `$propagatedBuildInputs` is absent — in a typical nix shell
 *     `$PYTHONPATH` carries the FULL transitive dependency closure (every
 *     dependency-of-a-dependency's site-packages), which is a large,
 *     rarely-queried set that would cost ty real index time and inflate the
 *     fuzzy-result tail for bare-name queries. The project's direct deps
 *     (from `$propagatedBuildInputs`) is the targeted set the agent actually
 *     searches. In a regular venv/conda (no `$propagatedBuildInputs`)
 *     `$PYTHONPATH` is the venv's own (small, direct) site-packages and is
 *     the only source, so it's fine to use it then.
 *
 * Returns distinct absolute paths that exist and are not the cwd itself.
 * Best-effort: never throws — a missing env var or unreadable dir yields [].
 * Existence is NOT checked here (the caller's `addWorkspaceFolders` is the
 * source of truth and tolerates missing dirs); we only dedupe and skip the
 * cwd to avoid adding the workspace root a second time.
 */

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function discoverPythonRoots(cwd: string): Promise<string[]> {
    const roots = new Set<string>();
    const seen = new Set<string>();
    const add = (p: string | undefined) => {
        if (!p) return;
        let abs: string;
        try {
            abs = resolve(p);
        } catch {
            return;
        }
        // Skip the cwd (already the server's root folder).
        if (abs === resolve(cwd)) return;
        if (seen.has(abs)) return;
        seen.add(abs);
        roots.add(abs);
    };

    // $propagatedBuildInputs (nix): space-separated package prefixes.
    // Each entry is a DIRECT dependency of the project (not transitive),
    // so this is the targeted set the agent actually searches.
    const prop = (process.env.propagatedBuildInputs ?? "").split(/\s+/).filter(Boolean);
    for (const pkg of prop) {
        // Discover `lib/pythonX.Y` and `lib/pythonX.Y/site-packages` under each.
        const lib = resolve(pkg, "lib");
        let entries;
        try {
            entries = await readdir(lib, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (!/^python\d+\.\d+$/.test(e.name)) continue;
            add(resolve(lib, e.name)); // stdlib (e.g. typing.py lives here)
            add(resolve(lib, e.name, "site-packages")); // installed packages
        }
    }
    // $PYTHONPATH is ONLY consulted when $propagatedBuildInputs is absent.
    // In a nix shell $PYTHONPATH carries the full transitive closure (deep,
    // rarely-queried, costly to index); $propagatedBuildInputs gives the
    // direct deps. In a regular venv/conda (no $propagatedBuildInputs)
    // $PYTHONPATH is the venv's own small site-packages and is the only source.
    if (prop.length === 0) {
        for (const p of (process.env.PYTHONPATH ?? "").split(":").filter(Boolean)) add(p);
    }

    return [...roots];
}
