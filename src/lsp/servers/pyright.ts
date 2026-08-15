import type { ServerConfig } from "../server-config";

/** Python: pyright (matches the user's Emacs config). */
export const PYRIGHT_CONFIG: ServerConfig = {
    command: "pyright-langserver",
    args: ["--stdio"],
    initOptions: {
        multiRoot: false,
        useLibraryCodeForTypes: true,
    },
};
