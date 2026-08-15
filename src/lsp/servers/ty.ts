import type { ServerConfig } from "../server-config";

/**
 * Python: ty (Astral) — preferred when available because it implements
 * workspace/symbol (pyright does not) and reports standard LSP SymbolKind.
 * No init options needed; ty discovers pyproject.toml / .venv from the root.
 */
export const TY_CONFIG: ServerConfig = {
    command: "ty",
    args: ["server"],
    // ty reports whole-workspace checking progress from workspace/diagnostic
    // only in workspace diagnostic mode. LspClient uses that request as the
    // cold-project readiness barrier before the first Python query.
    initOptions: { diagnosticMode: "workspace" },
};
