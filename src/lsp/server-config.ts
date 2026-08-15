/**
 * Built-in language-server configuration.
 *
 * The per-server defaults live in `./servers/<server>.ts`; this module owns
 * the `ServerConfig` shape, the `DEFAULTS` table, Python auto-detection (ty
 * preferred, pyright fallback), and the override-merging entry point
 * `resolveConfig`. `LspClient` receives an already-resolved config and never
 * knows why ty was selected over pyright.
 */

import { execSync } from "node:child_process";
import type { Lang } from "../languages/types";
import { CCLS_CONFIG } from "./servers/ccls";
import { TY_CONFIG } from "./servers/ty";
import { PYRIGHT_CONFIG } from "./servers/pyright";
import { BASH_CONFIG } from "./servers/bash-language-server";
import { TYPESCRIPT_CONFIG } from "./servers/typescript-language-server";

// Re-export the built-in per-server configs for the back-compat barrels that
// still expose them from lsp-client (and for tests/docs that inspect them).
export { CCLS_CONFIG } from "./servers/ccls";
export { TY_CONFIG } from "./servers/ty";
export { PYRIGHT_CONFIG } from "./servers/pyright";
export { BASH_CONFIG } from "./servers/bash-language-server";
export { TYPESCRIPT_CONFIG } from "./servers/typescript-language-server";

/** Command + args + init options for one language. */
export interface ServerConfig {
    command: string;
    args: string[];
    /** Passed as `initializationOptions` in the LSP initialize request. */
    initOptions: Record<string, unknown>;
}

/**
 * Stable identity of the server that produced a resolved config. Replaces the
 * old command-path regex `/(^|[\\/])ty$/` used to recognize ty for
 * project-readiness: a resolved config carries WHICH server it is, not just
 * how to run it.
 */
export type ServerKind =
    "ccls" | "ty" | "pyright" | "bash-language-server" | "typescript-language-server" | "custom";

/** A resolved config plus its stable server identity. */
export interface ResolvedServerConfig extends ServerConfig {
    serverKind: ServerKind;
}

/**
 * A per-language user override from `.pi/lsp.json`. Extends a `ServerConfig`
 * partial with an optional explicit adapter identity, so a user can point a
 * built-in server's policy at a non-canonical binary (e.g. an absolute path
 * to `ty`) without path-fragile regex recognition.
 */
export interface ServerOverride extends Partial<ServerConfig> {
    serverKind?: ServerKind;
}

const DEFAULTS: Record<Lang, ResolvedServerConfig> = {
    cpp: { ...CCLS_CONFIG, serverKind: "ccls" },
    python: { ...TY_CONFIG, serverKind: "ty" },
    bash: { ...BASH_CONFIG, serverKind: "bash-language-server" },
    typescript: { ...TYPESCRIPT_CONFIG, serverKind: "typescript-language-server" },
};

/**
 * Memoized PATH lookup. Returns true if `cmd` is executable on PATH.
 * Uses `which` (POSIX, always present) to avoid a node_modules dep.
 */
const cmdOnPathCache = new Map<string, boolean>();
export function commandExists(cmd: string): boolean {
    const cached = cmdOnPathCache.get(cmd);
    if (cached !== undefined) return cached;
    try {
        execSync(`command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`, {
            stdio: "ignore",
        });
        cmdOnPathCache.set(cmd, true);
        return true;
    } catch {
        cmdOnPathCache.set(cmd, false);
        return false;
    }
}

/**
 * Resolve the effective config for a language.
 *
 * For Python: if the user explicitly set a `command` in .pi/lsp.json, use it
 * verbatim (their choice wins). Otherwise auto-detect: prefer `ty` when on
 * PATH (it implements workspace/symbol and standard SymbolKind), falling back
 * to `pyright-langserver`.
 */
/**
 * Classify an explicit Python command by stable identity. Canonical command
 * names are recognized exactly; anything else is `custom` unless the override
 * carries an explicit `serverKind` (the escape hatch for absolute/custom
 * paths to a known server).
 */
function pythonCommandKind(command: string, explicit?: ServerKind): ServerKind {
    if (explicit) return explicit;
    if (command === TY_CONFIG.command) return "ty";
    if (command === PYRIGHT_CONFIG.command) return "pyright";
    return "custom";
}

export function resolveConfig(
    lang: Lang,
    overrides?: Partial<Record<Lang, ServerOverride>>,
): ResolvedServerConfig {
    if (lang === "python") {
        const ov = overrides?.python;
        // Explicit user command wins (e.g. force pyright, or pick basedpyright).
        if (ov?.command) {
            const serverKind = pythonCommandKind(ov.command, ov.serverKind);
            // Merge over the OPTED-IN server's defaults (ty for "ty", pyright
            // for "pyright-langserver", pyright for unknown/custom commands —
            // preserving the historical pyright base for user-selected servers).
            const base = serverKind === "ty" ? TY_CONFIG : PYRIGHT_CONFIG;
            return {
                command: ov.command,
                args: ov.args ?? base.args,
                initOptions: { ...base.initOptions, ...ov.initOptions },
                serverKind,
            };
        }
        const base = commandExists("ty") ? TY_CONFIG : PYRIGHT_CONFIG;
        const kind: ServerKind = base === TY_CONFIG ? "ty" : "pyright";
        if (!ov) return { ...base, serverKind: kind };
        return {
            command: base.command,
            args: ov.args ?? base.args,
            initOptions: { ...base.initOptions, ...ov.initOptions },
            serverKind: kind,
        };
    }
    const base = DEFAULTS[lang];
    const ov = overrides?.[lang];
    if (!ov) return base;
    // A user override of the built-in command opts OUT of the built-in
    // server's identity, so language-specific policies do not run against a
    // server they were not written for — unless the override carries an
    // explicit `serverKind` (the escape hatch for absolute paths to a known
    // server). Canonical commands equal to the built-in keep the base kind.
    const serverKind: ServerKind =
        ov.serverKind ?? (ov.command && ov.command !== base.command ? "custom" : base.serverKind);
    return {
        command: ov.command ?? base.command,
        args: ov.args ?? base.args,
        initOptions: { ...base.initOptions, ...ov.initOptions },
        serverKind,
    };
}
